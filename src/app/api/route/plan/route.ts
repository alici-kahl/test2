/* app/api/route/plan/route.ts */

import { NextRequest, NextResponse } from "next/server";
import bboxFn from "@turf/bbox";
import buffer from "@turf/buffer";
import booleanIntersects from "@turf/boolean-intersects";
import centroid from "@turf/centroid";
import { lineString, polygon, Feature, FeatureCollection, Polygon } from "@turf/helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Coords = [number, number];

type PlanReq = {
  start: Coords;
  end: Coords;
  vehicle?: { width_m?: number; height_m?: number; weight_t?: number; axleload_t?: number };
  ts?: string;
  tz?: string;
  corridor?: { width_m?: number };
  roadworks?: { buffer_m?: number; only_motorways?: boolean };
  alternates?: number;
  directions_language?: string;
  avoid_target_max?: number;
  valhalla_soft_max?: number;
  respect_direction?: boolean;
};

function makeSafeBBox(start: Coords, end: Coords, bufferKm: number): [number, number, number, number] {
  const line = lineString([start, end]);
  const buffered = buffer(line, bufferKm, { units: "kilometers" });
  return bboxFn(buffered) as [number, number, number, number];
}

function getLimits(p: any) {
  // Roadworks: max_width_m; Restrictions ggf. anders – wir bleiben minimal, aber robust
  const width =
    (typeof p?.max_width_m === "number" ? p.max_width_m : null) ??
    (typeof p?.max_width === "number" ? p.max_width : null) ??
    999;

  const weight =
    (typeof p?.max_weight_t === "number" ? p.max_weight_t : null) ??
    (typeof p?.max_weight === "number" ? p.max_weight : null) ??
    999;

  return { width: width === 0 ? 999 : width, weight: weight === 0 ? 999 : weight };
}

function stableObsId(obs: Feature<any>): string {
  const p: any = obs.properties || {};
  // bevorzugt echte IDs
  const id = p.roadwork_id ?? p.external_id ?? p.restriction_id ?? p.id;
  if (id) return String(id);
  // fallback
  return JSON.stringify(bboxFn(obs));
}

function createAvoidPolygon(f: Feature<any>): Feature<Polygon> | null {
  try {
    // kleiner Buffer (20m) => bbox => Rechteck (Valhalla-freundlich)
    const bf = buffer(f, 0.02, { units: "kilometers" });
    const b = bboxFn(bf);
    return polygon([
      [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[2], b[3]],
        [b[0], b[3]],
        [b[0], b[1]],
      ],
    ]);
  } catch {
    return null;
  }
}

async function callValhalla(reqBody: any, avoidPolys: Feature<Polygon>[]) {
  const payload = {
    ...reqBody,
    avoid_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
  };

  const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";

  const res = await fetch(`${host}/api/route/valhalla`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    return { geojson: { type: "FeatureCollection", features: [] }, error: txt || `Valhalla ${res.status}` };
  }

  return await res.json();
}

async function postJSON<T>(origin: string, path: string, body: any, timeoutMs = 8000): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PlanReq;

  const start = body.start;
  const end = body.end;
  const ts = body.ts ?? new Date().toISOString();
  const tz = body.tz ?? "Europe/Berlin";

  const vWidth = body.vehicle?.width_m ?? 2.55;
  const vWeight = body.vehicle?.weight_t ?? 40;

  const valhallaSoftMax = Number.isFinite(body.valhalla_soft_max as any) ? (body.valhalla_soft_max as number) : 80;
  const MAX_ITERATIONS = 6;

  // 20m Buffer um Route für Intersections
  const ROUTE_BUFFER_KM = 0.02;

  // Suchraum (50km) – kannst du später feintunen
  const bbox = makeSafeBBox(start, end, 50);

  const origin = req.nextUrl.origin;

  // WICHTIG: Roadworks/Restrictions so laden wie dein System es erwartet (ts/tz/bbox/only_motorways/buffer_m)
  const roadworksPayload = {
    ts,
    tz,
    bbox,
    buffer_m: body.roadworks?.buffer_m ?? 60,
    only_motorways: body.roadworks?.only_motorways ?? true,
  };

  const restrictionsPayload = {
    ts,
    tz,
    bbox,
    buffer_m: 10,
    simplify_m: 5,
    min_area_m2: 20,
    max_polygons: 1000,
    vehicle: body.vehicle,
  };

  const obstacles: Feature<any>[] = [];

  const rw = await postJSON<{ type: string; features: Feature<any>[] }>(origin, "/api/roadworks", roadworksPayload, 8000);
  if (rw?.features?.length) obstacles.push(...rw.features);

  const rs = await postJSON<{ geojson?: { features?: Feature<any>[] } }>(origin, "/api/restrictions", restrictionsPayload, 8000);
  if (rs?.geojson?.features?.length) obstacles.push(...rs.geojson.features);

  let avoids: Feature<Polygon>[] = [];
  const avoidIds = new Set<string>();

  let iterations = 0;
  let routeIsClean = false;
  let finalError: string | null = null;

  let route: FeatureCollection = { type: "FeatureCollection", features: [] };

  // für UI/Debug
  const blockingWarnings: any[] = [];

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const valhallaReq = {
      start,
      end,
      vehicle: body.vehicle,
      alternates: body.alternates ?? 1,
      directions_language: body.directions_language ?? "de-DE",
      respect_direction: body.respect_direction ?? true,
    };

    const res = await callValhalla(valhallaReq, avoids);

    if (!res?.geojson?.features?.length) {
      finalError = res?.error || "No route found";
      routeIsClean = false;
      break;
    }

    route = res.geojson;

    const line = route.features[0];
    // @ts-ignore
    const routeBuffer = buffer(line, ROUTE_BUFFER_KM, { units: "kilometers" });

    let blockedCount = 0;
    let addedAvoids = 0;

    // Scan aktuelle Route gegen Obstacles
    for (const obs of obstacles) {
      if (!booleanIntersects(routeBuffer, obs)) continue;

      const limits = getLimits(obs.properties);
      const blocked = (limits.width < vWidth) || (limits.weight < vWeight);

      if (!blocked) continue;

      blockedCount++;

      const id = stableObsId(obs);

      // Nur neue Avoids hinzufügen
      if (!avoidIds.has(id)) {
        const poly = createAvoidPolygon(obs);
        if (poly) {
          avoids.push(poly);
          avoidIds.add(id);
          addedAvoids++;
        }
      }
    }

    // Wenn keine blockierenden Treffer mehr => CLEAN
    if (blockedCount === 0) {
      routeIsClean = true;
      finalError = null;
      break;
    }

    // Wenn blockiert, aber keine neuen Avoids mehr möglich => stuck => BLOCKED
    if (blockedCount > 0 && addedAvoids === 0) {
      routeIsClean = false;
      finalError = "Route blocked - no valid detour possible";
      break;
    }

    // Hard cap
    if (avoids.length >= valhallaSoftMax) {
      routeIsClean = false;
      finalError = `Avoid polygon limit hit (${avoids.length} >= ${valhallaSoftMax})`;
      break;
    }

    // sonst: nächste Iteration mit mehr Avoids
  }

  // FINALER HARD CHECK: Endroute darf niemals als clean rausgehen, wenn sie noch blockierende Obstacles schneidet
  blockingWarnings.length = 0;
  if (route?.features?.length) {
    try {
      const line = route.features[0];
      // @ts-ignore
      const routeBuffer = buffer(line, ROUTE_BUFFER_KM, { units: "kilometers" });

      for (const obs of obstacles) {
        if (!booleanIntersects(routeBuffer, obs)) continue;

        const limits = getLimits(obs.properties);
        const blocked = (limits.width < vWidth) || (limits.weight < vWeight);

        if (blocked) {
          const p = obs.properties || {};
          blockingWarnings.push({
            title: p.title || p.description || "Obstacle",
            description: p.description,
            limits,
            coords: centroid(obs).geometry.coordinates,
            already_avoided: avoidIds.has(stableObsId(obs)),
          });
        }
      }
    } catch {
      // wenn der Check fehlschlägt: niemals clean behaupten
      routeIsClean = false;
      if (!finalError) finalError = "Final route validation failed";
    }
  }

  if (blockingWarnings.length > 0) {
    routeIsClean = false;
    if (!finalError) finalError = "Route blocked by one or more obstacles";
  }

  const status =
    routeIsClean ? "CLEAN" :
    finalError?.includes("Avoid polygon limit hit") ? "LIMIT_HIT" :
    route?.features?.length ? "BLOCKED" : "FAILED";

  return NextResponse.json({
    meta: {
      source: "route/plan-v16-bbox-only",
      iterations,
      avoids_applied: avoids.length,
      clean: routeIsClean,
      status,
      error: finalError,
    },
    avoid_applied: { total: avoids.length },
    geojson: route,
    blocking_warnings: blockingWarnings,
  });
}
