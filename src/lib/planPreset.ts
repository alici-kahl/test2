// src/lib/planPreset.ts
export type Coords = [number, number];

export type PlanPreset = {
  corridor: { mode: "soft" | "hard"; width_m: number };
  roadworks: { buffer_m: number; only_motorways: boolean };
  avoid_target_max: number;
  valhalla_soft_max: number;
  respect_direction: boolean;
  alternates: number;
};

export const DEFAULT_PLAN_PRESET: PlanPreset = {
  corridor: { mode: "soft", width_m: 2000 },
  roadworks: { buffer_m: 60, only_motorways: true },
  avoid_target_max: 120,
  valhalla_soft_max: 80,
  respect_direction: true,
  alternates: 1,
};

type BuildExtras = {
  ts?: string;
  tz?: string;
  vehicle?: { width_m?: number; height_m?: number; weight_t?: number; axleload_t?: number };
  directions_language?: string;
};

function deepMerge<T extends object>(base: T, patch: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (out as any)[k] === "object" && (out as any)[k] !== null) {
      (out as any)[k] = deepMerge((out as any)[k], v as any);
    } else {
      (out as any)[k] = v as any;
    }
  }
  return out;
}

export function buildPlanBody(
  start: Coords,
  end: Coords,
  overrides: Partial<PlanPreset> = {},
  extras: BuildExtras = {}
) {
  const merged = deepMerge(DEFAULT_PLAN_PRESET, overrides);
  const body: any = {
    start,
    end,
    corridor: merged.corridor,
    roadworks: merged.roadworks,
    avoid_target_max: merged.avoid_target_max,
    valhalla_soft_max: merged.valhalla_soft_max,
    respect_direction: merged.respect_direction,
    alternates: merged.alternates,
  };
  if (extras.ts) body.ts = extras.ts;
  if (extras.tz) body.tz = extras.tz;
  if (extras.vehicle) body.vehicle = extras.vehicle;
  if (extras.directions_language) body.directions_language = extras.directions_language;
  return body;
}
