// src/app/api/route/valhalla/_avoid.ts
export type Coords = [number, number];
type Ring = number[][];                 // [[lon,lat], ...]
export type ExcludePolygons = Ring[];

// --- Geo-Utils
function haversineM(a: [number, number], b: [number, number]) {
  const R = 6371008.8, toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function ringPerimeterM(ring: Ring): number {
  let p = 0; for (let i=1;i<ring.length;i++) p += haversineM(ring[i-1] as any, ring[i] as any); return p;
}
function closeRing(ring: Ring): Ring {
  if (!ring.length) return ring;
  const [fLon, fLat] = ring[0]; const [lLon, lLat] = ring[ring.length-1];
  return (fLon === lLon && fLat === lLat) ? ring : [...ring, ring[0]];
}
function bboxPolygonFromPoints(a: Coords, b: Coords, padDeg = 0.05) {
  const minLon = Math.min(a[0], b[0]) - padDeg, minLat = Math.min(a[1], b[1]) - padDeg;
  const maxLon = Math.max(a[0], b[0]) + padDeg, maxLat = Math.max(a[1], b[1]) + padDeg;
  return { type: "Polygon", coordinates: [[[minLon,minLat],[maxLon,minLat],[maxLon,maxLat],[minLon,maxLat],[minLon,minLat]]]};
}
function fcToExcludePolygons(fc: any): ExcludePolygons {
  const out: ExcludePolygons = [];
  if (!fc || fc.type !== "FeatureCollection") return out;
  for (const f of fc.features || []) {
    const g = f.geometry || {};
    if (g.type === "Polygon" && g.coordinates?.[0]) out.push(closeRing(g.coordinates[0]));
    if (g.type === "MultiPolygon" && Array.isArray(g.coordinates))
      for (const poly of g.coordinates) if (poly?.[0]) out.push(closeRing(poly[0]));
  }
  return out;
}
function filterByPerimeter(polys: ExcludePolygons, maxPerimeterM = 3000): ExcludePolygons {
  return polys.filter(r => ringPerimeterM(r) <= maxPerimeterM);
}

/** Punkte aus Polygonringen – strikt ≤ maxPoints (Default 50) */
export function pointsFromPolysStrict(polys: ExcludePolygons, maxPoints = 50): {lat:number;lon:number}[] {
  if (maxPoints <= 0) return [];
  const seen = new Set<string>();
  const push = (lon:number, lat:number, acc: {lat:number;lon:number}[])=>{
    const key = `${lat.toFixed(3)}|${lon.toFixed(3)}`; // grob ~100m Raster
    if (!seen.has(key)) { seen.add(key); acc.push({lat,lon}); }
  };
  const vertices = polys.reduce((s, r)=>s + r.length, 0);
  const step = Math.max(1, Math.ceil(vertices / maxPoints));
  const out: {lat:number;lon:number}[] = [];
  for (const ring of polys) {
    for (let i=0; i<ring.length; i+=step) { const [lon, lat] = ring[i]; push(lon, lat, out); if (out.length>=maxPoints) return out; }
  }
  if (out.length < maxPoints) {
    for (const ring of polys) { for (let i=1;i<ring.length && out.length<maxPoints;i++){ const [lon,lat]=ring[i]; push(lon,lat,out);} if (out.length>=maxPoints) break; }
  }
  return out.slice(0, maxPoints);
}

/** RPC: Avoid-Polygone (gepuffert/vereinfacht) aus Supabase holen */
export async function fetchAvoidExcludePolygons(opts: {
  start: Coords; end: Coords; ts?: string; tz?: string;
  buffer_m?: number; simplify_m?: number; min_area_m2?: number;
  max_perimeter_m?: number; max_polygons?: number; padDeg?: number;
  client_max_perimeter_m?: number;
}): Promise<ExcludePolygons> {
  const {
    start, end, ts, tz = "Europe/Berlin",
    buffer_m = 6, simplify_m = 10, min_area_m2 = 50,
    max_perimeter_m = 2800, max_polygons = 40, padDeg = 0.05,
    client_max_perimeter_m = 3000,
  } = opts;

  const SUPABASE_URL = process.env.SUPABASE_URL || "<SUPABASE_URL>";
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || "<SERVICE_ROLE_JWT>";
  const bboxGeoJSON = bboxPolygonFromPoints(start, end, padDeg);

  const body = {
    _ts: ts ?? new Date().toISOString(),
    _tz: tz,
    _bbox_geojson: bboxGeoJSON,
    _buffer_m: buffer_m,
    _simplify_m: simplify_m,
    _min_area_m2: min_area_m2,
    _max_perimeter_m: max_perimeter_m,    // DB-seitig
    _max_polygons: max_polygons
  };

  const url = `${SUPABASE_URL}/rest/v1/rpc/get_active_roadworks_avoid_polygons_v3_geojson`;
  const r = await fetch(url, {
    method: "POST",
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error("RPC avoid_polygons failed", r.status, await r.text()); return []; }

  const fc = await r.json();
  const rings = fcToExcludePolygons(fc);
  return filterByPerimeter(rings, client_max_perimeter_m);
}
