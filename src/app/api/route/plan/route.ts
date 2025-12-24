/* src/app/api/route/plan/route.ts */

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

/* ---------- Helpers ---------- */

function makeSafeBBox(start: Coords, end: Coords, bufferKm: number): [number, number, number, number] {
  const line = lineString([start, end]);
  const buffered = buffer(line, bufferKm, { units: "kilometers" });
  return bboxFn(buffered) as [number, number, number, number];
}

function getLimits(p: any) {
  const width =
    (typeof p?.max_width_m === "number" ? p.max_width_m : null) ??
    (typeof p?.max_width === "number" ? p.max_width : null) ??
    999;

  const weight =
    (typeof p?.max_weight_t === "number" ? p.max_weight_t : null) ??
    (typeof p?.max_weight === "number" ? p.max_weight : null) ??
    999;

  return {
    width: width === 0 ? 999 : width,
    weight: weight === 0 ? 999 : weight,
  };
}

function stableObsId(obs: Feature<any>): string {
  const p: any = obs.properties || {};
  return String(p.roadwork_id ?? p.external_id ?? p.restriction_id ?? p.id ?? JSON.stringify(bboxFn(obs)));
}

function createAvoidPolygon(f: Feature<any>): Feature<Polygon> | null {
  try {
    const bf = buffer(f, 0.02, { units: "kilometers" }); // 20m
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
    avoid_polygons: avoidPolys.length ? avoidPolys.map(p => p.geometry) : undefined,
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

async function postJSON<T>(origin: string, path: string, body: any): Promise<T | null> {
  try {
    const r = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/* ---------- Main ---------- */

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PlanReq;

  const start = body.start;
  const end = body.end;

  const ts = body.ts ?? new Date().toISOString();
  const tz = body.tz ?? "Europe/Berlin";

  const vWidth = body.vehicle?.width_m ?? 2.55;
  const vWeight = body.vehicle?.weight_t ?? 40;

  const MAX_ITERATIONS = 6;
  const ROUTE_BUFFER_KM = 0.02;
  const valhallaSoftMax = body.valhalla_soft_max ?? 80;

  const bbox = makeSafeBBox(start, end, 50);
  const origin = req.nextUrl.origin;

  const obstacles: Feature<any>[] = [];

  const rw = await postJSON<{ features: Feature<any>[] }>(origin, "/api/roadworks", {
    ts, tz, bbox,
    buffer_m: body.roadworks?.buffer_m ?? 60,
    only_motorways: body.roadworks?.only_motorways ?? true,
  });

  if (rw?.features?.length) obstacles.push(...rw.features);

  let avoids: Feature<Polygon>[] = [];
  let avoidIds = new Set<string>();
  let iterations = 0;
  let routeIsClean = false;
  let finalError: string | null = null;
  let route: FeatureCollection = { type: "FeatureCollection", features: [] };
  const blockingWarnings: any[] = [];

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const res = await callValhalla({
      start,
      end,
      vehicle: body.vehicle,
      alternates: body.alternates ?? 1,
      directions_language: body.directions_language ?? "de-DE",
      respect_direction: body.respect_direction ?? true,
    }, avoids);

    if (!res?.geojson?.features?.length) {
      finalError = res?.error ?? "No route found";
      break;
    }

    route = res.geojson;
    const line = route.features[0];
    const routeBuffer = buffer(line as any, ROUTE_BUFFER_KM, { units: "kilometers" });

    let blocked = 0;
    let added = 0;

    for (const obs of obstacles) {
      if (!booleanIntersects(routeBuffer, obs)) continue;
      const limits = getLimits(obs.properties);
      if (limits.width >= vWidth && limits.weight >= vWeight) continue;

      blocked++;
      const id = stableObsId(obs);
      if (!avoidIds.has(id)) {
        const poly = createAvoidPolygon(obs);
        if (poly) {
          avoids.push(poly);
          avoidIds.add(id);
          added++;
        }
      }
    }

    if (blocked === 0) {
      routeIsClean = true;
      break;
    }

    if (added === 0) {
      finalError = "Route blocked - no valid detour possible";
      break;
    }

    if (avoids.length >= valhallaSoftMax) {
      finalError = "Avoid polygon limit hit";
      break;
    }
  }

  if (route.features.length) {
    const line = route.features[0];
    const routeBuffer = buffer(line as any, ROUTE_BUFFER_KM, { units: "kilometers" });

    for (const obs of obstacles) {
      if (!booleanIntersects(routeBuffer, obs)) continue;
      const limits = getLimits(obs.properties);
      if (limits.width < vWidth || limits.weight < vWeight) {
        blockingWarnings.push({
          title: obs.properties?.title,
          description: obs.properties?.description,
          limits,
          coords: centroid(obs).geometry.coordinates,
          already_avoided: avoidIds.has(stableObsId(obs)),
        });
      }
    }
  }

  if (blockingWarnings.length) {
    routeIsClean = false;
    if (!finalError) finalError = "Route blocked by obstacles";
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
    avoid_applied: { total: avoids.length },
    geojson: route,
    blocking_warnings: blockingWarnings,
  });
}
