// src/app/api/route/valhalla/route.ts
import { NextRequest, NextResponse } from "next/server";

/**
 * Reliable wrapper around Valhalla's /route.
 * Always returns JSON (never plain-text errors), so the frontend never crashes on JSON.parse().
 *
 * Expected input (minimal):
 * {
 *   start: [lon, lat],
 *   end:   [lon, lat],
 *   vehicle: { width_m?: number, height_m?: number, weight_t?: number, axleload_t?: number },
 *   options?: {
 *     alternatives?: number,
 *     directions_language?: string,
 *     avoid_polygons?: GeoJSON.Polygon[],
 *     exclude_polygons?: GeoJSON.Polygon[],
 *     soft_avoid?: boolean,
 *     avoid_penalty_s?: number
 *   }
 * }
 */

type LonLat = [number, number];

type Vehicle = {
  width_m?: number;
  height_m?: number;
  weight_t?: number;
  axleload_t?: number;
};

type ValhallaOptions = {
  alternatives?: number;
  directions_language?: string;
  avoid_polygons?: any[]; // GeoJSON Polygons
  exclude_polygons?: any[]; // GeoJSON Polygons
  soft_avoid?: boolean;
  avoid_penalty_s?: number;
};

function decodePolyline6(str: string): LonLat[] {
  // Valhalla returns polyline6 in trip.legs[*].shape.
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coords: LonLat[] = [];

  while (index < str.length) {
    let b: number;
    let shift = 0;
    let result = 0;

    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlat = (result & 1) ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;

    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlon = (result & 1) ? ~(result >> 1) : result >> 1;
    lon += dlon;

    coords.push([lon / 1e6, lat / 1e6]);
  }

  return coords;
}

function valhallaToGeoJSON(valhalla: any) {
  const shape: string | undefined = valhalla?.trip?.legs?.[0]?.shape;
  if (!shape) {
    return {
      type: "FeatureCollection",
      features: [],
    };
  }

  const coordinates = decodePolyline6(shape);
  const maneuvers =
    valhalla?.trip?.legs?.[0]?.maneuvers?.map((m: any) => ({
      instruction: m.instruction,
      distance_km: m.length,
      duration_s: m.time,
      street_names: Array.isArray(m.street_names) ? m.street_names : [],
    })) ?? [];

  const summary = {
    distance_km: valhalla?.trip?.summary?.length ?? null,
    duration_s: valhalla?.trip?.summary?.time ?? null,
  };

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: { leg_index: 0, summary, maneuvers },
      },
    ],
  };
}

function buildValhallaRequest(
  start: LonLat,
  end: LonLat,
  vehicle: Vehicle,
  opts: ValhallaOptions
) {
  const {
    alternatives = 1,
    directions_language = "de-DE",
    avoid_polygons = [],
    exclude_polygons = [],
    soft_avoid = true,
    avoid_penalty_s = 900, // 15 minutes; strong but still routable
  } = opts;

  const costingOptions: any = {
    truck: {
      width: vehicle.width_m,
      height: vehicle.height_m,
      weight: vehicle.weight_t,
      axle_load: vehicle.axleload_t,
    },
  };

  // Soft avoids => strong penalties, but do not hard-fail early.
  if (soft_avoid && (avoid_polygons.length || exclude_polygons.length)) {
    costingOptions.truck.use_highways = 0.6; // slightly reduce highway preference, improves detours
    costingOptions.truck.use_tolls = 0.8;
    costingOptions.truck.use_ferry = 0.8;
    costingOptions.truck.use_tracks = 0.2;
    // Not guaranteed in every Valhalla build; harmless if ignored.
    costingOptions.truck.avoid_penalty = avoid_penalty_s;
  }

  const req: any = {
    locations: [
      { lon: start[0], lat: start[1], type: "break" },
      { lon: end[0], lat: end[1], type: "break" },
    ],
    costing: "truck",
    costing_options: costingOptions,
    directions_options: { language: directions_language },
    alternatives,
  };

  if (avoid_polygons?.length) req.avoid_polygons = avoid_polygons;
  if (exclude_polygons?.length) req.exclude_polygons = exclude_polygons;

  return req;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const start: LonLat = body?.start;
    const end: LonLat = body?.end;
    const vehicle: Vehicle = body?.vehicle ?? {};
    const options: ValhallaOptions = body?.options ?? {};

    if (!Array.isArray(start) || start.length !== 2 || !Array.isArray(end) || end.length !== 2) {
      return NextResponse.json(
        { error: "Invalid input: start/end must be [lon,lat]." },
        { status: 400 }
      );
    }

    const valhallaURL = process.env.VALHALLA_URL || "http://localhost:8002/route";
    const requestJson = buildValhallaRequest(start, end, vehicle, options);

    const vr = await fetchWithTimeout(
      valhallaURL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestJson),
      },
      8000
    );

    const rawText = await vr.text();
    let parsed: any = null;

    try {
      parsed = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        {
          error: "VALHALLA_NON_JSON_RESPONSE",
          status: vr.status,
          raw: rawText?.slice(0, 2000),
        },
        { status: 502 }
      );
    }

    if (!vr.ok) {
      return NextResponse.json(
        {
          error: "VALHALLA_ERROR",
          status: vr.status,
          valhalla: parsed,
        },
        { status: 502 }
      );
    }

    const geojson = valhallaToGeoJSON(parsed);

    return NextResponse.json(
      {
        ok: true,
        geojson,
        raw: parsed,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: "VALHALLA_ROUTE_HANDLER_ERROR", message: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
