import { NextRequest, NextResponse } from "next/server";
import bboxFn from "@turf/bbox";
import buffer from "@turf/buffer";
import booleanIntersects from "@turf/boolean-intersects";
import { lineString, point, featureCollection } from "@turf/helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

type Coords = [number, number];

type PrecheckReq = {
  start: Coords;
  end: Coords;
  vehicle?: {
    width_m?: number;
    weight_t?: number;
  };
  roadworks?: {
    buffer_m?: number; // "technischer" Sicherheitsabstand um Baustellen (Meter)
    only_motorways?: boolean;
    // optional: wie aggressiv wir "früh" wegdrücken (Meter)
    // (wenn du es im UI nicht setzt, nehmen wir sinnvolle Defaults)
    early_avoid_buffer_m?: number;
  };
};

/** Kleines Utility: Zahl robust aus number|string (inkl. "3,25") */
function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.trim().replace(",", ".");
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Sichere Default-Limits für Fahrzeug */
function getVehicleLimits(v?: PrecheckReq["vehicle"]) {
  return {
    width: typeof v?.width_m === "number" ? v.width_m : 999,
    weight: typeof v?.weight_t === "number" ? v.weight_t : 999,
  };
}

/** Einheitliche Limit-Auswertung aus Roadworks-Properties (robust) */
function getObstacleLimits(p: any) {
  const width =
    toNum(p?.max_width_m) ??
    toNum(p?.max_width) ??
    toNum(p?.width_m) ??
    toNum(p?.width) ??
    999;

  const weight =
    toNum(p?.max_weight_t) ??
    toNum(p?.max_weight) ??
    toNum(p?.weight_t) ??
    toNum(p?.weight) ??
    999;

  return { width, weight };
}

/** Clamp helper */
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as PrecheckReq;
  const { start, end } = body;

  if (!start || !end) {
    return NextResponse.json(
      { status: "ERROR", error: "start/end fehlen" },
      { status: 400 }
    );
  }

  const origin = new URL(req.url).origin;

  // 1) Korridor um die Verbindung Start->Ziel (nicht absurd groß!)
  //    buffer_m ist in Metern (typisch 2000m = 2km). Wir clampen sinnvoll.
  const baseLine = lineString([start, end]);

  const baseBufferM = body.roadworks?.buffer_m ?? 2000;
  const corridorBufferKm = clamp((baseBufferM / 1000) * 2.0, 2, 25); // 2..25 km

  const corridor = buffer(baseLine, corridorBufferKm, { units: "kilometers" });
  const bbox = bboxFn(corridor);

  // 2) Roadworks laden (gleiches RPC wie bei dir)
  const rwRes = await fetch(`${origin}/api/roadworks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bbox,
      // ganz wichtig: alle Straßen zulassen, nicht nur Autobahn
      only_motorways: body.roadworks?.only_motorways ?? false,
    }),
    cache: "no-store",
  });

  if (!rwRes.ok) {
    return NextResponse.json({
      status: "WARN",
      clean: false,
      reason: "Roadworks nicht ladbar",
      bbox,
      corridor_buffer_km: corridorBufferKm,
    });
  }

  const rwData = await rwRes.json();
  const features = rwData?.features ?? [];

  const vehicle = getVehicleLimits(body.vehicle);

  const blocking: any[] = [];
  let intersects = 0;

  // 3) Blockierende Baustellen im Korridor identifizieren
  for (const f of features) {
    if (!booleanIntersects(corridor, f)) continue;
    intersects++;

    const limits = getObstacleLimits(f.properties);

    // blockierend, wenn Baustellenlimit < Fahrzeugmaß
    if (limits.width < vehicle.width || limits.weight < vehicle.weight) {
      // Koordinaten robust holen (Point erwartet)
      const coords: any = f?.geometry?.coordinates;
      const lon = Array.isArray(coords) ? coords[0] : null;
      const lat = Array.isArray(coords) ? coords[1] : null;

      blocking.push({
        id: f.properties?.id ?? f.properties?.rw_id ?? undefined,
        title: f.properties?.title ?? f.properties?.name ?? "Baustelle",
        limits,
        coords: typeof lon === "number" && typeof lat === "number" ? [lon, lat] : null,
      });
    }
  }

  // 4) WICHTIG: NICHT "BLOCKED" zurückgeben.
  //    Stattdessen: WARN + große Avoid-Areas, damit das Routing frühzeitig ausweicht.
  //
  //    early_avoid_buffer_m: wie "aggressiv" wir wegdrücken.
  //    Default bewusst größer als buffer_m, damit man Kilometer vorher abbiegt.
  const earlyAvoidM =
    body.roadworks?.early_avoid_buffer_m ??
    Math.max(8000, (body.roadworks?.buffer_m ?? 2000) * 4); // mindestens 8km, sonst 4x buffer

  const earlyAvoidKm = clamp(earlyAvoidM / 1000, 5, 30); // 5..30 km

  const avoidFeatures: any[] = [];
  for (const b of blocking) {
    if (!b.coords) continue;

    // Punkt -> großes "No-Go" Polygon
    const p = point(b.coords, { title: b.title, limits: b.limits });
    const poly = buffer(p, earlyAvoidKm, { units: "kilometers" });
    // Markierung, dass das ein "frühes" Avoid ist
    (poly as any).properties = {
      ...(poly as any).properties,
      avoid_type: "early",
      title: b.title,
      limits: b.limits,
      avoid_buffer_km: earlyAvoidKm,
    };
    avoidFeatures.push(poly);
  }

  const avoid_areas = featureCollection(avoidFeatures);

  // Wenn es keine Blocker im Korridor gibt, darf Routing normal starten.
  if (blocking.length === 0) {
    return NextResponse.json({
      status: "CLEAN",
      clean: true,
      intersects,
      blocking_count: 0,
      bbox,
      corridor_buffer_km: corridorBufferKm,
      message: "Korridor grundsätzlich befahrbar – Routing darf starten",
      avoid_areas, // leer
    });
  }

  // Blocker vorhanden -> wir liefern Avoid-Areas (früher Ausweichdruck)
  return NextResponse.json({
    status: "WARN",
    clean: false,
    intersects,
    blocking_count: blocking.length,
    blocking,
    bbox,
    corridor_buffer_km: corridorBufferKm,
    early_avoid_buffer_km: earlyAvoidKm,
    message:
      "Blockierende Baustellen im Korridor gefunden. Umfahrung soll früh erfolgen (avoid_areas nutzen).",
    avoid_areas,
  });
}
