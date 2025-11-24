// src/app/api/route/valhalla/avoid-test/route.ts
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Coords = [number, number];

function bboxFromTwoPoints(a: Coords, b: Coords, padDeg = 0.3) {
  const minLon = Math.min(a[0], b[0]) - padDeg;
  const maxLon = Math.max(a[0], b[0]) + padDeg;
  const minLat = Math.min(a[1], b[1]) - padDeg;
  const maxLat = Math.max(a[1], b[1]) + padDeg;
  // WKT: SRID=4326;POLYGON((lon lat, lon lat, ...))
  const wkt = `SRID=4326;POLYGON((${minLon} ${minLat},${maxLon} ${minLat},${maxLon} ${maxLat},${minLon} ${maxLat},${minLon} ${minLat}))`;
  return { minLon, minLat, maxLon, maxLat, wkt };
}

export async function POST(req: NextRequest) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return NextResponse.json(
      {
        ok: false,
        status: 500,
        error: "ENV MISSING",
        echo_env: { has_url: !!SUPABASE_URL, has_key: !!SERVICE_KEY },
      },
      { status: 500 },
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      start?: Coords;
      end?: Coords;
      pad_deg?: number;
      buffer_m?: number;
      simplify_m?: number;
      min_area_m2?: number;
      max_polygons?: number;
      ts?: string;
      tz?: string;
    };

    const start: Coords = body.start ?? [6.96, 50.94];
    const end: Coords = body.end ?? [8.68, 50.11];

    const padDeg = Number.isFinite(body.pad_deg) ? Number(body.pad_deg) : 0.3;
    const { wkt, minLon, minLat, maxLon, maxLat } = bboxFromTwoPoints(
      start,
      end,
      padDeg,
    );

    const payload = {
      _ts: body.ts ?? new Date().toISOString(),
      _tz: body.tz ?? "Europe/Berlin",
      _bbox: wkt, // WKT mit SRID – PostgREST castet -> geometry
      _buffer_m: Number.isFinite(body.buffer_m) ? body.buffer_m : 12,
      _simplify_m: Number.isFinite(body.simplify_m) ? body.simplify_m : 6,
      _min_area_m2: Number.isFinite(body.min_area_m2) ? body.min_area_m2 : 40,
      _max_polygons: Number.isFinite(body.max_polygons) ? body.max_polygons : 80,
    };

    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/get_active_roadworks_avoid_polygons_v2`;
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    // Versuche JSON zu parsen – falls supabase Fehlerseite liefert, bleibt text erhalten
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* noop */
    }

    if (!r.ok) {
      return NextResponse.json(
        {
          ok: false,
          status: r.status,
          supabase_body: parsed ?? text,
          echo_env: { has_url: true, has_key: true },
          echo_bbox: [minLon, minLat, maxLon, maxLat],
          echo_payload: payload,
        },
        { status: 500 },
      );
    }

    const fc = parsed ?? {};
    const features = Array.isArray(fc?.features) ? fc.features : [];
    const sampleTypes: string[] = features
      .slice(0, 3)
      .map((f: any) => f?.geometry?.type)
      .filter(Boolean);

    return NextResponse.json({
      ok: true,
      status: 200,
      avoid_features: features.length,
      sample_types: sampleTypes,
      echo_bbox: [minLon, minLat, maxLon, maxLat],
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, status: 500, error: String(err) },
      { status: 500 },
    );
  }
}
