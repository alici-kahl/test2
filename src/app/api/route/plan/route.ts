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

/**
 * Robust & schnell: kleine BBox um die Baustelle (gebuffert).
 */
function createAvoidPolygon(f: Feature<any>): Feature<Polygon> | null {
  try {
    const bf = buffer(f, 0.02, { units: "kilometers" }); // 20m
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

async function callValhalla(origin: string, reqBody: any, avoidPolys: Feature<Polygon>[]) {
  const payload = {
    ...reqBody,
    avoid_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
    exclude_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(`${origin}/api/route/valhalla`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Wichtig: IMMER JSON-artig zurückgeben (damit Plan-Route nie "komisch" wird)
    const text = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(text);
      return parsed;
    } catch {
      return { geojson: { type: "FeatureCollection", features: [] }, error: text || "Valhalla Antwort nicht lesbar" };
    }
  } catch (e: any) {
    clearTimeout(timeout);
    return { geojson: { type: "FeatureCollection", features: [] }, error: String(e) };
  }
}

async function postJSON<T>(origin: string, path: string, body: any): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const r = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!r.ok) return null;

    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function collectBlockingWarnings(
  route: FeatureCollection,
  obstacles: Feature<any>[],
  routeBufferKm: number,
  vWidth: number,
  vWeight: number,
  avoidIds?: Set<string>
) {
  const warnings: any[] = [];
  if (!route?.features?.length) return warnings;

  const line = route.features[0];
  const routeBuffer = buffer(line as any, routeBufferKm, { units: "kilometers" });

  for (const obs of obstacles) {
    if (!booleanIntersects(routeBuffer, obs)) continue;
    const limits = getLimits(obs.properties);
    if (limits.width < vWidth || limits.weight < vWeight) {
      warnings.push({
        title: obs.properties?.title,
        description: obs.properties?.description,
        limits,
        coords: centroid(obs).geometry.coordinates,
        already_avoided: avoidIds ? avoidIds.has(stableObsId(obs)) : false,
      });
    }
  }
  return warnings;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PlanReq;

  const start = body.start;
  const end = body.end;

  const ts = body.ts ?? new Date().toISOString();
  const tz = body.tz ?? "Europe/Berlin";

  const vWidth = body.vehicle?.width_m ?? 2.55;
  const vWeight = body.vehicle?.weight_t ?? 40;

  // Wichtig gegen 504: harter Zeitdeckel für das gesamte Plan-Routing
  const TIME_BUDGET_MS = 50_000; // < 60s
  const t0 = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

  // Minimal, aber wirksam: weniger Schleifen, dafür IMMER automatische Notlösung am Ende
  const BBOX_STEPS_KM = [150, 300];
  const MAX_ITERATIONS_PER_STEP = 5;
  const ROUTE_BUFFER_KM = 0.02;
  const valhallaSoftMax = body.valhalla_soft_max ?? 200;

  const origin = req.nextUrl.origin;

  const plannerReqBase = {
    start,
    end,
    vehicle: body.vehicle,
    alternates: body.alternates ?? 2,
    directions_language: body.directions_language ?? "de-DE",
    respect_direction: body.respect_direction ?? true,
  };

  const phases: any[] = [];

  let finalRoute: FeatureCollection = { type: "FeatureCollection", features: [] };
  let finalWarnings: any[] = [];
  let finalStatus: "CLEAN" | "WARN" | "BLOCKED" = "BLOCKED";
  let finalError: string | null = null;
  let totalIterations = 0;
  let finalAvoidCount = 0;
  let usedBboxKm: number | null = null;

  // ---- Phase 1: STRICT (versuchen, passende Route zu finden)
  for (const bboxKm of BBOX_STEPS_KM) {
    usedBboxKm = bboxKm;
    if (timeLeft() < 12_000) break; // nicht mehr genug Luft für sinnvolle Schleifen

    const bbox = makeSafeBBox(start, end, bboxKm);

    const obstacles: Feature<any>[] = [];
    const rw = await postJSON<{ features: Feature<any>[] }>(origin, "/api/roadworks", {
      ts,
      tz,
      bbox,
      buffer_m: body.roadworks?.buffer_m ?? 60,
      only_motorways: body.roadworks?.only_motorways ?? false,
    });
    if (rw?.features?.length) obstacles.push(...rw.features);

    let avoids: Feature<Polygon>[] = [];
    const avoidIds = new Set<string>();
    let iterations = 0;
    let route: FeatureCollection = { type: "FeatureCollection", features: [] };
    let stuckReason: string | null = null;

    while (iterations < MAX_ITERATIONS_PER_STEP) {
      if (timeLeft() < 10_000) {
        stuckReason = "Zeitbudget erreicht (vor Notlösung abgebrochen).";
        break;
      }

      iterations++;
      totalIterations++;

      const res = await callValhalla(origin, plannerReqBase, avoids);

      if (!res?.geojson?.features?.length) {
        stuckReason = res?.error ?? "Keine Route gefunden (Valhalla).";
        route = { type: "FeatureCollection", features: [] };
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
        phases.push({
          phase: "STRICT",
          bbox_km: bboxKm,
          iterations,
          avoids_applied: avoids.length,
          result: "CLEAN",
        });

        return NextResponse.json({
          meta: {
            source: "route/plan-v18-budgeted-two-phase",
            status: "CLEAN",
            clean: true,
            error: null,
            iterations: totalIterations,
            avoids_applied: avoids.length,
            bbox_km_used: usedBboxKm,
            fallback_used: false,
            phases,
          },
          avoid_applied: { total: avoids.length },
          geojson: route,
          blocking_warnings: [],
        });
      }

      if (added === 0) {
        stuckReason = "Keine weitere Umfahrung möglich (keine neuen Avoids ableitbar).";
        break;
      }

      if (avoids.length >= valhallaSoftMax) {
        stuckReason = "Avoid-Limit erreicht (zu viele Baustellen/Restriktionen im Suchraum).";
        break;
      }
    }

    const strictWarnings = collectBlockingWarnings(route, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight, avoidIds);

    phases.push({
      phase: "STRICT",
      bbox_km: bboxKm,
      iterations,
      avoids_applied: avoids.length,
      result: route.features.length ? "WARN" : "NO_ROUTE",
      reason: stuckReason,
      blocking_warnings: strictWarnings.length,
    });

    // best effort merken (falls fallback aus irgendeinem Grund gar nicht geht)
    if (route.features.length) {
      finalRoute = route;
      finalWarnings = strictWarnings;
      finalAvoidCount = avoids.length;
      finalStatus = "WARN";
      finalError = stuckReason;
    }
  }

  // ---- Phase 2: AUTOMATISCHE Notlösung – ohne Avoids routen, dann warnen
  const bboxForFallback = makeSafeBBox(start, end, BBOX_STEPS_KM[BBOX_STEPS_KM.length - 1]);

  const obstaclesFallback: Feature<any>[] = [];
  const rwFallback = await postJSON<{ features: Feature<any>[] }>(origin, "/api/roadworks", {
    ts,
    tz,
    bbox: bboxForFallback,
    buffer_m: body.roadworks?.buffer_m ?? 60,
    only_motorways: body.roadworks?.only_motorways ?? false,
  });
  if (rwFallback?.features?.length) obstaclesFallback.push(...rwFallback.features);

  const fallbackRes = await callValhalla(origin, plannerReqBase, []); // ohne Avoids
  const fallbackRoute: FeatureCollection = fallbackRes?.geojson ?? { type: "FeatureCollection", features: [] };

  if (!fallbackRoute?.features?.length) {
    // wirklich gar keine Route berechenbar
    return NextResponse.json({
      meta: {
        source: "route/plan-v18-budgeted-two-phase",
        status: "BLOCKED",
        clean: false,
        error:
          typeof fallbackRes?.error === "string" && fallbackRes.error.length
            ? fallbackRes.error
            : "Es konnte gar keine Route berechnet werden (auch nicht als Notlösung).",
        iterations: totalIterations,
        avoids_applied: finalAvoidCount,
        bbox_km_used: usedBboxKm,
        fallback_used: true,
        phases: [
          ...phases,
          {
            phase: "FALLBACK_NO_AVOIDS",
            bbox_km: BBOX_STEPS_KM[BBOX_STEPS_KM.length - 1],
            result: "NO_ROUTE",
          },
        ],
      },
      avoid_applied: { total: finalAvoidCount },
      geojson: { type: "FeatureCollection", features: [] },
      blocking_warnings: [],
    });
  }

  const fallbackWarnings = collectBlockingWarnings(fallbackRoute, obstaclesFallback, ROUTE_BUFFER_KM, vWidth, vWeight);

  const status: "CLEAN" | "WARN" = fallbackWarnings.length ? "WARN" : "CLEAN";
  const errorMsg =
    status === "WARN"
      ? "Es wurde keine vollständig passende Umfahrung gefunden. Notlösung angezeigt; bitte Warnungen prüfen."
      : null;

  return NextResponse.json({
    meta: {
      source: "route/plan-v18-budgeted-two-phase",
      status,
      clean: status === "CLEAN",
      error: errorMsg,
      iterations: totalIterations,
      avoids_applied: finalAvoidCount,
      bbox_km_used: usedBboxKm,
      fallback_used: true,
      phases: [
        ...phases,
        {
          phase: "FALLBACK_NO_AVOIDS",
          bbox_km: BBOX_STEPS_KM[BBOX_STEPS_KM.length - 1],
          result: status,
          blocking_warnings: fallbackWarnings.length,
        },
      ],
    },
    avoid_applied: { total: finalAvoidCount },
    geojson: fallbackRoute,
    blocking_warnings: fallbackWarnings,
  });
}
