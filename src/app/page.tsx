"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { Map, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

// >>> Preset/Builder (bereits angelegt)
import { buildPlanBody, DEFAULT_PLAN_PRESET } from "../lib/planPreset";

type Coords = [number, number];
type Suggestion = { label: string; coord: Coords; raw: any };

const sToMin = (s: number) => Math.round((s || 0) / 60);

// -------------------- Helpers --------------------
function parseLonLat(input: string): Coords | null {
  const parts = input.split(",").map((s) => s.trim());
  if (parts.length !== 2) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

async function geocode(addr: string): Promise<Coords | null> {
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "1");
  u.searchParams.set("q", addr);
  u.searchParams.set("countrycodes", "de");
  const r = await fetch(u.toString(), {
    headers: { "User-Agent": "route-mvp/0.1 (demo)", "Accept-Language": "de" },
  });
  const j = await r.json();
  if (Array.isArray(j) && j[0]) {
    const lon = Number(j[0].lon);
    const lat = Number(j[0].lat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }
  return null;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatSuggestion(row: any): string | null {
  const a = row?.address || {};
  const road =
    a.road ||
    a.pedestrian ||
    a.footway ||
    a.path ||
    a.cycleway ||
    a.residential ||
    a.neighbourhood;
  const housenr = a.house_number || "";
  const postcode = a.postcode || "";
  const city =
    a.city ||
    a.town ||
    a.village ||
    a.municipality ||
    a.suburb ||
    a.hamlet ||
    a.county ||
    "";
  if (!road && !postcode && !city) return null;
  const streetPart = [road, housenr].filter(Boolean).join(" ").trim();
  const placePart = [postcode, city].filter(Boolean).join(", ").trim();
  return [streetPart, placePart].filter(Boolean).join(", ");
}

// -------------------- Autocomplete --------------------
function AutocompleteInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onSelect: (s: Suggestion) => void;
  getMapInfo: () => {
    center?: { lat: number; lon: number };
    bounds?: { left: number; top: number; right: number; bottom: number };
  };
}) {
  const { value, onChange, placeholder, onSelect, getMapInfo } = props;
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFocused(false);
        abortRef.current?.abort();
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (!focused) {
      setOpen(false);
      setLoading(false);
      abortRef.current?.abort();
      return;
    }
    if (value.trim().length < 3) {
      setItems([]);
      setOpen(false);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      abortRef.current?.abort();
      const aborter = new AbortController();
      abortRef.current = aborter;
      const myReqId = ++reqIdRef.current;

      try {
        setLoading(true);
        const info = getMapInfo();
        const u = new URL("https://nominatim.openstreetmap.org/search");
        u.searchParams.set("format", "jsonv2");
        u.searchParams.set("addressdetails", "1");
        u.searchParams.set("limit", "10");
        u.searchParams.set("q", value.trim());
        u.searchParams.set("countrycodes", "de");
        if (info.center) {
          u.searchParams.set("lat", String(info.center.lat));
          u.searchParams.set("lon", String(info.center.lon));
        }
        if (info.bounds) {
          const { left, top, right, bottom } = info.bounds;
          u.searchParams.set("viewbox", `${left},${top},${right},${bottom}`);
        }
        const r = await fetch(u.toString(), {
          headers: { "User-Agent": "route-mvp/0.1 (demo)", "Accept-Language": "de" },
          signal: aborter.signal,
        });
        const j = await r.json();
        if (reqIdRef.current !== myReqId) return;

        let list: Suggestion[] = Array.isArray(j)
          ? (j
              .map((row: any) => {
                const label = formatSuggestion(row);
                if (!label) return null;
                return {
                  label,
                  coord: [Number(row.lon), Number(row.lat)] as Coords,
                  raw: row,
                };
              })
              .filter(Boolean) as Suggestion[])
          : [];

        const ctr = info.center;
        const b = info.bounds;
        const inBox = (s: Suggestion) =>
          b
            ? s.coord[0] >= b.left &&
              s.coord[0] <= b.right &&
              s.coord[1] >= b.bottom &&
              s.coord[1] <= b.top
            : false;

        list = list
          .map((s) => {
            const dist = ctr
              ? haversine(ctr.lat, ctr.lon, s.coord[1], s.coord[0])
              : Number.POSITIVE_INFINITY;
            const rank = typeof s.raw?.place_rank === "number" ? s.raw.place_rank : 0;
            const imp = typeof s.raw?.importance === "number" ? s.raw.importance : 0;
            return {
              s,
              key: [inBox(s) ? 0 : 1, Math.round(dist), -rank, -imp, s.label.toLowerCase()],
            };
          })
          .sort((a: any, b2: any) => {
            for (let i = 0; i < a.key.length; i++) {
              const av = a.key[i];
              const bv = b2.key[i];
              if (av === bv) continue;
              if (typeof av === "number" && typeof bv === "number") return av - bv;
              return String(av).localeCompare(String(bv), "de");
            }
            return 0;
          })
          .map((x: any) => x.s);

        setItems(list);
        setHi(0);
        setOpen(focused && list.length > 0);
      } catch (err) {
        if ((err as any)?.name !== "AbortError") {
          setItems([]);
          setOpen(false);
        }
      } finally {
        if (reqIdRef.current === myReqId) setLoading(false);
      }
    }, 220) as unknown as number;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused, getMapInfo]);

  const selectIdx = (idx: number) => {
    const s = items[idx];
    if (!s) return;
    onSelect(s);
    setOpen(false);
    setFocused(false);
    abortRef.current?.abort();
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        className="inp"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((p) => Math.min(items.length - 1, p + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((p) => Math.max(0, p - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            selectIdx(hi);
          } else if (e.key === "Escape") {
            setOpen(false);
            setFocused(false);
            abortRef.current?.abort();
          }
        }}
      />
      {open && (
        <div
          style={{
            position: "absolute",
            zIndex: 20,
            top: "100%",
            left: 0,
            right: 0,
            background: "#fff",
            border: "1px solid #ddd",
            borderRadius: 8,
            marginTop: 4,
            maxHeight: 280,
            overflow: "auto",
            boxShadow:
              "0 8px 16px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.08)",
          }}
        >
          {loading && <div style={{ padding: 10, fontSize: 13, color: "#666" }}>Suche…</div>}
          {!loading &&
            items.map((it, i) => (
              <div
                key={i}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectIdx(i);
                }}
                style={{
                  padding: "10px 12px",
                  fontSize: 14,
                  lineHeight: 1.35,
                  cursor: "pointer",
                  background: i === hi ? "#eef3ff" : "#fff",
                }}
              >
                {it.label}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// -------------------- Page --------------------
export default function Page() {
  const [startInput, setStartInput] = useState("6.9603, 50.9375");
  const [endInput, setEndInput] = useState("7.4653, 51.5136");
  const [startPick, setStartPick] = useState<Suggestion | null>(null);
  const [endPick, setEndPick] = useState<Suggestion | null>(null);

  const [width, setWidth] = useState(3);
  const [height, setHeight] = useState(4);
  const [weight, setWeight] = useState(40);
  const [axle, setAxle] = useState(10);
  const [bufferValhalla, setBufferValhalla] = useState(40);

  // >>> Schalter: klassisch vs. Planer
  const [usePlanner, setUsePlanner] = useState(true);

  // >>> Planner-Presets (starten mit DEFAULT_PLAN_PRESET)
  const [corridorWidth, setCorridorWidth] = useState<number>(
    DEFAULT_PLAN_PRESET.corridor.width_m
  );
  const [respectDir, setRespectDir] = useState<boolean>(
    DEFAULT_PLAN_PRESET.respect_direction
  );
  const [rwBuffer, setRwBuffer] = useState<number>(DEFAULT_PLAN_PRESET.roadworks.buffer_m);
  const [avoidTargetMax, setAvoidTargetMax] = useState<number>(
    DEFAULT_PLAN_PRESET.avoid_target_max
  );
  const [valhallaSoftMax, setValhallaSoftMax] = useState<number>(
    DEFAULT_PLAN_PRESET.valhalla_soft_max
  );
  const [alternates, setAlternates] = useState<number>(DEFAULT_PLAN_PRESET.alternates);

  // Telemetrie vom Planer
  const [planMeta, setPlanMeta] = useState<null | {
    after_merge?: number;
    cell_m?: number;
    grid_cells?: number;
    avoid_polygons?: number;
    limit_hit?: boolean;
  }>(null);

  const [showRoadworks, setShowRoadworks] = useState(true);
  const [rwLoading, setRwLoading] = useState(false);
  const [rwCount, setRwCount] = useState(0);

  // >>> NEU: Blockade-Info aus /api/route/plan
  const [planBlocked, setPlanBlocked] = useState<null | {
    error?: string | null;
    warnings?: any[];
    meta?: any;
  }>(null);

  const [whenIsoLocal, setWhenIsoLocal] = useState<string>(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  });

  const mapRef = useRef<Map | null>(null);
  const mapLoadedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [geojson, setGeojson] = useState<any | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [steps, setSteps] = useState<
    { instruction: string; distance_km: number; duration_s: number; street_names: string[] }[]
  >([]);
  const [streets, setStreets] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [startCoord, setStartCoord] = useState<Coords | null>(null);
  const [endCoord, setEndCoord] = useState<Coords | null>(null);

  // -------------------- Map init --------------------
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          osm: {
            type: "raster",
            tiles: [
              "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
              "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
              "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
            ],
            tileSize: 256,
            attribution:
              '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          },
          "route-active": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
          "route-alts": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
          points: { type: "geojson", data: { type: "FeatureCollection", features: [] } },

          // Linien-Quelle
          "roadworks-lines": {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },

          // Ungeclusterte Icon-Quelle (für Sicht ab Zoom >= 11)
          "roadworks-icons": {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },

          // Geclusterte Spiegelquelle derselben Punkte (für Zoom <= 10)
          "roadworks-icons-cluster": {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            cluster: true,
            clusterMaxZoom: 10,
            clusterRadius: 50,
          },
        },
        layers: [
          { id: "osm", type: "raster", source: "osm" },

          // Routen-Layer
          {
            id: "route-active-casing",
            type: "line",
            source: "route-active",
            paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
            layout: { "line-join": "round", "line-cap": "round" },
          },
          {
            id: "route-active-line",
            type: "line",
            source: "route-active",
            paint: { "line-color": "#1E90FF", "line-width": 6 },
            layout: { "line-join": "round", "line-cap": "round" },
          },
          {
            id: "route-alts-line",
            type: "line",
            source: "route-alts",
            paint: {
              "line-color": "#666",
              "line-width": 5,
              "line-opacity": 0.9,
              "line-dasharray": [2, 2],
            },
            layout: { "line-join": "round", "line-cap": "round" },
          },
          {
            id: "points-circle",
            type: "circle",
            source: "points",
            paint: {
              "circle-radius": 6,
              "circle-color": ["match", ["get", "role"], "start", "#00A651", "#D84A4A"],
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 2,
            },
          },

          // Roadworks-Linien
          {
            id: "roadworks-line-casing",
            type: "line",
            source: "roadworks-lines",
            paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 },
            layout: { "line-join": "round", "line-cap": "round" },
          },
          {
            id: "roadworks-line",
            type: "line",
            source: "roadworks-lines",
            paint: { "line-color": "#E67E22", "line-width": 4 },
            layout: { "line-join": "round", "line-cap": "round" },
          },

          // --- Cluster bis Zoom 10 ---
          {
            id: "roadworks-clusters",
            type: "circle",
            source: "roadworks-icons-cluster",
            minzoom: 0,
            maxzoom: 11,
            filter: ["has", "point_count"],
            paint: {
              "circle-color": "#d28a3a",
              "circle-opacity": 0.88,
              "circle-stroke-color": "#7a4a15",
              "circle-stroke-width": 1.2,
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                3,
                10,
                6,
                14,
                9,
                ["+", 10, ["*", 2, ["ln", ["+", 2, ["get", "point_count"]]]]],
              ],
            },
          },
          {
            id: "roadworks-cluster-count",
            type: "symbol",
            source: "roadworks-icons-cluster",
            minzoom: 0,
            maxzoom: 11,
            filter: ["has", "point_count"],
            layout: {
              "text-field": ["get", "point_count_abbreviated"],
              "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
              "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 9, 12],
              "text-allow-overlap": true,
            },
            paint: { "text-color": "#ffffff" },
          },

          // --- Einzel-Icons ab Zoom 11 ---
          {
            id: "roadworks-icon",
            type: "symbol",
            source: "roadworks-icons",
            minzoom: 11,
            layout: {
              "icon-image": "roadwork-24",
              "icon-allow-overlap": false,
              "icon-ignore-placement": false,
              "icon-anchor": "center",
              "icon-pitch-alignment": "viewport",
              "icon-rotation-alignment": "viewport",
              "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.16, 13, 0.2, 15, 0.26, 17, 0.32],
            },
          },

          // Fallback-Kreis falls PNG nicht lädt
          {
            id: "roadworks-icon-fallback",
            type: "circle",
            source: "roadworks-icons",
            minzoom: 11,
            layout: { visibility: "none" },
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.0, 17, 4.0],
              "circle-color": "#E67E22",
              "circle-stroke-width": 1.5,
              "circle-stroke-color": "#ffffff",
            },
          },
        ],
      },
      center: [7.1, 51.1],
      zoom: 8.2,
    });

    mapRef.current = map;
    (window as any).maplibreMap = map;

    map.on("load", async () => {
      mapLoadedRef.current = true;

      // --- Icon laden ---
      try {
        const res = await fetch("/roadwork.png", { cache: "no-cache" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        if (!map.hasImage("roadwork-24")) map.addImage("roadwork-24", bmp);
        map.setLayoutProperty("roadworks-icon-fallback", "visibility", "none");
      } catch (e) {
        console.error("[icons] failed to register roadwork-24:", e);
        map.setLayoutProperty("roadworks-icon-fallback", "visibility", "visible");
      }

      refreshRoadworks();
    });

    map.on("mouseenter", "route-alts-line", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "route-alts-line", () => (map.getCanvas().style.cursor = ""));
    map.on("click", "route-alts-line", (e: MapMouseEvent) => {
      const idx = e.features?.[0]?.properties?.idx;
      if (typeof idx === "number") setActiveIdx(idx);
    });

    // Popups für Straßenarbeiten (FIXED: nur eine Popup-Version, keine Duplikate)
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false });

    const openRoadworkPopup = (f: maplibregl.MapboxGeoJSONFeature) => {
      const p: any = f.properties || {};

      const fmtNum = (v: any, unit: string, digits = 2) => {
        if (v === null || v === undefined || v === "") return "unbekannt";
        const n =
          typeof v === "number"
            ? v
            : typeof v === "string"
              ? Number(v.replace(",", "."))
              : NaN;
        return Number.isFinite(n) ? `${n.toFixed(digits)} ${unit}` : "unbekannt";
      };

      const fmtBool = (v: any) => (v === true ? "JA" : v === false ? "NEIN" : "unbekannt");
      const fmtDays = (v: any) => (Array.isArray(v) ? v.join(",") : "-");

      const html = `
        <div style="min-width:260px; max-width:360px">
          <div style="font-weight:600; margin-bottom:6px">${p.title ?? "Baustelle"}</div>
          <div style="font-size:12px; color:#444; line-height:1.4">
            <div><b>ID:</b> ${p.external_id ?? "-"}</div>
            <div><b>Gültig:</b> ${p.valid_from ?? "-"} – ${p.valid_to ?? "-"}</div>
            <div><b>Fenster:</b> ${p.start_time ?? "-"}–${p.end_time ?? "-"} (Tage: ${fmtDays(p.days)})</div>
            <div><b>Länge:</b> ${
              typeof p.length_m === "number" ? (p.length_m / 1000).toFixed(2) + " km" : "-"
            }</div>
            <div><b>Quelle:</b> ${p.source ?? "–"}</div>

            <hr style="border:none;border-top:1px solid #eee;margin:8px 0" />

            <div style="font-weight:600; margin-bottom:4px">Limits</div>
            <div><b>Max. Breite:</b> ${fmtNum(p.max_width_m ?? p.max_width, "m", 2)}</div>
            <div><b>Max. Höhe:</b> ${fmtNum(p.max_height_m ?? p.max_height, "m", 2)}</div>
            <div><b>Max. Gewicht:</b> ${fmtNum(p.max_weight_t ?? p.max_weight, "t", 1)}</div>
            <div><b>Max. Achslast:</b> ${fmtNum(p.max_axle_t ?? p.max_axleload_t, "t", 1)}</div>
            <div><b>Hard-Block:</b> ${fmtBool(p._hard_block)}</div>
          </div>
        </div>
      `;

      const g: any = f.geometry;
      let center: [number, number] | undefined;

      if (g?.type === "Point") center = g.coordinates as [number, number];
      if (!center && g?.type === "LineString" && Array.isArray(g.coordinates) && g.coordinates.length) {
        center = g.coordinates[Math.floor(g.coordinates.length / 2)] as [number, number];
      }

      if (center) popup.setLngLat(center).setHTML(html).addTo(map);
    };

    map.on("click", "roadworks-line", (e) => {
      console.log("CLICK roadworks-line", e);
      const f = e.features?.[0];
      if (f) openRoadworkPopup(f);
    });
    map.on("click", "roadworks-icon", (e) => {
      console.log("CLICK roadworks-icon", e);
      const f = e.features?.[0];
      if (f) openRoadworkPopup(f);
    });

    // Cluster: Zoom-in bei Klick
    map.on("click", "roadworks-clusters", (e) => {
      const feats = map.queryRenderedFeatures(e.point, { layers: ["roadworks-clusters"] });
      const clusterId = feats[0]?.properties?.cluster_id;
      const src = map.getSource("roadworks-icons-cluster") as maplibregl.GeoJSONSource & {
        getClusterExpansionZoom?: (id: number, cb: (err: any, zoom: number) => void) => void;
      };
      if (clusterId && src?.getClusterExpansionZoom) {
        src.getClusterExpansionZoom(Number(clusterId), (err, zoom) => {
          if (!err && typeof zoom === "number") {
            const [lng, lat] = (feats[0].geometry as any).coordinates;
            map.easeTo({ center: [lng, lat], zoom });
          }
        });
      }
    });
    map.on("mouseenter", "roadworks-clusters", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "roadworks-clusters", () => (map.getCanvas().style.cursor = ""));

    const onResize = () => map.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      map.remove();
      mapRef.current = null;
      mapLoadedRef.current = false;
    };
  }, []);

  // -------------------- Route zeichnen --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // >>> NEU: wenn keine Route vorhanden, Linienquellen leeren
    if (!geojson) {
      (map.getSource("route-active") as maplibregl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: [],
      });
      (map.getSource("route-alts") as maplibregl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: [],
      });
      setSteps([]);
      setStreets([]);
      return;
    }

    const features: any[] = geojson.features ?? [];
    {
      const active = features[activeIdx] ?? features[0];
      const alts = features
        .map((f: any, i: number) => ({ ...f, properties: { ...(f.properties || {}), idx: i } }))
        .filter((_: any, i: number) => i !== activeIdx);

      (map.getSource("route-active") as maplibregl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: active ? [active] : [],
      });
      (map.getSource("route-alts") as maplibregl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: alts,
      });

      const maneuvers = active?.properties?.maneuvers ?? [];
      setSteps(maneuvers);
      setStreets(active?.properties?.streets_sequence ?? []);

      const pts: any[] = [];
      if (startCoord)
        pts.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: startCoord },
          properties: { role: "start" },
        });
      if (endCoord)
        pts.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: endCoord },
          properties: { role: "end" },
        });
      (map.getSource("points") as maplibregl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: pts,
      });

      const bbox: [number, number, number, number] | undefined = active?.properties?.bbox;
      if (bbox) {
        map.fitBounds(
          [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[3]],
          ],
          { padding: { top: 40, right: 40, bottom: 40, left: 360 } }
        );
      }
    }
  }, [geojson, activeIdx, startCoord, endCoord]);

  // -------------------- Roadworks fetch + draw --------------------
  async function refreshRoadworks() {
    if (!showRoadworks) return;
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;

    const b = map.getBounds();
    const bbox: [number, number, number, number] = [
      b.getWest(),
      b.getSouth(),
      b.getEast(),
      b.getNorth(),
    ];

    // lokale Zeit -> ISO UTC
    const local = new Date(whenIsoLocal);
    const ts = new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin";

    setRwLoading(true);
    try {
      const res = await fetch("/api/roadworks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts, tz, bbox }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "HTTP " + res.status);

      const fc = data as { type: string; features: any[]; meta: any };

      const lineSrc = map.getSource("roadworks-lines") as maplibregl.GeoJSONSource | undefined;
      if (lineSrc) lineSrc.setData(fc);

      const pointFeats = (fc.features || [])
        .map((f: any) => {
          const p = f.properties || {};
          if (typeof p._icon_lon === "number" && typeof p._icon_lat === "number") {
            return {
              type: "Feature",
              geometry: { type: "Point", coordinates: [p._icon_lon, p._icon_lat] },
              properties: p,
            };
          }
          const g = f.geometry;
          if (g?.type === "LineString" && Array.isArray(g.coordinates) && g.coordinates.length) {
            const mid = g.coordinates[Math.floor(g.coordinates.length / 2)];
            return { type: "Feature", geometry: { type: "Point", coordinates: mid }, properties: p };
          }
          return null;
        })
        .filter(Boolean) as any[];

      const iconSrc = map.getSource("roadworks-icons") as maplibregl.GeoJSONSource | undefined;
      if (iconSrc) iconSrc.setData({ type: "FeatureCollection", features: pointFeats });

      const clusterSrc = map.getSource("roadworks-icons-cluster") as maplibregl.GeoJSONSource | undefined;
      if (clusterSrc) clusterSrc.setData({ type: "FeatureCollection", features: pointFeats });

      setRwCount(fc?.features?.length ?? 0);
    } catch (e) {
      console.error("roadworks fetch failed", e);
      setRwCount(0);
      const lineSrc = map.getSource("roadworks-lines") as maplibregl.GeoJSONSource | undefined;
      if (lineSrc) lineSrc.setData({ type: "FeatureCollection", features: [] });
      const iconSrc = map.getSource("roadworks-icons") as maplibregl.GeoJSONSource | undefined;
      if (iconSrc) iconSrc.setData({ type: "FeatureCollection", features: [] });
      const clusterSrc = map.getSource("roadworks-icons-cluster") as maplibregl.GeoJSONSource | undefined;
      if (clusterSrc) clusterSrc.setData({ type: "FeatureCollection", features: [] });
    } finally {
      setRwLoading(false);
    }
  }

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const handler = () => refreshRoadworks();
    m.on("moveend", handler);
    const t = setTimeout(() => refreshRoadworks(), 600);
    return () => {
      m.off("moveend", handler);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRoadworks, whenIsoLocal]);

  // -------------------- Routing --------------------
  function toUtcIso(isoLocal: string) {
    const d = new Date(isoLocal);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
  }

  async function planRoute() {
    setLoading(true);
    document.body.style.cursor = "progress";

    const toCoords = async (input: string, pick: Suggestion | null): Promise<Coords> => {
      if (pick && input.trim() === pick.label.trim()) return pick.coord;
      const ll = parseLonLat(input.trim());
      if (ll) return ll;
      const g = await geocode(input.trim());
      if (!g) throw new Error(`Konnte nicht geocodieren: "${input}"`);
      return g as Coords;
    };

    try {
      const start = await toCoords(startInput, startPick);
      const end = await toCoords(endInput, endPick);
      setStartCoord(start);
      setEndCoord(end);

      let data: any = null;

      // >>> NEU: vor jedem Plan resetten
      setPlanBlocked(null);

      if (usePlanner) {
        // ---- Neuer Planer (/api/route/plan) ----
        const body = buildPlanBody(
          start,
          end,
          {
            corridor: { mode: "soft", width_m: corridorWidth },
            roadworks: { buffer_m: rwBuffer, only_motorways: true },
            avoid_target_max: avoidTargetMax,
            valhalla_soft_max: valhallaSoftMax,
            respect_direction: respectDir,
            alternates,
          },
          {
            ts: toUtcIso(whenIsoLocal),
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin",
            vehicle: { width_m: width, height_m: height, weight_t: weight, axleload_t: axle },
            directions_language: "de-DE",
          }
        );

        const res = await fetch("/api/route/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        data = await res.json();
        if (!res.ok) {
          alert("Planner-Fehler: " + JSON.stringify(data?.error || data));
          setPlanMeta(null);
          return;
        }

        // Telemetrie merken
        const m = data?.meta?.roadworks || {};
        setPlanMeta({
          after_merge: m.after_merge,
          cell_m: m.cell_m,
          grid_cells: m.grid_cells,
          avoid_polygons: m.avoid_polygons,
          limit_hit: m.limit_hit,
        });

        // >>> OPTION A (WICHTIG):
        // Wenn BLOCKED: KEINE Route zeichnen, sondern Blockade anzeigen.
        if (data?.meta?.status === "BLOCKED") {
          setGeojson(null); // sorgt dafür, dass die Linie verschwindet
          setActiveIdx(0);
          setSteps([]);
          setStreets([]);
          setPlanBlocked({
            error: data?.meta?.error ?? "Route ist blockiert.",
            warnings: Array.isArray(data?.blocking_warnings) ? data.blocking_warnings : [],
            meta: data?.meta ?? null,
          });
        } else {
          setGeojson(data.geojson);
          setPlanBlocked(null);
        }
      } else {
        // ---- Klassisch direkt Valhalla (/api/route/valhalla) ----
        const res = await fetch("/api/route/valhalla", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start,
            end,
            vehicle: { width_m: width, height_m: height, weight_t: weight, axleload_t: axle },
            buffer_m: bufferValhalla, // nur relevant, falls Server-side Avoid vorhanden
            directions_language: "de-DE",
            alternates,
          }),
        });
        data = await res.json();
        if (!res.ok) {
          alert("Valhalla-Fehler: " + JSON.stringify(data?.error || data));
          setPlanMeta(null);
          return;
        }
        setPlanMeta(null);
        setGeojson(data.geojson);
        setPlanBlocked(null);
      }

      setActiveIdx(0);
      mapRef.current?.resize();
      refreshRoadworks();
    } catch (e: any) {
      alert(String(e));
    } finally {
      setLoading(false);
      document.body.style.cursor = "auto";
    }
  }

  // -------------------- UI --------------------
  function exportTxt() {
    const f = geojson?.features?.[activeIdx];
    if (!f) return;
    const distKm = Number(f.properties?.summary?.distance_km ?? 0);
    const timeS = Number(f.properties?.summary?.duration_s ?? 0);
    const lines: string[] = [];
    lines.push("Route – Zusammenfassung");
    lines.push(`Distanz: ${distKm.toFixed(1)} km • Dauer: ${sToMin(timeS)} min`);
    lines.push("");
    lines.push("Anweisungen:");
    (f.properties?.maneuvers ?? []).forEach((s: any, i: number) =>
      lines.push(
        `${i + 1}. ${s.instruction}  (${s.distance_km.toFixed(1)} km, ${sToMin(s.duration_s)} min)`
      )
    );
    lines.push("");
    lines.push("Befahrene Straßen (chronologisch, nicht dedupliziert):");
    (f.properties?.streets_sequence ?? []).forEach((name: string, i: number) =>
      lines.push(`${i + 1}. ${name}`)
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "route.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  const getMapInfo = () => {
    const m = mapRef.current;
    if (!m) return {};
    const c = m.getCenter();
    const b = m.getBounds();
    return {
      center: { lat: c.lat, lon: c.lng },
      bounds: { left: b.getWest(), top: b.getNorth(), right: b.getEast(), bottom: b.getSouth() },
    };
  };

  useEffect(() => setStartPick(null), [startInput]);
  useEffect(() => setEndPick(null), [endInput]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", height: "100vh" }}>
      <div style={{ padding: 12, overflowY: "auto", borderRight: "1px solid #eee" }}>
        <h2 style={{ marginTop: 4 }}>Schwertransport – Routen-MVP</h2>
        <p style={{ margin: "8px 0 12px 0" }}>
          Adresse <b>oder</b> „lon, lat“ eingeben. Alternativrouten sind anklickbar. Aktive Baustellen können als Layer eingeblendet werden.
        </p>

        {/* >>> NEU: BLOCKED-Box (Option A) */}
        {planBlocked && (
          <div
            style={{
              padding: 10,
              border: "1px solid #f2c3c3",
              background: "#fff5f5",
              borderRadius: 10,
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Route nicht möglich (BLOCKED)</div>
            <div style={{ fontSize: 13, color: "#7a1f1f", marginBottom: 8 }}>
              {planBlocked.error || "Die Route ist für dieses Fahrzeug nicht fahrbar."}
            </div>

            {Array.isArray(planBlocked.warnings) && planBlocked.warnings.length > 0 && (
              <div style={{ fontSize: 13, color: "#333" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Blockierende Stelle(n):</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {planBlocked.warnings.slice(0, 5).map((w: any, idx: number) => (
                    <li key={idx} style={{ marginBottom: 6 }}>
                      <div style={{ fontWeight: 600 }}>{w.title || "Baustelle/Restriktion"}</div>
                      {w.limits && (
                        <div style={{ fontSize: 12, color: "#555" }}>
                          Max. Breite: {typeof w.limits.width === "number" ? `${w.limits.width.toFixed(2)} m` : "–"} •
                          Max. Gewicht: {typeof w.limits.weight === "number" ? `${w.limits.weight} t` : "–"}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {planBlocked.warnings.length > 5 && (
                  <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                    …und {planBlocked.warnings.length - 5} weitere.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="box" style={{ padding: 8, border: "1px solid #eee", borderRadius: 8, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input id="chk-rw" type="checkbox" checked={showRoadworks} onChange={(e) => setShowRoadworks(e.target.checked)} />
            <label htmlFor="chk-rw"><b>Baustellen (aktiv) anzeigen</b></label>
            <span className="spacer" />
            <small style={{ color: "#666" }}>{rwLoading ? "Lade…" : `${rwCount} sichtbar`}</small>
          </div>
          <div style={{ marginTop: 6 }}>
            <label>Zeitpunkt (lokal)</label>
            <input className="inp" type="datetime-local" value={whenIsoLocal} onChange={(e) => setWhenIsoLocal(e.target.value)} />
            <small style={{ color: "#666" }}>Gefiltert per RPC <code>get_active_roadworks_geojson</code></small>
          </div>
          <div style={{ marginTop: 6 }}>
            <button onClick={refreshRoadworks}>Baustellen neu laden</button>
          </div>
        </div>

        <div className="box" style={{ padding: 8, border: "1px solid #eee", borderRadius: 8, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input id="chk-planner" type="checkbox" checked={usePlanner} onChange={(e) => setUsePlanner(e.target.checked)} />
            <label htmlFor="chk-planner"><b>Korridor + Baustellen vermeiden (empfohlen)</b></label>
          </div>

          {usePlanner ? (
            <div style={{ marginTop: 8 }}>
              <div className="row">
                <div className="col">
                  <label>Korridorbreite (m)</label>
                  <input className="inp" type="number" value={corridorWidth} onChange={(e) => setCorridorWidth(Number(e.target.value))} />
                </div>
                <div className="col">
                  <label>Roadworks-Buffer (m)</label>
                  <input className="inp" type="number" value={rwBuffer} onChange={(e) => setRwBuffer(Number(e.target.value))} />
                </div>
              </div>
              <div className="row">
                <div className="col">
                  <label>Valhalla Soft-Max (Polygone)</label>
                  <input className="inp" type="number" value={valhallaSoftMax} onChange={(e) => setValhallaSoftMax(Number(e.target.value))} />
                </div>
                <div className="col">
                  <label>Target Max (Merge-Ziel)</label>
                  <input className="inp" type="number" value={avoidTargetMax} onChange={(e) => setAvoidTargetMax(Number(e.target.value))} />
                </div>
              </div>
              <div className="row">
                <div className="col">
                  <label>Alternativen</label>
                  <input className="inp" type="number" value={alternates} onChange={(e) => setAlternates(Math.max(0, Math.min(2, Number(e.target.value))))} />
                </div>
                <div className="col" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input id="chk-dir" type="checkbox" checked={respectDir} onChange={(e) => setRespectDir(e.target.checked)} />
                  <label htmlFor="chk-dir">Fahrtrichtung respektieren</label>
                </div>
              </div>

              {planMeta && (
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  <b>Planner-Telemetrie:</b>{" "}
                  {typeof planMeta.after_merge === "number" ? `Avoids=${planMeta.after_merge}` : "–"} •{" "}
                  {typeof planMeta.cell_m === "number" ? `Cell=${Math.round(planMeta.cell_m)} m` : "–"} •{" "}
                  {typeof planMeta.grid_cells === "number" ? `Grid=${planMeta.grid_cells}` : "–"}{" "}
                  {planMeta.limit_hit ? "• limit_hit" : ""}
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              <label>Buffer um Avoid-Punkt (m) (nur klassisch/Fallback)</label>
              <input className="inp" type="number" value={bufferValhalla} onChange={(e) => setBufferValhalla(Number(e.target.value))} />
            </div>
          )}
        </div>

        <label>Start</label>
        <AutocompleteInput
          value={startInput}
          onChange={setStartInput}
          placeholder="Straße Hausnr, PLZ Ort"
          onSelect={(s) => { setStartInput(s.label); setStartPick(s); }}
          getMapInfo={getMapInfo}
        />

        <label>Ziel</label>
        <AutocompleteInput
          value={endInput}
          onChange={setEndInput}
          placeholder="Straße Hausnr, PLZ Ort"
          onSelect={(s) => { setEndInput(s.label); setEndPick(s); }}
          getMapInfo={getMapInfo}
        />

        <div className="row" style={{ marginTop: 6 }}>
          <div className="col">
            <label>Breite (m)</label>
            <input className="inp" type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </div>
          <div className="col">
            <label>Höhe (m)</label>
            <input className="inp" type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} />
          </div>
        </div>

        <div className="row">
          <div className="col">
            <label>Gewicht (t)</label>
            <input className="inp" type="number" value={weight} onChange={(e) => setWeight(Number(e.target.value))} />
          </div>
          <div className="col">
            <label>Achs-last (t)</label>
            <input className="inp" type="number" value={axle} onChange={(e) => setAxle(Number(e.target.value))} />
          </div>
        </div>

        <button className={`primary ${loading ? "loading" : ""}`} onClick={planRoute} disabled={loading}>
          {loading ? "Plane…" : "Route planen"}
        </button>

        {steps.length > 0 && (
          <>
            <div className="legend" style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
              <span><span className="dot blue" /> Aktive Route</span>
              <span><span className="dot gray" /> Alternativen (anklickbar)</span>
              <span><span className="dot" style={{ background:"#E67E22" }} /> Baustellen</span>
            </div>

            <div className="directions" style={{ marginTop: 12 }}>
              <div className="head">
                <b>Anweisungen</b>
                <span className="spacer" />
                <button onClick={exportTxt}>Als TXT exportieren</button>
              </div>
              <ol>
                {steps.map((s, i) => (
                  <li key={i}>
                    <div>{s.instruction}</div>
                    <small>{s.distance_km.toFixed(1)} km · {sToMin(s.duration_s)} min</small>
                    {!!s.street_names?.length && (
                      <div className="muted">Straßen (Manöver): {s.street_names.join(", ")}</div>
                    )}
                  </li>
                ))}
              </ol>
            </div>

            <div className="directions" style={{ marginTop: 12 }}>
              <div className="head"><b>Befahrene Straßen (chronologisch, nicht dedupliziert)</b></div>
              <ol>{streets.map((n, i) => <li key={i}><div>{n}</div></li>)}</ol>
            </div>
          </>
        )}
      </div>

      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", minHeight: "600px", background: "#f3f5f7" }}
      />
    </div>
  );
}
