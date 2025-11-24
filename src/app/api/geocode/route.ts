// src/app/api/geocode/route.ts
import { NextRequest, NextResponse } from "next/server";

const ORS_BASE = "https://api.openrouteservice.org";
const ORS_KEY = process.env.ORS_API_KEY!;

// Hilfsfunktionen
function ok(data: unknown, init: number = 200) {
  return NextResponse.json(data, { status: init });
}
function bad(msg: string, init: number = 400) {
  return ok({ error: msg }, init);
}

/**
 * GET /api/geocode?q=Adresse   -> vorwärts
 * GET /api/geocode?lon=..&lat=.. -> rückwärts
 * Antwort: { lon, lat, label }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const lon = searchParams.get("lon");
  const lat = searchParams.get("lat");

  try {
    if (q) {
      // Vorwärts-Geocoding
      const url = `${ORS_BASE}/geocode/search?text=${encodeURIComponent(q)}&size=1&lang=de`;
      const r = await fetch(url, { headers: { Authorization: ORS_KEY } });
      if (!r.ok) return bad(`Geocoding fehlgeschlagen (${r.status})`, r.status);
      const j = await r.json();
      const f = j.features?.[0];
      if (!f) return bad("Keine Treffer für Adresse.");
      const [LON, LAT] = f.geometry.coordinates;
      const label = f.properties.label || q;
      return ok({ lon: LON, lat: LAT, label });
    }

    if (lon && lat) {
      // Rückwärts-Geocoding
      const url = `${ORS_BASE}/geocode/reverse?point.lon=${lon}&point.lat=${lat}&size=1&lang=de`;
      const r = await fetch(url, { headers: { Authorization: ORS_KEY } });
      if (!r.ok) return bad(`Reverse-Geocoding fehlgeschlagen (${r.status})`, r.status);
      const j = await r.json();
      const f = j.features?.[0];
      const label = f?.properties?.label || `${lon},${lat}`;
      return ok({ lon: Number(lon), lat: Number(lat), label });
    }

    return bad("Parameter fehlen. Nutze ?q=… oder ?lon=…&lat=…");
  } catch (e: any) {
    return bad(e?.message || "Unbekannter Fehler", 500);
  }
}
