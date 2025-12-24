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
  let width = p.max_width_m ?? p.max_width ?? null;
  let weight = p.max_weight_t ?? p.max_weight ?? null;

  if (width === 0) width = 999;
  if (weight === 0) weight = 999;

  return { width: width ?? 999, weight: weight ?? 999 };
}

function stableObsId(obs: Feature<any>): string {
  const p: any = obs.properties || {};
  return String(p.roadwork_id ?? p.external_id ?? p.id ?? JSON.stringify(bboxFn(obs)));
}

function createAvoidPolygon(f: Feature<any>): Feature<Polygon> | null {
  try {
    const bf = buffer(f, 0.02, { units: "kilometers" });
    const b = bboxFn(bf);
    return polygon([[
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]],
      [b[0], b[1]],
    ]]);
  } catch {
    return null;
  }
}

async function callValhalla(reqBody: any, avoidPolys: Feature<Polygon>[]) {
  const payload = {
    ...reqBody,
    avoid_polygons: avoidPolys.map(p => p.geometry),
  };

  const host = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const res = await fetch(`${host}/api/route/valhalla`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    return { geojson: { type: "FeatureCollection", features: [] }, error: await res.text() };
  }

  return await res.json();
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as PlanReq;

  const vWidth = body.vehicle?.width_m ?? 2.55;
  const vWeight = body.vehicle?.weight_t ?? 40;
  const valhallaSoftMax = body.valhalla_soft_max ?? 80;
  const ROUTE_BUFFER_KM = 0.02;

  const bbox = makeSafeBBox(body.start, body.end, 50);

  const obstacles: Feature<any>[] = [];

  const rw = await fetch(`${req.nextUrl.origin}/api/roadworks`, {
    method: "POST",
    body: JSON.stringify({ bbox }),
  }).then(r => r.json()).catch(() => null);

  if (rw?.features) obstacles.push(...rw.features);

  let avoids: Feature<Polygon>[] = [];
  const avoidIds = new Set<string>();
  let iterations = 0;
  let routeIsClean = false;
  let finalError: string | null = null;
  let route: FeatureCollection = { type: "FeatureCollection", features: [] };

  while (iterations < 6) {
    iterations++;

    const res = await callValhalla(
      { start: body.start, end: body.end, vehicle: body.vehicle },
      avoids
    );

    if (!res.geojson?.features?.length) {
      finalError = "No route found";
      break;
    }

    route = res.geojson;
    const line = route.features[0];
    const routeBuffer = buffer(line, ROUTE_BUFFER_KM, { units: "kilometers" });

    let added = 0;

    for (const obs of obstacles) {
      if (!booleanIntersects(routeBuffer, obs)) continue;

      const limits = getLimits(obs.properties);
      const blocked =
        limits.width < vWidth || limits.weight < vWeight;

      if (!blocked) continue;

      const id = stableObsId(obs);
      if (avoidIds.has(id)) continue;

      const poly = createAvoidPolygon(obs);
      if (poly) {
        avoids.push(poly);
        avoidIds.add(id);
        added++;
      }
    }

    if (added === 0) {
      finalError = "Route blocked – no valid detour possible";
      routeIsClean = false;
      break;
    }

    if (avoids.length >= valhallaSoftMax) {
      finalError = "Avoid polygon limit hit";
      routeIsClean = false;
      break;
    }
  }

  const blockingWarnings: any[] = [];
  if (route.features.length) {
    const routeBuffer = buffer(route.features[0], ROUTE_BUFFER_KM, { units: "kilometers" });
    for (const obs of obstacles) {
      if (!booleanIntersects(routeBuffer, obs)) continue;
      const limits = getLimits(obs.properties);
      if (limits.width < vWidth || limits.weight < vWeight) {
        blockingWarnings.push({
          title: obs.properties?.title,
          limits,
          coords: centroid(obs).geometry.coordinates,
        });
      }
    }
  }

  if (blockingWarnings.length) {
    routeIsClean = false;
    if (!finalError) finalError = "Route blocked by roadworks";
  }

  return NextResponse.json({
    meta: {
      source: "route/plan-v16-bbox-only",
      iterations,
      avoids_applied: avoids.length,
      clean: routeIsClean,
      status: routeIsClean ? "CLEAN" : "BLOCKED",
      error: finalError,
    },
    geojson: route,
    blocking_warnings: blockingWarnings,
  });
}
