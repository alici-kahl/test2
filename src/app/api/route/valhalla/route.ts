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

type ValhallaLocation = { lon: number; lat: number };

function decodePolyline6(str: string): [number, number][] {
  let index = 0, lat = 0, lng = 0;
  const coordinates: [number, number][] = [];
  const shiftAndMask = () => {
    let result = 0, shift = 0, b: number;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };
  while (index < str.length) {
    lat += shiftAndMask();
    lng += shiftAndMask();
    coordinates.push([lng / 1e6, lat / 1e6]);
  }
  return coordinates;
}

function toFeatureLine(coords: [number, number][], properties: any = {}) {
  return { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: coords }, properties };
}

function valhallaToGeoJSON(response: any) {
  const trip = response?.trip;
  if (!trip) return { type: "FeatureCollection", features: [] };
  const features: any[] = [];
  (trip.legs || []).forEach((leg: any, idx: number) => {
    const coords = decodePolyline6(leg.shape || "");
    const summary = leg.summary || {};
    const props: any = {
      leg_index: idx,
      summary: { distance_km: Number(summary.length || 0), duration_s: Number(summary.time || 0) },
      maneuvers: (leg.maneuvers || []).map((m: any) => ({
        instruction: m.instruction,
        distance_km: Number(m.length || 0),
        duration_s: Number(m.time || 0),
        street_names: m.street_names || [],
      })),
      streets_sequence: (leg.maneuvers || []).flatMap((m: any) => m.street_names || []).filter(Boolean),
    };
    features.push(toFeatureLine(coords, props));
  });
  return { type: "FeatureCollection" as const, features };
}

function buildValhallaRequest(
  start: Coords,
  end: Coords,
  v: VehicleSpec,
  options: { avoid_polygons?: any[]; directions_language?: string; alternates?: number; } = {}
) {
  const costing = "truck";
  const hasAvoids = options.avoid_polygons && options.avoid_polygons.length > 0;

  // DYNAMISCHE KOSTEN:
  // Wenn Avoids da sind -> Atombombe (Penalty hoch)
  // Wenn keine Avoids -> Standard (Schnellste Route)
  const truckCosting: any = {
    width: v.width_m ?? 2.55,
    height: v.height_m ?? 4.0,
    weight: (v.weight_t ?? 40) * 1000,
    axle_load: (v.axleload_t ?? 10) * 1000,
    use_highways: 1.0,
    shortest: false, // Bevorzugt schnellste Route

    // Wenn wir ausweichen müssen, machen wir Hindernisse "unpassierbar".
    // Sonst lassen wir Valhalla normal rechnen.
    maneuver_penalty: hasAvoids ? 2000 : 5,
    gate_penalty: hasAvoids ? 10000000 : 300,
    service_penalty: hasAvoids ? 10000000 : 0,
    country_crossing_penalty: 0,
    hazmat: true, 
  };

  const json: any = {
    locations: [{ lon: start[0], lat: start[1] }, { lon: end[0], lat: end[1] }],
    costing,
    costing_options: { truck: truckCosting },
    directions_options: {
      language: options.directions_language || "de-DE",
      units: "kilometers",
    },
    alternates: options.alternates ?? 1,
  };

  if (hasAvoids) {
    json.avoid_polygons = options.avoid_polygons;
    json.exclude_polygons = options.avoid_polygons; 
  }

  return json;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as any;
  const start: Coords = body.start ?? [6.96, 50.94];
  const end: Coords = body.end ?? [8.68, 50.11];
  const vehicle: VehicleSpec = body.vehicle ?? {};
  
  const geoms: any[] = [];
  const pushGeom = (x: any) => {
    if(!x) return;
    if(x.type === "Polygon" || x.type === "MultiPolygon") geoms.push(x);
    else if(x.geometry) geoms.push(x.geometry);
  };
  
  if (body.avoid_polygons) {
      if(Array.isArray(body.avoid_polygons)) body.avoid_polygons.forEach(pushGeom);
      else if(body.avoid_polygons.features) body.avoid_polygons.features.forEach((f: any) => pushGeom(f));
  }

  const valhallaURL = process.env.VALHALLA_URL || "http://localhost:8002/route";
  const requestJson = buildValhallaRequest(start, end, vehicle, {
    avoid_polygons: geoms,
    directions_language: body.directions_language || "de-DE",
    alternates: body.alternates
  });

  // Längeres Timeout (Abbruchsignal)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000); // 45 Sekunden

  try {
    const vr = await fetch(valhallaURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestJson),
        signal: controller.signal
    });
    clearTimeout(timeout);

    if (!vr.ok) {
        const text = await vr.text();
        return NextResponse.json({ error: text, status: vr.status }, { status: 500 });
    }
    const parsed = await vr.json();
    const fc = valhallaToGeoJSON(parsed);
    return NextResponse.json({ avoid_count: geoms.length, geojson: fc });

  } catch (e: any) {
      clearTimeout(timeout);
      return NextResponse.json({ error: String(e), type: "FetchError" }, { status: 500 });
  }
}