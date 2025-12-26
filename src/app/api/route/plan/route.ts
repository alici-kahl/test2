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
  vehicle?: { width_m?: number; height_m?: number; weight_t?: number; axleload_t?: number; hazmat?: boolean };
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

async function callValhalla(origin: string, reqBody: any, avoidPolys: Feature<Polygon>[], timeoutMs: number) {
  const payload = {
    ...reqBody,
    avoid_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
    exclude_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${origin}/api/route/valhalla`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await res.text().catch(() => "");
    try {
      return JSON.parse(text);
    } catch {
      return {
        geojson: { type: "FeatureCollection", features: [] },
        error: text || "Valhalla Antwort nicht lesbar",
      };
    }
  } catch (e: any) {
    clearTimeout(timeout);
    return { geojson: { type: "FeatureCollection", features: [] }, error: String(e) };
  }
}

async function postJSON<T>(origin: string, path: string, body: any, timeoutMs: number): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

function extractDistanceKm(fc: FeatureCollection): number {
  try {
    const f: any = fc?.features?.[0];
    const d = f?.properties?.summary?.distance_km;
    return typeof d === "number" ? d : Number(d || 0);
  } catch {
    return 0;
  }
}

function computeRouteStats(
  route: FeatureCollection,
  obstacles: Feature<any>[],
  routeBufferKm: number,
  vWidth: number,
  vWeight: number,
  avoidIds?: Set<string>
) {
  const blockingWarnings: any[] = [];
  let roadworksHits = 0;

  if (!route?.features?.length) return { blockingWarnings, roadworksHits };

  const line = route.features[0];
  const routeBuffer = buffer(line as any, routeBufferKm, { units: "kilometers" });

  for (const obs of obstacles) {
    if (!booleanIntersects(routeBuffer, obs)) continue;

    roadworksHits++;

    const limits = getLimits(obs.properties);
    if (limits.width < vWidth || limits.weight < vWeight) {
      blockingWarnings.push({
        title: obs.properties?.title,
        description: obs.properties?.description,
        limits,
        coords: centroid(obs).geometry.coordinates,
        already_avoided: avoidIds ? avoidIds.has(stableObsId(obs)) : false,
      });
    }
  }

  return { blockingWarnings, roadworksHits };
}

type Candidate = {
  route: FeatureCollection;
  blockingWarnings: any[];
  roadworksHits: number;
  distance_km: number;
  meta: { bbox_km: number | null; avoids_applied: number; fallback_used: boolean };
};

function pickBetterCandidate(a: Candidate | null, b: Candidate | null) {
  if (!a) return b;
  if (!b) return a;

  // 1) Weniger Baustellen-Treffer gewinnt (dein Wunsch)
  if (b.roadworksHits < a.roadworksHits) return b;
  if (b.roadworksHits > a.roadworksHits) return a;

  // 2) Weniger BLOCKING-Problemstellen gewinnt
  if (b.blockingWarnings.length < a.blockingWarnings.length) return b;
  if (b.blockingWarnings.length > a.blockingWarnings.length) return a;

  // 3) Bei Gleichstand: kürzere Distanz gewinnt (falls bekannt)
  if (b.distance_km > 0 && a.distance_km > 0) {
    if (b.distance_km < a.distance_km) return b;
    if (b.distance_km > a.distance_km) return a;
  }

  return a;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PlanReq;

  const start = body.start;
  const end = body.end;

  const ts = body.ts ?? new Date().toISOString();
  const tz = body.tz ?? "Europe/Berlin";

  const vWidth = body.vehicle?.width_m ?? 2.55;
  const vWeight = body.vehicle?.weight_t ?? 40;

  // Vercel maxDuration=60 -> wir bleiben bewusst darunter (inkl. Roadworks/Valhalla)
  const TIME_BUDGET_MS = 45_000;
  const t0 = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

  // Einzel-Timeouts (damit keine 504s entstehen)
  const ROADWORKS_TIMEOUT_MS = 8_000;
  const VALHALLA_TIMEOUT_MS = 12_000;

  /**
   * BBox steuert primär: wie viele Roadworks wir "kennen" (für Avoids/Scoring/Warnungen).
   * Für "weitere Umwege" erweitern wir den Suchraum stufenweise.
   */
  const BBOX_STEPS_KM = [150, 300, 600, 1200];
  const MAX_ITERATIONS_PER_STEP = 3; // entscheidend gegen Timeout
  const ROUTE_BUFFER_KM = 0.02;

  const valhallaSoftMax = body.valhalla_soft_max ?? 300;
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
  let totalIterations = 0;

  let best: Candidate | null = null;

  // Phase 1: STRICT (Avoids bauen aus BLOCKING-Stellen)
  for (const bboxKm of BBOX_STEPS_KM) {
    if (timeLeft() < 12_000) break;

    const bbox = makeSafeBBox(start, end, bboxKm);

    const rw = await postJSON<{ features: Feature<any>[] }>(
      origin,
      "/api/roadworks",
      {
        ts,
        tz,
        bbox,
        buffer_m: body.roadworks?.buffer_m ?? 60,
        only_motorways: body.roadworks?.only_motorways ?? false,
      },
      ROADWORKS_TIMEOUT_MS
    );

    // Cap: riesige Mengen killen Laufzeit. (reicht fürs Scoring/Avoids)
    const obstacles: Feature<any>[] = (rw?.features ?? []).slice(0, 2500);

    let avoids: Feature<Polygon>[] = [];
    const avoidIds = new Set<string>();
    let iterations = 0;
    let stuckReason: string | null = null;

    while (iterations < MAX_ITERATIONS_PER_STEP) {
      if (timeLeft() < VALHALLA_TIMEOUT_MS + 3_000) {
        stuckReason = "Zeitbudget erreicht (STRICT abgebrochen).";
        break;
      }

      iterations++;
      totalIterations++;

      const res = await callValhalla(origin, plannerReqBase, avoids, VALHALLA_TIMEOUT_MS);
      const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };

      if (!route?.features?.length) {
        stuckReason = res?.error ?? "Keine Route gefunden (Valhalla).";
        break;
      }

      const { blockingWarnings, roadworksHits } = computeRouteStats(
        route,
        obstacles,
        ROUTE_BUFFER_KM,
        vWidth,
        vWeight,
        avoidIds
      );

      const cand: Candidate = {
        route,
        blockingWarnings,
        roadworksHits,
        distance_km: extractDistanceKm(route),
        meta: { bbox_km: bboxKm, avoids_applied: avoids.length, fallback_used: false },
      };

      best = pickBetterCandidate(best, cand);

      // Wenn komplett sauber (keine Roadworks-Treffer und keine Blocking-Warnungen) -> sofort zurück
      if (roadworksHits === 0 && blockingWarnings.length === 0) {
        phases.push({
          phase: "STRICT",
          bbox_km: bboxKm,
          iterations,
          avoids_applied: avoids.length,
          result: "CLEAN",
        });

        return NextResponse.json({
          meta: {
            source: "route/plan-v20-least-roadworks",
            status: "CLEAN",
            clean: true,
            error: null,
            iterations: totalIterations,
            avoids_applied: avoids.length,
            bbox_km_used: bboxKm,
            fallback_used: false,
            phases,
          },
          avoid_applied: { total: avoids.length },
          geojson: route,
          blocking_warnings: [],
        });
      }

      // Avoids nur aus BLOCKING-Stellen ableiten (sonst "übervermeiden" wir alles)
      const line = route.features[0];
      const routeBuffer = buffer(line as any, ROUTE_BUFFER_KM, { units: "kilometers" });

      let added = 0;
      for (const obs of obstacles) {
        if (!booleanIntersects(routeBuffer, obs)) continue;

        const limits = getLimits(obs.properties);
        if (limits.width >= vWidth && limits.weight >= vWeight) continue; // nicht blocking

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
        stuckReason = "Keine weiteren BLOCKING-Avoids ableitbar.";
        break;
      }
      if (avoids.length >= valhallaSoftMax) {
        stuckReason = "Avoid-Limit erreicht.";
        break;
      }
    }

    phases.push({
      phase: "STRICT",
      bbox_km: bboxKm,
      iterations,
      avoids_applied: avoids.length,
      result: best?.route?.features?.length ? "CANDIDATE" : "NO_ROUTE",
      reason: stuckReason,
    });
  }

  // Phase 2: FALLBACK – ohne Avoids routen und ebenfalls als Kandidat werten
  if (timeLeft() >= VALHALLA_TIMEOUT_MS + 2_000) {
    const bboxKm = BBOX_STEPS_KM[BBOX_STEPS_KM.length - 1];
    const bbox = makeSafeBBox(start, end, bboxKm);

    const rw = await postJSON<{ features: Feature<any>[] }>(
      origin,
      "/api/roadworks",
      {
        ts,
        tz,
        bbox,
        buffer_m: body.roadworks?.buffer_m ?? 60,
        only_motorways: body.roadworks?.only_motorways ?? false,
      },
      ROADWORKS_TIMEOUT_MS
    );

    const obstacles: Feature<any>[] = (rw?.features ?? []).slice(0, 2500);

    const fallbackRes = await callValhalla(origin, plannerReqBase, [], VALHALLA_TIMEOUT_MS);
    const fallbackRoute: FeatureCollection = fallbackRes?.geojson ?? { type: "FeatureCollection", features: [] };

    if (fallbackRoute?.features?.length) {
      const { blockingWarnings, roadworksHits } = computeRouteStats(
        fallbackRoute,
        obstacles,
        ROUTE_BUFFER_KM,
        vWidth,
        vWeight
      );

      const cand: Candidate = {
        route: fallbackRoute,
        blockingWarnings,
        roadworksHits,
        distance_km: extractDistanceKm(fallbackRoute),
        meta: { bbox_km: bboxKm, avoids_applied: 0, fallback_used: true },
      };

      best = pickBetterCandidate(best, cand);

      phases.push({
        phase: "FALLBACK_NO_AVOIDS",
        bbox_km: bboxKm,
        result: fallbackRoute.features.length ? "OK" : "NO_ROUTE",
        roadworks_hits: roadworksHits,
        blocking_warnings: blockingWarnings.length,
      });
    } else {
      phases.push({
        phase: "FALLBACK_NO_AVOIDS",
        bbox_km: bboxKm,
        result: "NO_ROUTE",
        reason: fallbackRes?.error ?? null,
      });
    }
  }

  // Final
  if (!best?.route?.features?.length) {
    return NextResponse.json({
      meta: {
        source: "route/plan-v20-least-roadworks",
        status: "BLOCKED",
        clean: false,
        error: "Es konnte gar keine Route berechnet werden (auch nicht als Notlösung).",
        iterations: totalIterations,
        avoids_applied: 0,
        bbox_km_used: null,
        fallback_used: true,
        phases,
      },
      avoid_applied: { total: 0 },
      geojson: { type: "FeatureCollection", features: [] },
      blocking_warnings: [],
    });
  }

  const status: "CLEAN" | "WARN" = best.blockingWarnings.length ? "WARN" : "CLEAN";
  const errorMsg =
    status === "WARN"
      ? "Beste verfügbare Route gewählt (minimale Baustellen-Treffer); es gibt jedoch Problemstellen. Bitte Warnungen prüfen."
      : null;

  return NextResponse.json({
    meta: {
      source: "route/plan-v20-least-roadworks",
      status,
      clean: status === "CLEAN",
      error: errorMsg,
      iterations: totalIterations,
      avoids_applied: best.meta.avoids_applied,
      bbox_km_used: best.meta.bbox_km,
      fallback_used: best.meta.fallback_used,
      phases,
    },
    avoid_applied: { total: best.meta.avoids_applied },
    geojson: best.route,
    blocking_warnings: best.blockingWarnings,
  });
}
