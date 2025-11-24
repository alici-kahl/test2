// app/lib/geo.ts
export function degToRad(d: number): number { return d * Math.PI / 180; }
export function radToDeg(r: number): number { return r * 180 / Math.PI; }
export function normDeg180(d: number): number {
  let x = (d + 180) % 360;
  if (x < 0) x += 360;
  return x - 180;
}
export function lonLatToWebMercator(ll: [number, number]): [number, number] {
  const [lon, lat] = ll;
  const x = lon * 20037508.34 / 180.0;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360.0)) / (Math.PI / 180.0);
  return [x, y * 20037508.34 / 180.0];
}
export function webMercatorToLonLat(m: [number, number]): [number, number] {
  const [x, y] = m;
  const lon = x / 20037508.34 * 180.0;
  let lat = y / 20037508.34 * 180.0;
  lat = 180 / Math.PI * (2 * Math.atan(Math.exp(lat * Math.PI / 180.0)) - Math.PI / 2);
  return [lon, lat];
}
export function pointToSegDistMeters(p: [number, number], a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const c2 = vx * vx + vy * vy;
  if (c2 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, c1 / c2));
  const projx = a[0] + t * vx;
  const projy = a[1] + t * vy;
  return Math.hypot(p[0] - projx, p[1] - projy);
}
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const φ1 = degToRad(lat1);
  const φ2 = degToRad(lat2);
  const λ1 = degToRad(lon1);
  const λ2 = degToRad(lon2);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  let θ = radToDeg(Math.atan2(y, x));
  if (θ < 0) θ += 360;
  return θ;
}
export function lineMidpoint(ll: [number, number][]): [number, number] {
  if (!ll || ll.length === 0) return [0, 0];
  const idx = Math.floor(ll.length / 2);
  return ll[Math.min(ll.length - 1, Math.max(0, idx))] as [number, number];
}
export function lineBBoxMeters(ll: [number, number][]): [number, number, number, number] {
  let minx = Number.POSITIVE_INFINITY, miny = Number.POSITIVE_INFINITY;
  let maxx = Number.NEGATIVE_INFINITY, maxy = Number.NEGATIVE_INFINITY;
  for (const c of ll) {
    const m = lonLatToWebMercator(c as [number, number]);
    if (m[0] < minx) minx = m[0];
    if (m[0] > maxx) maxx = m[0];
    if (m[1] < miny) miny = m[1];
    if (m[1] > maxy) maxy = m[1];
  }
  return [minx, miny, maxx, maxy];
}
export function expandBBoxMetersToPolygonLonLat(
  bboxM: [number, number, number, number],
  pad_m: number
): [number, number][] {
  const [minx, miny, maxx, maxy] = bboxM;
  const x0 = minx - pad_m, y0 = miny - pad_m;
  const x1 = maxx + pad_m, y1 = maxy + pad_m;
  const sw = webMercatorToLonLat([x0, y0]);
  const se = webMercatorToLonLat([x1, y0]);
  const ne = webMercatorToLonLat([x1, y1]);
  const nw = webMercatorToLonLat([x0, y1]);
  return [sw, se, ne, nw, sw];
}
