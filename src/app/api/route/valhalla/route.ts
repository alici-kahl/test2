// src/app/api/route/valhalla/route.ts
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
  let index = 0, lat = 0, lng = 0;
  const coordinates: [number, number][] = [];
  const shiftAndMask = () => {
    let result = 0, shift = 0, b: number;
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

function toNum(x: any): number | null {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : null;
}

function normalizeCoords(input: any): Coords | null {
  if (Array.isArray(input) && input.length >= 2) {
    const lon = toNum(input[0]);
    const lat = toNum(input[1]);
    if (lon == null || lat == null) return null;
    return [lon, lat];
  }
  if (input && typeof input === "object") {
    const lon = toNum(input.lon ?? input.lng);
    const lat = toNum(input.lat);
    if (lon == null || lat == null) return null;
    return [lon, lat];
  }
  return null;
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
    // Fahrzeugdimensionen – Valhalla prüft OSM-Tags nativ
    width:    v.width_m    ?? 2.55,
    height:   v.height_m   ?? 4.0,
    weight:   (v.weight_t  ?? 40)  * 1000,   // kg
    axle_load: (v.axleload_t ?? 10) * 1000,  // kg

    /**
     * FIX: `shortest: true` im Escape-Modus entfernt.
     * Vorher: escape_mode → shortest:true → Valhalla sucht kürzeste Route über
     * Landstraßen → extrem rechenintensiv → Timeout nach 2-3 Iterationen.
     * Jetzt: Valhalla bleibt im normalen Modus, meidet nur die Avoid-Polygone.
     *
     * FIX: use_highways weniger aggressiv.
     * Vorher: escape_mode → use_highways:0.15 → Valhalla meidet Autobahnen fast komplett.
     * Für Schwertransport ist das falsch – Autobahnen sind oft die einzige Option.
     * Jetzt: 0.6 im Escape-Modus (leichte Präferenz für Alternativen, aber Autobahn bleibt nutzbar).
     */
    use_highways: escape ? 0.6 : 1.0,
    // shortest: BEWUSST ENTFERNT – war die Hauptursache für Timeouts

    maneuver_penalty: escape ? 15 : 5,
    gate_penalty:     escape ? 2_000 : 300,
    service_penalty:  escape ? 500 : 0,

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

  const alternatesRaw =
    options.alternates != null ? options.alternates : escape ? 2 : 1;
  const alternates = Math.max(0, Math.min(15, Number(alternatesRaw) || 0));

  const json: any = {
    locations: [startLoc, endLoc],
    costing,
    costing_options: { truck: truckCosting },
    shape_format: "polyline6",
    directions_options: {
      language: options.directions_language || "de-DE",
      units: "kilometers",
    },
    alternates,
  };

  /**
   * FIX: Nur `exclude_polygons` verwenden, nicht beide parallel.
   * Vorher: avoid_polygons UND exclude_polygons gleichzeitig gesetzt.
   * Valhalla interpretiert beide unterschiedlich → inkonsistentes Verhalten + langsamere Berechnung.
   * `exclude_polygons` = harter Ausschluss, genau was wir wollen.
   */
  if (hasAvoids) {
    json.exclude_polygons = options.avoid_polygons;
    // avoid_polygons bewusst weggelassen – exclude_polygons ist der harte Ausschluss
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

function looksLikeMissingLocations(msg: any) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("required parameter 'locations'") ||
    s.includes("parameter \"locations\"") ||
    s.includes("locations")
  );
}

async function fetchValhalla(
  url: string,
  requestJson: any,
  timeoutMs: number,
  controller: AbortController
) {
  const vr = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(requestJson),
    signal: controller.signal,
    cache: "no-store",
  });
  const rawText = await vr.text().catch(() => "");
  let parsed: any = null;
  try { parsed = rawText ? JSON.parse(rawText) : null; } catch { parsed = null; }
  return { vr, rawText, parsed };
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as any;

  console.log("[VALHALLA IN]", {
    alternates:             body?.alternates,
    escape_mode:            body?.escape_mode,
    avoid_polygons_count:   Array.isArray(body?.avoid_polygons)   ? body.avoid_polygons.length   : 0,
    exclude_polygons_count: Array.isArray(body?.exclude_polygons) ? body.exclude_polygons.length : 0,
  });

  let start: Coords | null = normalizeCoords(body.start);
  let end:   Coords | null = normalizeCoords(body.end);

  if ((!start || !end) && Array.isArray(body.locations) && body.locations.length >= 2) {
    const a = body.locations[0];
    const b = body.locations[1];
    start = start ?? normalizeCoords([a?.lon ?? a?.lng, a?.lat]);
    end   = end   ?? normalizeCoords([b?.lon ?? b?.lng, b?.lat]);
  }

  /**
   * FIX: Kein stiller Fallback auf Köln/Frankfurt mehr.
   * Vorher: start = start ?? [6.96, 50.94] → falsche Route ohne Fehlermeldung.
   * Jetzt: Fehlermeldung wenn Start/End fehlen oder ungültig.
   */
  if (
    !start || !end ||
    !Number.isFinite(start[0]) || !Number.isFinite(start[1]) ||
    !Number.isFinite(end[0])   || !Number.isFinite(end[1])
  ) {
    return NextResponse.json(
      {
        meta: {
          ok: false,
          avoid_count: 0,
          raw_http_status: null,
          raw_status: null,
          raw_status_message: "INVALID_START_END: Start oder Ziel fehlen oder sind ungültig.",
          has_trip: false,
          has_alternates: false,
        },
        geojson:     { type: "FeatureCollection", features: [] },
        geojson_alts: [] as any[],
      },
      { status: 400 }
    );
  }

  const vehicle: VehicleSpec = body.vehicle ?? {};

  let start_radius_m = typeof body.start_radius_m === "number" ? body.start_radius_m : undefined;
  let end_radius_m   = typeof body.end_radius_m   === "number" ? body.end_radius_m   : undefined;

  const distKm = haversineKm(start, end);
  if (distKm >= 80) {
    if (start_radius_m == null) start_radius_m = 200;
    if (end_radius_m   == null) end_radius_m   = 300;
  }

  const geoms: any[] = [];
  const pushGeom = (x: any) => {
    if (!x) return;
    if (x.type === "Polygon" || x.type === "MultiPolygon") geoms.push(x);
    else if (
      x.geometry &&
      (x.geometry.type === "Polygon" || x.geometry.type === "MultiPolygon")
    ) geoms.push(x.geometry);
  };

  // FIX: Nur exclude_polygons als Quelle verwenden (avoid_polygons als Fallback)
  const srcAvoid = body.exclude_polygons ?? body.avoid_polygons;
  if (srcAvoid) {
    if (Array.isArray(srcAvoid)) srcAvoid.forEach(pushGeom);
    else if (srcAvoid.features) srcAvoid.features.forEach((f: any) => pushGeom(f));
  }

  const valhallaURL = process.env.VALHALLA_URL || "http://localhost:8002/route";

  const requestJson = buildValhallaRequest(start, end, vehicle, {
    avoid_polygons:     geoms,
    directions_language: body.directions_language || "de-DE",
    alternates:         body.alternates,
    start_radius_m,
    end_radius_m,
    escape_mode:        Boolean(body.escape_mode),
  });

  const controller = new AbortController();
  const requested =
    typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : 14_000;
  const timeoutMs = Math.min(requested, 22_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let { vr, rawText, parsed } = await fetchValhalla(valhallaURL, requestJson, timeoutMs, controller);

    const msg =
      parsed?.trip?.status_message ??
      parsed?.status_message ??
      parsed?.error ??
      parsed?.message ??
      rawText;

    const requestStr = JSON.stringify(requestJson);
    const canTryGetFallback = requestStr.length <= 6000 && geoms.length === 0;

    if (!vr.ok || (looksLikeMissingLocations(msg) && canTryGetFallback)) {
      if (looksLikeMissingLocations(msg) && canTryGetFallback) {
        const sep    = valhallaURL.includes("?") ? "&" : "?";
        const urlGet = `${valhallaURL}${sep}json=${encodeURIComponent(requestStr)}`;
        const vr2    = await fetch(urlGet, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
          cache: "no-store",
        });
        const rawText2 = await vr2.text().catch(() => "");
        let parsed2: any = null;
        try { parsed2 = rawText2 ? JSON.parse(rawText2) : null; } catch { parsed2 = null; }
        if (vr2.ok && parsed2) {
          vr = vr2 as any;
          rawText = rawText2;
          parsed = parsed2;
        }
      }
    }

    if (!vr.ok) {
      return NextResponse.json(
        {
          meta: buildMeta(parsed, geoms.length, { ok: false, raw_http_status: vr.status, timeout_ms_used: timeoutMs }),
          geojson:     { type: "FeatureCollection", features: [] },
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
          geojson:     { type: "FeatureCollection", features: [] },
          geojson_alts: [] as any[],
        },
        { status: 200 }
      );
    }

    const fc       = valhallaToGeoJSON(parsed);
    const altsRaw  = Array.isArray(parsed?.alternates) ? parsed.alternates : [];
    const geojson_alts = altsRaw.map((alt: any) => valhallaToGeoJSON({ trip: alt }));

    console.log("[VALHALLA OUT]", {
      ok:            true,
      features:      fc.features.length,
      alternates:    geojson_alts.length,
      avoid_count:   geoms.length,
      distance_km:   fc.features[0]?.properties?.summary?.distance_km ?? null,
    });

    return NextResponse.json({
      meta: buildMeta(parsed, geoms.length, { timeout_ms_used: timeoutMs }),
      geojson: fc,
      geojson_alts,
    });

  } catch (e: any) {
    const msg     = String(e);
    const isAbort = e?.name === "AbortError" || msg.toLowerCase().includes("abort");
    console.error("[VALHALLA ERROR]", isAbort ? "TIMEOUT" : msg);
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
        geojson:     { type: "FeatureCollection", features: [] },
        geojson_alts: [] as any[],
      },
      { status: 200 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
