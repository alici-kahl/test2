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
  vehicle?: { width_m?: number; height_m?: number; weight_t?: number; axleload_t?: number; };
  ts?: string;
  tz?: string;
  corridor?: { width_m?: number };
  roadworks?: { buffer_m?: number; only_motorways?: boolean };
  alternates?: number;
  directions_language?: string;
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
        const wMatch = text.match(/(?:Breite|width|breite)[^0-9]*([0-9]+(?:[.,][0-9]+)?)\s*m/i) || 
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

// --- FINALER FIX: NUR NOCH RECHTECKE ---
// Diese Funktion wandelt JEDES Hindernis in ein simples Viereck um.
// Das verhindert den "fetch failed" bei Valhalla, weil die Datenmenge winzig bleibt.
function createAvoidPolygon(f: Feature<any>): Feature<Polygon> | null {
    try {
        // 1. Kleiner Buffer (20m), damit Linien zu Flächen werden
        const km = 0.02; 
        const bf = buffer(f, km, { units: "kilometers" });
        if (!bf) return null;
        
        // 2. Wir nehmen NUR die Bounding Box.
        // Keine komplexen Formen mehr. Nur 5 Punkte: [minX, minY, maxX, maxY]
        const b = bboxFn(bf);
        
        return polygon([[
            [b[0], b[1]], // unten-links
            [b[2], b[1]], // unten-rechts
            [b[2], b[3]], // oben-rechts
            [b[0], b[3]], // oben-links
            [b[0], b[1]]  // schließen
        ]]);
    } catch { return null; }
}

async function callValhalla(reqBody: any, avoidPolys: Feature<Polygon>[]): Promise<{ geojson: FeatureCollection; error?: string }> {
    const payload = {
        ...reqBody,
        avoid_polygons: avoidPolys.length > 0 ? avoidPolys.map(p => p.geometry) : undefined
    };

    try {
        const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
        
        // Timeout auf 60 Sekunden erhöht
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const res = await fetch(`${host}/api/route/valhalla`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!res.ok) {
            const txt = await res.text();
            return { geojson: { type: "FeatureCollection", features: [] }, error: `Status ${res.status}: ${txt.slice(0,100)}` };
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
  try { return await fetch(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
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
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts, tz, bbox: queryBBox, buffer_m: 10, vehicle: body.vehicle, max_polygons: 1000 })
    }, 5000);
    if (rRes.ok) { const j = await rRes.json(); allObstacles.push(...(j.geojson?.features || [])); }
  } catch (e) {}

  try {
    const rwRes = await fetchWithTimeout(new URL("/api/roadworks", req.nextUrl.origin), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts, tz, bbox: queryBBox, only_motorways: false })
    }, 5000);
    if (rwRes.ok) { const j = await rwRes.json(); allObstacles.push(...(j.features || [])); }
  } catch (e) {}

  /* 2. Iteration Loop */
  let currentRouteGeoJSON: FeatureCollection = { type: "FeatureCollection", features: [] };
  const activeAvoids: Feature<Polygon>[] = [];
  const avoidIds = new Set<string>(); 
  
  let iterations = 0;
  const MAX_ITERATIONS = 6;
  let routeIsClean = false;
  let finalError = null;

  const valhallaBody = {
      start, end, vehicle: body.vehicle, 
      alternates: body.alternates ?? 1, 
      directions_language: body.directions_language ?? "de-DE"
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
      if (!routeLine || routeLine.geometry.type !== "LineString") break;

      // Buffer um Route
      // @ts-ignore
      const routeBuffer = buffer(routeLine, 0.015, { units: 'kilometers' }); 

      let newConflictsFound = 0;

      for (const obs of allObstacles) {
          const obsId = JSON.stringify(obs.geometry.coordinates).slice(0, 50) + (obs.properties?.id || "");
          if (avoidIds.has(obsId)) continue; 

          if (booleanIntersects(routeBuffer, obs)) {
              const p = obs.properties || {};
              const limits = getLimits(p);
              const title = p.title || p.description || "unknown";
              
              let isConflict = false;
              let reasons: string[] = [];

              if (limits.width < 900 && limits.width < vWidth) {
                  isConflict = true;
                  reasons.push(`Width ${limits.width} < ${vWidth}`);
              }
              if (!isConflict && limits.weight < 900 && limits.weight < vWeight) {
                  isConflict = true;
                  reasons.push(`Weight ${limits.weight} < ${vWeight}`);
              }

              if (isConflict) {
                  console.log(`[CONFLICT] "${title.slice(0,30)}..." -> Reason: ${reasons.join(", ")}`);
                  
                  const poly = createAvoidPolygon(obs);
                  if (poly) {
                      activeAvoids.push(poly);
                      avoidIds.add(obsId);
                      newConflictsFound++;
                  }
              }
          }
      }

      if (newConflictsFound === 0) {
          console.log(`[SUCCESS] Clean route found in iteration ${iterations}.`);
          routeIsClean = true;
          break; 
      }
  }

  /* 3. Warnings */
  const warnings: any[] = [];
  try {
    if (currentRouteGeoJSON.features.length > 0) {
        const routeLine = currentRouteGeoJSON.features[0];
        // @ts-ignore
        const routeBuffer = buffer(routeLine, 0.02, { units: 'kilometers' });

        for (const obs of allObstacles) {
            const obsId = JSON.stringify(obs.geometry.coordinates).slice(0, 50) + (obs.properties?.id || "");
            if (avoidIds.has(obsId)) continue;

            if (booleanIntersects(routeBuffer, obs)) {
                const p = obs.properties || {};
                warnings.push({
                    title: p.title || "Baustelle ohne Einschränkung",
                    description: p.description,
                    limits: getLimits(p),
                    coords: centroid(obs).geometry.coordinates
                });
                if (warnings.length > 20) break; 
            }
        }
    }
  } catch (e) {}

  return NextResponse.json({
    meta: {
      source: "route/plan-v16-bbox-only",
      iterations: iterations,
      avoids_applied: activeAvoids.length,
      clean: routeIsClean,
      error: finalError
    },
    avoid_applied: { total: activeAvoids.length },
    geojson: currentRouteGeoJSON,
    warnings: warnings 
  });
}
