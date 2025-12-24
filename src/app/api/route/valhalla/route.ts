// src/app/api/route/valhalla/route.ts
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Coords = [number, number];
type VehicleSpec = {
  width_m?: number;
  height_m?: number;
  weight_t?: number;
  axleload_t?: number;
};

// --- Polyline6 decoder (Valhalla uses polyline6 by default)
function decodePolyline6(str: string): [number, number][] {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates: [number, number][] = [];

  const nextValue = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
    return delta;
  };

  while (index < str.length) {
    lat += nextValue();
    lon += nextValue();
    // 1e6 because polyline6
    coordinates.push([lon / 1e6, lat / 1e6]);
  }

  return coordinates;
}

function toFeatureLine(coords: [number, number][], properties: any = {}) {
  return {
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: coords },
    properties,
  };
}

function valhallaToGeoJSON(response: any) {
  const trip = response?.trip;
  if (!trip) return { type: "FeatureCollection" as const, features: [] as any[] };

  const legs = trip?.legs || [];
  const features: any[] = [];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const shape: string | undefined = leg?.shape;

    // Valhalla sometimes returns "shape" + "shape_format". We assume polyline6.
    const coords = shape ? decodePolyline6(shape) : [];
    features.push(
      toFeatureLine(coords, {
        leg_index: i,
        summary: leg?.summary ?? null,
        maneuvers: leg?.maneuvers ?? [],
      }),
    );
  }

  return { type: "FeatureCollection" as const, features };
}

// --- Normalize incoming avoid polygons to GeoJSON geometries (Polygon / MultiPolygon)
type GeoJSONGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

function isPolyGeom(g: any): g is GeoJSONGeometry {
  return (
    g &&
    (g.type === "Polygon" || g.type === "MultiPolygon") &&
    Array.isArray(g.coordinates)
  );
}

function collectGeoms(input: any): GeoJSONGeometry[] {
  const out: GeoJSONGeometry[] = [];

  const pushGeom = (g: any) => {
    if (isPolyGeom(g)) out.push(g);
  };

  if (!input) return out;

  // 1) Array of geometries/features
  if (Array.isArray(input)) {
    for (const x of input) {
      if (isPolyGeom(x)) pushGeom(x);
      else if (x?.geometry) pushGeom(x.geometry);
    }
    return out;
  }

  // 2) FeatureCollection
  if (input?.type === "FeatureCollection" && Array.isArray(input.features)) {
    for (const f of input.features) pushGeom(f?.geometry);
    return out;
  }

  // 3) Single Feature
  if (input?.type === "Feature" && input?.geometry) {
    pushGeom(input.geometry);
    return out;
  }

  // 4) Single geometry
  pushGeom(input);
  return out;
}

function buildValhallaRequest(
  start: Coords,
  end: Coords,
  v: VehicleSpec,
  options: {
    exclude_polygons?: GeoJSONGeometry[];
    directions_language?: string;
    alternates?: number;
  } = {},
) {
  const costing = "truck";
  const hasExcludes =
    Array.isArray(options.exclude_polygons) && options.exclude_polygons.length > 0;

  const truckCosting: any = {
    width: v.width_m ?? 2.55,
    height: v.height_m ?? 4.0,
    weight: (v.weight_t ?? 40) * 1000,
    axle_load: (v.axleload_t ?? 10) * 1000,

    // Autobahn stark bevorzugen
    use_highways: 1.0,
    shortest: false,

    // Bei Excludes: Detour erzwingen, aber nicht "Request kaputt" machen
    maneuver_penalty: hasExcludes ? 2000 : 5,
    gate_penalty: hasExcludes ? 10_000_000 : 300,
    service_penalty: hasExcludes ? 10_000_000 : 0,

    country_crossing_penalty: 0,
    hazmat: true,
  };

  const json: any = {
    locations: [
      { lon: start[0], lat: start[1] },
      { lon: end[0], lat: end[1] },
    ],
    costing,
    costing_options: { truck: truckCosting },
    directions_options: {
      language: options.directions_language || "de-DE",
      units: "kilometers",
    },
    alternates: options.alternates ?? 1,
  };

  // IMPORTANT:
  // Different Valhalla builds/clients vary; we set BOTH keys defensively.
  if (hasExcludes) {
    json.exclude_polygons = options.exclude_polygons;
    json.avoid_polygons = options.exclude_polygons;
  }

  return json;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as any;

  const start: Coords = body.start ?? [6.96, 50.94];
  const end: Coords = body.end ?? [8.68, 50.11];
  const vehicle: VehicleSpec = body.vehicle ?? {};

  // Accept body.avoid_polygons in many shapes (array, FeatureCollection, Feature, geometry)
  const geoms = collectGeoms(body.avoid_polygons);

  const valhallaURL = process.env.VALHALLA_URL || "http://localhost:8002/route";
  const requestJson = buildValhallaRequest(start, end, vehicle, {
    exclude_polygons: geoms,
    directions_language: body.directions_language || "de-DE",
    alternates: body.alternates,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const vr = await fetch(valhallaURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestJson),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Always return JSON (prevents "Unexpected token ..." in the browser)
    if (!vr.ok) {
      const text = await vr.text().catch(() => "");
      return NextResponse.json(
        { error: text || "Valhalla request failed", status: vr.status, request_had_excludes: geoms.length > 0 },
        { status: 500 },
      );
    }

    const parsed = await vr.json();
    const fc = valhallaToGeoJSON(parsed);

    return NextResponse.json({
      exclude_count: geoms.length,
      geojson: fc,
      raw: body.debug_raw ? parsed : undefined,
    });
  } catch (e: any) {
    clearTimeout(timeout);
    return NextResponse.json(
      { error: String(e), type: "FetchError", request_had_excludes: geoms.length > 0 },
      { status: 500 },
    );
  }
}
