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

/**
 * Motorway-Erkennung: nur anhand des `network`-Felds oder source-Feldes,
 * NICHT anhand von external_id (die haben alle Einträge).
 */
function isMotorwayByProps(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  const network = String(p.network ?? "").toLowerCase();
  if (network === "autobahn" || network.includes("autobahn")) return true;
  if (p.source_system && String(p.source_system).toLowerCase().includes("autobahn")) return true;
  if (p.source && String(p.source).toLowerCase().includes("autobahn")) return true;
  return false;
}

/**
 * Normalisiert und validiert Limit-Werte aus der DB.
 * - Liest direkt aus DB-Spalten (neue RPC liefert max_width_m etc. korrekt)
 * - Fallback: Freitext-Extraktion wenn DB-Wert fehlt
 * - Plausibilitätsprüfung: verhindert Einheitenfehler (cm statt m etc.)
 */
function enrichFeatureProperties(f: any): any {
  if (!f || !f.properties) return f;
  const p = f.properties;

  // Direkt aus DB-Spalten lesen (neue RPC liefert diese korrekt)
  let width  = p.max_width_m  != null ? Number(p.max_width_m)  : null;
  let height = p.max_height_m != null ? Number(p.max_height_m) : null;
  let weight = p.max_weight_t != null ? Number(p.max_weight_t) : null;
  let axle   = p.max_axle_t   != null ? Number(p.max_axle_t)   : null;

  // Ungültige Zahlen auf null setzen
  if (!Number.isFinite(width))  width  = null;
  if (!Number.isFinite(height)) height = null;
  if (!Number.isFinite(weight)) weight = null;
  if (!Number.isFinite(axle))   axle   = null;

  // Fallback: Freitext-Extraktion wenn DB-Wert fehlt
  const text = `${p.title || ""} ${p.description || ""} ${p.reason || ""} ${p.subtitle || ""}`;

  if (width === null) {
    const m =
      text.match(/(?:Breite|width|breite)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i) ||
      text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:Breite|width|breite)/i);
    if (m) width = parseFloat(m[1].replace(",", "."));
  }

  if (weight === null) {
    const m = text.match(/(?:Gewicht|weight|Last|last)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*t/i);
    if (m) weight = parseFloat(m[1].replace(",", "."));
  }

  if (height === null) {
    const m = text.match(/(?:Höhe|Hoehe|height)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i);
    if (m) height = parseFloat(m[1].replace(",", "."));
  }

  // Plausibilitätsprüfung – fängt Einheitenfehler (z.B. cm statt m) ab
  // und entfernt physikalisch unsinnige Werte
  if (width  !== null && (width  <= 0 || width  > 30  || !Number.isFinite(width)))  width  = null;
  if (height !== null && (height <= 0 || height > 15  || !Number.isFinite(height))) height = null;
  if (weight !== null && (weight <= 0 || weight > 500 || !Number.isFinite(weight))) weight = null;
  if (axle   !== null && (axle   <= 0 || axle   > 100 || !Number.isFinite(axle)))   axle   = null;

  // Zurückschreiben – immer, auch wenn null (überschreibt alte fehlerhafte Werte)
  f.properties.max_width_m  = width;
  f.properties.max_height_m = height;
  f.properties.max_weight_t = weight;
  f.properties.max_axle_t   = axle;

  // Debug-Logging: nur wenn tatsächlich ein Limit vorhanden ist
  if (width !== null || weight !== null || height !== null || axle !== null) {
    console.log("[ENRICH] limit found:", {
      id:           p.external_id ?? p.roadwork_id ?? null,
      kind:         p.kind        ?? null,
      max_width_m:  width,
      max_height_m: height,
      max_weight_t: weight,
      max_axle_t:   axle,
    });
  }

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

    const requested =
      typeof body?.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : 12_000;
    const timeoutMs = Math.min(requested, 15_000);

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
    // _bbox als WKT mit SRID übergeben – PostGIS akzeptiert das als geometry
    if (bbox) rpcPayload._bbox = bboxToWkt4326(bbox);

    console.log("[ROADWORKS] calling RPC", {
      ts,
      tz,
      bbox,
      only_motorways,
      timeoutMs,
    });

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
      console.error("[ROADWORKS] RPC fetch failed:", isAbort ? "TIMEOUT" : msg);
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
      console.error("[ROADWORKS] RPC HTTP error:", resp.status, text.slice(0, 300));
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
      console.error("[ROADWORKS] JSON parse failed, raw:", text.slice(0, 300));
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

    // Die neue RPC gibt direkt ein json-Objekt zurück (kein Array)
    let rawFeatures: any[] = [];
    if (parsed?.type === "FeatureCollection" && Array.isArray(parsed?.features)) {
      rawFeatures = parsed.features;
    } else if (Array.isArray(parsed)) {
      // Fallback für alte RPC-Variante
      rawFeatures = parsed;
    } else if (parsed && typeof parsed === "object") {
      // Supabase RPC gibt manchmal das Objekt direkt zurück
      if (Array.isArray(parsed?.features)) {
        rawFeatures = parsed.features;
      }
    }

    console.log("[ROADWORKS] fetched features:", rawFeatures.length);

    const enrichedFeatures = rawFeatures.map(enrichFeatureProperties);

    let usedFeatures = enrichedFeatures;
    if (only_motorways) {
      usedFeatures = enrichedFeatures.filter((f) => isMotorwayByProps(f?.properties));
    }

    // Zähle wie viele Features tatsächlich Limits haben (für Debugging)
    const withLimits = usedFeatures.filter(
      (f) => f?.properties?.max_width_m != null || f?.properties?.max_weight_t != null
    ).length;

    console.log("[ROADWORKS] result:", {
      fetched: rawFeatures.length,
      used: usedFeatures.length,
      with_limits: withLimits,
      only_motorways,
    });

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
          with_limits: withLimits,
          timeout_ms_used: timeoutMs,
        },
      },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("[ROADWORKS] unhandled error:", e);
    return NextResponse.json(
      emptyFC({ ...metaBase, error: String(e?.message || e) }),
      { status: 200 }
    );
  }
}
