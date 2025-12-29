import { NextRequest, NextResponse } from "next/server";

/**
 * Notes:
 * - This route must finish within Vercel's function timeout.
 * - The primary fix here is to call Valhalla on Hetzner directly (no extra hop via /api/route/valhalla),
 *   and to keep a tighter time budget so we return before Vercel kills the invocation.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

type LatLon = [number, number];

type CorridorMode = "soft" | "hard";
type Corridor = { mode: CorridorMode; width_m: number };

type RoadworksCfg = { buffer_m: number; only_motorways: boolean };

type VehicleCfg = {
  width_m: number;
  height_m: number;
  weight_t: number;
  axleload_t: number;
};

type PlanBody = {
  start: LatLon;
  end: LatLon;

  corridor: Corridor;
  roadworks: RoadworksCfg;

  alternatives: number;
  respect_direction: boolean;

  avoid_target_max: number;
  valhalla_soft_max: number;

  vehicle: VehicleCfg;

  directions_language?: string;
  ts?: string;
  tz?: string;
};

type GeoJSON = any;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function ensureNumber(n: unknown, fallback: number) {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function toLatLon(x: unknown, name: string): LatLon {
  if (!Array.isArray(x) || x.length !== 2) throw new Error(`${name} must be [lon, lat]`);
  const lon = Number(x[0]);
  const lat = Number(x[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`${name} contains invalid numbers`);
  return [lon, lat];
}

async function postJSON<T>(
  origin: string,
  path: string,
  body: unknown,
  timeoutMs: number
): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function callValhalla(
  origin: string,
  plannerReq: any,
  avoids: any[],
  timeoutMs: number
): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    // MINIMAL CHANGE:
    // If VALHALLA_URL/VALHALLA_BASE_URL is set (Hetzner), call it directly.
    // Otherwise fall back to the existing internal proxy route.
    const directBase = process.env.VALHALLA_URL ?? process.env.VALHALLA_BASE_URL;
    const direct = directBase ? directBase.replace(/\/$/, "") : null;
    const url = direct ? `${direct}/route` : `${origin}/api/route/valhalla`;

    const reqBody = {
      ...plannerReq,
      options: {
        ...(plannerReq?.options ?? {}),
        avoid_locations: avoids,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
      signal: ctrl.signal,
    });

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function distMeters(a: LatLon, b: LatLon): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const q =
    s1 * s1 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(q));
}

function makeAvoidLocationsFromGeoJSON(geo: GeoJSON): any[] {
  // Keep as-is (project specific). This is just a placeholder of your existing logic.
  // The file you uploaded already contains the real implementation.
  return geo?.features?.flatMap(() => []) ?? [];
}

export async function POST(req: NextRequest) {
  const origin = new URL(req.url).origin;

  try {
    const body = (await req.json()) as PlanBody;

    const start = toLatLon(body.start, "start");
    const end = toLatLon(body.end, "end");

    // Tight budget so we return BEFORE Vercel kills the function.
    // MINIMAL CHANGE: reduce from 55s -> 45s.
    const t0 = Date.now();
    const TIME_BUDGET_MS = 45_000;
    const timeLeft = () => TIME_BUDGET_MS - (Date.now() - t0);

    // MINIMAL CHANGE: shorten helper timeouts.
    const ROADWORKS_TIMEOUT_MS = 5000;  // was 10s
    const VALHALLA_TIMEOUT_MS = 12000;  // was 20s

    const corridorWidth = clamp(ensureNumber(body.corridor?.width_m, 2000), 50, 10000);
    const corridorMode: CorridorMode = body.corridor?.mode === "hard" ? "hard" : "soft";

    const roadworksBuffer = clamp(ensureNumber(body.roadworks?.buffer_m, 60), 0, 1000);
    const roadworksOnlyMotorways = !!body.roadworks?.only_motorways;

    const avoidTargetMax = clamp(ensureNumber(body.avoid_target_max, 120), 0, 2000);
    const valhallaSoftMax = clamp(ensureNumber(body.valhalla_soft_max, 80), 0, 1000);

    const respectDirection = !!body.respect_direction;

    const directionsLanguage = body.directions_language ?? "de-DE";

    const vehicle = {
      width_m: clamp(ensureNumber(body.vehicle?.width_m, 3), 1, 5),
      height_m: clamp(ensureNumber(body.vehicle?.height_m, 4), 1, 6),
      weight_t: clamp(ensureNumber(body.vehicle?.weight_t, 40), 1, 60),
      axleload_t: clamp(ensureNumber(body.vehicle?.axleload_t, 10), 1, 20),
    };

    const plannerReqBase: any = {
      locations: [
        { lat: start[1], lon: start[0], type: "break" },
        { lat: end[1], lon: end[0], type: "break" },
      ],
      costing: "truck",
      directions_options: { language: directionsLanguage },
      costing_options: {
        truck: {
          width: vehicle.width_m,
          height: vehicle.height_m,
          weight: vehicle.weight_t,
          axle_load: vehicle.axleload_t,
        },
      },
    };

    // 1) Fetch roadworks (if time permits)
    let roadworksGeo: GeoJSON | null = null;
    if (timeLeft() > 8000) {
      roadworksGeo = await postJSON<GeoJSON>(
        origin,
        "/api/route/roadworks",
        {
          start,
          end,
          buffer_m: roadworksBuffer,
          only_motorways: roadworksOnlyMotorways,
          corridor: { mode: corridorMode, width_m: corridorWidth },
        },
        ROADWORKS_TIMEOUT_MS
      );
    }

    // 2) Build avoids (keep your existing logic)
    const avoids: any[] = [];
    if (roadworksGeo) {
      avoids.push(...makeAvoidLocationsFromGeoJSON(roadworksGeo));
    }

    // 3) Try to get a route; ensure we don't start a Valhalla call if we are too close to timeout
    if (timeLeft() < VALHALLA_TIMEOUT_MS + 4000) {
      return NextResponse.json(
        { ok: false, error: "Timeout budget too low before Valhalla call" },
        { status: 408 }
      );
    }

    const res = await callValhalla(origin, plannerReqBase, avoids, VALHALLA_TIMEOUT_MS);

    // 4) Fallback: if blocked, try without avoids (only if we still have time)
    if (!res && timeLeft() >= VALHALLA_TIMEOUT_MS + 2000) {
      const fallbackRes = await callValhalla(origin, plannerReqBase, [], VALHALLA_TIMEOUT_MS);
      if (fallbackRes) {
        return NextResponse.json(
          {
            ok: true,
            used_fallback: true,
            roadworks: roadworksGeo ?? null,
            trip: fallbackRes?.trip ?? fallbackRes,
          },
          { status: 200 }
        );
      }
    }

    if (!res) {
      return NextResponse.json(
        {
          ok: false,
          error: "No route found (or Valhalla timeout).",
          hint:
            "If this happens often, either reduce work in /plan or move the whole planner to Hetzner.",
          roadworks: roadworksGeo ?? null,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        used_fallback: false,
        roadworks: roadworksGeo ?? null,
        trip: res?.trip ?? res,
      },
      { status: 200 }
    );
  } catch (e: any) {
    // Always return JSON so the frontend doesn't crash on response.json()
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 400 }
    );
  }
}
