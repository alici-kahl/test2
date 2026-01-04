import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Coords = [number, number];

type VehicleSpec = {
  width_m?: number;
  height_m?: number;
  weight_t?: number;
  axleload_t?: number;
  hazmat?: boolean;
};

function decodePolyline6(str: string): [number, number][] {
  let index = 0,
    lat = 0,
    lng = 0;
  const coordinates: [number, number][] = [];
  const shiftAndMask = () => {
    let result = 0,
      shift = 0,
      b: number;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < str.length) {
    lat += shiftAndMask();
    lng += shiftAndMask();
    coordinates.push([lng / 1e6, lat / 1e6]);
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
  const trip = response?.trip ?? response;
  if (!trip) return { type: "FeatureCollection", features: [] as any[] };

  const features: any[] = [];
  (trip.legs || []).forEach((leg: any, idx: number) => {
    const coords = decodePolyline6(leg.shape || "");
    const summary = leg.summary || {};
    const props: any = {
      leg_index: idx,
      summary: {
        distance_km: Number(summary.length || 0),
        duration_s: Number(summary.time || 0),
      },
      maneuvers: (leg.maneuvers || []).map((m: any) => ({
        instruction: m.instruction,
        distance_km: Number(m.length || 0),
        duration_s: Number(m.time || 0),
        street_names: m.street_names || [],
      })),
      streets_sequence: (leg.maneuvers || [])
        .flatMap((m: any) => m.street_names || [])
        .filter(Boolean),
    };
    features.push(toFeatureLine(coords, props));
  });

  return { type: "FeatureCollection" as const, features };
}

function haversineKm(a: Coords, b: Coords) {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function buildValhallaRequest(
  start: Coords,
  end: Coords,
  v: VehicleSpec,
  options: {
    avoid_polygons?: any[];
    directions_language?: string;
    alternates?: number;
    start_radius_m?: number;
    end_radius_m?: number;
    escape_mode?: boolean;
  } = {}
) {
  const costing = "truck";
  const hasAvoids =
    Array.isArray(options.avoid_polygons) && options.avoid_polygons.length > 0;

  const escape = Boolean(options.escape_mode) || hasAvoids;

  const truckCosting: any = {
    width: v.width_m ?? 2.55,
    height: v.height_m ?? 4.0,
    weight: (v.weight_t ?? 40) * 1000,
    axle_load: (v.axleload_t ?? 10) * 1000,

    use_highways: escape ? 0.15 : 1.0,
    shortest: escape ? true : false,

    maneuver_penalty: escape ? 30 : 5,
    gate_penalty: escape ? 5_000 : 300,
    service_penalty: escape ? 2_000 : 0,

    hazmat: Boolean(v.hazmat),
  };

  const startLoc: any = { lon: start[0], lat: start[1], type: "break" };
  if (Number.isFinite(options.start_radius_m) && (options.start_radius_m as number) > 0) {
    startLoc.radius = options.start_radius_m;
  }

  const endLoc: any = { lon: end[0], lat: end[1], type: "break" };
  if (Number.isFinite(options.end_radius_m) && (options.end_radius_m as number) > 0) {
    endLoc.radius = options.end_radius_m;
  }

  const alternates =
    options.alternates != null ? options.alternates : escape ? 3 : 1;

  const json: any = {
    locations: [startLoc, endLoc],
    costing,
    costing_options: { truck: truckCosting },
    directions_options: {
      language: options.directions_language || "de-DE",
      units: "kilometers",
    },
    alternates,
  };

  if (hasAvoids) {
    json.avoid_polygons = options.avoid_polygons;
    json.exclude_polygons = options.avoid_polygons;
  }

  return json;
}

function buildMeta(parsed: any, avoidCount: number, extra?: any) {
  const trip = parsed?.trip;
  const status = trip?.status;
  const statusMessage =
    trip?.status_message ??
    parsed?.status_message ??
    parsed?.error ??
    parsed?.message ??
    null;

  const ok = status === 0;

  return {
    ok,
    avoid_count: avoidCount,
    raw_status: status ?? null,
    raw_status_message: statusMessage,
    has_trip: Boolean(trip),
    has_alternates: Array.isArray(parsed?.alternates) && parsed.alternates.length > 0,
    ...extra,
  };
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as any;
  const start: Coords = body.start ?? [6.96, 50.94];
  const end: Coords = body.end ?? [8.68, 50.11];
  const vehicle: VehicleSpec = body.vehicle ?? {};

  let start_radius_m =
    typeof body.start_radius_m === "number" ? body.start_radius_m : undefined;
  let end_radius_m =
    typeof body.end_radius_m === "number" ? body.end_radius_m : undefined;

  const distKm = haversineKm(start, end);
  if (distKm >= 80) {
    if (start_radius_m == null) start_radius_m = 200;
    if (end_radius_m == null) end_radius_m = 300;
  }

  const geoms: any[] = [];
  const pushGeom = (x: any) => {
    if (!x) return;
    if (x.type === "Polygon" || x.type === "MultiPolygon") geoms.push(x);
    else if (x.geometry) geoms.push(x.geometry);
  };

  const srcAvoid = body.avoid_polygons ?? body.exclude_polygons;
  if (srcAvoid) {
    if (Array.isArray(srcAvoid)) srcAvoid.forEach(pushGeom);
    else if (srcAvoid.features) srcAvoid.features.forEach((f: any) => pushGeom(f));
  }

  const valhallaURL = process.env.VALHALLA_URL || "http://localhost:8002/route";

  const requestJson = buildValhallaRequest(start, end, vehicle, {
    avoid_polygons: geoms,
    directions_language: body.directions_language || "de-DE",
    alternates: body.alternates,
    start_radius_m,
    end_radius_m,
    escape_mode: Boolean(body.escape_mode),
  });

  const controller = new AbortController();

  // ✅ KRITISCHER FIX:
  // In Serverless darf das NICHT 45s default sein.
  // Default 12s, Hard-Cap 20s.
  const requested =
    typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : 12_000;
  const timeoutMs = Math.min(requested, 20_000);

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const vr = await fetch(valhallaURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestJson),
      signal: controller.signal,
      cache: "no-store",
    });

    const rawText = await vr.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!vr.ok) {
      return NextResponse.json(
        {
          meta: buildMeta(parsed, geoms.length, {
            ok: false,
            raw_http_status: vr.status,
            timeout_ms_used: timeoutMs,
          }),
          geojson: { type: "FeatureCollection", features: [] },
          geojson_alts: [] as any[],
        },
        { status: 200 }
      );
    }

    if (!parsed) {
      return NextResponse.json(
        {
          meta: {
            ok: false,
            avoid_count: geoms.length,
            raw_http_status: vr.status,
            raw_status: null,
            raw_status_message: rawText || "Valhalla: Leere/ungültige Antwort",
            has_trip: false,
            has_alternates: false,
            timeout_ms_used: timeoutMs,
          },
          geojson: { type: "FeatureCollection", features: [] },
          geojson_alts: [] as any[],
        },
        { status: 200 }
      );
    }

    const fc = valhallaToGeoJSON(parsed);
    const altsRaw = Array.isArray(parsed?.alternates) ? parsed.alternates : [];
    const geojson_alts = altsRaw.map((alt: any) => valhallaToGeoJSON({ trip: alt }));

    return NextResponse.json({
      meta: buildMeta(parsed, geoms.length, { timeout_ms_used: timeoutMs }),
      geojson: fc,
      geojson_alts,
    });
  } catch (e: any) {
    const msg = String(e);
    const isAbort =
      e?.name === "AbortError" || msg.toLowerCase().includes("abort");

    return NextResponse.json(
      {
        meta: {
          ok: false,
          avoid_count: geoms.length,
          raw_http_status: null,
          raw_status: null,
          raw_status_message: isAbort ? "VALHALLA_TIMEOUT" : msg,
          has_trip: false,
          has_alternates: false,
          timeout_ms_used: timeoutMs,
        },
        geojson: { type: "FeatureCollection", features: [] },
        geojson_alts: [] as any[],
      },
      { status: 200 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
