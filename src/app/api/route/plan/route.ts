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
};

function makeSafeBBox(
  start: Coords,
  end: Coords,
  bufferKm: number,
): [number, number, number, number] {
  const line = lineString([start, end]);
  const buffered = buffer(line, bufferKm, { units: "kilometers" });
  return bboxFn(buffered) as [number, number, number, number];
}

/** robust: number parsing for values like "12,25", "3.5", 3.5 */
function toNumOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** robust: true for true/1/"true"/"yes"/"ja" */
function toBool(v: any): boolean {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "ja";
}

type Limits = {
  width_m: number | null;
  height_m: number | null;
  weight_t: number | null;
  axleload_t: number | null;
  hard_block: boolean;
};

function getLimits(p: any): Limits {
  // direct fields (various naming variants)
  let width =
    p.max_width_m ?? p.max_width ?? p.width ?? p.width_limit ?? p.breite ?? null;
  let height =
    p.max_height_m ?? p.max_height ?? p.height ?? p.height_limit ?? p.hoehe ?? null;
  let weight =
    p.max_weight_t ?? p.max_weight ?? p.weight ?? p.weight_limit ?? p.gewicht ?? null;
  let axle =
    p.max_axleload_t ?? p.max_axle_t ?? p.axleload_t ?? p.axle_load_t ?? p.axleload ?? p.achslast ?? null;

  const hard =
    toBool(p.hard_block) ||
    toBool(p.hardblock) ||
    toBool(p.closed) ||
    toBool(p.blocked) ||
    toBool(p.road_closed);

  const text = `${p.title || ""} ${p.description || ""} ${p.reason || ""} ${p.subtitle || ""}`;

  // try to extract width from text if missing
  if (toNumOrNull(width) === null) {
    const wMatch =
      text.match(/(?:Breite|width|breite)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i) ||
      text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:Breite|width|breite)/i) ||
      text.match(/(?:über|over|width)\s*([0-9]+(?:[.,][0-9]+)?)\s*m/i);
    if (wMatch) width = wMatch[1];
  }

  // try to extract height from text if missing
  if (toNumOrNull(height) === null) {
    const hMatch =
      text.match(/(?:Höhe|Hoehe|height)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i) ||
      text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:Höhe|Hoehe|height)/i);
    if (hMatch) height = hMatch[1];
  }

  // try to extract weight from text if missing
  if (toNumOrNull(weight) === null) {
    const wtMatch = text.match(
      /(?:Gewicht|weight|Last|last)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*t/i,
    );
    if (wtMatch) weight = wtMatch[1];
  }

  // try to extract axle load from text if missing (rare, but safe)
  if (toNumOrNull(axle) === null) {
    const aMatch =
      text.match(/(?:Achslast|axle)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*t/i);
    if (aMatch) axle = aMatch[1];
  }

  return {
    width_m: toNumOrNull(width),
    height_m: toNumOrNull(height),
    weight_t: toNumOrNull(weight),
    axleload_t: toNumOrNull(axle),
    hard_block: hard,
  };
}

/**
 * Hard conflict if:
 * - hard_block/closed
 * - or vehicle exceeds any present limit
 */
function isHardBlockedOrConflicting(
  limits: Limits,
  vehicle: { width_m?: number; height_m?: number; weight_t?: number; axleload_t?: number },
) {
  if (limits.hard_block) {
    return { conflict: true, reasons: ["hard_block/closed"] as string[] };
  }

  const reasons: string[] = [];
  const vw = toNumOrNull(vehicle.width_m);
  const vh = toNumOrNull(vehicle.height_m);
  const vwt = toNumOrNull(vehicle.weight_t);
  const va = toNumOrNull(vehicle.axleload_t);

  if (vw !== null && limits.width_m !== null && vw > limits.width_m) {
    reasons.push(`Width ${vw} > ${limits.width_m}`);
  }
  if (vh !== null && limits.height_m !== null && vh > limits.height_m) {
    reasons.push(`Height ${vh} > ${limits.height_m}`);
  }
  if (vwt !== null && limits.weight_t !== null && vwt > limits.weight_t) {
    reasons.push(`Weight ${vwt} > ${limits.weight_t}`);
  }
  if (va !== null && limits.axleload_t !== null && va > limits.axleload_t) {
    reasons.push(`Axle ${va} > ${limits.axleload_t}`);
  }

  return { conflict: reasons.length > 0, reasons };
}

// --- FINALER FIX: NUR NOCH RECHTECKE ---
function createAvoidPolygon(f: Feature<any>): Feature<Polygon> | null {
  try {
    const km = 0.02;
    const bf = buffer(f, km, { units: "kilometers" });
    if (!bf) return null;

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

async function callValhalla(
  reqBody: any,
  avoidPolys: Feature<Polygon>[],
): Promise<{ geojson: FeatureCollection; error?: string }> {
  const payload = {
    ...reqBody,
    avoid_polygons: avoidPolys.length > 0 ? avoidPolys.map((p) => p.geometry) : undefined,
  };

  try {
    const host = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(`${host}/api/route/valhalla`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const txt = await res.text();
      return {
        geojson: { type: "FeatureCollection", features: [] },
        error: `Status ${res.status}: ${txt.slice(0, 100)}`,
      };
    }
    const data = await res.json();
    return { geojson: data.geojson };
  } catch (e: any) {
    return { geojson: { type: "FeatureCollection", features: [] }, error: String(e) };
  }
}

async function fetchWithTimeout(url: URL, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ----------------------------- Main Handler ----------------------------- */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as PlanReq;
  const start = body.start;
  const end = body.end;
  const ts = body.ts ?? new Date().toISOString();
  const tz = body.tz ?? "Europe/Berlin";

  const vWidth = body.vehicle?.width_m ?? 2.55;
  const vWeight = body.vehicle?.weight_t ?? 40;

  console.log(`[PLAN START] Veh: ${vWidth}m / ${vWeight}t`);

  const queryBBox = makeSafeBBox(start, end, 50);
  let allObstacles: Feature<any>[] = [];

  /* 1. Lade Daten */
  try {
    const rRes = await fetchWithTimeout(new URL("/api/restrictions", req.nextUrl.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ts,
        tz,
        bbox: queryBBox,
        buffer_m: 10,
        vehicle: body.vehicle,
        max_polygons: 1000,
      }),
    }, 5000);
    if (rRes.ok) {
      const j = await rRes.json();
      allObstacles.push(...(j.geojson?.features || []));
    }
  } catch (e) {}

  try {
    const rwRes = await fetchWithTimeout(new URL("/api/roadworks", req.nextUrl.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts, tz, bbox: queryBBox, only_motorways: false }),
    }, 5000);
    if (rwRes.ok) {
      const j = await rwRes.json();
      allObstacles.push(...(j.features || []));
    }
  } catch (e) {}

  /* 2. Iteration Loop */
  let currentRouteGeoJSON: FeatureCollection = { type: "FeatureCollection", features: [] };
  const activeAvoids: Feature<Polygon>[] = [];
  const avoidIds = new Set<string>();

  let iterations = 0;
  const MAX_ITERATIONS = 6;
  let routeIsClean = false;
  let finalError: string | null = null;

  // NEW: für Response/Debug
  let lastHardCollisions = 0;
  let lastAddedAvoids = 0;

  const valhallaBody = {
    start,
    end,
    vehicle: body.vehicle,
    alternates: body.alternates ?? 1,
    directions_language: body.directions_language ?? "de-DE",
  };

  let fallbackRoute: FeatureCollection | null = null;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`--- ITERATION ${iterations} (Avoids: ${activeAvoids.length}) ---`);

    const result = await callValhalla(valhallaBody, activeAvoids);

    if (result.error || !result.geojson.features.length) {
      finalError = result.error || "No route found";
      console.error(`[FAIL] Iteration ${iterations} failed: ${finalError}`);

      if (fallbackRoute) {
        console.log("Using fallback route from previous iteration.");
        currentRouteGeoJSON = fallbackRoute;
        finalError = null;
      }
      break;
    }

    currentRouteGeoJSON = result.geojson;
    fallbackRoute = result.geojson;

    const routeLine = currentRouteGeoJSON.features[0];
    if (!routeLine || routeLine.geometry.type !== "LineString") {
      finalError = "Invalid route geometry returned by Valhalla";
      routeIsClean = false;
      break;
    }

    // @ts-ignore
    const routeBuffer = buffer(routeLine, 0.015, { units: "kilometers" });

    let addedAvoids = 0;
    let hardCollisions = 0;

    for (const obs of allObstacles) {
      const obsId =
        JSON.stringify(obs.geometry.coordinates).slice(0, 50) + (obs.properties?.id || "");

      if (!booleanIntersects(routeBuffer, obs)) continue;

      const p = obs.properties || {};
      const limits = getLimits(p);
      const title = p.title || p.description || "unknown";

      const { conflict, reasons } = isHardBlockedOrConflicting(limits, body.vehicle ?? {});
      if (!conflict) continue;

      hardCollisions++;

      if (avoidIds.has(obsId)) {
        console.warn(
          `[STILL COLLIDING AFTER AVOID] "${title.slice(0, 30)}..." -> ${reasons.join(", ")}`,
        );
        continue;
      }

      console.log(`[CONFLICT] "${title.slice(0, 30)}..." -> Reason: ${reasons.join(", ")}`);

      const poly = createAvoidPolygon(obs);
      if (poly) {
        activeAvoids.push(poly);
        avoidIds.add(obsId);
        addedAvoids++;
      }
    }

    // NEW: speichern für Response/Debug
    lastHardCollisions = hardCollisions;
    lastAddedAvoids = addedAvoids;

    if (hardCollisions === 0) {
      console.log(`[SUCCESS] Clean route found in iteration ${iterations}.`);
      routeIsClean = true;
      finalError = null;
      break;
    }

    if (hardCollisions > 0 && addedAvoids === 0) {
      finalError =
        "Route still collides with hard obstacles, but no new avoids can be added (stuck).";
      console.error(`[STUCK] ${finalError}`);
      routeIsClean = false;
      break;
    }
  }

  /* 3. Warnings */
  const warnings: any[] = [];
  try {
    if (currentRouteGeoJSON.features.length > 0) {
      const routeLine = currentRouteGeoJSON.features[0];
      // @ts-ignore
      const routeBuffer = buffer(routeLine, 0.02, { units: "kilometers" });

      for (const obs of allObstacles) {
        const obsId =
          JSON.stringify(obs.geometry.coordinates).slice(0, 50) + (obs.properties?.id || "");

        if (booleanIntersects(routeBuffer, obs)) {
          const p = obs.properties || {};
          const limits = getLimits(p);
          warnings.push({
            id: p.id ?? obsId,
            title: p.title || "Baustelle ohne Einschränkung",
            description: p.description,
            limits,
            coords: centroid(obs).geometry.coordinates,
          });
          if (warnings.length > 20) break;
        }
      }
    }
  } catch (e) {}

  // NEW: wenn nicht clean -> HTTP Fehlerstatus, damit Frontend es NICHT als "OK" behandelt
  const statusCode = routeIsClean ? 200 : 409;

  return NextResponse.json(
    {
      meta: {
        source: "route/plan-v16-bbox-only",
        iterations,
        avoids_applied: activeAvoids.length,
        clean: routeIsClean,
        error: finalError,
        hard_collisions: lastHardCollisions,
        added_avoids_last_iter: lastAddedAvoids,
      },
      avoid_applied: { total: activeAvoids.length },
      geojson: currentRouteGeoJSON,
      warnings,
    },
    { status: statusCode },
  );
}
