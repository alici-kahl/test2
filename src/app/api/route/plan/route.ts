// src/app/api/route/plan/route.ts
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
 * Robust: Avoid-Polygon um eine Baustelle.
 * Wichtig: buffer() kann bei kaputten/unerwarteten Geometrien werfen -> Fallback.
 */
function createAvoidPolygon(f: Feature<any>, bufferKm: number): Feature<Polygon> | null {
  // Mindestpuffer: 30m (zu klein führt häufig dazu, dass Valhalla trotzdem “drüber schneidet”)
  const km = Math.max(0.03, Number.isFinite(bufferKm) ? bufferKm : 0.03);

  // 1) Primär: buffer() + bbox
  try {
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
    // 2) Fallback: bbox vom Feature selbst + “expand”
    try {
      const b0 = bboxFn(f as any);
      const expand = km * 1.5; // etwas großzügiger im Fallback
      const b: [number, number, number, number] = [b0[0] - expand, b0[1] - expand, b0[2] + expand, b0[3] + expand];
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
}

// ✅ MINIMAL-ERWEITERUNG:
// - escape_mode (Option A) an /api/route/valhalla weiterreichen
// - alternates optional überschreiben (für aggressive Umfahrungen)
async function callValhalla(
  origin: string,
  reqBody: any,
  avoidPolys: Feature<Polygon>[],
  timeoutMs: number,
  escape_mode: boolean = false,
  alternates_override?: number
) {
  const payload = {
    ...reqBody,
    escape_mode: escape_mode || undefined,
    alternates: typeof alternates_override === "number" ? alternates_override : reqBody?.alternates,
    // Valhalla kann je nach Build avoid_polygons oder exclude_polygons nutzen.
    avoid_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
    exclude_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${origin}/api/route/valhalla`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });

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
    return { geojson: { type: "FeatureCollection", features: [] }, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function postJSON<T>(origin: string, path: string, body: any, timeoutMs: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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

  const aClean = a.blockingWarnings.length === 0;
  const bClean = b.blockingWarnings.length === 0;
  if (bClean && !aClean) return b;
  if (aClean && !bClean) return a;

  if (b.blockingWarnings.length < a.blockingWarnings.length) return b;
  if (b.blockingWarnings.length > a.blockingWarnings.length) return a;

  if (b.roadworksHits < a.roadworksHits) return b;
  if (b.roadworksHits > a.roadworksHits) return a;

  if (b.distance_km > 0 && a.distance_km > 0) {
    if (b.distance_km < a.distance_km) return b;
    if (b.distance_km > a.distance_km) return a;
  }

  return a;
}

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

function chunkRouteToBBoxes(coords: Coords[], chunkKm: number, overlapKm: number, expandKm: number) {
  if (!Array.isArray(coords) || coords.length < 2) return [] as [number, number, number, number][];

  const out: [number, number, number, number][] = [];
  let startIdx = 0;
  let acc = 0;

  for (let i = 1; i < coords.length; i++) {
    acc += haversineKm(coords[i - 1], coords[i]);

    if (acc >= chunkKm) {
      const slice = coords.slice(startIdx, i + 1);
      const ls = lineString(slice);
      const bb = bboxFn(buffer(ls, expandKm, { units: "kilometers" })) as [number, number, number, number];
      out.push(bb);

      let back = 0;
      let j = i;
      while (j > 0 && back < overlapKm) {
        back += haversineKm(coords[j - 1], coords[j]);
        j--;
      }
      startIdx = Math.max(0, j);
      acc = 0;
    }
  }

  const tail = coords.slice(startIdx);
  if (tail.length >= 2) {
    const ls = lineString(tail);
    const bb = bboxFn(buffer(ls, expandKm, { units: "kilometers" })) as [number, number, number, number];
    out.push(bb);
  }

  const seen = new Set<string>();
  return out.filter((b) => {
    const k = b.map((x) => x.toFixed(3)).join(",");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * ✅ Minimal-Fix für FAST_PATH:
 * Statt "die ersten N Boxen" nehmen wir N Boxen gleichmäßig verteilt über die Route,
 * damit lange Strecken nicht nur am Anfang Roadworks laden.
 */
function pickSpreadBoxes<T>(arr: T[], max: number): T[] {
  if (!Array.isArray(arr) || arr.length <= max) return arr;
  if (max <= 1) return [arr[0]];

  const out: T[] = [];
  const n = arr.length;

  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (n - 1)) / (max - 1));
    out.push(arr[idx]);
  }

  // Dedupe (falls Rundung gleiche Indizes produziert)
  const seen = new Set<string>();
  return out.filter((x, i) => {
    const k = `${i}-${JSON.stringify(x)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mergeObstacles(featuresList: Feature<any>[][], cap: number) {
  const out: Feature<any>[] = [];
  const seen = new Set<string>();

  for (const feats of featuresList) {
    for (const f of feats) {
      const id = stableObsId(f);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(f);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function prioritizeObstacles(
  obstacles: Feature<any>[],
  start: Coords,
  end: Coords,
  corridorKm: number,
  cap: number
) {
  if (!Array.isArray(obstacles) || obstacles.length <= cap) return obstacles;

  let corridorPoly: any = null;
  try {
    corridorPoly = buffer(lineString([start, end]), corridorKm, { units: "kilometers" });
  } catch {
    corridorPoly = null;
  }

  const primary: Feature<any>[] = [];
  const secondary: Feature<any>[] = [];

  for (const o of obstacles) {
    if (corridorPoly && booleanIntersects(corridorPoly as any, o)) primary.push(o);
    else secondary.push(o);
  }

  const out: Feature<any>[] = [];
  const seen = new Set<string>();

  const pushUnique = (f: Feature<any>) => {
    const id = stableObsId(f);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(f);
  };

  for (const f of primary) {
    pushUnique(f);
    if (out.length >= cap) return out;
  }
  for (const f of secondary) {
    pushUnique(f);
    if (out.length >= cap) return out;
  }

  return out;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PlanReq;

  const start = body.start;
  const end = body.end;

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

  // Vercel maxDuration=60 -> wir bleiben darunter
  const TIME_BUDGET_MS = 55_000;
  const t0 = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

  const VALHALLA_TIMEOUT_MS = 14_000;
  const ROADWORKS_TIMEOUT_MS = 4_500;

  // Route-Buffer: 20m ist okay als Intersect-Test
  const ROUTE_BUFFER_KM = 0.02;

  const origin = req.nextUrl.origin;

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

  const roadworksBufferM = body.roadworks?.buffer_m ?? 60;

  // Avoid-Puffer: Basis aus Roadworks-Buffer + zusätzliche Sicherheitsmarge für sehr breite Fahrzeuge
  const baseAvoidKm = Math.max(0.03, roadworksBufferM / 1000); // mind 30m
  const widthExtraKm = Math.min(0.15, Math.max(0, (vWidth - 2.55) * 0.01)); // +1cm/km pro 1m über 2.55, capped
  const avoidBufferKm = Math.max(baseAvoidKm, baseAvoidKm + widthExtraKm);

  const corridorWidthM = body.corridor?.width_m ?? 2000;
  const corridorKm = Math.max(6, Math.min(60, (corridorWidthM / 1000) * 6));

  // dynamische Caps (optional steuerbar)
  const MAX_AVOIDS_GLOBAL = Math.max(10, Math.min(80, body.avoid_target_max ?? 30));

  // --- FAST PATH (lange Strecken) ---
  if (approxKm >= LONG_ROUTE_KM) {
    const res0 = await callValhalla(
      origin,
      plannerReqBase,
      [],
      Math.min(VALHALLA_TIMEOUT_MS, Math.max(9_000, timeLeft() - 2_500)),
      false
    );
    const route0: FeatureCollection = res0?.geojson ?? { type: "FeatureCollection", features: [] };

    if (!route0?.features?.length) {
      return NextResponse.json(
        {
          meta: {
            source: "route/plan-v21-least-roadworks",
            status: "BLOCKED",
            clean: false,
            error: res0?.error ?? "Keine Route gefunden (FAST-PATH).",
            iterations: totalIterations,
            avoids_applied: 0,
            bbox_km_used: null,
            fallback_used: true,
            phases: [{ phase: "FAST_PATH", approx_km: approxKm, result: "NO_ROUTE", reason: res0?.error ?? null }],
          },
          avoid_applied: { total: 0 },
          geojson: { type: "FeatureCollection", features: [] },
          blocking_warnings: [],
          geojson_alts: [],
        },
        { status: 200 }
      );
    }

    const coords: Coords[] = (route0.features?.[0] as any)?.geometry?.coordinates ?? [];

    const chunkKm = 260;
    const overlapKm = 45;
    const expandKm = Math.max(10, Math.min(28, corridorKm)); // leicht größer für Detours in FAST_PATH

    const boxesAll = chunkRouteToBBoxes(coords, chunkKm, overlapKm, expandKm);

    // Budget-sicher: max 4 Boxen (aber jetzt über die Route verteilt)
    const MAX_BOXES_FAST = 4;
    const boxes = pickSpreadBoxes(boxesAll, MAX_BOXES_FAST);

    const onlyMotorways = body.roadworks?.only_motorways ?? false;

    const rwPromises = boxes.map((bb) =>
      postJSON<{ features: Feature<any>[] }>(
        origin,
        "/api/roadworks",
        { ts, tz, bbox: bb, buffer_m: roadworksBufferM, only_motorways: onlyMotorways },
        ROADWORKS_TIMEOUT_MS
      )
    );

    const rwResults = await Promise.all(rwPromises);
    const allFeat: Feature<any>[][] = rwResults.map((rw) => ((rw?.features ?? []) as Feature<any>[]));

    const merged = mergeObstacles(allFeat, 1800);
    const obstacles: Feature<any>[] = prioritizeObstacles(merged, start, end, corridorKm, 1400);

    const { blockingWarnings, roadworksHits } = computeRouteStats(route0, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight);

    let best: Candidate = {
      route: route0,
      blockingWarnings,
      roadworksHits,
      distance_km: extractDistanceKm(route0),
      meta: { bbox_km: null, avoids_applied: 0, fallback_used: true },
    };

    if (blockingWarnings.length === 0) {
      phases.push({
        phase: "FAST_PATH",
        approx_km: approxKm,
        result: "OK",
        roadworks_hits: roadworksHits,
        boxes: boxes.length,
      });
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
          phases,
        },
        avoid_applied: { total: 0 },
        geojson: best.route,
        blocking_warnings: [],
        geojson_alts: [],
      });
    }

    const MAX_ITER_FAST = 8;
    const MAX_AVOIDS_FAST = Math.min(MAX_AVOIDS_GLOBAL, 50);
    const MAX_NEW_AVOIDS_PER_ITER = 8;

    const avoidIds = new Set<string>();
    let avoids: Feature<Polygon>[] = [];
    let stuckReason: string | null = null;

    for (let i = 0; i < MAX_ITER_FAST; i++) {
      if (timeLeft() < VALHALLA_TIMEOUT_MS + 2_500) {
        stuckReason = "Zeitbudget erreicht (FAST_PATH Iteration abgebrochen).";
        break;
      }

      totalIterations++;

      const line = best.route.features[0];
      let routeBufferPoly: any = null;
      try {
        routeBufferPoly = buffer(line as any, ROUTE_BUFFER_KM, { units: "kilometers" });
      } catch {
        routeBufferPoly = null;
      }

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
        stuckReason = "Blockierende Baustellen erkannt, aber keine neuen Avoid-Polygone ableitbar.";
        break;
      }

      // Wichtig: engste (kritischste) zuerst
      blockingObs.sort((a, b) => {
        const la = getLimits(a.properties);
        const lb = getLimits(b.properties);
        if (la.width !== lb.width) return la.width - lb.width;
        return la.weight - lb.weight;
      });

      let added = 0;
      for (const obs of blockingObs) {
        if (avoids.length >= MAX_AVOIDS_FAST) break;
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
        stuckReason = "Konnte keine neuen Avoid-Polygone hinzufügen (Geometrie/Parsing).";
        break;
      }

      // ✅ Option A: sobald Avoids aktiv sind -> escape_mode true + Alternativen anfordern
      const res = await callValhalla(origin, plannerReqBase, avoids, VALHALLA_TIMEOUT_MS, true, 3);
      const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };

      if (!route?.features?.length) {
        stuckReason = res?.error ?? "Keine Route gefunden (Valhalla FAST_PATH Iteration).";
        break;
      }

      const stats = computeRouteStats(route, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight, avoidIds);
      const cand: Candidate = {
        route,
        blockingWarnings: stats.blockingWarnings,
        roadworksHits: stats.roadworksHits,
        distance_km: extractDistanceKm(route),
        meta: { bbox_km: null, avoids_applied: avoids.length, fallback_used: true },
      };

      best = pickBetterCandidate(best, cand);

      if (best.blockingWarnings.length === 0) {
        stuckReason = null;
        break;
      }
    }

    // ✅ finaler ESCAPE-Pass (Option A), falls noch Zeit und immer noch WARN
    if (best.blockingWarnings.length > 0 && timeLeft() >= VALHALLA_TIMEOUT_MS + 2_500) {
      const resEsc = await callValhalla(origin, plannerReqBase, avoids, VALHALLA_TIMEOUT_MS, true, 3);
      const routeEsc: FeatureCollection = resEsc?.geojson ?? { type: "FeatureCollection", features: [] };
      if (routeEsc?.features?.length) {
        const statsEsc = computeRouteStats(routeEsc, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight, avoidIds);
        const candEsc: Candidate = {
          route: routeEsc,
          blockingWarnings: statsEsc.blockingWarnings,
          roadworksHits: statsEsc.roadworksHits,
          distance_km: extractDistanceKm(routeEsc),
          meta: { bbox_km: null, avoids_applied: avoids.length, fallback_used: true },
        };
        best = pickBetterCandidate(best, candEsc);
        phases.push({ phase: "ESCAPE_PASS", result: "DONE", avoids_applied: avoids.length });
      }
    }

    phases.push({
      phase: "FAST_PATH",
      approx_km: approxKm,
      result: best.blockingWarnings.length === 0 ? "CLEAN" : "WARN",
      boxes: boxes.length,
      roadworks_hits: best.roadworksHits,
      avoids_applied: best.meta.avoids_applied,
      reason: stuckReason,
    });

    const status: "CLEAN" | "WARN" = best.blockingWarnings.length ? "WARN" : "CLEAN";
    const errorMsg =
      status === "WARN"
        ? "Route gefunden, aber es gibt blockierende Baustellen. Es wurden Umfahrungen versucht; bitte Warnungen prüfen."
        : null;

    return NextResponse.json({
      meta: {
        source: "route/plan-v21-least-roadworks",
        status,
        clean: status === "CLEAN",
        error: errorMsg,
        iterations: totalIterations,
        avoids_applied: best.meta.avoids_applied,
        bbox_km_used: null,
        fallback_used: true,
        phases,
      },
      avoid_applied: { total: best.meta.avoids_applied },
      geojson: best.route,
      blocking_warnings: best.blockingWarnings,
      geojson_alts: [],
    });
  }

  // --- STRICT (kürzere Strecken) ---
  const BBOX_STEPS_KM = [200, 400, 800, 1400, 2200];

  const MAX_ITERATIONS_PER_STEP = 7;
  const MAX_AVOIDS_TOTAL = Math.min(MAX_AVOIDS_GLOBAL, 60);
  const MAX_NEW_AVOIDS_PER_ITER = 7;

  let best: Candidate | null = null;
  const altCandidates: Candidate[] = [];

  for (const bboxKm of BBOX_STEPS_KM) {
    if (timeLeft() < VALHALLA_TIMEOUT_MS + 4_000) break;

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

    const rawObstacles: Feature<any>[] = (rw?.features ?? []) as Feature<any>[];

    // Für große BBOX: Korridor etwas lockern, sonst werden Detour-Obstacles “wegpriorisiert”
    const corridorKmStep = Math.min(90, Math.max(corridorKm, bboxKm * 0.04)); // z.B. bei 1400km => 56km

    const obstacles: Feature<any>[] = prioritizeObstacles(rawObstacles, start, end, corridorKmStep, 1600);

    let avoids: Feature<Polygon>[] = [];
    const avoidIds = new Set<string>();

    let iterations = 0;
    let stuckReason: string | null = null;

    while (iterations < MAX_ITERATIONS_PER_STEP) {
      if (timeLeft() < VALHALLA_TIMEOUT_MS + 2_500) {
        stuckReason = "Zeitbudget erreicht (STRICT abgebrochen).";
        break;
      }

      iterations++;
      totalIterations++;

      // ✅ Option A: sobald Avoids vorhanden sind -> escape_mode true, und Alternativen anfordern
      const escapeNow = avoids.length > 0;
      const res = await callValhalla(origin, plannerReqBase, avoids, VALHALLA_TIMEOUT_MS, escapeNow, escapeNow ? 3 : undefined);

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

      if (altCandidates.length < 2) {
        const alreadySimilar = altCandidates.some(
          (c) => Math.abs((c.distance_km || 0) - (cand.distance_km || 0)) < 0.1
        );
        if (!alreadySimilar) altCandidates.push(cand);
      }

      if (blockingWarnings.length === 0) {
        stuckReason = null;
        break;
      }

      const line = route.features[0];
      let routeBufferPoly: any = null;
      try {
        routeBufferPoly = buffer(line as any, ROUTE_BUFFER_KM, { units: "kilometers" });
      } catch {
        routeBufferPoly = null;
      }

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
        stuckReason = "Blockierende Baustellen erkannt, aber keine neuen Avoid-Polygone ableitbar.";
        break;
      }

      // Engste zuerst (schneller “CLEAN” erreichen)
      blockingObs.sort((a, b) => {
        const la = getLimits(a.properties);
        const lb = getLimits(b.properties);
        if (la.width !== lb.width) return la.width - lb.width;
        return la.weight - lb.weight;
      });

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
        stuckReason = "Konnte keine neuen Avoid-Polygone hinzufügen (Geometrie/Parsing).";
        break;
      }
    }

    phases.push({
      phase: "STRICT",
      bbox_km: bboxKm,
      iterations,
      avoids_applied: best?.meta?.avoids_applied ?? 0,
      result: best?.route?.features?.length ? "CANDIDATE" : "NO_ROUTE",
      reason: stuckReason,
    });

    if (best?.blockingWarnings?.length === 0) break;
  }

  if (!best?.route?.features?.length && timeLeft() >= VALHALLA_TIMEOUT_MS + 2_500) {
    const fallbackRes = await callValhalla(origin, plannerReqBase, [], VALHALLA_TIMEOUT_MS, false);
    const fallbackRoute: FeatureCollection = fallbackRes?.geojson ?? { type: "FeatureCollection", features: [] };

    if (fallbackRoute?.features?.length) {
      best = {
        route: fallbackRoute,
        blockingWarnings: [],
        roadworksHits: 0,
        distance_km: extractDistanceKm(fallbackRoute),
        meta: { bbox_km: null, avoids_applied: 0, fallback_used: true },
      };
      phases.push({ phase: "FALLBACK_NO_ROADWORKS", result: "OK" });
    } else {
      phases.push({ phase: "FALLBACK_NO_ROADWORKS", result: "NO_ROUTE", reason: fallbackRes?.error ?? null });
    }
  }

  // ✅ finaler ESCAPE-Pass (Option A) auch für kurze Strecken, falls WARN und noch Zeit
  if (best?.route?.features?.length && best.blockingWarnings.length > 0 && timeLeft() >= VALHALLA_TIMEOUT_MS + 2_500) {
    const resEsc = await callValhalla(origin, plannerReqBase, [], VALHALLA_TIMEOUT_MS, true, 3);
    const routeEsc: FeatureCollection = resEsc?.geojson ?? { type: "FeatureCollection", features: [] };
    if (routeEsc?.features?.length) {
      // Ohne zusätzliche Obstacles-BBox (minimal-invasiv), aber Escape kann neue Wege erschließen.
      const candEsc: Candidate = {
        route: routeEsc,
        blockingWarnings: best.blockingWarnings,
        roadworksHits: best.roadworksHits,
        distance_km: extractDistanceKm(routeEsc),
        meta: { bbox_km: best.meta.bbox_km, avoids_applied: best.meta.avoids_applied, fallback_used: best.meta.fallback_used },
      };
      best = pickBetterCandidate(best, candEsc);
      phases.push({ phase: "ESCAPE_PASS", result: "DONE" });
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

  const geojson_alts = altCandidates.filter((c) => c.route?.features?.length).map((c) => c.route);

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
