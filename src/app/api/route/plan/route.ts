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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSafeBBox(start: Coords, end: Coords, bufferKm: number): [number, number, number, number] {
  const line = lineString([start, end]);
  const buffered = buffer(line as any, bufferKm, { units: "kilometers" });
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

/**
 * Einheitliche Logik: "blockt dieses Hindernis das Fahrzeug?"
 * - NULL/0/NaN => keine Aussage => blockt NICHT
 * - ansonsten: wenn Limit < Fahrzeugwert => blockt
 */
function blocksVehicle(limits: { width: number | null; weight: number | null }, vWidth: number, vWeight: number) {
  const w = limits.width;
  const wt = limits.weight;

  const blocksWidth = typeof w === "number" && Number.isFinite(w) && w > 0 && w < vWidth;
  const blocksWeight = typeof wt === "number" && Number.isFinite(wt) && wt > 0 && wt < vWeight;

  return {
    blocksWidth,
    blocksWeight,
    blocksAny: blocksWidth || blocksWeight,
  };
}

function stableObsId(obs: Feature<any>): string {
  const p: any = obs.properties || {};
  return String(p.roadwork_id ?? p.external_id ?? p.restriction_id ?? p.id ?? JSON.stringify(bboxFn(obs)));
}

/**
 * Robust: Avoid-Polygon um eine Baustelle.
 * Wir erzeugen IMMER ein Avoid-Rechteck um centroid/bbox-mitte => sehr stabil.
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

  // Fallback: bbox-mitte
  if (lon === null || lat === null || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    try {
      const b = bboxFn(f as any) as [number, number, number, number];
      lon = (b[0] + b[2]) / 2;
      lat = (b[1] + b[3]) / 2;
    } catch {
      return null;
    }
  }

  const latRad = (lat * Math.PI) / 180;
  const dLat = km / 110.574;
  const cosLat = Math.cos(latRad);
  const dLon = km / (111.32 * (Math.abs(cosLat) < 1e-6 ? 1 : cosLat));

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
 * FIX: aus Route GeoJSON sicher Koordinaten holen
 * (behebt: "getRouteCoords is not defined" + defensive parsing)
 */
function getRouteCoords(route: FeatureCollection): Coords[] {
  try {
    const f: any = route?.features?.[0];
    const coords: any = f?.geometry?.coordinates;
    if (!Array.isArray(coords)) return [];

    // Erwartet LineString: [ [lon,lat], ... ]
    if (coords.length && Array.isArray(coords[0]) && coords[0].length >= 2) {
      return coords
        .map((c: any) => [Number(c[0]), Number(c[1])] as Coords)
        .filter((c: Coords) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
    }
    return [];
  } catch {
    return [];
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

async function postJSON<T>(origin: string, path: string, body: any, timeoutMs: number): Promise<{ ok: boolean; data: T | null; error?: string; ms: number }> {
  const controller = new AbortController();
  const t0 = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, data: null, error: `HTTP ${r.status}`, ms };

    const json = (await r.json()) as T;
    return { ok: true, data: json, ms };
  } catch (e: any) {
    const ms = Date.now() - t0;
    return { ok: false, data: null, error: String(e?.name === "AbortError" ? `AbortError: ${e?.message ?? "aborted"}` : e), ms };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Roadworks: robust (Retry + kurze Backoff), aber niemals Route blockieren.
 */
async function fetchRoadworksRobust(
  origin: string,
  payload: any,
  timeoutMs: number,
  tries: number
): Promise<{ ok: boolean; features: Feature<any>[]; ms: number; error?: string }> {
  let lastErr: string | undefined;
  let lastMs = 0;

  for (let i = 0; i < tries; i++) {
    const r = await postJSON<{ features: Feature<any>[] }>(origin, "/api/roadworks", payload, timeoutMs);
    lastMs = r.ms;

    if (r.ok && r.data && Array.isArray((r.data as any).features)) {
      return { ok: true, features: ((r.data as any).features ?? []) as Feature<any>[], ms: r.ms };
    }

    lastErr = r.error ?? "unknown";
    // kleiner Backoff (aber kurz halten -> wir sind in maxDuration)
    if (i < tries - 1) await sleep(120 + i * 160);
  }

  return { ok: false, features: [], ms: lastMs, error: lastErr };
}

/**
 * Precheck-Call: zweite Ebene VOR Routing.
 * Wichtig: Wir blocken hier NICHT hart, außer require_clean=true.
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

function safeRouteBuffer(lineFeature: any, routeBufferKm: number) {
  try {
    return buffer(lineFeature as any, routeBufferKm, { units: "kilometers" });
  } catch {
    return null;
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

  if (!route?.features?.length || !Array.isArray(obstacles) || obstacles.length === 0) {
    return { blockingWarnings, roadworksHits };
  }

  const line = route.features[0];
  const routeBufferPoly = safeRouteBuffer(line as any, routeBufferKm);
  if (!routeBufferPoly) return { blockingWarnings, roadworksHits };

  for (const obs of obstacles) {
    if (!booleanIntersects(routeBufferPoly as any, obs)) continue;

    roadworksHits++;

    const limits = getLimits(obs.properties);
    const { blocksAny } = blocksVehicle(limits, vWidth, vWeight);
    if (!blocksAny) continue;

    let cc: any = null;
    try {
      cc = centroid(obs as any).geometry.coordinates;
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
    Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLon / 2) * (Math.sin(dLon / 2)));
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
      const bb = bboxFn(buffer(ls as any, expandKm, { units: "kilometers" }) as any) as [number, number, number, number];
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
    const bb = bboxFn(buffer(ls as any, expandKm, { units: "kilometers" }) as any) as [number, number, number, number];
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
    corridorPoly = buffer(lineString([start, end]) as any, corridorKm, { units: "kilometers" });
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
            source: "route/plan-v23-roadworks-robust",
            status: "BLOCKED",
            clean: false,
            error: "Ungültige Eingabe: start/end fehlen oder sind nicht [lon,lat].",
          },
          geojson: { type: "FeatureCollection", features: [] },
          blocking_warnings: [],
          geojson_alts: [],
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
     * Zeitbudget (Vercel 60s). Wir halten bewusst Puffer für Cold-Starts/Overhead.
     * Ziel: niemals in FUNCTION_INVOCATION_TIMEOUT laufen.
     */
    const TIME_BUDGET_MS = 44_000;
    const t0 = Date.now();
    const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

    /**
     * Valhalla timeouts:
     * eher konservativ, damit wir nicht "hängen".
     */
    const baseValhallaTimeout = vWidth >= 3 ? 8_500 : 10_500;
    const maxValhallaTimeout = 13_000;

    const ROADWORKS_TIMEOUT_MS = 4_200;
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
    const onlyMotorways = body.roadworks?.only_motorways ?? false;

    // Precheck (niemals hart blockieren außer require_clean)
    if (timeLeft() > 3_000) {
      const precheckPayload = { start, end, vehicle: body.vehicle, roadworks: body.roadworks };
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
          return NextResponse.json({
            meta: {
              source: "route/plan-v23-roadworks-robust",
              status: "BLOCKED",
              clean: false,
              error:
                "Precheck: Korridor ist grundsätzlich nicht befahrbar (require_clean=true). Es wurde daher kein Routing gestartet.",
              iterations: totalIterations,
              avoids_applied: 0,
              bbox_km_used: null,
              fallback_used: false,
              roadworks: { status: "SKIPPED" },
              phases,
            },
            avoid_applied: { total: 0 },
            geojson: { type: "FeatureCollection", features: [] },
            blocking_warnings: pre.data?.blocking ?? [],
            geojson_alts: [],
          });
        }
      } else {
        phases.push({ phase: "PRECHECK", result: "WARN", clean: null, reason: pre.data?.error ?? "Precheck failed/timeout" });
      }
    } else {
      phases.push({ phase: "PRECHECK", result: "SKIPPED", reason: "time_budget_low" });
    }

    // Avoid-Parameter
    const baseAvoidKm = Math.max(0.03, roadworksBufferM / 1000);
    const widthExtraKm = Math.min(0.35, Math.max(0, (vWidth - 2.55) * 0.02));
    const avoidBufferKmBase = Math.max(baseAvoidKm, baseAvoidKm + widthExtraKm);

    const corridorWidthM = body.corridor?.width_m ?? 2000;
    const corridorKm = Math.max(6, Math.min(90, (corridorWidthM / 1000) * 6));

    const MAX_AVOIDS_GLOBAL = Math.max(20, Math.min(140, body.avoid_target_max ?? 60));
    const IS_WIDE = vWidth >= 3;
    const MAX_BLOCKING_SCAN = IS_WIDE ? 450 : 900;

    const respondRequireCleanBlocked = (bestBlocking: any[], metaExtra: any) => {
      return NextResponse.json({
        meta: {
          source: "route/plan-v23-roadworks-robust",
          status: "BLOCKED",
          clean: false,
          error:
            "Keine baustellenfreie Route gefunden (require_clean=true). Es wurden viele Umfahrungen versucht; dennoch blieb mindestens eine blockierende Baustelle auf der Route.",
          iterations: totalIterations,
          avoids_applied: metaExtra?.avoids_applied ?? 0,
          bbox_km_used: metaExtra?.bbox_km_used ?? null,
          fallback_used: metaExtra?.fallback_used ?? false,
          roadworks: metaExtra?.roadworks ?? { status: "UNKNOWN" },
          phases,
        },
        avoid_applied: { total: metaExtra?.avoids_applied ?? 0 },
        geojson: { type: "FeatureCollection", features: [] },
        blocking_warnings: bestBlocking ?? [],
        geojson_alts: [],
      });
    };

    const ESCALATIONS = [
      { alternates: 3, timeout: baseValhallaTimeout, bufferMul: 1.0 },
      { alternates: 5, timeout: Math.min(maxValhallaTimeout, baseValhallaTimeout + 2_500), bufferMul: 1.2 },
      { alternates: 7, timeout: Math.min(maxValhallaTimeout, baseValhallaTimeout + 4_000), bufferMul: 1.55 },
      { alternates: 9, timeout: maxValhallaTimeout, bufferMul: 1.95 },
    ];

    /**
     * FAST PATH (lange Strecken):
     * Priorität: IMMER eine Route liefern.
     * Roadworks nur "best effort" (falls fail -> Route trotzdem zurück).
     */
    if (approxKm >= LONG_ROUTE_KM) {
      if (timeLeft() < baseValhallaTimeout + 2_800) {
        // notfalls: kein Routing versuchen, aber das ist extrem selten
        return NextResponse.json({
          meta: {
            source: "route/plan-v23-roadworks-robust",
            status: "ERROR",
            clean: false,
            error: "Zeitbudget zu klein (FAST_PATH Start).",
            iterations: totalIterations,
            avoids_applied: 0,
            bbox_km_used: null,
            fallback_used: true,
            roadworks: { status: "SKIPPED" },
            phases: phases.concat([{ phase: "FAST_PATH", approx_km: approxKm, result: "TIME_BUDGET" }]),
          },
          avoid_applied: { total: 0 },
          geojson: { type: "FeatureCollection", features: [] },
          blocking_warnings: [],
          geojson_alts: [],
        });
      }

      const res0 = await callValhalla(origin, plannerReqBase, [], baseValhallaTimeout, false);
      const route0: FeatureCollection = res0?.geojson ?? { type: "FeatureCollection", features: [] };

      if (!route0?.features?.length) {
        return NextResponse.json({
          meta: {
            source: "route/plan-v23-roadworks-robust",
            status: "BLOCKED",
            clean: false,
            error: res0?.error ?? "Keine Route gefunden (FAST_PATH).",
            iterations: totalIterations,
            avoids_applied: 0,
            bbox_km_used: null,
            fallback_used: true,
            roadworks: { status: "SKIPPED" },
            phases: phases.concat([{ phase: "FAST_PATH", approx_km: approxKm, result: "NO_ROUTE", reason: res0?.error ?? null }]),
          },
          avoid_applied: { total: 0 },
          geojson: { type: "FeatureCollection", features: [] },
          blocking_warnings: [],
          geojson_alts: [],
        });
      }

      const coords = getRouteCoords(route0);

      // Roadworks sampling entlang Route (best effort)
      const chunkKm = 220;
      const overlapKm = 55;
      const expandKm = Math.max(12, Math.min(34, corridorKm));

      const boxesAll = chunkRouteToBBoxes(coords, chunkKm, overlapKm, expandKm);
      const MAX_BOXES_FAST = 6;
      const boxes = pickSpreadBoxes(boxesAll, MAX_BOXES_FAST);

      let obstacles: Feature<any>[] = [];
      const rwTelemetry: any = {
        status: "SKIPPED",
        boxes_total: boxes.length,
        boxes_ok: 0,
        boxes_failed: 0,
        timeout_ms: ROADWORKS_TIMEOUT_MS,
        only_motorways: onlyMotorways,
        buffer_m: roadworksBufferM,
        notes: null as string | null,
      };

      if (boxes.length && timeLeft() > ROADWORKS_TIMEOUT_MS + 2_000) {
        rwTelemetry.status = "RUNNING";

        // Parallel, aber jedes Request hat eigenes Timeout + Retry
        const rwPromises = boxes.map((bb) =>
          fetchRoadworksRobust(
            origin,
            { ts, tz, bbox: bb, buffer_m: roadworksBufferM, only_motorways: onlyMotorways },
            ROADWORKS_TIMEOUT_MS,
            2
          )
        );

        const rwResults = await Promise.all(rwPromises);

        const allFeat: Feature<any>[][] = [];
        for (const r of rwResults) {
          if (r.ok) {
            rwTelemetry.boxes_ok++;
            allFeat.push(r.features);
          } else {
            rwTelemetry.boxes_failed++;
            allFeat.push([]);
          }
        }

        if (rwTelemetry.boxes_ok > 0) {
          rwTelemetry.status = rwTelemetry.boxes_failed > 0 ? "DEGRADED" : "OK";
          const merged = mergeObstacles(allFeat, 2200);
          obstacles = prioritizeObstacles(merged, start, end, corridorKm, 1700);
        } else {
          rwTelemetry.status = "FAILED";
          rwTelemetry.notes = "Baustellendaten konnten nicht geladen werden (alle Boxen fehlgeschlagen).";
          obstacles = [];
        }

        phases.push({
          phase: "ROADWORKS_FAST",
          boxes_total: rwTelemetry.boxes_total,
          boxes_ok: rwTelemetry.boxes_ok,
          boxes_failed: rwTelemetry.boxes_failed,
          status: rwTelemetry.status,
        });
      } else {
        rwTelemetry.status = "SKIPPED";
        phases.push({ phase: "ROADWORKS_FAST", status: "SKIPPED", reason: "time_budget_low_or_no_boxes" });
      }

      const stats0 = computeRouteStats(route0, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight);

      let best: Candidate = {
        route: route0,
        blockingWarnings: stats0.blockingWarnings,
        roadworksHits: stats0.roadworksHits,
        distance_km: extractDistanceKm(route0),
        meta: { bbox_km: null, avoids_applied: 0, fallback_used: true },
      };

      // Wenn wir keine Obstacles haben: sofort Route liefern, aber Telemetrie zeigt Roadworks FAIL.
      // Das ist absichtlich: Route > Baustellen.
      if (!obstacles.length) {
        return NextResponse.json({
          meta: {
            source: "route/plan-v23-roadworks-robust",
            status: "CLEAN",
            clean: true,
            error: rwTelemetry.status === "FAILED" ? "Baustellendaten konnten nicht geladen werden." : null,
            iterations: totalIterations,
            avoids_applied: 0,
            bbox_km_used: null,
            fallback_used: true,
            roadworks: rwTelemetry,
            phases,
          },
          avoid_applied: { total: 0 },
          geojson: best.route,
          blocking_warnings: [],
          geojson_alts: [],
        });
      }

      // Wenn blockierend: nur begrenzt iterieren (Zeitbudget schützen)
      const MAX_ITER_FAST = IS_WIDE ? 6 : 10;
      const MAX_AVOIDS_FAST = Math.min(MAX_AVOIDS_GLOBAL, IS_WIDE ? 80 : 110);
      const MAX_NEW_AVOIDS_PER_ITER = IS_WIDE ? 12 : 18;

      const avoidIds = new Set<string>();
      let avoids: Feature<Polygon>[] = [];
      let stuckReason: string | null = null;

      for (let i = 0; i < MAX_ITER_FAST; i++) {
        if (timeLeft() < baseValhallaTimeout + 2_600) {
          stuckReason = "Zeitbudget erreicht (FAST_PATH Iteration abgebrochen).";
          break;
        }

        totalIterations++;

        const line = best.route.features[0];
        const routeBufferPoly = safeRouteBuffer(line as any, ROUTE_BUFFER_KM);
        if (!routeBufferPoly) {
          stuckReason = "Route-Buffer konnte nicht erzeugt werden.";
          break;
        }

        const blockingObs: Feature<any>[] = [];
        for (const obs of obstacles) {
          if (!booleanIntersects(routeBufferPoly as any, obs)) continue;

          const limits = getLimits(obs.properties);
          const { blocksAny } = blocksVehicle(limits, vWidth, vWeight);
          if (!blocksAny) continue;

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
          if (la.width !== lb.width) return (la.width ?? 0) - (lb.width ?? 0);
          return (la.weight ?? 0) - (lb.weight ?? 0);
        });

        let added = 0;
        for (const obs of blockingObs) {
          if (avoids.length >= MAX_AVOIDS_FAST) break;

          const id = stableObsId(obs);
          if (avoidIds.has(id)) continue;

          const poly = createAvoidPolygon(obs, avoidBufferKmBase * 1.15);
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

      // Eskalation (limitiert)
      if (best.blockingWarnings.length > 0) {
        for (let e = 0; e < ESCALATIONS.length; e++) {
          const esc = ESCALATIONS[e];
          if (timeLeft() < esc.timeout + 2_600) break;

          const bumped: Feature<Polygon>[] = [];
          for (const obs of obstacles) {
            const limits = getLimits(obs.properties);
            const { blocksAny } = blocksVehicle(limits, vWidth, vWeight);
            if (!blocksAny) continue;

            const id = stableObsId(obs);
            if (avoidIds.has(id)) continue;

            const poly = createAvoidPolygon(obs, avoidBufferKmBase * esc.bufferMul);
            if (!poly) continue;

            bumped.push(poly);
            avoidIds.add(id);

            if (avoids.length + bumped.length >= MAX_AVOIDS_FAST) break;
            if (bumped.length >= (IS_WIDE ? 22 : 34)) break;
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
          roadworks: rwTelemetry,
        });
      }

      const status: "CLEAN" | "WARN" = best.blockingWarnings.length ? "WARN" : "CLEAN";
      const errorMsg =
        status === "WARN"
          ? "Route gefunden, aber es gibt blockierende Baustellen. Es wurden Umfahrungen versucht; bitte Warnungen prüfen."
          : rwTelemetry.status === "FAILED"
          ? "Baustellendaten konnten nicht geladen werden."
          : null;

      return NextResponse.json({
        meta: {
          source: "route/plan-v23-roadworks-robust",
          status,
          clean: status === "CLEAN",
          error: errorMsg,
          iterations: totalIterations,
          avoids_applied: best.meta.avoids_applied,
          bbox_km_used: null,
          fallback_used: true,
          roadworks: rwTelemetry,
          phases,
        },
        avoid_applied: { total: best.meta.avoids_applied },
        geojson: best.route,
        blocking_warnings: best.blockingWarnings,
        geojson_alts: [],
      });
    }

    /**
     * STRICT (kürzere Strecken):
     * Roadworks ist "best effort". Bei Roadworks-Fail routen wir trotzdem (ohne Avoids).
     */
    const BBOX_STEPS_KM = IS_WIDE ? [200, 600, 1400, 2200] : [200, 400, 800, 1400, 2200, 3200];

    const MAX_ITERATIONS_PER_STEP = IS_WIDE ? 8 : 14;
    const MAX_AVOIDS_TOTAL = Math.min(MAX_AVOIDS_GLOBAL, IS_WIDE ? 100 : 130);
    const MAX_NEW_AVOIDS_PER_ITER = IS_WIDE ? 12 : 18;

    let best: Candidate | null = null;
    const altCandidates: Candidate[] = [];

    // global roadworks telemetry (STRICT)
    const roadworksMeta: any = {
      status: "SKIPPED",
      boxes_total: 0,
      boxes_ok: 0,
      boxes_failed: 0,
      timeout_ms: ROADWORKS_TIMEOUT_MS,
      only_motorways: onlyMotorways,
      buffer_m: roadworksBufferM,
      notes: null as string | null,
    };

    for (const bboxKm of BBOX_STEPS_KM) {
      if (timeLeft() < baseValhallaTimeout + ROADWORKS_TIMEOUT_MS + 2_800) break;

      const bbox = makeSafeBBox(start, end, bboxKm);

      roadworksMeta.status = "RUNNING";
      roadworksMeta.boxes_total += 1;

      const rw = await fetchRoadworksRobust(
        origin,
        { ts, tz, bbox, buffer_m: roadworksBufferM, only_motorways: onlyMotorways },
        ROADWORKS_TIMEOUT_MS,
        2
      );

      let obstacles: Feature<any>[] = [];
      let roadworksStatusForStep: "OK" | "DEGRADED" | "FAILED" = "FAILED";

      if (rw.ok) {
        roadworksMeta.boxes_ok += 1;
        obstacles = prioritizeObstacles((rw.features ?? []) as Feature<any>[], start, end, Math.min(120, Math.max(corridorKm, bboxKm * 0.045)), 1900);
        roadworksStatusForStep = "OK";
      } else {
        roadworksMeta.boxes_failed += 1;
        obstacles = [];
        roadworksStatusForStep = "FAILED";
      }

      // Update overall roadworks status
      if (roadworksMeta.boxes_ok > 0) roadworksMeta.status = roadworksMeta.boxes_failed > 0 ? "DEGRADED" : "OK";
      else roadworksMeta.status = "FAILED";

      phases.push({
        phase: "ROADWORKS_STRICT",
        bbox_km: bboxKm,
        ok: rw.ok,
        status: roadworksStatusForStep,
        ms: rw.ms,
        error: rw.error ?? null,
      });

      let avoids: Feature<Polygon>[] = [];
      const avoidIds = new Set<string>();

      let iterations = 0;
      let stuckReason: string | null = null;

      // Wenn keine Obstacles: wir routen ohne Avoid-Schleife (schnell + stabil)
      const shouldAvoidLoop = obstacles.length > 0;

      while (iterations < MAX_ITERATIONS_PER_STEP) {
        const localTimeout = Math.min(maxValhallaTimeout, baseValhallaTimeout + Math.min(2_800, iterations * 600));
        if (timeLeft() < localTimeout + 2_600) {
          stuckReason = "Zeitbudget erreicht (STRICT abgebrochen).";
          break;
        }

        iterations++;
        totalIterations++;

        const escapeNow = shouldAvoidLoop && avoids.length > 0;
        const res = await callValhalla(origin, plannerReqBase, avoids, localTimeout, escapeNow, escapeNow ? 5 : undefined);

        const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };

        if (!route?.features?.length) {
          stuckReason = res?.error ?? "Keine Route gefunden (Valhalla).";
          // Wenn wir ohnehin keine Obstacles haben: nicht weiter drehen -> nächster bbox step
          if (!shouldAvoidLoop) break;

          // Wenn Avoids existieren und wir keine Route bekommen: Druck reduzieren
          if (avoids.length > 0) {
            avoids = avoids.slice(0, Math.max(0, avoids.length - (IS_WIDE ? 6 : 10)));
            continue;
          }
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

        if (altCandidates.length < 3) {
          const alreadySimilar = altCandidates.some((c) => Math.abs((c.distance_km || 0) - (cand.distance_km || 0)) < 0.1);
          if (!alreadySimilar) altCandidates.push(cand);
        }

        // Wenn keine Baustellendaten: wir betrachten Route als "CLEAN" im Sinne "keine Warnungen verfügbar"
        if (!shouldAvoidLoop) {
          stuckReason = null;
          break;
        }

        if (blockingWarnings.length === 0) {
          stuckReason = null;
          break;
        }

        // Avoids erweitern
        const line = route.features[0];
        const routeBufferPoly = safeRouteBuffer(line as any, ROUTE_BUFFER_KM);
        if (!routeBufferPoly) {
          stuckReason = "Route-Buffer konnte nicht erzeugt werden.";
          break;
        }

        const blockingObs: Feature<any>[] = [];
        for (const obs of obstacles) {
          if (!booleanIntersects(routeBufferPoly as any, obs)) continue;

          const limits = getLimits(obs.properties);
          const { blocksAny } = blocksVehicle(limits, vWidth, vWeight);
          if (!blocksAny) continue;

          const id = stableObsId(obs);
          if (!avoidIds.has(id)) {
            blockingObs.push(obs);
            if (blockingObs.length >= MAX_BLOCKING_SCAN) break;
          }
        }

        blockingObs.sort((a, b) => {
          const la = getLimits(a.properties);
          const lb = getLimits(b.properties);
          if (la.width !== lb.width) return (la.width ?? 0) - (lb.width ?? 0);
          return (la.weight ?? 0) - (lb.weight ?? 0);
        });

        let added = 0;
        for (const obs of blockingObs) {
          if (avoids.length >= MAX_AVOIDS_TOTAL) break;

          const id = stableObsId(obs);
          if (avoidIds.has(id)) continue;

          const poly = createAvoidPolygon(obs, avoidBufferKmBase * 1.25);
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
      }

      phases.push({
        phase: "STRICT",
        bbox_km: bboxKm,
        iterations,
        avoids_applied: best?.meta?.avoids_applied ?? 0,
        result: best?.route?.features?.length ? "CANDIDATE" : "NO_ROUTE",
        reason: stuckReason,
        roadworks_status: roadworksStatusForStep,
      });

      if (best?.route?.features?.length && best?.blockingWarnings?.length === 0) break;
    }

    // Fallback: wenn STRICT keine Route liefert -> Valhalla ohne Roadworks
    if (!best?.route?.features?.length && timeLeft() >= baseValhallaTimeout + 2_600) {
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
          source: "route/plan-v23-roadworks-robust",
          status: "BLOCKED",
          clean: false,
          error: "Es konnte gar keine Route berechnet werden (auch nicht als Notlösung).",
          iterations: totalIterations,
          avoids_applied: 0,
          bbox_km_used: null,
          fallback_used: true,
          roadworks: roadworksMeta,
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
        roadworks: roadworksMeta,
      });
    }

    const status: "CLEAN" | "WARN" = best.blockingWarnings.length > 0 ? "WARN" : "CLEAN";
    const errorMsg =
      status === "WARN"
        ? "Route gefunden, aber es gibt blockierende Baustellen. Es wurden Umfahrungen versucht; bitte Warnungen prüfen."
        : roadworksMeta.status === "FAILED"
        ? "Baustellendaten konnten nicht geladen werden."
        : null;

    const geojson_alts = altCandidates.filter((c) => c.route?.features?.length).map((c) => c.route);

    return NextResponse.json({
      meta: {
        source: "route/plan-v23-roadworks-robust",
        status,
        clean: status === "CLEAN",
        error: errorMsg,
        iterations: totalIterations,
        avoids_applied: best.meta.avoids_applied,
        bbox_km_used: best.meta.bbox_km,
        fallback_used: best.meta.fallback_used,
        roadworks: roadworksMeta,
        phases,
      },
      avoid_applied: { total: best.meta.avoids_applied },
      geojson: best.route,
      blocking_warnings: best.blockingWarnings,
      geojson_alts,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        meta: {
          source: "route/plan-v23-roadworks-robust",
          status: "ERROR",
          clean: false,
          error: String(err?.message ?? err ?? "Unbekannter Fehler"),
        },
        geojson: { type: "FeatureCollection", features: [] },
        blocking_warnings: [],
        geojson_alts: [],
      },
      { status: 500 }
    );
  }
}
