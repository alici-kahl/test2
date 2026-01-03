// src/app/api/route/plan/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This route:
 * - Calls /api/route/valhalla to compute a route (short vs long handling).
 * - Calls /api/roadworks to fetch roadworks GeoJSON in one or more bboxes.
 * - Iteratively adds avoid_polygons to Valhalla until blocking roadworks are avoided
 *   (best-effort within time/request budget).
 *
 * Key improvement vs older versions:
 * - For long routes and for iterative detours: roadworks are also refreshed along
 *   the currently found route in route-chunks, not only in the initial start/end bbox.
 */

// ------------------------ Types (loose) ------------------------

type Coord = [number, number]; // [lon, lat]

type RoadworkObstacle = {
  title?: string;
  description?: string;
  coords?: [number, number]; // [lon, lat] representative point
  limits?: {
    width?: number;
    height?: number;
    weight?: number;
    axeload?: number;
  };
  // line feature optional
  geometry?: any;
};

type RouteMeta = {
  status?: string; // "OK" | "WARN" | "ERROR"
  clean?: boolean;
  error?: string | null;
  iterations?: number;
  avoids_applied?: number;
  bbox_km_used?: number;
  fallback_used?: boolean;
  phases?: Array<any>;
};

type RouteResponse = {
  meta?: RouteMeta;
  geojson?: any; // FeatureCollection LineString
  geojson_alts?: any[];
  avoid_applied?: { total?: number };
  blocking_warnings?: RoadworkObstacle[];
};

// ------------------------ Utils ------------------------

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function nowMs() {
  return Date.now();
}

function kmBetween(a: Coord, b: Coord) {
  // Haversine
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bboxFromCoords(coords: Coord[], expandKm: number) {
  // expandKm ~ rough; convert km to degrees (approx)
  const kmToDegLat = (km: number) => km / 110.574;
  const kmToDegLon = (km: number, lat: number) => km / (111.32 * Math.cos((lat * Math.PI) / 180));

  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;

  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  const midLat = (minLat + maxLat) / 2;
  const dLat = kmToDegLat(expandKm);
  const dLon = kmToDegLon(expandKm, midLat);

  return {
    minLon: minLon - dLon,
    minLat: minLat - dLat,
    maxLon: maxLon + dLon,
    maxLat: maxLat + dLat,
  };
}

function bboxToParam(b: { minLon: number; minLat: number; maxLon: number; maxLat: number }) {
  // format used by your /api/roadworks route: bbox=minLon,minLat,maxLon,maxLat
  return `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;
}

function uniqKeyForObstacle(o: RoadworkObstacle) {
  const c = o.coords ? `${o.coords[0].toFixed(6)},${o.coords[1].toFixed(6)}` : "";
  const t = (o.title || "").slice(0, 80);
  const w = o.limits?.width ?? "";
  return `${t}|${c}|${w}`;
}

function extractRouteLineCoords(routeGeojson: any): Coord[] {
  try {
    const feat = routeGeojson?.features?.[0];
    const coords = feat?.geometry?.coordinates;
    if (!Array.isArray(coords)) return [];
    // coords is [lon,lat] points
    return coords as Coord[];
  } catch {
    return [];
  }
}

function sampleCoords(coords: Coord[], maxPoints: number): Coord[] {
  if (coords.length <= maxPoints) return coords;
  const step = coords.length / maxPoints;
  const out: Coord[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(coords[Math.floor(i * step)]);
  }
  // ensure last
  out.push(coords[coords.length - 1]);
  return out;
}

function chunkRouteToBBoxes(routeCoords: Coord[], chunkKm: number, overlapKm: number, expandKm: number) {
  // Create sequential chunks along route distance and compute bbox per chunk.
  // Best-effort, approximate based on sampling of points.
  const coords = sampleCoords(routeCoords, 320); // keep it light
  if (coords.length < 2) return [];

  const bboxes: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number }> = [];

  let startIdx = 0;
  let acc = 0;

  for (let i = 1; i < coords.length; i++) {
    acc += kmBetween(coords[i - 1], coords[i]);
    if (acc >= chunkKm) {
      const chunk = coords.slice(startIdx, i + 1);
      bboxes.push(bboxFromCoords(chunk, expandKm));
      // overlap: move start backwards a bit
      const targetBackKm = overlapKm;
      let backAcc = 0;
      let j = i;
      while (j > 0 && backAcc < targetBackKm) {
        backAcc += kmBetween(coords[j - 1], coords[j]);
        j--;
      }
      startIdx = Math.max(0, j);
      acc = 0;
    }
  }

  // last chunk
  if (startIdx < coords.length - 1) {
    const chunk = coords.slice(startIdx);
    bboxes.push(bboxFromCoords(chunk, expandKm));
  }

  return bboxes;
}

function isBlockingForVehicle(o: RoadworkObstacle, veh: { width_m: number; height_m: number; weight_t: number; axeload_t: number }) {
  const lim = o.limits || {};
  const widthOk = lim.width == null ? true : veh.width_m <= lim.width;
  const heightOk = lim.height == null ? true : veh.height_m <= lim.height;
  const weightOk = lim.weight == null ? true : veh.weight_t <= lim.weight;
  const axeloadOk = lim.axeload == null ? true : veh.axeload_t <= lim.axeload;

  // blocking if ANY dimension exceeds a provided limit
  return !(widthOk && heightOk && weightOk && axeloadOk);
}

function avoidPolygonFromObstacle(o: RoadworkObstacle, bufferKm: number) {
  // Create a simple square polygon around representative coords.
  // bufferKm converted to degrees approx.
  if (!o.coords) return null;
  const [lon, lat] = o.coords;
  const kmToDegLat = (km: number) => km / 110.574;
  const kmToDegLon = (km: number, lat: number) => km / (111.32 * Math.cos((lat * Math.PI) / 180));

  const dLat = kmToDegLat(bufferKm);
  const dLon = kmToDegLon(bufferKm, lat);

  const poly = {
    type: "Polygon",
    coordinates: [
      [
        [lon - dLon, lat - dLat],
        [lon + dLon, lat - dLat],
        [lon + dLon, lat + dLat],
        [lon - dLon, lat + dLat],
        [lon - dLon, lat - dLat],
      ],
    ],
  };

  return poly;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------ Core fetch helpers ------------------------

async function postJson(url: string, body: any, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchRoadworksByBboxes(baseUrl: string, bboxes: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number }>, ts: string, tz: string, timeoutMs: number, maxBoxes: number) {
  const out: RoadworkObstacle[] = [];
  const seen = new Set<string>();

  const limited = bboxes.slice(0, maxBoxes);

  for (const b of limited) {
    const bbox = bboxToParam(b);
    const url = `${baseUrl}/api/roadworks?bbox=${encodeURIComponent(bbox)}&ts=${encodeURIComponent(ts)}&tz=${encodeURIComponent(tz)}`;
    const res = await getJson(url, timeoutMs);
    if (!res.ok) continue;
    const data = await res.json();

    // Expecting your roadworks endpoint to return something like:
    // { obstacles: RoadworkObstacle[], geojson_points, geojson_lines, ... }
    const obstacles: RoadworkObstacle[] = Array.isArray(data?.obstacles) ? data.obstacles : [];
    for (const o of obstacles) {
      const k = uniqKeyForObstacle(o);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(o);
      }
    }
  }

  return out;
}

async function fetchRoadworksAlongRoute(baseUrl: string, routeGeojson: any, ts: string, tz: string, timeoutMs: number, budgetBoxes: number) {
  const coords = extractRouteLineCoords(routeGeojson);
  if (coords.length < 2) return { obstacles: [] as RoadworkObstacle[], usedBoxes: 0 };

  // For long routes: chunk 180km with 40km overlap; expand 18km
  const bboxes = chunkRouteToBBoxes(coords, 180, 40, 18);

  const maxBoxes = clamp(budgetBoxes, 0, bboxes.length);
  const obstacles = await fetchRoadworksByBboxes(baseUrl, bboxes, ts, tz, timeoutMs, maxBoxes);
  return { obstacles, usedBoxes: maxBoxes };
}

function mergeObstacles(a: RoadworkObstacle[], b: RoadworkObstacle[]) {
  const out: RoadworkObstacle[] = [];
  const seen = new Set<string>();
  for (const o of a) {
    const k = uniqKeyForObstacle(o);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(o);
    }
  }
  for (const o of b) {
    const k = uniqKeyForObstacle(o);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(o);
    }
  }
  return out;
}

// ------------------------ Handler ------------------------

export async function POST(req: Request) {
  const t0 = nowMs();

  // Hard budget to avoid Vercel function timeout cascades
  const HARD_BUDGET_MS = 55_000;

  const timeLeft = () => HARD_BUDGET_MS - (nowMs() - t0);

  try {
    const body = await req.json();

    // Expected input payload from UI (based on your devtools screenshots):
    // {
    //   start: [lon, lat],
    //   end: [lon, lat],
    //   corridor: { mode: "soft", width_m: 2000 },
    //   roadworks: { buffer_m: 60, only_motorways: false },
    //   vehicle: { width_m, height_m, weight_t, axeload_t },
    //   alternatives: 1,
    //   avoid_target_max: 120,
    //   ts, tz, respect_direction, directions_language, valhalla_soft_max
    // }
    const start: Coord = body?.start;
    const end: Coord = body?.end;

    if (!Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2) {
      return NextResponse.json({ error: "Invalid start/end" }, { status: 400 });
    }

    const ts: string = body?.ts || new Date().toISOString();
    const tz: string = body?.tz || "Europe/Berlin";

    const vehicle = {
      width_m: Number(body?.vehicle?.width_m ?? 3),
      height_m: Number(body?.vehicle?.height_m ?? 4),
      weight_t: Number(body?.vehicle?.weight_t ?? 40),
      axeload_t: Number(body?.vehicle?.axeload_t ?? 10),
    };

    const roadworksCfg = {
      buffer_m: Number(body?.roadworks?.buffer_m ?? 60),
      only_motorways: Boolean(body?.roadworks?.only_motorways ?? false),
    };

    const avoidTargetMax: number = Number(body?.avoid_target_max ?? 120);

    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      // fallback: same-origin
      (req.headers.get("origin") || "");

    // ----------------- Tunables (balanced to still run fast) -----------------
    const LONG_ROUTE_KM = 250;

    // For strict iterative mode (short routes)
    const BBOX_STEPS_KM = [220, 420, 750, 1200]; // was often too small for detours
    const MAX_ITER_PER_STEP = 5; // per bbox step
    const MAX_AVOIDS_TOTAL = 24;
    const MAX_NEW_AVOIDS_PER_ITER = 6;

    // For long routes (fast-path first, then strict if needed)
    const FAST_MAX_ITER = 6;
    const FAST_MAX_AVOIDS_TOTAL = 30;
    const FAST_NEW_AVOIDS_PER_ITER = 6;

    // Roadworks fetch budgets
    const ROADWORKS_TIMEOUT_MS = 9_000;
    const VALHALLA_TIMEOUT_MS = 18_000;

    // Budgeted extra boxes along route per iteration (kept small; improves long-route consistency)
    const ALONG_ROUTE_BOX_BUDGET_INITIAL = 3;
    const ALONG_ROUTE_BOX_BUDGET_PER_ITER = 2;

    // Avoid polygon buffer in km (from meters)
    const baseAvoidKm = Math.max(roadworksCfg.buffer_m / 1000, 0.06); // ensure not too tiny
    // For long routes, slight increase helps "unstick" around motorway works:
    const longAvoidKm = Math.max(baseAvoidKm, 0.09);

    // ----------------- Helper: call Valhalla (your internal route) -----------------

    async function callValhalla(payload: any) {
      const url = `${baseUrl}/api/route/valhalla`;
      const res = await postJson(url, payload, Math.min(VALHALLA_TIMEOUT_MS, Math.max(6_000, timeLeft() - 2_000)));
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // preserve raw
      }
      return { ok: res.ok, status: res.status, json, raw: text };
    }

    // ----------------- Initial roadworks fetch (start/end bbox) -----------------

    function initialBboxForKm(km: number) {
      return bboxFromCoords([start, end], km / 2); // rough; "expand" is half of bbox target
    }

    async function fetchInitialRoadworks(km: number) {
      const b = initialBboxForKm(km);
      const obs = await fetchRoadworksByBboxes(baseUrl, [b], ts, tz, Math.min(ROADWORKS_TIMEOUT_MS, Math.max(4_000, timeLeft() - 2_000)), 1);
      return obs;
    }

    // ----------------- Evaluate blocking obstacles -----------------

    function computeBlocking(obstacles: RoadworkObstacle[]) {
      const blocking = obstacles.filter((o) => isBlockingForVehicle(o, vehicle));
      return blocking.slice(0, 999);
    }

    // ----------------- Fast path (for long routes) -----------------

    const directKm = kmBetween(start, end);

    async function longRouteFastPath() {
      // 1) initial route (no avoid polygons) to get a baseline polyline
      const basePayload = {
        ...body,
        alternatives: Math.max(0, Number(body?.alternatives ?? 0)),
        avoid_polygons: [],
        // keep language etc from body
      };

      const first = await callValhalla(basePayload);
      if (!first.ok || !first.json?.geojson) {
        return {
          meta: {
            source: "route/plan-fast",
            status: "ERROR",
            clean: false,
            error: first.json?.error || first.raw || "Valhalla error",
            iterations: 0,
            avoids_applied: 0,
            bbox_km_used: null,
            fallback_used: false,
            phases: [{ phase: "FAST_PATH", result: "ERROR" }],
          },
          geojson: first.json?.geojson ?? null,
          geojson_alts: first.json?.geojson_alts ?? [],
          blocking_warnings: [],
        } as RouteResponse;
      }

      // 2) roadworks along initial route + initial bbox
      let obstacles = await fetchInitialRoadworks(420);
      if (timeLeft() > 9_000) {
        const extra = await fetchRoadworksAlongRoute(baseUrl, first.json.geojson, ts, tz, ROADWORKS_TIMEOUT_MS, ALONG_ROUTE_BOX_BUDGET_INITIAL);
        obstacles = mergeObstacles(obstacles, extra.obstacles);
      }

      let avoids: any[] = [];
      let best = first.json as RouteResponse;

      // 3) iterate: detect blocking roadworks and add avoids; refresh roadworks along new route in each iteration
      for (let iter = 1; iter <= FAST_MAX_ITER; iter++) {
        if (timeLeft() < 8_000) break;

        const blocking = computeBlocking(obstacles);

        // If clean -> done
        if (blocking.length === 0) {
          best = {
            ...best,
            meta: {
              ...(best.meta || {}),
              source: "route/plan-fast",
              status: "CLEAN",
              clean: true,
              iterations: iter - 1,
              avoids_applied: avoids.length,
              bbox_km_used: 420,
              fallback_used: false,
              phases: [{ phase: "FAST_PATH", result: "OK", approx_km: directKm }],
            },
          };
          best.blocking_warnings = [];
          return best;
        }

        // Add new avoids (limited)
        const bufferKm = directKm >= LONG_ROUTE_KM ? longAvoidKm : baseAvoidKm;
        const newAvoids: any[] = [];
        for (const o of blocking) {
          if (avoids.length + newAvoids.length >= FAST_MAX_AVOIDS_TOTAL) break;
          if (newAvoids.length >= FAST_NEW_AVOIDS_PER_ITER) break;
          const poly = avoidPolygonFromObstacle(o, bufferKm);
          if (poly) newAvoids.push(poly);
        }

        if (newAvoids.length === 0) break;

        avoids = avoids.concat(newAvoids);

        const routed = await callValhalla({
          ...body,
          alternatives: Math.max(0, Number(body?.alternatives ?? 0)),
          avoid_polygons: avoids,
        });

        if (routed.ok && routed.json?.geojson) {
          best = routed.json as RouteResponse;

          // Refresh roadworks along the NEW route (critical for long detours)
          if (timeLeft() > 9_000) {
            const extra = await fetchRoadworksAlongRoute(baseUrl, best.geojson, ts, tz, ROADWORKS_TIMEOUT_MS, ALONG_ROUTE_BOX_BUDGET_PER_ITER);
            obstacles = mergeObstacles(obstacles, extra.obstacles);
          }
        } else {
          // if routing failed after avoids, stop and let strict mode try
          break;
        }
      }

      // Not clean: return best with warnings (strict mode may improve further)
      const blockingFinal = computeBlocking(obstacles).slice(0, avoidTargetMax);
      best.meta = {
        ...(best.meta || {}),
        source: "route/plan-fast",
        status: blockingFinal.length ? "WARN" : "CLEAN",
        clean: blockingFinal.length === 0,
        error: blockingFinal.length
          ? "Route gefunden, aber es gibt blockierende Baustellen. Es wurden Umfahrungen versucht; bitte Warnungen prüfen."
          : null,
        iterations: (best.meta?.iterations ?? 0) || FAST_MAX_ITER,
        avoids_applied: avoids.length,
        bbox_km_used: 420,
        fallback_used: false,
        phases: [{ phase: "FAST_PATH", result: blockingFinal.length ? "CANDIDATE" : "OK", approx_km: directKm }],
      };
      best.blocking_warnings = blockingFinal;
      return best;
    }

    // ----------------- Strict mode (bbox expansion) -----------------

    async function strictIterativePlan() {
      let globalAvoids: any[] = [];
      let best: RouteResponse | null = null;

      for (let stepIdx = 0; stepIdx < BBOX_STEPS_KM.length; stepIdx++) {
        if (timeLeft() < 10_000) break;

        const bboxKm = BBOX_STEPS_KM[stepIdx];
        let obstacles = await fetchInitialRoadworks(bboxKm);

        // initial attempt this step
        let res0 = await callValhalla({
          ...body,
          alternatives: Math.max(0, Number(body?.alternatives ?? 0)),
          avoid_polygons: globalAvoids,
        });

        if (res0.ok && res0.json?.geojson) {
          best = res0.json as RouteResponse;

          // also load roadworks along this candidate route (prevents “blind” detours)
          if (timeLeft() > 9_000) {
            const extra = await fetchRoadworksAlongRoute(baseUrl, best.geojson, ts, tz, ROADWORKS_TIMEOUT_MS, ALONG_ROUTE_BOX_BUDGET_INITIAL);
            obstacles = mergeObstacles(obstacles, extra.obstacles);
          }
        } else {
          // try next bbox step
          continue;
        }

        for (let iter = 1; iter <= MAX_ITER_PER_STEP; iter++) {
          if (timeLeft() < 8_000) break;
          if (!best?.geojson) break;

          const blocking = computeBlocking(obstacles);

          if (blocking.length === 0) {
            best.meta = {
              ...(best.meta || {}),
              source: "route/plan-v21-strict",
              status: "CLEAN",
              clean: true,
              error: null,
              iterations: iter - 1,
              avoids_applied: globalAvoids.length,
              bbox_km_used: bboxKm,
              fallback_used: false,
              phases: [{ phase: "STRICT", bbox_km: bboxKm, iterations: iter - 1, result: "OK" }],
            };
            best.blocking_warnings = [];
            return best;
          }

          // pick new avoids
          const bufferKm = bboxKm >= 750 ? longAvoidKm : baseAvoidKm;
          const newAvoids: any[] = [];
          for (const o of blocking) {
            if (globalAvoids.length + newAvoids.length >= MAX_AVOIDS_TOTAL) break;
            if (newAvoids.length >= MAX_NEW_AVOIDS_PER_ITER) break;
            const poly = avoidPolygonFromObstacle(o, bufferKm);
            if (poly) newAvoids.push(poly);
          }

          if (newAvoids.length === 0) break;

          globalAvoids = globalAvoids.concat(newAvoids);

          const routed = await callValhalla({
            ...body,
            alternatives: Math.max(0, Number(body?.alternatives ?? 0)),
            avoid_polygons: globalAvoids,
          });

          if (routed.ok && routed.json?.geojson) {
            best = routed.json as RouteResponse;

            // IMPORTANT: refresh roadworks along the NEW route each iteration (small budget)
            if (timeLeft() > 9_000) {
              const extra = await fetchRoadworksAlongRoute(baseUrl, best.geojson, ts, tz, ROADWORKS_TIMEOUT_MS, ALONG_ROUTE_BOX_BUDGET_PER_ITER);
              obstacles = mergeObstacles(obstacles, extra.obstacles);
            }
          } else {
            // if routing fails, stop strict iteration on this step
            break;
          }
        }
      }

      // no clean route found within budget => return best candidate with warnings
      if (best?.geojson) {
        // We cannot truthfully guarantee a clean route exists; best-effort result:
        const fallbackBlocking = (best.blocking_warnings || []).slice(0, avoidTargetMax);

        best.meta = {
          ...(best.meta || {}),
          source: "route/plan-v21-least-roadworks",
          status: fallbackBlocking.length ? "WARN" : "CLEAN",
          clean: fallbackBlocking.length === 0,
          error: fallbackBlocking.length
            ? "Route gefunden, aber es gibt blockierende Baustellen. Es wurden Umfahrungen versucht; bitte Warnungen prüfen."
            : null,
          iterations: best.meta?.iterations ?? 0,
          avoids_applied: globalAvoids.length,
          bbox_km_used: best.meta?.bbox_km_used ?? null,
          fallback_used: true,
          phases: [{ phase: "STRICT", result: fallbackBlocking.length ? "CANDIDATE" : "OK" }],
        };

        best.blocking_warnings = fallbackBlocking;
        return best;
      }

      return {
        meta: {
          source: "route/plan-v21",
          status: "ERROR",
          clean: false,
          error: "Keine Route gefunden (Valhalla).",
          iterations: 0,
          avoids_applied: 0,
          bbox_km_used: null,
          fallback_used: true,
          phases: [{ phase: "STRICT", result: "ERROR" }],
        },
        geojson: null,
        geojson_alts: [],
        blocking_warnings: [],
      } as RouteResponse;
    }

    // ----------------- Decide pipeline -----------------

    // For long routes: try fast path first; if it returns WARN, try strict to improve.
    if (directKm >= LONG_ROUTE_KM) {
      const fast = await longRouteFastPath();
      if (fast?.meta?.clean) {
        return NextResponse.json(fast);
      }
      // If time allows, let strict try to clean it further
      if (timeLeft() > 15_000) {
        const strict = await strictIterativePlan();
        // If strict is clean or at least better, return it. Otherwise return fast.
        if (strict?.meta?.clean) return NextResponse.json(strict);
        return NextResponse.json(strict || fast);
      }
      return NextResponse.json(fast);
    }

    // Short routes: strict iterative is ok and fast enough
    const strict = await strictIterativePlan();
    return NextResponse.json(strict);
  } catch (e: any) {
    return NextResponse.json(
      {
        meta: {
          source: "route/plan",
          status: "ERROR",
          clean: false,
          error: e?.message || String(e),
        },
        geojson: null,
        geojson_alts: [],
        blocking_warnings: [],
      },
      { status: 500 }
    );
  }
}
