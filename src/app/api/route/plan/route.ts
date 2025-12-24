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
 * Sehr konservativ: statt komplexer Polygon-Geometrie nehmen wir eine kleine BBox um die Baustelle,
 * gepuffert um 20m. Das ist robust und reicht für "avoid"-Routing.
 */
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
    avoid_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
    exclude_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
  };

  const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";

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

  // Ziel: "so lange wie möglich versuchen" – aber innerhalb maxDuration.
  // Deshalb: mehrere BBox-Stufen (größerer Suchraum = mehr Roadworks-Infos = bessere Umfahrungsversuche).
  const BBOX_STEPS_KM = [150, 300, 600]; // kannst du später erhöhen, aber 600km ist schon groß
  const MAX_ITERATIONS_PER_STEP = 10;    // pro Stufe
  const ROUTE_BUFFER_KM = 0.02;          // 20m
  const valhallaSoftMax = body.valhalla_soft_max ?? 400; // mehr Luft als 200

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

  // Ergebnisvariablen
  let finalRoute: FeatureCollection = { type: "FeatureCollection", features: [] };
  let finalWarnings: any[] = [];
  let finalStatus: "CLEAN" | "WARN" | "BLOCKED" = "BLOCKED";
  let finalError: string | null = null;
  let totalIterations = 0;
  let finalAvoidCount = 0;
  let usedBboxKm: number | null = null;
  let fallbackUsed = false;

  // ---- Phase 1: "STRICT" – Umfahrungen versuchen, Roadworks-BBox wächst
  for (const bboxKm of BBOX_STEPS_KM) {
    usedBboxKm = bboxKm;

    const bbox = makeSafeBBox(start, end, bboxKm);

    // Roadworks holen (für diese Stufe)
    const obstacles: Feature<any>[] = [];
    const rw = await postJSON<{ features: Feature<any>[] }>(origin, "/api/roadworks", {
      ts,
      tz,
      bbox,
      buffer_m: body.roadworks?.buffer_m ?? 60,
      // IMPORTANT: Umfahrungen brauchen oft Nicht-Autobahn
      only_motorways: body.roadworks?.only_motorways ?? false,
    });
    if (rw?.features?.length) obstacles.push(...rw.features);

    let avoids: Feature<Polygon>[] = [];
    const avoidIds = new Set<string>();
    let iterations = 0;
    let route: FeatureCollection = { type: "FeatureCollection", features: [] };
    let stuckReason: string | null = null;

    while (iterations < MAX_ITERATIONS_PER_STEP) {
      iterations++;
      totalIterations++;

      const res = await callValhalla(plannerReqBase, avoids);

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

        // passt -> kein Problem
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

      // CLEAN erreicht
      if (blocked === 0) {
        finalRoute = route;
        finalWarnings = [];
        finalStatus = "CLEAN";
        finalError = null;
        finalAvoidCount = avoids.length;

        phases.push({
          phase: "STRICT",
          bbox_km: bboxKm,
          iterations,
          avoids_applied: avoids.length,
          result: "CLEAN",
        });

        return NextResponse.json({
          meta: {
            source: "route/plan-v17-two-phase",
            status: finalStatus,
            clean: true,
            error: finalError,
            iterations: totalIterations,
            avoids_applied: finalAvoidCount,
            bbox_km_used: usedBboxKm,
            fallback_used: false,
            phases,
          },
          avoid_applied: { total: finalAvoidCount },
          geojson: finalRoute,
          blocking_warnings: finalWarnings,
        });
      }

      // wir konnten nichts Neues vermeiden -> "stuck"
      if (added === 0) {
        stuckReason = "Keine weitere Umfahrung möglich (keine neuen Avoids ableitbar).";
        break;
      }

      // Avoid-Limit
      if (avoids.length >= valhallaSoftMax) {
        stuckReason = "Avoid-Limit erreicht (zu viele Baustellen/Restriktionen im Suchraum).";
        break;
      }
    }

    // STRICT nicht CLEAN: protokollieren und zur nächsten BBox-Stufe
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

    // wir merken uns die "beste bisherige" Route (falls wir am Ende gar nichts finden)
    // aber wichtig: wir werden sowieso Fallback fahren, wenn nicht CLEAN.
    if (route.features.length) {
      finalRoute = route;
      finalWarnings = strictWarnings;
      finalAvoidCount = avoids.length;
      finalStatus = strictWarnings.length ? "WARN" : "CLEAN";
      finalError = stuckReason;
    }
  }

  // ---- Phase 2: Fallback (automatisch!) – OHNE Avoids routen, dann warnen
  fallbackUsed = true;
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

  const fallbackRes = await callValhalla(plannerReqBase, []); // <<< ohne Avoids
  const fallbackRoute: FeatureCollection = fallbackRes?.geojson ?? { type: "FeatureCollection", features: [] };

  if (!fallbackRoute?.features?.length) {
    // wirklich gar keine Route (Start/Ziel unplausibel, Valhalla down, etc.)
    finalStatus = "BLOCKED";
    finalRoute = { type: "FeatureCollection", features: [] };
    finalWarnings = [];
    finalError =
      typeof fallbackRes?.error === "string" && fallbackRes.error.length
        ? fallbackRes.error
        : "Es konnte gar keine Route berechnet werden (auch nicht als Notlösung).";

    phases.push({
      phase: "FALLBACK_NO_AVOIDS",
      bbox_km: BBOX_STEPS_KM[BBOX_STEPS_KM.length - 1],
      result: "NO_ROUTE",
      reason: finalError,
    });

    return NextResponse.json({
      meta: {
        source: "route/plan-v17-two-phase",
        status: finalStatus,
        clean: false,
        error: finalError,
        iterations: totalIterations,
        avoids_applied: finalAvoidCount,
        bbox_km_used: usedBboxKm,
        fallback_used: true,
        phases,
      },
      avoid_applied: { total: finalAvoidCount },
      geojson: finalRoute,
      blocking_warnings: finalWarnings,
    });
  }

  const fallbackWarnings = collectBlockingWarnings(
    fallbackRoute,
    obstaclesFallback,
    ROUTE_BUFFER_KM,
    vWidth,
    vWeight
  );

  finalStatus = fallbackWarnings.length ? "WARN" : "CLEAN";
  finalRoute = fallbackRoute;
  finalWarnings = fallbackWarnings;

  // Deutsche, klare Meldung:
  finalError =
    finalStatus === "WARN"
      ? "Es wurde keine vollständig passende Umfahrung gefunden. Notlösung angezeigt; bitte Warnungen prüfen."
      : null;

  phases.push({
    phase: "FALLBACK_NO_AVOIDS",
    bbox_km: BBOX_STEPS_KM[BBOX_STEPS_KM.length - 1],
    result: finalStatus,
    blocking_warnings: fallbackWarnings.length,
  });

  return NextResponse.json({
    meta: {
      source: "route/plan-v17-two-phase",
      status: finalStatus,
      clean: finalStatus === "CLEAN",
      error: finalError,
      iterations: totalIterations,
      avoids_applied: finalAvoidCount,
      bbox_km_used: usedBboxKm,
      fallback_used: true,
      phases,
    },
    avoid_applied: { total: finalAvoidCount },
    geojson: finalRoute,
    blocking_warnings: finalWarnings,
  });
}
