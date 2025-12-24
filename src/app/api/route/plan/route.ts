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

  // (Frontend sendet diese Felder bereits; hier nur ergänzt, damit wir sie sauber nutzen können)
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
  let width = p.max_width_m ?? p.max_width ?? p.width ?? p.width_limit ?? p.breite ?? null;
  let weight = p.max_weight_t ?? p.max_weight ?? p.weight ?? p.weight_limit ?? p.gewicht ?? null;
  const text = `${p.title || ""} ${p.description || ""} ${p.reason || ""} ${p.subtitle || ""}`;

  if (!width || width > 900) {
    const wMatch =
      text.match(/(?:Breite|width|breite)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i) ||
      text.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\s*(?:Breite|width|breite)/i) ||
      text.match(/(?:über|over|width)\s*([0-9]+(?:[.,][0-9]+)?)\s*m/i);
    if (wMatch) width = parseFloat(wMatch[1].replace(",", "."));
  }

  if (!weight || weight > 900) {
    const wtMatch = text.match(/(?:Gewicht|weight|Last|last)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*t/i);
    if (wtMatch) weight = parseFloat(wtMatch[1].replace(",", "."));
  }

  if (width === 0) width = 999;
  if (weight === 0) weight = 999;

  return { width: width ?? 999, weight: weight ?? 999 };
}

/**
 * Stabilere ID für Obstacles:
 * - bevorzugt echte IDs aus properties
 * - fallback: bbox + title (statt coordinates slice)
 */
function stableObsId(obs: Feature<any>): string {
  const p: any = obs.properties || {};
  const id =
    p.id ??
    p.external_id ??
    p.source_id ??
    p.roadwork_id ??
    p.restriction_id ??
    null;

  if (id) return String(id);

  // Fallback: bbox + title-ish
  let b: number[] = [];
  try {
    b = bboxFn(obs);
  } catch {
    // ignore
  }
  const title = (p.title || p.description || "unknown").toString().slice(0, 80);
  const bb = b.length === 4 ? b.map((n) => Number(n).toFixed(6)).join(",") : "nobbox";
  return `${bb}|${title}`;
}

// --- FINALER FIX: NUR NOCH RECHTECKE ---
function createAvoidPolygon(f: Feature<any>): Feature<Polygon> | null {
  try {
    // 1. Kleiner Buffer (20m), damit Linien zu Flächen werden
    const km = 0.02;
    const bf = buffer(f, km, { units: "kilometers" });
    if (!bf) return null;

    // 2. Bounding Box als Rechteck
    const b = bboxFn(bf);

    return polygon([
      [
        [b[0], b[1]], // unten-links
        [b[2], b[1]], // unten-rechts
        [b[2], b[3]], // oben-rechts
        [b[0], b[3]], // oben-links
        [b[0], b[1]], // schließen
      ],
    ]);
  } catch {
    return null;
  }
}

async function callValhalla(
  reqBody: any,
  avoidPolys: Feature<Polygon>[]
): Promise<{ geojson: FeatureCollection; error?: string }> {
  const payload = {
    ...reqBody,
    avoid_polygons: avoidPolys.length > 0 ? avoidPolys.map((p) => p.geometry) : undefined,
  };

  try {
    const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";

    // Timeout auf 60 Sekunden erhöht (Achtung: valhalla-proxy kann intern kürzer sein)
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

  // harte Obergrenze für exclude_polygons (Frontend sendet valhalla_soft_max)
  const valhallaSoftMax = Number.isFinite(body.valhalla_soft_max as any) ? (body.valhalla_soft_max as number) : 80;

  // Konsistenter Route-Buffer für Conflict & Warning (20m)
  const ROUTE_BUFFER_KM = 0.02;

  console.log(`[PLAN START] Veh: ${vWidth}m / ${vWeight}t | valhallaSoftMax=${valhallaSoftMax}`);

  const queryBBox = makeSafeBBox(start, end, 50);
  let allObstacles: Feature<any>[] = [];

  /* 1. Lade Daten */
  try {
    const rRes = await fetchWithTimeout(
      new URL("/api/restrictions", req.nextUrl.origin),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts, tz, bbox: queryBBox, buffer_m: 10, vehicle: body.vehicle, max_polygons: 1000 }),
      },
      5000
    );
    if (rRes.ok) {
      const j = await rRes.json();
      allObstacles.push(...(j.geojson?.features || []));
    }
  } catch {}

  try {
    const rwRes = await fetchWithTimeout(
      new URL("/api/roadworks", req.nextUrl.origin),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts, tz, bbox: queryBBox, only_motorways: false }),
      },
      5000
    );
    if (rwRes.ok) {
      const j = await rwRes.json();
      allObstacles.push(...(j.features || []));
    }
  } catch {}

  /* 2. Iteration Loop */
  let currentRouteGeoJSON: FeatureCollection = { type: "FeatureCollection", features: [] };
  const activeAvoids: Feature<Polygon>[] = [];
  const avoidIds = new Set<string>();

  let iterations = 0;
  const MAX_ITERATIONS = 6;
  let routeIsClean = false;
  let finalError: string | null = null;

  // Blockierende Treffer merken wir uns (damit wir sie sicher melden können)
  let blockedFindings: any[] = [];

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

    // Hard cap: bevor wir weiter wachsen, stoppen wir sauber (verhindert Timeouts/Explosion)
    if (activeAvoids.length >= valhallaSoftMax) {
      finalError = `Avoid polygon limit hit (${activeAvoids.length} >= ${valhallaSoftMax}).`;
      console.error(`[LIMIT] ${finalError}`);
      routeIsClean = false;
      break;
    }

    const result = await callValhalla(valhallaBody, activeAvoids);

    if (result.error || !result.geojson.features.length) {
      finalError = result.error || "No route found";
      console.error(`[FAIL] Iteration ${iterations} failed: ${finalError}`);

      if (fallbackRoute) {
        console.log("Using fallback route from previous iteration.");
        currentRouteGeoJSON = fallbackRoute;
        // Wichtig: bei Fallback setzen wir NICHT clean=true, sondern lassen clean von Findings/Warnings bestimmen
        finalError = null;
      }
      break;
    }

    currentRouteGeoJSON = result.geojson;
    fallbackRoute = result.geojson;

    const routeLine = currentRouteGeoJSON.features[0];
    if (!routeLine || routeLine.geometry.type !== "LineString") break;

    // Konsistenter Buffer um Route
    // @ts-ignore
    const routeBuffer = buffer(routeLine, ROUTE_BUFFER_KM, { units: "kilometers" });

    let newConflictsFound = 0;

    for (const obs of allObstacles) {
      const obsId = stableObsId(obs);
      if (avoidIds.has(obsId)) continue;

      if (booleanIntersects(routeBuffer, obs)) {
        const p = obs.properties || {};
        const limits = getLimits(p);
        const title = p.title || p.description || "unknown";

        // Blockade-Entscheidung (nur width/weight, wie bisher; aber jetzt konsistent)
        const reasons: string[] = [];
        const blockedByWidth = limits.width < 900 && limits.width < vWidth;
        const blockedByWeight = limits.weight < 900 && limits.weight < vWeight;

        if (blockedByWidth) reasons.push(`Width ${limits.width} < ${vWidth}`);
        if (blockedByWeight) reasons.push(`Weight ${limits.weight} < ${vWeight}`);

        const isBlocked = reasons.length > 0;

        if (isBlocked) {
          console.log(`[BLOCK] "${title.slice(0, 60)}" -> ${reasons.join(", ")}`);

          // Wir merken uns blockierende Treffer (für Rückgabe/Debug)
          blockedFindings.push({
            title,
            description: p.description,
            limits,
            coords: centroid(obs).geometry.coordinates,
            reasons,
          });

          // Wir versuchen weiterhin, eine Alternative zu finden (durch Avoid)
          const poly = createAvoidPolygon(obs);
          if (poly) {
            activeAvoids.push(poly);
            avoidIds.add(obsId);
            newConflictsFound++;
          }

          // Wenn wir bereits das Limit erreichen/überschreiten würden, stoppen wir sauber
          if (activeAvoids.length >= valhallaSoftMax) {
            finalError = `Avoid polygon limit hit (${activeAvoids.length} >= ${valhallaSoftMax}).`;
            console.error(`[LIMIT] ${finalError}`);
            routeIsClean = false;
            break;
          }
        }
      }
    }

    // wenn innerer loop wegen limit abgebrochen hat
    if (finalError) break;

    if (newConflictsFound === 0) {
      console.log(`[SUCCESS] No new blocking conflicts in iteration ${iterations}.`);
      // "clean" bestimmen wir final anhand von Warnings/Findings (sicherer)
      routeIsClean = true;
      break;
    }
  }

  /* 3. Warnings (und: blockierende Warnings erzwingen BLOCKED) */
  const warnings: any[] = [];
  const blockingWarnings: any[] = [];

  try {
    if (currentRouteGeoJSON.features.length > 0) {
      const routeLine = currentRouteGeoJSON.features[0];
      // @ts-ignore
      const routeBuffer = buffer(routeLine, ROUTE_BUFFER_KM, { units: "kilometers" });

      for (const obs of allObstacles) {
        const obsId = stableObsId(obs);
        if (avoidIds.has(obsId)) continue;

        if (booleanIntersects(routeBuffer, obs)) {
          const p = obs.properties || {};
          const limits = getLimits(p);

          const title = p.title || "Baustelle/Restriktion";
          const c = centroid(obs).geometry.coordinates;

          const reasons: string[] = [];
          const blockedByWidth = limits.width < 900 && limits.width < vWidth;
          const blockedByWeight = limits.weight < 900 && limits.weight < vWeight;

          if (blockedByWidth) reasons.push(`Width ${limits.width} < ${vWidth}`);
          if (blockedByWeight) reasons.push(`Weight ${limits.weight} < ${vWeight}`);

          const entry = {
            title,
            description: p.description,
            limits,
            coords: c,
            blocking: reasons.length > 0,
            reasons: reasons.length > 0 ? reasons : undefined,
          };

          if (entry.blocking) {
            blockingWarnings.push(entry);
          } else {
            warnings.push(entry);
          }

          // Sicherheitsgrenze
          if (warnings.length + blockingWarnings.length > 40) break;
        }
      }
    }
  } catch {}

  // Wenn wir irgendwo blockierende Treffer haben, darf clean niemals true sein.
  if (blockingWarnings.length > 0) {
    routeIsClean = false;
    if (!finalError) {
      finalError = "Route is blocked by one or more restrictions/roadworks (see blocking_warnings).";
    }
  }

  // status für UI/Debug
  let status: "CLEAN" | "CLEAN_WITH_WARNINGS" | "BLOCKED" | "FAILED" | "LIMIT_HIT" = "FAILED";
  if (finalError && finalError.includes("Avoid polygon limit hit")) status = "LIMIT_HIT";
  else if (!currentRouteGeoJSON.features.length) status = "FAILED";
  else if (blockingWarnings.length > 0) status = "BLOCKED";
  else if (warnings.length > 0) status = "CLEAN_WITH_WARNINGS";
  else if (routeIsClean) status = "CLEAN";
  else status = "FAILED";

  return NextResponse.json({
    meta: {
      source: "route/plan-v16-bbox-only",
      iterations: iterations,
      avoids_applied: activeAvoids.length,
      clean: routeIsClean,
      status,
      error: finalError,
    },
    avoid_applied: { total: activeAvoids.length },
    geojson: currentRouteGeoJSON,

    // non-blocking intersects
    warnings,

    // NEW: blockierende intersects (das ist der Fix für deinen 9m/8.85m Fall)
    blocking_warnings: blockingWarnings,

    // optional: was im Loop als blockierend erkannt wurde (kann du später entfernen)
    blocked_findings: blockedFindings.slice(0, 20),
  });
}
