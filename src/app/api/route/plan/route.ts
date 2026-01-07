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

  /**
   * Wenn true, wird NUR eine CLEAN-Route akzeptiert (keine blockierenden Baustellen).
   * Wenn nach allen Versuchen keine CLEAN-Route gefunden wird => status=BLOCKED und geojson leer.
   */
  require_clean?: boolean;
};

function makeSafeBBox(start: Coords, end: Coords, bufferKm: number): [number, number, number, number] {
  const line = lineString([start, end]);
  const buffered = buffer(line, bufferKm, { units: "kilometers" });
  return bboxFn(buffered) as [number, number, number, number];
}

function normalizeLimit(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function getLimits(p: any) {
  return {
    width: normalizeLimit(p?.max_width_m ?? p?.max_width),
    weight: normalizeLimit(p?.max_weight_t ?? p?.max_weight),
  };
}

function stableObsId(obs: Feature<any>): string {
  const p: any = obs.properties || {};
  return String(p.roadwork_id ?? p.external_id ?? p.restriction_id ?? p.id ?? JSON.stringify(bboxFn(obs)));
}

/**
 * Robust: Avoid-Polygon um eine Baustelle.
 *
 * ALT (Problem): turf.buffer(feature) kann bei "kaputten"/unerwarteten Geometrien werfen
 * -> dann kommt "Konnte keine neuen Avoid-Polygone hinzufügen (Geometrie/Parsing)."
 *
 * NEU (Fix): Wir erzeugen IMMER ein Avoid-Rechteck rund um den centroid.
 * Das kann praktisch nicht mehr scheitern und verhindert, dass die Iterationsschleife "stuck" geht.
 */
function createAvoidPolygon(f: Feature<any>, bufferKm: number): Feature<Polygon> | null {
  const km = Math.max(0.03, Number.isFinite(bufferKm) ? bufferKm : 0.03);

  let c: any;
  try {
    c = centroid(f as any);
  } catch {
    c = null;
  }

  let lon: number | null = null;
  let lat: number | null = null;

  try {
    const coords = c?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length === 2) {
      lon = Number(coords[0]);
      lat = Number(coords[1]);
    }
  } catch {
    lon = null;
    lat = null;
  }

  // Fallback: falls centroid irgendwie unbrauchbar ist, nimm bbox-mitte
  if (lon === null || lat === null || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    try {
      const b = bboxFn(f as any) as [number, number, number, number];
      lon = (b[0] + b[2]) / 2;
      lat = (b[1] + b[3]) / 2;
    } catch {
      return null;
    }
  }

  // km -> Grad (grob, aber stabil und für Avoid ausreichend)
  const latRad = (lat * Math.PI) / 180;
  const dLat = km / 110.574; // km pro Breitengrad
  const cosLat = Math.cos(latRad);
  const dLon = km / (111.32 * (Math.abs(cosLat) < 1e-6 ? 1 : cosLat)); // km pro Längengrad

  const b: [number, number, number, number] = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];

  return polygon([
    [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]],
      [b[0], b[1]],
    ],
  ]);
}

/**
 * callValhalla:
 * - escape_mode an /api/route/valhalla weiterreichen
 * - alternates optional überschreiben
 * - avoid_polygons setzen
 */
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
    // Wichtig: nur avoid_polygons verwenden (klarer, weniger "doppelte" Interpretation)
    avoid_polygons: avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined,
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

/**
 * Precheck-Call: zweite Ebene VOR Routing.
 * Wichtig: Wir blocken hier NICHT hart, außer require_clean=true,
 * damit du so selten wie möglich "BLOCKED" siehst.
 */
async function callPrecheck(origin: string, payload: any, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${origin}/api/route/precheck`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text().catch(() => "");
    try {
      return { ok: res.ok, data: JSON.parse(text) };
    } catch {
      return { ok: false, data: { status: "WARN", error: "Precheck returned non-JSON", raw: text?.slice?.(0, 200) } };
    }
  } catch (e: any) {
    return { ok: false, data: { status: "WARN", error: String(e) } };
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
      let cc: any = null;
      try {
        cc = centroid(obs).geometry.coordinates;
      } catch {
        cc = null;
      }

      blockingWarnings.push({
        title: obs.properties?.title,
        description: obs.properties?.description,
        limits,
        coords: cc,
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
 * Statt "die ersten N Boxen" nehmen wir N Boxen gleichmäßig verteilt über die Route.
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

  // Dedupe
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = JSON.stringify(x);
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

function prioritizeObstacles(obstacles: Feature<any>[], start: Coords, end: Coords, corridorKm: number, cap: number) {
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
  try {
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

    const requireClean = Boolean(body.require_clean);

    const ts = body.ts ?? new Date().toISOString();
    const tz = body.tz ?? "Europe/Berlin";

    const vWidth = body.vehicle?.width_m ?? 2.55;
    const vWeight = body.vehicle?.weight_t ?? 40;

    /**
     * Aggressiver suchen, aber Vercel maxDuration=60 respektieren:
     * Wir planen bis ~55s, danach müssen wir raus.
     */
    const TIME_BUDGET_MS = 55_000;
    const t0 = Date.now();
    const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

    /**
     * Timeouts pro Valhalla Call:
     * - initial moderat
     * - eskaliert später
     */
    const baseValhallaTimeout = vWidth >= 3 ? 12_000 : 14_000;
    const maxValhallaTimeout = 19_000; // minimal erhöht, damit Eskalation real Wirkung hat

    const ROADWORKS_TIMEOUT_MS = 6_000;
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

    // --- PRECHECK (2. Ebene) ---
    // Wichtig: Damit du "so selten wie möglich BLOCKED" siehst,
    // brechen wir nur hart ab, wenn require_clean=true.
    if (timeLeft() > 3_000) {
      const precheckPayload = {
        start,
        end,
        vehicle: body.vehicle,
        roadworks: body.roadworks,
      };

      const pre = await callPrecheck(origin, precheckPayload, 2_800);

      if (pre.ok && pre.data) {
        phases.push({
          phase: "PRECHECK",
          result: pre.data?.status ?? "UNKNOWN",
          clean: pre.data?.clean ?? null,
          blocking_count: pre.data?.blocking_count ?? null,
          message: pre.data?.message ?? null,
        });

        if (pre.data?.status === "BLOCKED" && requireClean) {
          // require_clean verlangt CLEAN-only => hier korrekt BLOCKED
          return NextResponse.json({
            meta: {
              source: "route/plan-v21-least-roadworks",
              status: "BLOCKED",
              clean: false,
              error:
                "Precheck: Korridor ist grundsätzlich nicht befahrbar (require_clean=true). " +
                "Es wurde daher kein Routing gestartet.",
              iterations: totalIterations,
              avoids_applied: 0,
              bbox_km_used: null,
              fallback_used: false,
              phases,
            },
            avoid_applied: { total: 0 },
            geojson: { type: "FeatureCollection", features: [] },
            blocking_warnings: pre.data?.blocking ?? [],
            geojson_alts: [],
          });
        }
        // Wenn require_clean=false: KEIN harter Abbruch, wir routen trotzdem weiter
      } else {
        phases.push({
          phase: "PRECHECK",
          result: "WARN",
          clean: null,
          reason: pre.data?.error ?? "Precheck failed/timeout",
        });
      }
    } else {
      phases.push({ phase: "PRECHECK", result: "SKIPPED", reason: "time_budget_low" });
    }
    // --- PRECHECK ENDE ---

    // Avoid-Puffer: Roadworks-Buffer + Sicherheitsmarge für breite Fahrzeuge
    const baseAvoidKm = Math.max(0.03, roadworksBufferM / 1000);
    const widthExtraKm = Math.min(0.35, Math.max(0, (vWidth - 2.55) * 0.02)); // etwas aggressiver
    const avoidBufferKmBase = Math.max(baseAvoidKm, baseAvoidKm + widthExtraKm);

    const corridorWidthM = body.corridor?.width_m ?? 2000;
    const corridorKm = Math.max(6, Math.min(90, (corridorWidthM / 1000) * 6));

    // Mehr globales Avoid-Limit, aber gedeckelt (zu viele Polygone => Valhalla instabil)
    const MAX_AVOIDS_GLOBAL = Math.max(20, Math.min(140, body.avoid_target_max ?? 60));

    const IS_WIDE = vWidth >= 3;
    const MAX_BLOCKING_SCAN = IS_WIDE ? 450 : 1000;

    const respondRequireCleanBlocked = (bestBlocking: any[], metaExtra: any) => {
      return NextResponse.json({
        meta: {
          source: "route/plan-v21-least-roadworks",
          status: "BLOCKED",
          clean: false,
          error:
            "Keine baustellenfreie Route gefunden (require_clean=true). " +
            "Es wurden sehr viele Umfahrungen versucht; dennoch blieb mindestens eine blockierende Baustelle auf der Route.",
          iterations: totalIterations,
          avoids_applied: metaExtra?.avoids_applied ?? 0,
          bbox_km_used: metaExtra?.bbox_km_used ?? null,
          fallback_used: metaExtra?.fallback_used ?? false,
          phases,
        },
        avoid_applied: { total: metaExtra?.avoids_applied ?? 0 },
        geojson: { type: "FeatureCollection", features: [] },
        blocking_warnings: bestBlocking ?? [],
        geojson_alts: [],
      });
    };

    /**
     * Eskalationsstrategie (härter):
     * - Mehr Schritte
     * - Größere BufferMul (sorgt dafür, dass Valhalla deutlich früher abbiegt)
     * - Mehr Alternates
     */
    const ESCALATIONS = [
      { alternates: 3, timeout: baseValhallaTimeout, bufferMul: 1.0 },
      { alternates: 5, timeout: Math.min(maxValhallaTimeout, baseValhallaTimeout + 3000), bufferMul: 1.15 },
      { alternates: 7, timeout: Math.min(maxValhallaTimeout, baseValhallaTimeout + 4500), bufferMul: 1.45 },
      { alternates: 9, timeout: maxValhallaTimeout, bufferMul: 1.85 },
      { alternates: 11, timeout: maxValhallaTimeout, bufferMul: 2.25 },
    ];

    // --- FAST PATH (lange Strecken) ---
    if (approxKm >= LONG_ROUTE_KM) {
      if (timeLeft() < baseValhallaTimeout + 4_000) {
        return NextResponse.json(
          {
            meta: {
              source: "route/plan-v21-least-roadworks",
              status: "ERROR",
              clean: false,
              error: "Zeitbudget zu klein (FAST_PATH Start).",
              iterations: totalIterations,
              avoids_applied: 0,
              bbox_km_used: null,
              fallback_used: true,
              phases: phases.concat([{ phase: "FAST_PATH", approx_km: approxKm, result: "TIME_BUDGET" }]),
            },
            avoid_applied: { total: 0 },
            geojson: { type: "FeatureCollection", features: [] },
            blocking_warnings: [],
            geojson_alts: [],
          },
          { status: 200 }
        );
      }

      const res0 = await callValhalla(origin, plannerReqBase, [], baseValhallaTimeout, false);
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
              phases: phases.concat([{ phase: "FAST_PATH", approx_km: approxKm, result: "NO_ROUTE", reason: res0?.error ?? null }]),
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

      const chunkKm = 220;
      const overlapKm = 55;
      const expandKm = Math.max(12, Math.min(34, corridorKm));

      const boxesAll = chunkRouteToBBoxes(coords, chunkKm, overlapKm, expandKm);
      const MAX_BOXES_FAST = 6;
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

      const merged = mergeObstacles(allFeat, 2200);
      const obstacles: Feature<any>[] = prioritizeObstacles(merged, start, end, corridorKm, 1700);

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

      // Aggressiver als vorher (aber noch im Zeitbudget machbar)
      const MAX_ITER_FAST = IS_WIDE ? 8 : 16;
      const MAX_AVOIDS_FAST = Math.min(MAX_AVOIDS_GLOBAL, IS_WIDE ? 90 : 120);
      const MAX_NEW_AVOIDS_PER_ITER = IS_WIDE ? 14 : 20;

      const avoidIds = new Set<string>();
      let avoids: Feature<Polygon>[] = [];
      let stuckReason: string | null = null;

      for (let i = 0; i < MAX_ITER_FAST; i++) {
        if (timeLeft() < baseValhallaTimeout + 3_500) {
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

          const blocksWidth =
            limits.width > 0 && limits.width < vWidth;

          const blocksWeight =
            limits.weight > 0 && limits.weight < vWeight;

          if (blocksWidth || blocksWeight) {
            const id = stableObsId(obs);
            if (!avoidIds.has(id)) {
              blockingObs.push(obs);
              if (blockingObs.length >= MAX_BLOCKING_SCAN) break;
            }
          }


        if (blockingObs.length === 0) {
          stuckReason = "Blockierende Baustellen erkannt, aber keine neuen Avoid-Polygone ableitbar.";
          break;
        }

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

          // leicht aggressiver, damit wir früher wegleiten
          const poly = createAvoidPolygon(obs, avoidBufferKmBase * 1.15);
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

        // Mit Avoids -> escape_mode + mehr Alternates
        const res = await callValhalla(origin, plannerReqBase, avoids, baseValhallaTimeout, true, 5);
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

      // Eskalationspässe
      if (best.blockingWarnings.length > 0) {
        for (let e = 0; e < ESCALATIONS.length; e++) {
          const esc = ESCALATIONS[e];
          const needMs = esc.timeout + 3_500;
          if (timeLeft() < needMs) break;

          // Buffer erhöhen -> zwingt Valhalla früher abzufahren
          // Wichtig: Wir erzeugen zusätzliche Avoids um noch nicht "avoidete" Hindernisse
          const bumped: Feature<Polygon>[] = [];
          for (const obs of obstacles) {
            const limits = getLimits(obs.properties);

            const blocksWidth =
              limits.width > 0 && limits.width < vWidth;

            const blocksWeight =
              limits.weight > 0 && limits.weight < vWeight;

            if (!blocksWidth && !blocksWeight) continue;


            const id = stableObsId(obs);
            if (avoidIds.has(id)) continue;

            const poly = createAvoidPolygon(obs, avoidBufferKmBase * esc.bufferMul);
            if (!poly) continue;

            bumped.push(poly);
            avoidIds.add(id);

            if (avoids.length + bumped.length >= MAX_AVOIDS_FAST) break;
            if (bumped.length >= (IS_WIDE ? 28 : 40)) break;
          }
          avoids = avoids.concat(bumped);

          totalIterations++;

          const resEsc = await callValhalla(origin, plannerReqBase, avoids, esc.timeout, true, esc.alternates);
          const routeEsc: FeatureCollection = resEsc?.geojson ?? { type: "FeatureCollection", features: [] };

          if (!routeEsc?.features?.length) {
            phases.push({
              phase: "FAST_PATH_ESCALATION",
              step: e,
              alternates: esc.alternates,
              timeout_ms: esc.timeout,
              bufferMul: esc.bufferMul,
              result: "NO_ROUTE",
              reason: resEsc?.error ?? null,
              avoids_applied: avoids.length,
            });
            continue;
          }

          const statsEsc = computeRouteStats(routeEsc, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight, avoidIds);
          const candEsc: Candidate = {
            route: routeEsc,
            blockingWarnings: statsEsc.blockingWarnings,
            roadworksHits: statsEsc.roadworksHits,
            distance_km: extractDistanceKm(routeEsc),
            meta: { bbox_km: null, avoids_applied: avoids.length, fallback_used: true },
          };

          best = pickBetterCandidate(best, candEsc);

          phases.push({
            phase: "FAST_PATH_ESCALATION",
            step: e,
            alternates: esc.alternates,
            timeout_ms: esc.timeout,
            bufferMul: esc.bufferMul,
            result: best.blockingWarnings.length === 0 ? "CLEAN" : "STILL_BLOCKED",
            avoids_applied: avoids.length,
          });

          if (best.blockingWarnings.length === 0) break;
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

      if (requireClean && best.blockingWarnings.length > 0) {
        return respondRequireCleanBlocked(best.blockingWarnings, {
          avoids_applied: best.meta.avoids_applied,
          bbox_km_used: null,
          fallback_used: true,
        });
      }

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
    const BBOX_STEPS_KM = [200, 400, 800, 1400, 2200, 3200];

    const MAX_ITERATIONS_PER_STEP = IS_WIDE ? 8 : 16;
    const MAX_AVOIDS_TOTAL = Math.min(MAX_AVOIDS_GLOBAL, IS_WIDE ? 110 : 140);
    const MAX_NEW_AVOIDS_PER_ITER = IS_WIDE ? 14 : 20;

    let best: Candidate | null = null;
    const altCandidates: Candidate[] = [];

    for (const bboxKm of BBOX_STEPS_KM) {
      if (timeLeft() < baseValhallaTimeout + 6_000) break;

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

      const corridorKmStep = Math.min(120, Math.max(corridorKm, bboxKm * 0.045));
      const obstacles: Feature<any>[] = prioritizeObstacles(rawObstacles, start, end, corridorKmStep, 1900);

      let avoids: Feature<Polygon>[] = [];
      const avoidIds = new Set<string>();

      let iterations = 0;
      let stuckReason: string | null = null;

      while (iterations < MAX_ITERATIONS_PER_STEP) {
        const localTimeout = Math.min(maxValhallaTimeout, baseValhallaTimeout + Math.min(6_000, iterations * 900));
        if (timeLeft() < localTimeout + 3_500) {
          stuckReason = "Zeitbudget erreicht (STRICT abgebrochen).";
          break;
        }

        iterations++;
        totalIterations++;

        const escapeNow = avoids.length > 0;
        const res = await callValhalla(origin, plannerReqBase, avoids, localTimeout, escapeNow, escapeNow ? 5 : undefined);

        const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };

        if (!route?.features?.length) {
          stuckReason = res?.error ?? "Keine Route gefunden (Valhalla).";
          // In STRICT eskalieren wir innerhalb der Stufe: Buffer erhöhen und weiter versuchen (statt sofort abzubrechen)
          // Wenn wir noch keine Avoids haben, ist ohne Route aber wenig zu tun -> nächster bboxKm Schritt kommt.
          if (avoids.length === 0) break;

          // Wenn Avoids existieren und wir keine Route bekommen, machen wir die Avoids NICHT größer,
          // sondern versuchen es mit weniger Druck: etwas kleinere Subset (pop), um wieder eine Route zu bekommen.
          avoids = avoids.slice(0, Math.max(0, avoids.length - (IS_WIDE ? 6 : 10)));
          continue;
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

        if (altCandidates.length < 3) {
          const alreadySimilar = altCandidates.some((c) => Math.abs((c.distance_km || 0) - (cand.distance_km || 0)) < 0.1);
          if (!alreadySimilar) altCandidates.push(cand);
        }

        if (blockingWarnings.length === 0) {
          stuckReason = null;
          break;
        }

        // Blocking obs aus aktueller Route ableiten und Avoids erweitern
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

          const blocksWidth =
            limits.width > 0 && limits.width < vWidth;

          const blocksWeight =
            limits.weight > 0 && limits.weight < vWeight;

          if (blocksWidth || blocksWeight) {
            const id = stableObsId(obs);
            if (!avoidIds.has(id)) {
              blockingObs.push(obs);
              if (blockingObs.length >= MAX_BLOCKING_SCAN) break;
            }
          }


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

          // In STRICT ebenfalls leicht aggressiver: früher rauslenken
          const poly = createAvoidPolygon(obs, avoidBufferKmBase * 1.25);
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

    if (!best?.route?.features?.length && timeLeft() >= baseValhallaTimeout + 3_500) {
      const fallbackRes = await callValhalla(origin, plannerReqBase, [], baseValhallaTimeout, false);
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

    if (requireClean && best.blockingWarnings.length > 0) {
      return respondRequireCleanBlocked(best.blockingWarnings, {
        avoids_applied: best.meta.avoids_applied,
        bbox_km_used: best.meta.bbox_km,
        fallback_used: best.meta.fallback_used,
      });
    }

    const status: "CLEAN" | "WARN" =
      best.blockingWarnings.length > 0 ? "WARN" : "CLEAN";

    const errorMsg =
      status === "WARN"
        ? "Route gefunden, aber es gibt blockierende Baustellen. Es wurden Umfahrungen versucht; bitte Warnungen prüfen."
        : null;

    const geojson_alts = altCandidates
      .filter((c) => c.route?.features?.length)
      .map((c) => c.route);

    return NextResponse.json(
      {
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
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        meta: {
          source: "route/plan-v21-least-roadworks",
          status: "ERROR",
          clean: false,
          error: String(err?.message ?? err ?? "Unbekannter Fehler"),
        },
        geojson: {
          type: "FeatureCollection",
          features: [],
        },
        blocking_warnings: [],
        geojson_alts: [],
      },
      { status: 500 }
    );
  }
}

