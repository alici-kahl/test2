// src/lib/avoid.ts
import bbox from '@turf/bbox';
import buffer from '@turf/buffer';
import centroid from '@turf/centroid';
import booleanIntersects from '@turf/boolean-intersects';
import { lineString, polygon, Feature, FeatureCollection, Position } from '@turf/helpers';

/**
 * Grobe Näherung: Meter -> Grad (Longitude/Latitude) für eine gegebene Breite (lat).
 * Reicht fürs Zellenraster (wir machen kein exaktes Geodesy-Grid).
 */
function metersToDeg(m: number, latDeg: number) {
  const latRad = (latDeg * Math.PI) / 180;
  const degLat = m / 111_320;        // ~111.32 km pro Grad Breite
  const degLon = m / (111_320 * Math.cos(latRad) || 1e-6);
  return { degLat, degLon };
}

/**
 * Ermittelt Mittel-Latitude eines BBOX (für die Grid-Umrechnung).
 */
function meanLatOfBbox(b: [number, number, number, number]) {
  return (b[1] + b[3]) / 2;
}

/**
 * Richtungswinkel (in Grad 0..360) einer LineString-Geometrie, basierend auf dem ersten brauchbaren Segment.
 */
export function bearingOfLine(coords: Position[]): number | null {
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x =
      Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
      Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    const brng = (Math.atan2(y, x) * 180) / Math.PI;
    if (Number.isFinite(brng)) {
      const norm = (brng + 360) % 360;
      if (!Number.isNaN(norm)) return norm;
    }
  }
  return null;
}

/**
 * Prüft, ob eine Baustelle in Gegenrichtung liegt, wenn wir beidseitig dir. Info haben.
 * Erwartet:
 *  - rwBearing: Richtung der Baustelle (falls vorhanden, sonst null)
 *  - routeBearing: Richtungswinkel der aktuellen Routen-Geometrie
 *  - properties kann Flags wie { direction: 'both'|'forward'|'backward' } etc. enthalten
 */
export function isOppositeDirection(
  routeBearing: number | null,
  rwBearing: number | null,
  properties: any
): boolean {
  // Wenn wir keine sichere Info haben: nicht filtern
  if (routeBearing == null) return false;

  // Wenn Quelle „both directions“ markiert: nicht filtern
  const dirFlag = (properties?.direction || properties?.dir || '').toString().toLowerCase();
  if (dirFlag.includes('both') || dirFlag.includes('beide')) return false;

  // Wenn wir keine Baustellenrichtung haben, aber 'only X carriageway' Indikator fehlt -> nicht filtern
  if (rwBearing == null && !dirFlag) return false;

  // Toleranz (±60°): bei Autobahnen sind Richtungen relativ stabil
  const tol = 60;

  // Heuristik:
  //  - Wenn rwBearing vorhanden: ist Winkel ~180° zu routeBearing? (Gegenrichtung)
  //  - Wenn nicht, aber dirFlag sagt z.B. 'opposite' / 'Gegenrichtung' -> filtern
  if (rwBearing != null) {
    const delta = Math.abs(rwBearing - routeBearing);
    const wrapped = Math.min(delta, 360 - delta);
    // Gegenrichtung, wenn nahe 180° (+/- tol)
    if (Math.abs(wrapped - 180) <= tol) return true;
    return false;
  }

  // Fallback über Textflag:
  if (dirFlag.includes('opposite') || dirFlag.includes('gegen')) return true;

  return false;
}

/**
 * Verdichtet viele kleine Buffer-Polygone in ein Zellenraster und erzeugt
 * daraus <= targetMax Valhalla-Avoid-Polygone (Rechtecke der belegten Zellen).
 *
 * Rückgabe enthält Meta zur Nachvollziehbarkeit.
 */
export function mergeAvoidPolygonsGrid(
  inputPolys: FeatureCollection,
  corridorPoly: Feature,          // Korridorpolygon (zur Beschneidung)
  targetMax: number               // gewünschte Obergrenze (z.B. 80)
) {
  const bb = bbox(corridorPoly) as [number, number, number, number];
  const midLat = meanLatOfBbox(bb);

  // Start mit heuristischer Zellgröße; wird ggf. dynamisch angepasst.
  let cellMeters = 300; // feines Raster
  let passes = 0;

  while (passes < 6) { // begrenze Anpassversuche, damit es deterministisch bleibt
    const { degLat, degLon } = metersToDeg(cellMeters, midLat);

    // Zellen befüllen
    const usedCells = new Set<string>();

    for (const f of inputPolys.features) {
      if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon') continue;

      // Grobe Beschneidung: nur wenn innerhalb Korridor (überschneidet)
      if (!booleanIntersects(f as any, corridorPoly as any)) continue;

      const c = centroid(f as any).geometry.coordinates as Position;
      const col = Math.floor((c[0] - bb[0]) / degLon);
      const row = Math.floor((c[1] - bb[1]) / degLat);
      usedCells.add(`${col}:${row}`);
    }

    const cellFeatures: Feature[] = [];
    usedCells.forEach((key) => {
      const [colStr, rowStr] = key.split(':');
      const col = Number(colStr), row = Number(rowStr);
      const minX = bb[0] + col * degLon;
      const minY = bb[1] + row * degLat;
      const maxX = minX + degLon;
      const maxY = minY + degLat;

      const poly = polygon([[
        [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]
      ]]);
      // Beschneidung auf Korridor ist optional; Valhalla braucht nur gültige Polygone.
      cellFeatures.push(poly);
    });

    if (cellFeatures.length <= targetMax) {
      return {
        polygons: {
          type: 'FeatureCollection',
          features: cellFeatures
        } as FeatureCollection,
        meta: {
          merged_from: inputPolys.features.length,
          after_merge: cellFeatures.length,
          target_max: targetMax,
          cell_m: cellMeters,
          limit_hit: false
        }
      };
    }

    // zu viele: Zellen vergrößern (gröbere Aggregation)
    cellMeters = Math.round(cellMeters * 1.8);
    passes++;
  }

  // Sicherheitsrückgabe (falls wir die Zielzahl nicht erreichen)
  // mit der letzten Aggregation
  const { degLat, degLon } = metersToDeg(cellMeters, midLat);
  const usedCells = new Set<string>();
  for (const f of inputPolys.features) {
    if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon') continue;
    if (!booleanIntersects(f as any, corridorPoly as any)) continue;
    const c = centroid(f as any).geometry.coordinates as Position;
    const col = Math.floor((c[0] - bb[0]) / degLon);
    const row = Math.floor((c[1] - bb[1]) / degLat);
    usedCells.add(`${col}:${row}`);
  }
  const cellFeatures: Feature[] = [];
  usedCells.forEach((key) => {
    const [colStr, rowStr] = key.split(':');
    const col = Number(colStr), row = Number(rowStr);
    const minX = bb[0] + col * degLon;
    const minY = bb[1] + row * degLat;
    const maxX = minX + degLon;
    const maxY = minY + degLat;

    const poly = polygon([[
      [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]
    ]]);
    cellFeatures.push(poly);
  });

  return {
    polygons: {
      type: 'FeatureCollection',
      features: cellFeatures
    } as FeatureCollection,
    meta: {
      merged_from: inputPolys.features.length,
      after_merge: cellFeatures.length,
      target_max: targetMax,
      cell_m: cellMeters,
      limit_hit: true
    }
  };
}

/**
 * Hilfsfunktion: puffert eine LineString-Baustelle (Meter) zu einem Polygon.
 */
export function bufferLineToPoly(lineCoords: Position[], bufferMeters: number): Feature {
  const ls = lineString(lineCoords);
  // Turf-Buffer erwartet Distanz in Kilometern
  const poly = buffer(ls as any, bufferMeters / 1000, { units: 'kilometers' });
  return poly as any;
}
