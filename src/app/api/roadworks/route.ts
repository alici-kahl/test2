// src/app/api/roadworks/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BBox = [number, number, number, number];

function isBBox(x: any): x is BBox {
  return (
    Array.isArray(x) &&
    x.length === 4 &&
    x.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    x[0] < x[2] &&
    x[1] < x[3]
  );
}

/** SRID=4326;POLYGON((minx miny, maxx miny, maxx maxy, minx maxy, minx miny)) */
function bboxToWkt4326(b: BBox): string {
  const [minx, miny, maxx, maxy] = b;
  const ring = [
    `${minx} ${miny}`,
    `${maxx} ${miny}`,
    `${maxx} ${maxy}`,
    `${minx} ${maxy}`,
    `${minx} ${miny}`,
  ].join(", ");
  return `SRID=4326;POLYGON((${ring}))`;
}

function emptyFC(meta: any) {
  return { type: "FeatureCollection", features: [] as any[], meta };
}

function isMotorwayByProps(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  if (p.external_id && typeof p.external_id === "string" && p.external_id.trim().length > 0) return true;
  if (p.source_system && String(p.source_system).toLowerCase().includes("autobahn")) return true;
  if (p.source && String(p.source).toLowerCase().includes("autobahn")) return true;
  return false;
}

/**
 * WICHTIG: Dieser Helper versucht, Breiten/Gewichte zu retten,
 * falls sie in der DB fehlen oder im Text versteckt sind.
 */
function enrichFeatureProperties(f: any): any {
  if (!f || !f.properties) return f;
  const p = f.properties;

  let width = p.max_width_m ?? p.max_width ?? p.width ?? p.width_limit ?? p.breite ?? null;
  let weight = p.max_weight_t ?? p.max_weight ?? p.weight ?? p.weight_limit ?? p.gewicht ?? null;

  const text = `${p.title || ""} ${p.description || ""} ${p.reason || ""} ${p.subtitle || ""}`;

  if (!width || width > 900) {
    const widthMatch =
      text.match(/(?:Breite|width|breite)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i) ||
      text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:Breite|width|breite)/i) ||
      text.match(/(?:über|over|width)\s*([0-9]+(?:[.,][0-9]+)?)\s*m/i);

    if (widthMatch) {
      width = parseFloat(widthMatch[1].replace(",", "."));
    }
  }

  if (!weight || weight > 900) {
    const weightMatch = text.match(/(?:Gewicht|weight|Last|last)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*t/i);
    if (weightMatch) {
      weight = parseFloat(weightMatch[1].replace(",", "."));
    }
  }

  if (width !== null && !isNaN(width)) f.properties.max_width_m = width;
  if (weight !== null && !isNaN(weight)) f.properties.max_weight_t = weight;

  return f;
}

export async function POST(req: Request) {
  const metaBase: any = { source: "get_active_roadworks_geojson" };

  try {
    const body = await req.json().catch(() => ({}));
    const ts: string | undefined = body?.ts;
    const tz: string = body?.tz || "Europe/Berlin";
    const bbox: BBox | null = isBBox(body?.bbox) ? body.bbox : null;
    const only_motorways: boolean = !!body?.only_motorways;

    // ✅ KRITISCHER FIX: Supabase RPC darf nicht “unendlich” hängen.
    const requested =
      typeof body?.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : 4_500;
    const timeoutMs = Math.min(requested, 8_000);

    if (!ts) {
      return NextResponse.json(
        emptyFC({ ...metaBase, ts, tz, rw_bbox: bbox, only_motorways, error: "Missing 'ts' (ISO-UTC)" }),
        { status: 400 }
      );
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE =
      process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return NextResponse.json(emptyFC({ ...metaBase, error: "ENV missing" }), { status: 500 });
    }

    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/get_active_roadworks_geojson`;
    const rpcPayload: Record<string, any> = { _ts: ts, _tz: tz };
    if (bbox) rpcPayload._bbox = bboxToWkt4326(bbox);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    let text = "";

    try {
      resp = await fetch(rpcUrl, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(rpcPayload),
        cache: "no-store",
        signal: controller.signal,
      });

      text = await resp.text().catch(() => "");
    } catch (e: any) {
      const msg = String(e);
      const isAbort = e?.name === "AbortError" || msg.toLowerCase().includes("abort");
      return NextResponse.json(
        emptyFC({
          ...metaBase,
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          error: isAbort ? "RPC_TIMEOUT" : "RPC_FETCH_FAILED",
          timed_out: isAbort,
          timeout_ms_used: timeoutMs,
        }),
        { status: 200 }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      return NextResponse.json(
        emptyFC({
          ...metaBase,
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          rpc_status: resp.status,
          error: "RPC failed",
          timeout_ms_used: timeoutMs,
        }),
        { status: 200 }
      );
    }

    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return NextResponse.json(
        emptyFC({
          ...metaBase,
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          error: "RPC JSON parse failed",
          timeout_ms_used: timeoutMs,
        }),
        { status: 200 }
      );
    }

    let rawFeatures: any[] = [];
    if (parsed?.type === "FeatureCollection" && Array.isArray(parsed?.features)) {
      rawFeatures = parsed.features;
    } else if (Array.isArray(parsed)) {
      rawFeatures = parsed;
    }

    const enrichedFeatures = rawFeatures.map(enrichFeatureProperties);

    let usedFeatures = enrichedFeatures;
    if (only_motorways) {
      usedFeatures = enrichedFeatures.filter((f) => isMotorwayByProps(f?.properties));
    }

    return NextResponse.json(
      {
        type: "FeatureCollection",
        features: usedFeatures,
        meta: {
          ...metaBase,
          ts,
          tz,
          rw_bbox: bbox,
          only_motorways,
          fetched: rawFeatures.length,
          used: usedFeatures.length,
          timeout_ms_used: timeoutMs,
        },
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      emptyFC({ ...metaBase, error: String(e?.message || e) }),
      { status: 200 }
    );
  }
}
