import { NextResponse } from "next/server";

type Coords = [number, number]; // [lon, lat]

type VehicleSpec = {
  width_m?: number;
  height_m?: number;
  length_m?: number;
  weight_kg?: number;
  axle_load_kg?: number;
  hazmat?: boolean;
};

function buildValhallaRequest(
  start: Coords,
  end: Coords,
  v: VehicleSpec,
  options: {
    avoid_polygons?: any[];
    directions_language?: string;
    alternates?: number;
  } = {}
) {
  const costing = "truck";
  const hasAvoids = Array.isArray(options.avoid_polygons) && options.avoid_polygons.length > 0;

  const truckCosting: any = {
    width: v.width_m ?? 2.55,
    height: v.height_m ?? 4.0,
    length: v.length_m ?? 16.5,
    weight: v.weight_kg ?? 40_000,
    axle_load: v.axle_load_kg ?? 11_500,

    // Wenn Avoid-Polygone aktiv sind, wollen wir NICHT, dass Valhalla „durch“ service roads/kleine Wege flüchtet.
    // (Das ist bei dir relevant, weil du mit Avoid-GeoJSON arbeitest.)
    use_highways: 1.0,
    use_tolls: 0.5,
    use_ferry: 0.2,

    // Mit Avoids ggf. stärker bestrafen (optional, bei dir schon drin)
    service_penalty: hasAvoids ? 50_000 : 0,

    // Hazmat NICHT erzwingen – nur wenn explizit gesetzt.
    hazmat: Boolean(v.hazmat),
  };

  const json: any = {
    locations: [{ lon: start[0], lat: start[1] }, { lon: end[0], lat: end[1] }],
    costing,
    costing_options: { truck: truckCosting },
    directions_options: {
      language: options.directions_language || "de-DE",
      units: "kilometers",
    },
  };

  if (options.alternates != null) {
    json.alternates = options.alternates;
  }

  if (hasAvoids) {
    json.avoid_polygons = options.avoid_polygons;
  }

  return json;
}

/**
 * Baut aus einer Route-URL (…/route) die Base (…)
 * und daraus /locate und /route.
 */
function valhallaEndpointsFromRouteUrl(routeUrl: string) {
  // routeUrl kann z.B. "http://159.69.22.206:8002/route" sein
  // oder auch schon ohne /route – wir normalisieren.
  const u = new URL(routeUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const basePath = path.endsWith("/route") ? path.slice(0, -"/route".length) : path;

  const base = `${u.protocol}//${u.host}${basePath}`;
  return {
    base,
    locate: `${base}/locate`,
    route: `${base}/route`,
  };
}

async function snapToRoad(locateUrl: string, lon: number, lat: number): Promise<{ lon: number; lat: number }> {
  try {
    const body = { locations: [{ lon, lat }] };
    const r = await fetch(locateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    if (!r.ok) return { lon, lat };
    const j: any = await r.json();

    // Erwartet: Array mit [ { edges: [ { correlated_lon, correlated_lat, ... } ] } ]
    const edge = j?.[0]?.edges?.[0];
    const corrLon = edge?.correlated_lon;
    const corrLat = edge?.correlated_lat;

    if (typeof corrLon === "number" && typeof corrLat === "number") {
      return { lon: corrLon, lat: corrLat };
    }

    return { lon, lat };
  } catch {
    return { lon, lat };
  }
}

type ValhallaError = {
  error_code?: number;
  error?: string;
  status_code?: number;
  status?: string;
};

function isNoPathError(j: any): boolean {
  const e = j as ValhallaError;
  return e?.error_code === 442 || /no path could be found/i.test(String(e?.error ?? ""));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Erwartetes Input-Format (aus deinen bisherigen Calls):
    // {
    //   start: { lon, lat },
    //   end: { lon, lat },
    //   vehicle?: {...},
    //   avoid_polygons?: [...]
    //   directions_language?: "de-DE"
    //   alternates?: number
    // }
    const start: Coords = [body?.start?.lon, body?.start?.lat];
    const end: Coords = [body?.end?.lon, body?.end?.lat];
    const vehicle: VehicleSpec = body?.vehicle ?? {};

    if (
      !Array.isArray(start) ||
      !Array.isArray(end) ||
      typeof start[0] !== "number" ||
      typeof start[1] !== "number" ||
      typeof end[0] !== "number" ||
      typeof end[1] !== "number"
    ) {
      return NextResponse.json({ error: "Bad input: start/end missing or invalid" }, { status: 400 });
    }

    const VALHALLA_ROUTE_URL = process.env.VALHALLA_URL || "http://159.69.22.206:8002/route";
    const endpoints = valhallaEndpointsFromRouteUrl(VALHALLA_ROUTE_URL);

    // 1) Snap Start/Ziel via /locate (das ist der große Stabilitätsgewinn)
    const snappedStart = await snapToRoad(endpoints.locate, start[0], start[1]);
    const snappedEnd = await snapToRoad(endpoints.locate, end[0], end[1]);

    const requestJson = buildValhallaRequest(
      [snappedStart.lon, snappedStart.lat],
      [snappedEnd.lon, snappedEnd.lat],
      vehicle,
      {
        avoid_polygons: body?.avoid_polygons,
        directions_language: body?.directions_language,
        alternates: body?.alternates,
      }
    );

    // 2) Erst normal versuchen, dann bei 442 Radius-Fallback am ZIEL
    const radii = [0, 50, 150, 300, 600];

    let lastErrorJson: any = null;
    let lastHttpStatus = 400;

    for (const rad of radii) {
      // radius nur setzen, wenn > 0
      if (rad > 0) {
        requestJson.locations[1].radius = rad;
      } else {
        // falls vorher gesetzt (weil wir loop reusen)
        delete requestJson.locations[1].radius;
      }

      const r = await fetch(endpoints.route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestJson),
        cache: "no-store",
      });

      const j = await r.json().catch(() => null);

      if (r.ok) {
        // Erfolg
        return NextResponse.json(j, { status: 200 });
      }

      lastHttpStatus = r.status;
      lastErrorJson = j;

      // Nur bei „No path“ weiter mit Radius probieren
      if (!isNoPathError(j)) {
        break;
      }
    }

    // Wenn wir hier sind: alles fehlgeschlagen
    return NextResponse.json(
      {
        error: "Valhalla routing failed",
        detail: lastErrorJson,
        // Debug: du kannst sehen, ob locate gesnapped hat
        debug: {
          used_start: { lon: requestJson.locations[0].lon, lat: requestJson.locations[0].lat },
          used_end: { lon: requestJson.locations[1].lon, lat: requestJson.locations[1].lat, radius: requestJson.locations[1].radius ?? 0 },
          valhalla_endpoints: endpoints,
        },
      },
      { status: lastHttpStatus || 400 }
    );
  } catch (e: any) {
    return NextResponse.json({ error: "Server error", detail: String(e?.message ?? e) }, { status: 500 });
  }
}
