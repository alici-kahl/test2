import { NextRequest, NextResponse } from "next/server";
import bboxFn from "@turf/bbox";
import { buffer, booleanIntersects, centroid, featureCollection } from "@turf/turf";
import type {
  Feature,
  FeatureCollection,
  LineString,
  Polygon,
  Geometry,
} from "geojson";

// ---------- Types ----------
type CorridorMode = "soft" | "hard" | "off";

type PlanReq = {
  start: [number, number];
  end: [number, number];
  corridor?: { mode: CorridorMode; width_m: number };
  roadworks?: { buffer_m: number; only_motorways?: boolean };
  avoid_target_max?: number;
  valhalla_soft_max?: number;
  directions_language?: string;
  respect_direction?: boolean;
  vehicle?: {
    width_m?: number;
    height_m?: number;
    weight_t?: number;
    axleload_t?: number;
  };
  ts?: string;
  tz?: string;
};

type ValhallaResult = {
  error?: string | null;
  geojson: FeatureCollection;
};

// ---------- Helpers ----------
function getLimits(p: any) {
  return {
    width_m: p?.limits?.width_m ?? p?.width_m ?? null,
    height_m: p?.limits?.height_m ?? p?.height_m ?? null,
    weight_t: p?.limits?.weight_t ?? p?.weight_t ?? null,
    axleload_t: p?.limits?.axleload_t ?? p?.axleload_t ?? null,
    hard_block: p?.limits?.hard_block ?? p?.hard_block ?? null,
  };
}

function isHardBlocked(limits: ReturnType<typeof getLimits>) {
  // Hard-block wenn:
  // - explizit hard_block true
  // - oder irgendein Limit gesetzt ist (width/height/weight/axleload)
  if (limits.hard_block === true) return true;
  if (limits.width_m != null) return true;
  if (limits.height_m != null) return true;
  if (limits.weight_t != null) return true;
  if (limits.axleload_t != null) return true;
  return false;
}

function makeSafeBBox(
  start: [number, number],
  end: [number, number],
  paddingDeg = 0.1,
) {
  const minLon = Math.min(start[0], end[0]) - paddingDeg;
  const minLat = Math.min(start[1], end[1]) - paddingDeg;
  const maxLon = Math.max(start[0], end[0]) + paddingDeg;
  const maxLat = Math.max(start[1], end[1]) + paddingDeg;
  return [minLon, minLat, maxLon, maxLat] as [number, number, number, number];
}

function createAvoidPolygonScaled(
  obs: Feature,
  kmPad: number,
): Feature<Polygon> | null {
  try {
    // buffer() erwartet km (units: kilometers)
    const buffered = buffer(obs as any, kmPad, { units: "kilometers" });
    const geom = buffered?.geometry;
    if (!geom) return null;

    // buffer() kann MultiPolygon liefern – wir nehmen Polygon, sonst erste Polygon-Teilfläche
    if (geom.type === "Polygon") {
      return buffered as Feature<Polygon>;
    }
    if (geom.type === "MultiPolygon" && geom.coordinates?.length) {
      return {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: geom.coordinates[0] as any,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

function mergePolygons(
  polys: Feature<Polygon>[],
  valhallaSoftMax: number,
  avoidTargetMax: number,
) {
  // Simpler Merge: Wenn > valhallaSoftMax, dann reduzieren wir auf avoidTargetMax
  // (genaues geometrisches Union ist hier absichtlich NICHT gemacht – Performance/Robustheit)
  if (polys.length <= valhallaSoftMax) return polys;
  const target = Math.min(avoidTargetMax, valhallaSoftMax);
  return polys.slice(0, target);
}

// ---------- API Calls ----------
async function callRestrictions(
  planReq: PlanReq,
  bbox: [number, number, number, number],
): Promise<FeatureCollection | null> {
  try {
    const url = new URL(`${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/restrictions`);
    url.searchParams.set("bbox", bbox.join(","));
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as FeatureCollection;
  } catch {
    return null;
  }
}

async function callRoadworks(
  planReq: PlanReq,
  bbox: [number, number, number, number],
): Promise<FeatureCollection | null> {
  try {
    const url = new URL(`${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/roadworks`);
    url.searchParams.set("bbox", bbox.join(","));
    url.searchParams.set(
      "buffer_m",
      String(planReq.roadworks?.buffer_m ?? 60),
    );
    url.searchParams.set(
      "only_motorways",
      String(planReq.roadworks?.only_motorways ?? true),
    );
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as FeatureCollection;
  } catch {
    return null;
  }
}

async function callValhalla(
  valhallaBody: any,
  avoidPolys: Feature<Polygon>[],
): Promise<ValhallaResult> {
  try {
    const url = new URL(
      `${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/route/valhalla`,
    );
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        ...valhallaBody,
        avoid_polygons: avoidPolys.length
          ? { type: "FeatureCollection", features: avoidPolys }
          : null,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        error: data?.error || `Valhalla error (${res.status})`,
        geojson: featureCollection([]) as any,
      };
    }

    return {
      error: data?.error ?? null,
      geojson: data?.geojson ?? featureCollection([]),
    };
  } catch (e: any) {
    return {
      error: e?.message ?? "Valhalla request failed",
      geojson: featureCollection([]) as any,
    };
  }
}

// ---------- Main ----------
export async function POST(req: NextRequest) {
  const body = await req.json();

  const start = body.start as [number, number];
  const end = body.end as [number, number];

  // bbox padding to search obstacles
  const bbox = makeSafeBBox(start, end, 0.1);

  const corridorWidth = Number(body.corridor?.width_m ?? 2000);
  const roadworksBufferM = Number(body.roadworks?.buffer_m ?? 60);

  const avoidTargetMax = Number(body.avoid_target_max ?? 120);
  const valhallaSoftMax = Number(body.valhalla_soft_max ?? 80);

  const directionsLanguage = String(body.directions_language ?? "de-DE");
  const respectDirection = Boolean(body.respect_direction ?? true);

  const vehicle = body.vehicle ?? {
    width_m: Number(body.vehicle?.width_m ?? 3),
    height_m: Number(body.vehicle?.height_m ?? 4),
    weight_t: Number(body.vehicle?.weight_t ?? 40),
    axleload_t: Number(body.vehicle?.axleload_t ?? 10),
  };

  const planReq: PlanReq = {
    start,
    end,
    corridor: body.corridor ?? { mode: "soft", width_m: corridorWidth },
    roadworks: {
      buffer_m: roadworksBufferM,
      only_motorways: true, // immer Autobahn (wie du willst)
    },
    avoid_target_max: avoidTargetMax,
    valhalla_soft_max: valhallaSoftMax,
    directions_language: directionsLanguage,
    respect_direction: respectDirection,
    vehicle,
    ts: body.ts,
    tz: body.tz,
  };

  const restrictionsFC = await callRestrictions(planReq, bbox);
  const roadworksFC = await callRoadworks(planReq, bbox);

  const allObstacles: Feature[] = [
    ...(restrictionsFC?.features ?? []),
    ...(roadworksFC?.features ?? []),
  ];

  const valhallaBody = {
    start,
    end,
    directions_language: directionsLanguage,
    respect_direction: respectDirection,
    vehicle,
    ts: planReq.ts,
    tz: planReq.tz,
  };

  const MAX_ITERATIONS = 10;

  let iterations = 0;
  let activeAvoids: Feature<Polygon>[] = [];
  let currentRouteGeoJSON: FeatureCollection | null = null;
  let finalError: string | null = null;
  let lastHardCollisions = 0;
  let lastAddedAvoids = 0;

  // pro Hindernis-Key merken wir, wie oft wir es schon "vergrößert" haben
  const avoidAttempts = new Map<string, number>();

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    console.log(
      `--- Iteration ${iterations} --- Avoids: ${activeAvoids.length}`,
    );

    const result = await callValhalla(valhallaBody, activeAvoids);

    if (result.error || !result.geojson.features.length) {
      finalError = result.error || "No route found";
      console.error(`[FAIL] Iteration ${iterations}: ${finalError}`);
      break;
    }

    currentRouteGeoJSON = result.geojson;

    const routeLine = currentRouteGeoJSON.features[0] as Feature<LineString>;
    const routeBuffer = buffer(routeLine, corridorWidth / 1000, {
      units: "kilometers",
    });

    const hardCollisions = allObstacles.filter((obs) => {
      const p = obs.properties || {};
      const limits = getLimits(p);
      if (!isHardBlocked(limits)) return false;
      return booleanIntersects(routeBuffer, obs as any);
    });

    lastHardCollisions = hardCollisions.length;

    if (hardCollisions.length === 0) {
      finalError = null;
      lastAddedAvoids = 0;
      break;
    }

    const before = activeAvoids.length;

    // harte Kollisionen -> avoid hinzufügen
    for (const obs of hardCollisions) {
      if (activeAvoids.length >= avoidTargetMax) break;

      const p = obs.properties || {};
      const title = String(p.title ?? "unknown");

      const obsKey = String(
        p.id ??
          p.oid ??
          p.osm_id ??
          // fallback: bbox-string vom obstacle
          bboxFn(obs as any).map((n) => Number(n.toFixed(6))).join(","),
      );

      const attempt = avoidAttempts.get(obsKey) ?? 0;
      avoidAttempts.set(obsKey, attempt + 1);

      // Skalierung (km): 0.25, 0.5, 1.0, 2.0, 3.0 …
      const step = attempt;

      // Aggressives Padding: bei harten Kollisionen brauchen wir oft deutlich mehr Abstand als 60m.
      // Wir skalieren daher stufenweise hoch (in Kilometern) und erlauben mehr Versuche pro Objekt.
      const baseKm = Math.max(roadworksBufferM / 1000, 0.25); // mindestens 250m
      const kmPad =
        step === 1
          ? baseKm
          : step === 2
            ? 0.5
            : step === 3
              ? 1.0
              : step === 4
                ? 2.0
                : 3.0;

      // Sicherheitslimit: nach 12 Versuchen geben wir pro Objekt auf (sonst explodiert Avoid-Menge)
      if (step > 12) {
        console.warn(
          `[GIVE UP] "${title.slice(0, 30)}..." still colliding after ${step - 1} avoid expansions`,
        );
        continue;
      }

      const poly = createAvoidPolygonScaled(obs as any, kmPad);
      if (!poly) continue;

      activeAvoids.push(poly);
    }

    // Soft-Max (Valhalla) respektieren
    if (activeAvoids.length > valhallaSoftMax) {
      activeAvoids = mergePolygons(activeAvoids, valhallaSoftMax, avoidTargetMax);
    }

    lastAddedAvoids = activeAvoids.length - before;

    // „stuck“: nichts Neues hinzugefügt
    if (lastAddedAvoids <= 0) {
      finalError =
        "Route still collides with hard obstacles, but no new avoids can be added (stuck).";
      break;
    }
  }

  const routeIsClean =
    !!currentRouteGeoJSON && finalError === null && lastHardCollisions === 0;

  // warnings fürs Frontend (max 20)
  const warnings: any[] = [];
  if (currentRouteGeoJSON?.features?.length) {
    const routeLine = currentRouteGeoJSON.features[0] as Feature<LineString>;
    const routeBuffer = buffer(routeLine, corridorWidth / 1000, {
      units: "kilometers",
    });

    for (const obs of allObstacles) {
      if (!booleanIntersects(routeBuffer, obs as any)) continue;
      const p = obs.properties || {};
      warnings.push({
        id: p.id ?? p.oid ?? p.osm_id ?? p.title ?? "unknown",
        title: p.title || "Baustelle ohne Einschränkung",
        description: p.description,
        limits: getLimits(p),
        coords: centroid(obs as any).geometry.coordinates,
      });
      if (warnings.length >= 20) break;
    }
  }

  // Wenn nicht clean -> HTTP 409, damit Frontend es nicht als "OK" behandelt
  const statusCode = routeIsClean ? 200 : 409;

  return NextResponse.json(
    {
      meta: {
        source: "route/plan-v16-bbox-only",
        iterations,
        avoids_applied: activeAvoids.length,
        clean: routeIsClean,
        error: finalError,
        hard_collisions: lastHardCollisions,
        added_avoids_last_iter: lastAddedAvoids,
      },
      avoid_applied: { total: activeAvoids.length },
      geojson: currentRouteGeoJSON ?? featureCollection([]),
      warnings,
    },
    { status: statusCode },
  );
}
