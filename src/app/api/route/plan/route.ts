import { NextRequest, NextResponse } from "next/server";
import bboxFn from "@turf/bbox";
import buffer from "@turf/buffer";
import booleanIntersects from "@turf/boolean-intersects";
import centroid from "@turf/centroid";
import { lineString, polygon, Feature, FeatureCollection, Polygon } from "@turf/helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// WICHTIG: sicherstellen, dass das NICHT als Edge-Route läuft (Edge hat andere Limits/Verhalten)
export const runtime = "nodejs";

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
 * Robust: BBox um die Baustelle (gepuffert).
 * bufferKm sollte ungefähr dem roadworks buffer entsprechen (z.B. 60m => 0.06km).
 */
function createAvoidPolygon(f: Feature<any>, bufferKm: number): Feature<Polygon> | null {
  try {
    const km = Math.max(0.02, Number.isFinite(bufferKm) ? bufferKm : 0.02); // mind. 20m
    const bf = buffer(f as any, km, { units: "kilometers" });
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

  // 0) CLEAN schlägt WARN (wichtig für "wirklich Umfahren")
  const aClean = a.blockingWarnings.length === 0;
  const bClean = b.blockingWarnings.length === 0;
  if (bClean && !aClean) return b;
  if (aClean && !bClean) return a;

  // 1) Weniger BLOCKING-Problemstellen gewinnt (wichtiger als reine Trefferzahl)
  if (b.blockingWarnings.length < a.blockingWarnings.length) return b;
  if (b.blockingWarnings.length > a.blockingWarnings.length) return a;

  // 2) Weniger Baustellen-Treffer gewinnt
  if (b.roadworksHits < a.roadworksHits) return b;
  if (b.roadworksHits > a.roadworksHits) return a;

  // 3) Bei Gleichstand: kürzere Distanz gewinnt (falls bekannt)
  if (b.distance_km > 0 && a.distance_km > 0) {
    if (b.distance_km < a.distance_km) return b;
    if (b.distance_km > a.distance_km) return a;
  }

  return a;
}

// Minimal: schnelle Distanzschätzung (keine neue Dependency)
function haversineKm(a: Coords, b: Coords) {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLon / 2) * Math.sin(dLon / 2));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PlanReq;

  const start = body.start;
  const end = body.end;

  // Minimal: Eingangscheck, damit wir nicht “leerlaufen”
  if (!Array.isArray(start) || start.length !== 2 || !Array.isArray(end) || end.length !== 2) {
    return NextResponse.json(
      {
        meta: {
          source: "route/plan-v21-least-roadworks",
          status: "BLOCKED",
          clean: false,
          error: "Ungültige Eingabe: start/end fehlen oder sind nicht [lon,lat].",
        },
        geojson: { type: "FeatureCollection", features: [] },
        blocking_warnings: [],
      },
      { status: 400 }
    );
  }

  const ts = body.ts ?? new Date().toISOString();
  const tz = body.tz ?? "Europe/Berlin";

  const vWidth = body.vehicle?.width_m ?? 2.55;
  const vWeight = body.vehicle?.weight_t ?? 40;

  // Vercel maxDuration=60 -> wir bleiben bewusst deutlich darunter
  const TIME_BUDGET_MS = 40_000;
  const t0 = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

  // Einzel-Timeouts
  const ROADWORKS_TIMEOUT_MS = 6_000;
  const VALHALLA_TIMEOUT_MS = 16_000;

  const ROUTE_BUFFER_KM = 0.02;

  const origin = req.nextUrl.origin;

  // Distanz: lange Strecke = FAST-PATH (stabil)
  const approxKm = haversineKm(start, end);
  const LONG_ROUTE_KM = 220;

  const plannerReqBase = {
    start,
    end,
    vehicle: body.vehicle,
    alternates: approxKm >= LONG_ROUTE_KM ? 0 : body.alternates ?? 2,
    directions_language: body.directions_language ?? "de-DE",
    respect_direction: body.respect_direction ?? true,
    end_radius_m: 300,
  };

  const phases: any[] = [];
  let totalIterations = 0;

  // Optional: roadworks buffer als Avoid-Puffer verwenden
  const roadworksBufferM = body.roadworks?.buffer_m ?? 60;
  const avoidBufferKm = Math.max(0.02, roadworksBufferM / 1000); // mind. 20m

  // --- FAST PATH (lange Strecken): nur 1x Valhalla, sofort zurück ---
  if (approxKm >= LONG_ROUTE_KM) {
    const res = await callValhalla(
      origin,
      plannerReqBase,
      [],
      Math.min(VALHALLA_TIMEOUT_MS, Math.max(8_000, timeLeft() - 2_000))
    );
    const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };

    if (!route?.features?.length) {
      return NextResponse.json(
        {
          meta: {
            source: "route/plan-v21-least-roadworks",
            status: "BLOCKED",
            clean: false,
            error: res?.error ?? "Keine Route gefunden (FAST-PATH).",
            iterations: totalIterations,
            avoids_applied: 0,
            bbox_km_used: null,
            fallback_used: true,
            phases: [{ phase: "FAST_PATH", approx_km: approxKm, result: "NO_ROUTE", reason: res?.error ?? null }],
          },
          avoid_applied: { total: 0 },
          geojson: { type: "FeatureCollection", features: [] },
          blocking_warnings: [],
          geojson_alts: [],
        },
        { status: 200 }
      );
    }

    return NextResponse.json({
      meta: {
        source: "route/plan-v21-least-roadworks",
        status: "CLEAN",
        clean: true,
        error: null,
        iterations: totalIterations,
        avoids_applied: 0,
        bbox_km_used: null,
        fallback_used: true,
        phases: [{ phase: "FAST_PATH", approx_km: approxKm, result: "OK" }],
      },
      avoid_applied: { total: 0 },
      geojson: route,
      blocking_warnings: [],
      geojson_alts: [],
    });
  }

  // BBox Steps (Roadworks Umfang)
  const BBOX_STEPS_KM = [300, 600, 1200];

  // ✅ Umfahrungen: mehrere Iterationen erlauben (aber gedeckelt)
  const MAX_ITERATIONS_PER_STEP = 4;
  const MAX_AVOIDS_TOTAL = 12;
  const MAX_NEW_AVOIDS_PER_ITER = 4;

  let best: Candidate | null = null;

  // Optional: 1–2 Alternativen sammeln (FeatureCollections)
  const altCandidates: Candidate[] = [];

  for (const bboxKm of BBOX_STEPS_KM) {
    if (timeLeft() < VALHALLA_TIMEOUT_MS + 3_000) break;

    const bbox = makeSafeBBox(start, end, bboxKm);

    const rw = await postJSON<{ features: Feature<any>[] }>(
      origin,
      "/api/roadworks",
      {
        ts,
        tz,
        bbox,
        buffer_m: roadworksBufferM,
        only_motorways: body.roadworks?.only_motorways ?? false,
      },
      ROADWORKS_TIMEOUT_MS
    );

    const obstacles: Feature<any>[] = (rw?.features ?? []).slice(0, 900);

    let avoids: Feature<Polygon>[] = [];
    const avoidIds = new Set<string>();

    let iterations = 0;
    let stuckReason: string | null = null;

    while (iterations < MAX_ITERATIONS_PER_STEP) {
      if (timeLeft() < VALHALLA_TIMEOUT_MS + 2_000) {
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

      const { blockingWarnings, roadworksHits } = computeRouteStats(route, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight, avoidIds);

      const cand: Candidate = {
        route,
        blockingWarnings,
        roadworksHits,
        distance_km: extractDistanceKm(route),
        meta: { bbox_km: bboxKm, avoids_applied: avoids.length, fallback_used: false },
      };

      best = pickBetterCandidate(best, cand);

      // Alternative Kandidaten sammeln (nur wenige, damit Response klein bleibt)
      if (altCandidates.length < 2) {
        // nur aufnehmen, wenn Route existiert und NICHT identisch zur bisherigen besten (sehr grob über distance)
        const alreadySimilar = altCandidates.some((c) => Math.abs((c.distance_km || 0) - (cand.distance_km || 0)) < 0.1);
        if (!alreadySimilar) altCandidates.push(cand);
      }

      // ✅ CLEAN -> fertig
      if (blockingWarnings.length === 0) {
        stuckReason = null;
        break;
      }

      // ✅ blockierend -> Avoids hinzufügen und neu routen
      // Wir identifizieren die blockierenden Obstacles robust über Route-Intersection
      const line = route.features[0];
      let routeBufferPoly: any = null;
      try {
        routeBufferPoly = buffer(line as any, ROUTE_BUFFER_KM, { units: "kilometers" });
      } catch {
        routeBufferPoly = null;
      }

      // Blockierende Obstacles sammeln (die wirklich die Route schneiden)
      const blockingObs: Feature<any>[] = [];
      for (const obs of obstacles) {
        if (routeBufferPoly && !booleanIntersects(routeBufferPoly as any, obs)) continue;
        const limits = getLimits(obs.properties);
        if (limits.width < vWidth || limits.weight < vWeight) {
          const id = stableObsId(obs);
          if (!avoidIds.has(id)) blockingObs.push(obs);
        }
      }

      if (blockingObs.length === 0) {
        // Wir haben Warnings, aber keine neuen vermeidbaren Objekte gefunden -> Endlosschleife verhindern
        stuckReason = "Blockierende Baustellen erkannt, aber keine neuen Avoid-Polygone ableitbar.";
        break;
      }

      let added = 0;
      for (const obs of blockingObs) {
        if (avoids.length >= MAX_AVOIDS_TOTAL) break;

        const id = stableObsId(obs);
        if (avoidIds.has(id)) continue;

        const poly = createAvoidPolygon(obs, avoidBufferKm);
        if (!poly) continue;

        avoids.push(poly);
        avoidIds.add(id);
        added++;

        if (added >= MAX_NEW_AVOIDS_PER_ITER) break;
      }

      if (added === 0) {
        stuckReason = "Konnte keine neuen Avoid-Polygone hinzufügen.";
        break;
      }

      // nächste Iteration läuft automatisch weiter (neu routen mit avoids)
    }

    phases.push({
      phase: "STRICT",
      bbox_km: bboxKm,
      iterations,
      avoids_applied: avoids.length,
      result: best?.route?.features?.length ? "CANDIDATE" : "NO_ROUTE",
      reason: stuckReason,
    });

    // Wenn wir bereits CLEAN haben, können wir früh stoppen
    if (best?.blockingWarnings?.length === 0) break;
  }

  // Phase 2: FALLBACK – 1x ohne Roadworks/Avoids (nochmals schnell), aber nur wenn Budget reicht
  if (!best?.route?.features?.length && timeLeft() >= VALHALLA_TIMEOUT_MS + 2_000) {
    const fallbackRes = await callValhalla(origin, plannerReqBase, [], VALHALLA_TIMEOUT_MS);
    const fallbackRoute: FeatureCollection = fallbackRes?.geojson ?? { type: "FeatureCollection", features: [] };

    if (fallbackRoute?.features?.length) {
      best = {
        route: fallbackRoute,
        blockingWarnings: [],
        roadworksHits: 0,
        distance_km: extractDistanceKm(fallbackRoute),
        meta: { bbox_km: null, avoids_applied: 0, fallback_used: true },
      };
      phases.push({
        phase: "FALLBACK_NO_ROADWORKS",
        result: "OK",
      });
    } else {
      phases.push({
        phase: "FALLBACK_NO_ROADWORKS",
        result: "NO_ROUTE",
        reason: fallbackRes?.error ?? null,
      });
    }
  }

  if (!best?.route?.features?.length) {
    return NextResponse.json({
      meta: {
        source: "route/plan-v21-least-roadworks",
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
      geojson_alts: [],
    });
  }

  const status: "CLEAN" | "WARN" = best.blockingWarnings.length ? "WARN" : "CLEAN";
  const errorMsg =
    status === "WARN"
      ? "Route gefunden, aber es gibt blockierende Baustellen. Es wurden Umfahrungen versucht; bitte Warnungen prüfen."
      : null;

  // Alternativen nur als zusätzliche Info; UI kann das später nutzen
  const geojson_alts = altCandidates
    .filter((c) => c.route?.features?.length)
    .map((c) => c.route);

  return NextResponse.json({
    meta: {
      source: "route/plan-v21-least-roadworks",
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
    geojson_alts,
  });
}
