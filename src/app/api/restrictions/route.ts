// src/app/api/restrictions/route.ts
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Coords = [number, number];

function wktFromBbox(b: [number, number, number, number]) {
  const [minX, minY, maxX, maxY] = b;
  return `SRID=4326;POLYGON((${minX} ${minY},${maxX} ${minY},${maxX} ${maxY},${minX} ${maxY},${minX} ${minY}))`;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as any;

  const ts: string = typeof body.ts === "string" ? body.ts : new Date().toISOString();
  const tz: string = typeof body.tz === "string" ? body.tz : "Europe/Berlin";

  const bbox: [number, number, number, number] | null =
    Array.isArray(body.bbox) && body.bbox.length === 4
      ? [
          Number(body.bbox[0]),
          Number(body.bbox[1]),
          Number(body.bbox[2]),
          Number(body.bbox[3]),
        ]
      : null;

  // Saubere Numerik-Parsing-Helfer
  const asNumberOrNull = (v: any) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const asNumberOrDefault = (v: any, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;

  const buffer_m: number = asNumberOrDefault(body.buffer_m, 10);
  const simplify_m: number = asNumberOrDefault(body.simplify_m, 5);
  const min_area_m2: number = asNumberOrDefault(body.min_area_m2, 20);
  const max_polygons: number = asNumberOrDefault(body.max_polygons, 200);

  const veh_width_m  = asNumberOrNull(body.vehicle?.width_m);
  const veh_height_m = asNumberOrNull(body.vehicle?.height_m);
  const veh_weight_t = asNumberOrNull(body.vehicle?.weight_t);
  const veh_axle_t   = asNumberOrNull(body.vehicle?.axleload_t);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return NextResponse.json(
      { error: "Supabase credentials missing" },
      { status: 500 }
    );
  }

  const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/get_active_restrictions_fc`;

  // Wichtig: Parameternamen exakt wie in der SQL-Funktion
  const payload = {
    _ts: ts,
    _tz: tz,
    _bbox: bbox ? wktFromBbox(bbox) : null,
    _max_polygons: max_polygons,
    _buffer_m: buffer_m,
    _simplify_m: simplify_m,
    _min_area_m2: min_area_m2,
    _veh_width_m: veh_width_m,
    _veh_height_m: veh_height_m,
    _veh_weight_t: veh_weight_t,
    _veh_axle_t: veh_axle_t,
  };

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
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // falls Supabase mal kein JSON zurückgibt
  }

  if (!r.ok) {
    return NextResponse.json(
      {
        error: parsed?.error || parsed?.message || text,
        status: r.status,
        supabase_payload: payload, // hilft beim Debuggen
      },
      { status: 500 }
    );
  }

  const fc = parsed; // jsonb FeatureCollection direkt aus der Funktion
  return NextResponse.json({
    meta: {
      ts,
      tz,
      buffer_m,
      simplify_m,
      min_area_m2,
      max_polygons,
      vehicle: {
        width_m: veh_width_m,
        height_m: veh_height_m,
        weight_t: veh_weight_t,
        axleload_t: veh_axle_t,
      },
      bbox,
    },
    geojson: fc,
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    usage:
      "POST {ts?, tz?, bbox:[minX,minY,maxX,maxY], buffer_m?, simplify_m?, min_area_m2?, max_polygons?, vehicle:{width_m?,height_m?,weight_t?,axleload_t?}}",
  });
}