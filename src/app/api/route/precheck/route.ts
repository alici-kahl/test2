import { NextRequest, NextResponse } from "next/server";
import bboxFn from "@turf/bbox";
import buffer from "@turf/buffer";
import booleanIntersects from "@turf/boolean-intersects";
import { lineString } from "@turf/helpers";

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
    buffer_m?: number;
    only_motorways?: boolean;
  };
};

/**
 * Sichere Default-Limits
 */
function getVehicleLimits(v?: PrecheckReq["vehicle"]) {
  return {
    width: v?.width_m ?? 999,
    weight: v?.weight_t ?? 999,
  };
}

/**
 * Einheitliche Limit-Auswertung aus Roadworks
 */
function getObstacleLimits(p: any) {
  return {
    width:
      typeof p?.max_width_m === "number"
        ? p.max_width_m
        : typeof p?.max_width === "number"
        ? p.max_width
        : 999,
    weight:
      typeof p?.max_weight_t === "number"
        ? p.max_weight_t
        : typeof p?.max_weight === "number"
        ? p.max_weight
        : 999,
  };
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

  // 1️⃣ Großer, früher Korridor (NICHT lokal!)
  const baseLine = lineString([start, end]);

  const bufferKm =
    Math.max(200, (body.roadworks?.buffer_m ?? 2000) / 1000) * 1.2;

  const corridor = buffer(baseLine, bufferKm, { units: "kilometers" });
  const bbox = bboxFn(corridor);

  // 2️⃣ Roadworks laden (gleiches RPC wie bei dir)
  const rwRes = await fetch(`${origin}/api/roadworks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bbox,
      only_motorways: body.roadworks?.only_motorways ?? false,
    }),
    cache: "no-store",
  });

  if (!rwRes.ok) {
    return NextResponse.json({
      status: "WARN",
      clean: false,
      reason: "Roadworks nicht ladbar",
    });
  }

  const rwData = await rwRes.json();
  const features = rwData?.features ?? [];

  const vehicle = getVehicleLimits(body.vehicle);

  const blocking: any[] = [];
  let intersects = 0;

  // 3️⃣ Brutale, frühe Realität
  for (const f of features) {
    if (!booleanIntersects(corridor, f)) continue;

    intersects++;

    const limits = getObstacleLimits(f.properties);

    if (limits.width < vehicle.width || limits.weight < vehicle.weight) {
      blocking.push({
        title: f.properties?.title,
        limits,
      });
    }
  }

  // 4️⃣ Entscheidung
  if (blocking.length > 0) {
    return NextResponse.json({
      status: "BLOCKED",
      clean: false,
      intersects,
      blocking_count: blocking.length,
      blocking,
      message:
        "Korridor ist grundsätzlich nicht befahrbar – Umfahrung MUSS früher erfolgen",
    });
  }

  return NextResponse.json({
    status: "CLEAN",
    clean: true,
    intersects,
    message:
      "Korridor grundsätzlich befahrbar – Routing darf starten",
  });
}

