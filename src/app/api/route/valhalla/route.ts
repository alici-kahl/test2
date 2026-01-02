import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Coords = [number, number];

type VehicleSpec = {
  width_m?: number;
  height_m?: number;
  weight_t?: number;
  axleload_t?: number;
  hazmat?: boolean; // <-- WICHTIG: nicht erzwingen, sondern vom Client übernehmen
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
  const trip = response?.trip;
  if (!trip) return { type: "FeatureCollection", features: [] as any[] };

  const features: any[] = [];
  (trip.legs || []).forEach((leg: any, idx: number) => {
    const coords = decodePolyline6(leg.shape || "");
    const summary = leg.summary || {};
    const props: any = {
      leg_index: idx,
      summary: {
        // Valhalla length ist i.d.R. km (mit units=kilometers)
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

function buildValhallaRequest(
  start: Coords,
  end: Coords,
  v: VehicleSpec,
  options: {
    avoid_polygons?: any[];
    directions_language?: string;
    alternates?: number;
    // NEU: Radius-Fallback (in Metern). Wenn gesetzt, routet Valhalla zu einem Punkt
    // innerhalb dieses Radius (stabilisiert "No path could be found" bei Truck).
    start_radius_m?: number;
    end_radius_m?: number;
  } = {}
) {
  const costing = "truck";
  const hasAvoids =
    Array.isArray(options.avoid_polygons) && options.avoid_polygons.length > 0;

  const truckCosting: any = {
    width: v.width_m ?? 2.55,
    height: v.height_m ?? 4.0,

    // Valhalla erwartet kg
    weight: (v.weight_t ?? 40) * 1000,
    axle_load: (v.axleload_t ?? 10) * 1000,

    // Nur wenn Avoids aktiv sind, erhöhen wir die „Strafen“, sonst normal routen lassen
    use_highways: hasAvoids ? 0.7 : 1.0,
    shortest: false,

    maneuver_penalty: hasAvoids ? 250 : 5,
    gate_penalty: hasAvoids ? 50_000 : 300,
    service_penalty: hasAvoids ? 50_000 : 0,

    // WICHTIG: Hazmat NICHT erzwingen.
    // Wenn hazmat=true, kann Valhalla sehr schnell „NO path“ liefern (dein Problem bei langen Strecken).
    hazmat: Boolean(v.hazmat),
  };

  // radius direkt in locations (Valhalla unterstützt radius pro Location)
  const startLoc: any = { lon: start[0], lat: start[1], type: "break" };
  if (
    typeof options.start_radius_m === "number" &&
    Number.isFinite(options.start_radius_m) &&
    options.start_radius_m > 0
  ) {
    startLoc.radius = options.start_radius_m;
  }

  const endLoc: any = { lon: end[0], lat: end[1], type: "break" };
  if (
    typeof options.end_radius_m === "number" &&
    Number.isFinite(options.end_radius_m) &&
    options.end_radius_m > 0
  ) {
    endLoc.radius = options.end_radius_m;
  }

  const json: any = {
    locations: [startLoc, endLoc],
    costing,
    costing_options: { truck: truckCosting },
    directions_options: {
      language: options.directions_language || "de-DE",
      units: "kilometers",
    },
    alternates: options.alternates ?? 1,
  };

  if (hasAvoids) {
    // beide Keys setzen (kompatibel)
    json.avoid_polygons = options.avoid_polygons;
    json.exclude_polygons = options.avoid_polygons;
  }

  return json;
}

/**
 * Valhalla-Fetch mit Timeout + stabiler Fehlerausgabe
 */
async function fetchValhallaJson(
  url: string,
  requestJson: any,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; json: any | null; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const vr = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestJson),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const status = vr.status;

    // Versuch: JSON
    const text = await vr.text().catch(() => "");
    let parsed: any | null = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    return {
      ok: vr.ok,
      status,
      json: parsed,
      text,
    };
  } catch (e: any) {
    clearTimeout(timeout);
    return {
      ok: false,
      status: 0,
      json: null,
      text: String(e),
    };
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as any;
  const start: Coords = body.start ?? [6.96, 50.94];
  const end: Coords = body.end ?? [8.68, 50.11];
  const vehicle: VehicleSpec = body.vehicle ?? {};

  // Radius-Parameter (in Metern) aus dem Body
  const start_radius_m =
    typeof body.start_radius_m === "number" ? body.start_radius_m : undefined;
  const end_radius_m =
    typeof body.end_radius_m === "number" ? body.end_radius_m : undefined;

  const geoms: any[] = [];
  const pushGeom = (x: any) => {
    if (!x) return;
    if (x.type === "Polygon" || x.type === "MultiPolygon") geoms.push(x);
    else if (x.geometry) geoms.push(x.geometry);
  };

  // akzeptiere beide keys
  const srcAvoid = body.avoid_polygons ?? body.exclude_polygons;
  if (srcAvoid) {
    if (Array.isArray(srcAvoid)) srcAvoid.forEach(pushGeom);
    else if (srcAvoid.features) srcAvoid.features.forEach((f: any) => pushGeom(f));
  }

  const valhallaURL = process.env.VALHALLA_URL || "http://localhost:8002/route";

  // ------------------------------------------------------------
  // ROBUSTE STRATEGIE FÜR LANGE STRECKEN:
  // 1) Route mit allen Avoids
  // 2) Falls scheitert/zu langsam: Route mit reduzierten Avoids (Top N)
  // 3) Falls immer noch scheitert: Fallback ohne Avoids (aber meta zeigt das!)
  // ------------------------------------------------------------

  const timeoutMs =
    typeof body.valhalla_timeout_ms === "number" && body.valhalla_timeout_ms > 0
      ? body.valhalla_timeout_ms
      : 30_000;

  // Bei sehr vielen Avoid-Polygonen wird Valhalla oft extrem langsam (oder NO PATH).
  // Deshalb: „Top N“ als Rettungsanker.
  const MAX_AVOIDS =
    typeof body.max_avoids === "number" && body.max_avoids > 0
      ? Math.floor(body.max_avoids)
      : 120;

  const avoidAll = geoms;
  const avoidReduced = geoms.length > MAX_AVOIDS ? geoms.slice(0, MAX_AVOIDS) : geoms;

  const baseOptions = {
    directions_language: body.directions_language || "de-DE",
    alternates: body.alternates,
    start_radius_m,
    end_radius_m,
  };

  // Versuch A: volle Avoids
  const reqA = buildValhallaRequest(start, end, vehicle, {
    ...baseOptions,
    avoid_polygons: avoidAll,
  });

  // Versuch B: reduzierte Avoids
  const reqB = buildValhallaRequest(start, end, vehicle, {
    ...baseOptions,
    avoid_polygons: avoidReduced,
  });

  // Versuch C: ohne Avoids (Fallback)
  const reqC = buildValhallaRequest(start, end, vehicle, {
    ...baseOptions,
    avoid_polygons: [],
  });

  const meta: any = {
    source: "valhalla",
    avoid_requested: geoms.length, // was kam rein?
    avoid_applied: 0, // was wurde effektiv für den finalen Run genutzt?
    reduced_avoids: false,
    fallback_used: false,
    phase: "A",
    error: null as string | null,
    valhalla_http_status: null as number | null,
    valhalla_trip_status: null as any,
  };

  // Helper: prüft, ob Valhalla „wirklich“ OK ist
  const isTripOk = (parsed: any) => {
    const st = parsed?.trip?.status;
    // Valhalla: status 0 = OK
    return st === 0 || st === "0";
  };

  // --- Phase A
  let r = await fetchValhallaJson(valhallaURL, reqA, timeoutMs);
  meta.valhalla_http_status = r.status ?? null;
  meta.valhalla_trip_status = r.json?.trip?.status ?? null;

  if (r.ok && r.json && isTripOk(r.json)) {
    meta.avoid_applied = avoidAll.length;
    const fc = valhallaToGeoJSON(r.json);
    return NextResponse.json({ meta, geojson: fc });
  }

  // --- Phase B (reduziert), nur wenn wir wirklich Avoids hatten
  if (avoidAll.length > 0) {
    meta.phase = "B";
    meta.reduced_avoids = avoidReduced.length !== avoidAll.length;

    r = await fetchValhallaJson(valhallaURL, reqB, timeoutMs);
    meta.valhalla_http_status = r.status ?? null;
    meta.valhalla_trip_status = r.json?.trip?.status ?? null;

    if (r.ok && r.json && isTripOk(r.json)) {
      meta.avoid_applied = avoidReduced.length;
      const fc = valhallaToGeoJSON(r.json);
      return NextResponse.json({ meta, geojson: fc });
    }
  }

  // --- Phase C (Fallback ohne Avoids)
  meta.phase = "C";
  meta.fallback_used = true;

  r = await fetchValhallaJson(valhallaURL, reqC, timeoutMs);
  meta.valhalla_http_status = r.status ?? null;
  meta.valhalla_trip_status = r.json?.trip?.status ?? null;

  if (r.ok && r.json && isTripOk(r.json)) {
    meta.avoid_applied = 0;
    // Wichtig: hier setzen wir einen klaren Fehlerhinweis, warum wir fallbacken mussten
    meta.error =
      (typeof r.text === "string" && r.text && r.text.slice(0, 300)) ||
      "Fallback ohne Avoids (Phase A/B schlug fehl oder war zu langsam).";
    const fc = valhallaToGeoJSON(r.json);
    return NextResponse.json({ meta, geojson: fc });
  }

  // Wenn wirklich gar nichts geht: trotzdem JSON liefern (kein HTML/Text!)
  meta.error =
    (r.text && String(r.text).slice(0, 500)) ||
    "Valhalla Fehler / keine Route (auch Fallback ohne Avoids fehlgeschlagen).";

  return NextResponse.json(
    {
      meta,
      geojson: { type: "FeatureCollection", features: [] },
    },
    { status: 200 }
  );
}
