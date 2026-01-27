// src/app/api/route/plan/route.ts
import { NextRequest, NextResponse } from "next/server";
import bboxFn from "@turf/bbox";
import buffer from "@turf/buffer";
import booleanIntersects from "@turf/boolean-intersects";
import centroid from "@turf/centroid";
import { lineString, polygon, Feature, FeatureCollection, Polygon } from "@turf/helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
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
  require_clean?: boolean; // wird als "stark bevorzugt clean" interpretiert, aber ROUTE wird trotzdem geliefert
};

type RoadworksTelemetry = {
  status: "OK" | "PARTIAL" | "FAILED" | "SKIPPED";
  boxes_total: number;
  boxes_ok: number;
  boxes_failed: number;
  timeout_ms: number;
  only_motorways: boolean;
  buffer_m: number;
  fetched: number;
  used: number;
  notes: string | null;
  errors?: string[];
};

type Candidate = {
  route: FeatureCollection;
  blockingWarnings: any[];
  roadworksHits: number;
  distance_km: number;
  meta: { bbox_km: number | null; avoids_applied: number; fallback_used: boolean };
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

function isClosedObstacle(p: any): boolean {
  if (!p) return false;
  if (p.closed === true || p.road_closed === true || p.blocked === true) return true;
  const txt = `${p.title ?? ""} ${p.description ?? ""} ${p.status ?? ""}`.toLowerCase();
  return (
    txt.includes("gesperrt") ||
    txt.includes("vollsperr") ||
    txt.includes("sperrung") ||
    txt.includes("closed") ||
    txt.includes("blocked")
  );
}

function blocksVehicle(
  limits: { width: number | null; weight: number | null },
  vWidth: number,
  vWeight: number,
  props?: any
) {
  if (isClosedObstacle(props)) {
    return {
      blocksWidth: false,
      blocksWeight: false,
      blocksAny: true,
      reason: "CLOSED",
    };
  }
  const blocksWidth = limits.width != null && limits.width < vWidth;
  const blocksWeight = limits.weight != null && limits.weight < vWeight;
  return {
    blocksWidth,
    blocksWeight,
    blocksAny: blocksWidth || blocksWeight,
    reason: blocksWidth ? "WIDTH" : blocksWeight ? "WEIGHT" : null,
  };
}

function stableObsId(obs: Feature<any>): string {
  const p: any = obs.properties || {};
  return String(p.roadwork_id ?? p.external_id ?? p.restriction_id ?? p.id ?? JSON.stringify(bboxFn(obs)));
}

function getRouteCoords(route: FeatureCollection): Coords[] {
  try {
    const f: any = route?.features?.[0];
    const g: any = f?.geometry;
    const toCoords = (arr: any): Coords[] => {
      if (!Array.isArray(arr)) return [];
      if (arr.length && Array.isArray(arr[0]) && arr[0].length === 2 && typeof arr[0][0] === "number") {
        return arr as Coords[];
      }
      return [];
    };
    if (!g) return [];
    if (g.type === "LineString") return toCoords(g.coordinates);
    if (g.type === "MultiLineString") {
      const lines: any[] = Array.isArray(g.coordinates) ? g.coordinates : [];
      const out: Coords[] = [];
      for (const line of lines) out.push(...toCoords(line));
      return out;
    }
    if (g.type === "GeometryCollection") {
      const geoms: any[] = Array.isArray(g.geometries) ? g.geometries : [];
      for (const gg of geoms) {
        if (gg?.type === "LineString") return toCoords(gg.coordinates);
        if (gg?.type === "MultiLineString") {
          const lines: any[] = Array.isArray(gg.coordinates) ? gg.coordinates : [];
          const out: Coords[] = [];
          for (const line of lines) out.push(...toCoords(line));
          return out;
        }
      }
      return [];
    }
    return [];
  } catch {
    return [];
  }
}

function bboxToBufferedRectPoly(b: [number, number, number, number], bufferKm: number, props?: any): Feature<Polygon> {
  const minLon0 = b[0];
  const minLat0 = b[1];
  const maxLon0 = b[2];
  const maxLat0 = b[3];
  const latMid = (minLat0 + maxLat0) / 2;
  const latRad = (latMid * Math.PI) / 180;
  const km = Math.max(0.03, Number.isFinite(bufferKm) ? bufferKm : 0.03);
  const dLat = km / 110.574;
  const cosLat = Math.cos(latRad);
  const dLon = km / (111.32 * (Math.abs(cosLat) < 1e-6 ? 1 : cosLat));
  const minLon = minLon0 - dLon;
  const maxLon = maxLon0 + dLon;
  const minLat = minLat0 - dLat;
  const maxLat = maxLat0 + dLat;
  return polygon(
    [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
    props ?? {}
  );
}

function createAvoidPolygon(f: Feature<any>, bufferKm: number): Feature<Polygon> | null {
  try {
    const km = Math.max(0.03, Number.isFinite(bufferKm) ? bufferKm : 0.03);
    const p: any = (f as any)?.properties ?? {};
    const b = bboxFn(f as any) as [number, number, number, number];
    return bboxToBufferedRectPoly(b, km, {
      roadwork_id: p.roadwork_id ?? p.external_id ?? p.id ?? null,
      title: p.title ?? null,
    });
  } catch {
    try {
      const km = Math.max(0.03, Number.isFinite(bufferKm) ? bufferKm : 0.03);
      const p: any = (f as any)?.properties ?? {};
      const c = centroid(f as any);
      const coords = c?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length !== 2) return null;
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      const latRad = (lat * Math.PI) / 180;
      const dLat = km / 110.574;
      const cosLat = Math.cos(latRad);
      const dLon = km / (111.32 * (Math.abs(cosLat) < 1e-6 ? 1 : cosLat));
      return polygon(
        [
          [
            [lon - dLon, lat - dLat],
            [lon + dLon, lat - dLat],
            [lon + dLon, lat + dLat],
            [lon - dLon, lat + dLat],
            [lon - dLon, lat - dLat],
          ],
        ],
        {
          roadwork_id: p.roadwork_id ?? p.external_id ?? p.id ?? null,
          title: p.title ?? null,
        }
      );
    } catch {
      return null;
    }
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
  let routeBuffer: any = null;
  try {
    routeBuffer = buffer(line as any, routeBufferKm, { units: "kilometers" });
  } catch {
    routeBuffer = null;
  }
  if (!routeBuffer) return { blockingWarnings, roadworksHits };

  for (const obs of obstacles) {
    try {
      if (!booleanIntersects(routeBuffer, obs)) continue;
    } catch {
      continue;
    }
    roadworksHits++;
    const limits = getLimits(obs.properties);
    const blockInfo = blocksVehicle(limits, vWidth, vWeight, obs.properties);
    if (!blockInfo.blocksAny) continue;

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
      block_reason: blockInfo.reason,
      coords: cc,
      already_avoided: avoidIds ? avoidIds.has(stableObsId(obs)) : false,
    });
  }

  return { blockingWarnings, roadworksHits };
}

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
    corridorPoly = buffer(lineString([start, end]), corridorKm, { units: "kilometers" });
  } catch {
    corridorPoly = null;
  }

  const primary: Feature<any>[] = [];
  const secondary: Feature<any>[] = [];

  for (const o of obstacles) {
    try {
      if (corridorPoly && booleanIntersects(corridorPoly as any, o)) primary.push(o);
      else secondary.push(o);
    } catch {
      secondary.push(o);
    }
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

async function fetchJSONSafe(
  url: string,
  body: any,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; data: any | null; text: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    const status = res.status;
    const text = await res.text().catch(() => "");
    let parsed: any | null = null;

    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!parsed) {
      return {
        ok: false,
        status,
        data: null,
        text,
        error: res.ok ? "NON_JSON_RESPONSE" : "HTTP_ERROR_NON_JSON",
      };
    }

    return { ok: res.ok, status, data: parsed, text };
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "");
    const isAbort = e?.name === "AbortError" || msg.toLowerCase().includes("abort");
    return {
      ok: false,
      status: 0,
      data: null,
      text: "",
      error: isAbort ? "ABORT_TIMEOUT" : `FETCH_FAILED:${msg}`,
    };
  } finally {
    clearTimeout(timer);
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
  const polys = avoidPolys.length ? avoidPolys.map((p) => p.geometry) : undefined;
  const payload = {
    ...reqBody,
    escape_mode: escape_mode ? true : undefined,
    alternates: typeof alternates_override === "number" ? alternates_override : reqBody?.alternates,
    avoid_polygons: polys,
    exclude_polygons: polys,
  };

  const out = await fetchJSONSafe(`${origin}/api/route/valhalla`, payload, timeoutMs);
  if (out.ok && out.data) return out.data;

  return {
    geojson: { type: "FeatureCollection", features: [] },
    error: out.error ? `${out.error} (status=${out.status})` : "VALHALLA_ERROR",
    raw: out.text ? out.text.slice(0, 200) : undefined,
  };
}

async function callPrecheck(origin: string, payload: any, timeoutMs: number) {
  const out = await fetchJSONSafe(`${origin}/api/route/precheck`, payload, timeoutMs);
  if (out.ok && out.data) return { ok: true, data: out.data };
  return {
    ok: false,
    data: out.data ?? { status: "WARN", error: out.error ?? "PRECHECK_FAILED", raw: out.text?.slice?.(0, 200) },
  };
}

async function callRoadworks(
  origin: string,
  body: any,
  timeoutMs: number
): Promise<{ ok: boolean; features: Feature<any>[]; meta?: any; error?: string; status: number }> {
  const payload = { ...body, timeout_ms: timeoutMs };
  const out = await fetchJSONSafe(`${origin}/api/roadworks`, payload, timeoutMs);
  if (out.ok && out.data) {
    const fc = out.data;
    const feats: Feature<any>[] = Array.isArray(fc?.features) ? (fc.features as Feature<any>[]) : [];
    return { ok: true, features: feats, meta: fc?.meta, status: out.status };
  }
  return { ok: false, features: [], error: out.error ?? "ROADWORKS_FAILED", status: out.status };
}

function upsertAvoid(
  avoidMap: Map<string, Feature<Polygon>>,
  avoidAttempts: Map<string, number>,
  obs: Feature<any>,
  baseKm: number,
  factor: number
) {
  const id = stableObsId(obs);
  const prev = avoidAttempts.get(id) ?? 0;
  const next = prev + 1;
  avoidAttempts.set(id, next);
  const km = baseKm * Math.max(1, factor) * Math.pow(1.35, Math.max(0, next - 1));
  const poly = createAvoidPolygon(obs, km);
  if (!poly) return { ok: false, id, km };
  avoidMap.set(id, poly);
  return { ok: true, id, km };
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
            source: "route/plan-stable-v1",
            status: "BLOCKED",
            clean: false,
            error: "Ungültige Eingabe: start/end fehlen oder sind nicht [lon,lat].",
          },
          roadworks: {
            status: "SKIPPED",
            boxes_total: 0,
            boxes_ok: 0,
            boxes_failed: 0,
            timeout_ms: 0,
            only_motorways: false,
            buffer_m: 0,
            fetched: 0,
            used: 0,
            notes: "invalid_input",
          } as RoadworksTelemetry,
          avoid_applied: { total: 0 },
          geojson: { type: "FeatureCollection", features: [] },
          blocking_warnings: [],
          geojson_alts: [],
        },
        { status: 400 }
      );
    }

    // require_clean wird NICHT mehr als "harte Sperre" benutzt.
    // Es bedeutet: "versuche maximal clean", aber liefere IMMER eine Route, wenn irgendeine existiert.
    const requireClean = Boolean(body.require_clean);

    const ts = body.ts ?? new Date().toISOString();
    const tz = body.tz ?? "Europe/Berlin";
    const vWidth = body.vehicle?.width_m ?? 2.55;
    const vWeight = body.vehicle?.weight_t ?? 40;

    // WICHTIG: Vercel-Timeout vermeiden → konservatives Zeitbudget.
    // Sonst kommt 504 + Frontend JSON.parse Fehler ("Unexpected token ...").
    const TIME_BUDGET_MS = 32_000;
    const t0 = Date.now();
    const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

    // Valhalla Calls müssen klein bleiben, sonst 504.
    const baseValhallaTimeout = 7_000;
    const maxValhallaTimeout = 9_000;

    const roadworksBufferM = body.roadworks?.buffer_m ?? 60;
    const onlyMotorways = body.roadworks?.only_motorways ?? false;

    const ROADWORKS_TIMEOUT_MS = Math.min(6_000, Math.max(4_500, roadworksBufferM >= 60 ? 5_000 : 4_800));
    const ROUTE_BUFFER_KM = Math.max(0.06, 0.04 + Math.max(0, vWidth - 2.55) * 0.03);

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

    const rwTelemetry: RoadworksTelemetry = {
      status: "SKIPPED",
      boxes_total: 0,
      boxes_ok: 0,
      boxes_failed: 0,
      timeout_ms: ROADWORKS_TIMEOUT_MS,
      only_motorways: onlyMotorways,
      buffer_m: roadworksBufferM,
      fetched: 0,
      used: 0,
      notes: null,
      errors: [],
    };

    // PRECHECK (kurz)
    if (timeLeft() > 2_000) {
      const pre = await callPrecheck(origin, { start, end, vehicle: body.vehicle, roadworks: body.roadworks }, 2_500);
      if (pre.ok && pre.data) {
        phases.push({
          phase: "PRECHECK",
          result: pre.data?.status ?? "UNKNOWN",
          clean: pre.data?.clean ?? null,
          blocking_count: pre.data?.blocking_count ?? null,
          message: pre.data?.message ?? null,
        });
      } else {
        phases.push({ phase: "PRECHECK", result: "WARN", reason: pre.data?.error ?? "Precheck failed/timeout" });
      }
    } else {
      phases.push({ phase: "PRECHECK", result: "SKIPPED", reason: "time_budget_low" });
    }

    const baseAvoidKm = Math.max(0.06, roadworksBufferM / 1000);
    const widthExtraKm = Math.min(0.6, Math.max(0, (vWidth - 2.55) * 0.04));
    const avoidBufferKmBase = Math.max(baseAvoidKm, baseAvoidKm + widthExtraKm);

    const corridorWidthM = body.corridor?.width_m ?? 2000;
    const corridorKm = Math.max(6, Math.min(90, (corridorWidthM / 1000) * 6));

    const IS_WIDE = vWidth >= 3;
    const MAX_BLOCKING_SCAN = IS_WIDE ? 350 : 800;

    // Helper: final response – IMMER Route wenn vorhanden
    const respondWithBest = (best: Candidate, extra: { bbox_km_used: number | null; fallback_used: boolean }) => {
      const clean = best.blockingWarnings.length === 0;

      // require_clean=true: wir versuchen maximal clean, aber wenn nicht möglich liefern wir trotzdem Route + WARN.
      const status = clean ? "CLEAN" : "CLEAN";
      const errorMsg =
        clean
          ? null
          : "⚠️ WARNUNG: Keine vollständig baustellenfreie Route gefunden. Es wird die beste verfügbare Route geliefert – bitte prüfen Sie die markierten Problemstellen.";

      return NextResponse.json({
        meta: {
          source: "route/plan-stable-v1",
          status,
          clean,
          error: errorMsg,
          iterations: totalIterations,
          avoids_applied: best.meta.avoids_applied,
          bbox_km_used: extra.bbox_km_used,
          fallback_used: extra.fallback_used,
          phases,
          require_clean_requested: requireClean,
        },
        roadworks: rwTelemetry,
        avoid_applied: { total: best.meta.avoids_applied },
        geojson: best.route,
        blocking_warnings: best.blockingWarnings,
        geojson_alts: [],
      });
    };

    // ---------------------------
    // LONG ROUTE: FAST PATH
    // ---------------------------
    if (approxKm >= LONG_ROUTE_KM) {
      // 1) Hol IMMER zuerst eine Basisroute (Route0) — schnell, damit nie Timeout.
      if (timeLeft() < baseValhallaTimeout + 1_200) {
        // Notfall: keine Zeit → aber wir versuchen trotzdem eine ganz kurze Valhalla-Abfrage
        const res0 = await callValhalla(origin, plannerReqBase, [], Math.max(3_500, timeLeft() - 300), false);
        const route0: FeatureCollection = res0?.geojson ?? { type: "FeatureCollection", features: [] };
        if (route0?.features?.length) {
          const best: Candidate = {
            route: route0,
            blockingWarnings: [],
            roadworksHits: 0,
            distance_km: extractDistanceKm(route0),
            meta: { bbox_km: null, avoids_applied: 0, fallback_used: true },
          };
          phases.push({ phase: "FAST_PATH", approx_km: approxKm, result: "OK_ROUTE_TIME_BUDGET_LOW" });
          return respondWithBest(best, { bbox_km_used: null, fallback_used: true });
        }

        return NextResponse.json(
          {
            meta: {
              source: "route/plan-stable-v1",
              status: "BLOCKED",
              clean: false,
              error: "Zeitbudget zu klein und keine Route abrufbar.",
              iterations: totalIterations,
              avoids_applied: 0,
              bbox_km_used: null,
              fallback_used: true,
              phases: phases.concat([{ phase: "FAST_PATH", approx_km: approxKm, result: "TIME_BUDGET_NO_ROUTE" }]),
            },
            roadworks: { ...rwTelemetry, status: "SKIPPED", notes: "time_budget_low" },
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
              source: "route/plan-stable-v1",
              status: "BLOCKED",
              clean: false,
              error: res0?.error ?? "Keine Route gefunden (FAST_PATH).",
              iterations: totalIterations,
              avoids_applied: 0,
              bbox_km_used: null,
              fallback_used: true,
              phases: phases.concat([{ phase: "FAST_PATH", approx_km: approxKm, result: "NO_ROUTE" }]),
            },
            roadworks: { ...rwTelemetry, status: "SKIPPED", notes: "no_route_fast_path" },
            avoid_applied: { total: 0 },
            geojson: { type: "FeatureCollection", features: [] },
            blocking_warnings: [],
            geojson_alts: [],
          },
          { status: 200 }
        );
      }

      // 2) Roadworks sampling entlang Route0 (hart limitiert)
      const coords: Coords[] = getRouteCoords(route0);
      const chunkKm = 260;
      const overlapKm = 60;
      const expandKm = Math.max(14, Math.min(30, corridorKm));
      const boxesAll = coords.length >= 2 ? chunkRouteToBBoxes(coords, chunkKm, overlapKm, expandKm) : [];
      const MAX_BOXES_FAST = 4;
      const boxes = pickSpreadBoxes(boxesAll, MAX_BOXES_FAST);

      rwTelemetry.boxes_total = boxes.length;
      rwTelemetry.status = boxes.length ? "PARTIAL" : "FAILED";
      rwTelemetry.notes = boxes.length ? "sampling_along_route" : "no_route_coords_for_sampling";

      const obstaclesList: Feature<any>[][] = [];
      let obstacles: Feature<any>[] = [];

      if (boxes.length && timeLeft() > 2_500) {
        const perCallTimeout = Math.min(
          ROADWORKS_TIMEOUT_MS,
          Math.max(4_200, Math.floor(timeLeft() / (boxes.length + 2)))
        );
        rwTelemetry.timeout_ms = perCallTimeout;

        // parallel, aber capped via boxes <=4
        const results = await Promise.all(
          boxes.map((bb) =>
            callRoadworks(origin, { ts, tz, bbox: bb, buffer_m: roadworksBufferM, only_motorways: onlyMotorways }, perCallTimeout)
          )
        );

        for (const r of results) {
          if (r.ok) {
            rwTelemetry.boxes_ok++;
            rwTelemetry.fetched += r.features.length;
            obstaclesList.push(r.features);
          } else {
            rwTelemetry.boxes_failed++;
            rwTelemetry.errors?.push(r.error ?? `roadworks_failed_status_${r.status}`);
          }
        }

        const merged = mergeObstacles(obstaclesList, 1800);
        obstacles = prioritizeObstacles(merged, start, end, corridorKm, 1300);
        rwTelemetry.used = obstacles.length;

        if (rwTelemetry.boxes_ok > 0 && rwTelemetry.boxes_failed === 0) rwTelemetry.status = "OK";
        else if (rwTelemetry.boxes_ok > 0) rwTelemetry.status = "PARTIAL";
        else rwTelemetry.status = "FAILED";

        if (rwTelemetry.status !== "OK") {
          rwTelemetry.notes = "Roadworks teilweise/fehlgeschlagen. Route wird trotzdem geliefert (fail-open).";
        }
      } else {
        rwTelemetry.status = "FAILED";
        rwTelemetry.notes = "Roadworks sampling skipped (insufficient time).";
      }

      const stats0 = obstacles.length
        ? computeRouteStats(route0, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight)
        : { blockingWarnings: [], roadworksHits: 0 };

      let best: Candidate = {
        route: route0,
        blockingWarnings: stats0.blockingWarnings,
        roadworksHits: stats0.roadworksHits,
        distance_km: extractDistanceKm(route0),
        meta: { bbox_km: null, avoids_applied: 0, fallback_used: true },
      };

      // Wenn Roadworks nicht da → liefere route0 sofort
      if (rwTelemetry.status === "FAILED" || !obstacles.length) {
        phases.push({ phase: "FAST_PATH", approx_km: approxKm, result: "OK_ROUTE_NO_ROADWORKS" });
        return respondWithBest(best, { bbox_km_used: null, fallback_used: true });
      }

      // 3) Clean-Versuch: wenige Iterationen, harte Stop-Regeln
      if (best.blockingWarnings.length > 0 && timeLeft() > baseValhallaTimeout + 2_000) {
        const MAX_ITER_FAST = 8; // hart niedrig halten
        const MAX_AVOIDS_FAST = Math.min(120, IS_WIDE ? 80 : 100);
        const MAX_NEW_AVOIDS_PER_ITER = IS_WIDE ? 10 : 14;

        const avoidMap = new Map<string, Feature<Polygon>>();
        const avoidAttempts = new Map<string, number>();
        const avoidIds = new Set<string>();
        let stuckReason: string | null = null;

        for (let i = 0; i < MAX_ITER_FAST; i++) {
          const localTimeout = Math.min(maxValhallaTimeout, baseValhallaTimeout + i * 250);

          if (timeLeft() < localTimeout + 1_700) {
            stuckReason = "Zeitbudget erreicht (FAST_PATH abgebrochen).";
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

          const newBlocking: Feature<any>[] = [];
          const stillBlockingAvoided: Feature<any>[] = [];

          for (const obs of obstacles) {
            if (routeBufferPoly) {
              try {
                if (!booleanIntersects(routeBufferPoly as any, obs)) continue;
              } catch {
                continue;
              }
            }
            const limits = getLimits(obs.properties);
            const { blocksAny } = blocksVehicle(limits, vWidth, vWeight, obs.properties);
            if (!blocksAny) continue;

            const id = stableObsId(obs);
            if (!avoidMap.has(id)) newBlocking.push(obs);
            else stillBlockingAvoided.push(obs);

            if (newBlocking.length + stillBlockingAvoided.length >= MAX_BLOCKING_SCAN) break;
          }

          const sorter = (a: Feature<any>, b: Feature<any>) => {
            const la = getLimits(a.properties);
            const lb = getLimits(b.properties);
            if (la.width !== lb.width) return (la.width ?? 0) - (lb.width ?? 0);
            return (la.weight ?? 0) - (lb.weight ?? 0);
          };

          newBlocking.sort(sorter);
          stillBlockingAvoided.sort(sorter);

          let added = 0;

          for (const obs of newBlocking) {
            if (avoidMap.size >= MAX_AVOIDS_FAST) break;
            const r = upsertAvoid(avoidMap, avoidAttempts, obs, avoidBufferKmBase, 2.0);
            if (!r.ok) continue;
            avoidIds.add(r.id);
            added++;
            if (added >= MAX_NEW_AVOIDS_PER_ITER) break;
          }

          // Wenn nichts Neues: eskalieren (wenige)
          if (added === 0 && stillBlockingAvoided.length > 0) {
            let escalated = 0;
            for (const obs of stillBlockingAvoided.slice(0, IS_WIDE ? 4 : 6)) {
              const id = stableObsId(obs);
              const r = upsertAvoid(avoidMap, avoidAttempts, obs, avoidBufferKmBase, 10.0);
              if (!r.ok) continue;
              avoidIds.add(id);
              escalated++;
            }
            if (escalated > 0) added = escalated;
          }

          if (added === 0) {
            stuckReason = "Keine neuen/eskalierbaren Avoid-Polygone.";
            break;
          }

          const avoidsArr = Array.from(avoidMap.values());
          const res = await callValhalla(origin, plannerReqBase, avoidsArr, localTimeout, true, 0);
          const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };

          if (!route?.features?.length) {
            stuckReason = res?.error ?? "Valhalla: keine Route in Iteration.";
            // konservativ: last avoids zurücknehmen, statt endlos zu loop-en
            const keys = Array.from(avoidMap.keys());
            for (const k of keys.slice(-Math.min(4, keys.length))) avoidMap.delete(k);
            continue;
          }

          const stats = computeRouteStats(route, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight, avoidIds);
          const cand: Candidate = {
            route,
            blockingWarnings: stats.blockingWarnings,
            roadworksHits: stats.roadworksHits,
            distance_km: extractDistanceKm(route),
            meta: { bbox_km: null, avoids_applied: avoidMap.size, fallback_used: true },
          };

          best = pickBetterCandidate(best, cand);
          if (best.blockingWarnings.length === 0) {
            stuckReason = null;
            break;
          }
        }

        phases.push({
          phase: "FAST_PATH",
          approx_km: approxKm,
          result: best.blockingWarnings.length === 0 ? "CLEAN" : "WARN",
          avoids_applied: best.meta.avoids_applied,
          roadworks_hits: best.roadworksHits,
          reason: stuckReason,
        });
      } else {
        phases.push({ phase: "FAST_PATH", approx_km: approxKm, result: best.blockingWarnings.length ? "WARN" : "CLEAN" });
      }

      return respondWithBest(best, { bbox_km_used: null, fallback_used: true });
    }

    // ---------------------------
    // SHORT/MID ROUTE: STRICT PATH
    // ---------------------------
    const BBOX_STEPS_KM = [120, 200, 400, 800, 1400, 2200];
    const MAX_ITERATIONS_PER_STEP = 22; // niedriger → kein Timeout
    const MAX_AVOIDS_TOTAL = 140;
    const MAX_NEW_AVOIDS_PER_ITER = IS_WIDE ? 10 : 14;

    let best: Candidate | null = null;
    const altCandidates: Candidate[] = [];

    for (const bboxKm of BBOX_STEPS_KM) {
      if (timeLeft() < baseValhallaTimeout + 2_000) break;

      const bbox = makeSafeBBox(start, end, bboxKm);

      rwTelemetry.status = "PARTIAL";
      rwTelemetry.boxes_total = 1;
      rwTelemetry.boxes_ok = 0;
      rwTelemetry.boxes_failed = 0;
      rwTelemetry.fetched = 0;
      rwTelemetry.used = 0;
      rwTelemetry.notes = null;
      rwTelemetry.errors = [];

      const rwCallTimeout = Math.min(ROADWORKS_TIMEOUT_MS, Math.max(4_500, Math.floor(timeLeft() / 3)));
      rwTelemetry.timeout_ms = rwCallTimeout;

      const rwRes = await callRoadworks(
        origin,
        { ts, tz, bbox, buffer_m: roadworksBufferM, only_motorways: onlyMotorways },
        rwCallTimeout
      );

      let rawObstacles: Feature<any>[] = [];
      if (rwRes.ok) {
        rwTelemetry.boxes_ok = 1;
        rwTelemetry.boxes_failed = 0;
        rwTelemetry.status = "OK";
        rawObstacles = rwRes.features;
        rwTelemetry.fetched = rawObstacles.length;
      } else {
        rwTelemetry.boxes_ok = 0;
        rwTelemetry.boxes_failed = 1;
        rwTelemetry.status = "FAILED";
        rwTelemetry.notes = "Baustellendaten nicht ladbar. Route wird trotzdem geliefert (fail-open).";
        rwTelemetry.errors?.push(rwRes.error ?? `roadworks_failed_status_${rwRes.status}`);
        phases.push({
          phase: "ROADWORKS_STRICT",
          bbox_km: bboxKm,
          ok: false,
          status: rwRes.status,
          timeout_ms: rwCallTimeout,
          error: rwRes.error ?? null,
        });
      }

      const corridorKmStep = Math.min(120, Math.max(corridorKm, bboxKm * 0.045));
      const obstacles: Feature<any>[] =
        rawObstacles.length > 0 ? prioritizeObstacles(rawObstacles, start, end, corridorKmStep, 1400) : [];
      rwTelemetry.used = obstacles.length;

      const avoidMap = new Map<string, Feature<Polygon>>();
      const avoidAttempts = new Map<string, number>();
      const avoidIds = new Set<string>();

      let iterations = 0;
      let stuckReason: string | null = null;

      // Wenn Roadworks FAILED → nur Route liefern, nicht hängen
      if (rwTelemetry.status === "FAILED") {
        const res = await callValhalla(origin, plannerReqBase, [], baseValhallaTimeout, false);
        const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };
        totalIterations++;

        if (route?.features?.length) {
          best = pickBetterCandidate(best, {
            route,
            blockingWarnings: [],
            roadworksHits: 0,
            distance_km: extractDistanceKm(route),
            meta: { bbox_km: bboxKm, avoids_applied: 0, fallback_used: false },
          });

          phases.push({
            phase: "STRICT",
            bbox_km: bboxKm,
            iterations: 1,
            avoids_applied: 0,
            result: "OK_ROUTE_NO_ROADWORKS",
            reason: rwTelemetry.notes,
            roadworks_status: rwTelemetry.status,
          });
          break;
        }

        phases.push({
          phase: "STRICT",
          bbox_km: bboxKm,
          iterations: 1,
          avoids_applied: 0,
          result: "NO_ROUTE",
          reason: res?.error ?? "no_route_valhalla",
          roadworks_status: rwTelemetry.status,
        });
        continue;
      }

      while (iterations < MAX_ITERATIONS_PER_STEP) {
        const localTimeout = Math.min(maxValhallaTimeout, baseValhallaTimeout + Math.min(1_500, iterations * 200));
        if (timeLeft() < localTimeout + 1_700) {
          stuckReason = "Zeitbudget erreicht (STRICT abgebrochen).";
          break;
        }

        iterations++;
        totalIterations++;

        const escapeNow = avoidMap.size > 0;
        const avoidsArr = Array.from(avoidMap.values());
        const res = await callValhalla(origin, plannerReqBase, avoidsArr, localTimeout, escapeNow, escapeNow ? 3 : undefined);

        const route: FeatureCollection = res?.geojson ?? { type: "FeatureCollection", features: [] };
        if (!route?.features?.length) {
          stuckReason = res?.error ?? "Keine Route (Valhalla).";
          if (avoidMap.size === 0) break;
          const keys = Array.from(avoidMap.keys());
          for (const k of keys.slice(-Math.min(IS_WIDE ? 4 : 6, keys.length))) avoidMap.delete(k);
          continue;
        }

        const { blockingWarnings, roadworksHits } = computeRouteStats(route, obstacles, ROUTE_BUFFER_KM, vWidth, vWeight, avoidIds);
        const cand: Candidate = {
          route,
          blockingWarnings,
          roadworksHits,
          distance_km: extractDistanceKm(route),
          meta: { bbox_km: bboxKm, avoids_applied: avoidMap.size, fallback_used: false },
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

        const line = route.features[0];
        let routeBufferPoly: any = null;
        try {
          routeBufferPoly = buffer(line as any, ROUTE_BUFFER_KM, { units: "kilometers" });
        } catch {
          routeBufferPoly = null;
        }

        const newBlocking: Feature<any>[] = [];
        const stillBlockingAvoided: Feature<any>[] = [];

        for (const obs of obstacles) {
          if (routeBufferPoly) {
            try {
              if (!booleanIntersects(routeBufferPoly as any, obs)) continue;
            } catch {
              continue;
            }
          }

          const limits = getLimits(obs.properties);
          const { blocksAny } = blocksVehicle(limits, vWidth, vWeight, obs.properties);
          if (!blocksAny) continue;

          const id = stableObsId(obs);
          if (!avoidMap.has(id)) newBlocking.push(obs);
          else stillBlockingAvoided.push(obs);

          if (newBlocking.length + stillBlockingAvoided.length >= MAX_BLOCKING_SCAN) break;
        }

        newBlocking.sort((a, b) => {
          const la = getLimits(a.properties);
          const lb = getLimits(b.properties);
          if (la.width !== lb.width) return (la.width ?? 0) - (lb.width ?? 0);
          return (la.weight ?? 0) - (lb.weight ?? 0);
        });

        stillBlockingAvoided.sort((a, b) => {
          const la = getLimits(a.properties);
          const lb = getLimits(b.properties);
          if (la.width !== lb.width) return (la.width ?? 0) - (lb.width ?? 0);
          return (la.weight ?? 0) - (lb.weight ?? 0);
        });

        let added = 0;

        for (const obs of newBlocking) {
          if (avoidMap.size >= MAX_AVOIDS_TOTAL) break;
          const r = upsertAvoid(avoidMap, avoidAttempts, obs, avoidBufferKmBase, 2.0);
          if (!r.ok) continue;
          avoidIds.add(r.id);
          added++;
          if (added >= MAX_NEW_AVOIDS_PER_ITER) break;
        }

        if (added === 0 && stillBlockingAvoided.length > 0) {
          let escalated = 0;
          for (const obs of stillBlockingAvoided.slice(0, IS_WIDE ? 4 : 6)) {
            const id = stableObsId(obs);
            const r = upsertAvoid(avoidMap, avoidAttempts, obs, avoidBufferKmBase, 10.0);
            if (!r.ok) continue;
            avoidIds.add(id);
            escalated++;
          }
          if (escalated > 0) added = escalated;
        }

        if (added === 0) {
          stuckReason = "Keine neuen/eskalierbaren Avoid-Polygone.";
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
        roadworks_status: rwTelemetry.status,
      });

      // Wenn clean gefunden → raus
      if (best?.blockingWarnings?.length === 0 && best?.route?.features?.length) break;
    }

    // Wenn gar keine Route gefunden: minimaler Fallback (ohne Avoids)
    if (!best?.route?.features?.length && timeLeft() > 3_500) {
      const fallbackRes = await callValhalla(origin, plannerReqBase, [], Math.min(baseValhallaTimeout, Math.max(3_500, timeLeft() - 300)), false);
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
      return NextResponse.json(
        {
          meta: {
            source: "route/plan-stable-v1",
            status: "BLOCKED",
            clean: false,
            error: "Es konnte gar keine Route berechnet werden.",
            iterations: totalIterations,
            avoids_applied: 0,
            bbox_km_used: null,
            fallback_used: true,
            phases,
          },
          roadworks: rwTelemetry.status === "SKIPPED" ? { ...rwTelemetry, status: "SKIPPED", notes: "no_route" } : rwTelemetry,
          avoid_applied: { total: 0 },
          geojson: { type: "FeatureCollection", features: [] },
          blocking_warnings: [],
          geojson_alts: [],
        },
        { status: 200 }
      );
    }

    // Alternativen (nur wenn vorhanden)
    const geojson_alts = altCandidates.filter((c) => c.route?.features?.length).map((c) => c.route);

    // Final response: IMMER Route
    const clean = best.blockingWarnings.length === 0;
    const errorMsg =
      clean
        ? null
        : "⚠️ WARNUNG: Keine vollständig baustellenfreie Route gefunden. Es wird die beste verfügbare Route geliefert – bitte prüfen Sie die markierten Problemstellen.";

    return NextResponse.json({
      meta: {
        source: "route/plan-stable-v1",
        status: "CLEAN",
        clean,
        error: errorMsg,
        iterations: totalIterations,
        avoids_applied: best.meta.avoids_applied,
        bbox_km_used: best.meta.bbox_km,
        fallback_used: best.meta.fallback_used,
        phases,
        require_clean_requested: requireClean,
      },
      roadworks: rwTelemetry,
      avoid_applied: { total: best.meta.avoids_applied },
      geojson: best.route,
      blocking_warnings: best.blockingWarnings,
      geojson_alts,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        meta: {
          source: "route/plan-stable-v1",
          status: "ERROR",
          clean: false,
          error: String(err?.message ?? err ?? "Unbekannter Fehler"),
        },
        roadworks: {
          status: "SKIPPED",
          boxes_total: 0,
          boxes_ok: 0,
          boxes_failed: 0,
          timeout_ms: 0,
          only_motorways: false,
          buffer_m: 0,
          fetched: 0,
          used: 0,
          notes: "handler_exception",
        } as RoadworksTelemetry,
        avoid_applied: { total: 0 },
        geojson: { type: "FeatureCollection", features: [] },
        blocking_warnings: [],
        geojson_alts: [],
      },
      { status: 500 }
    );
  }
}
