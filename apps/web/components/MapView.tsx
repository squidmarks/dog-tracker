"use client";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { circleRing, distanceM } from "../lib/geo";
import { farthestHeard, gapsGeoJSON, QUALITY, signalGeoJSON } from "../lib/coverage";
import { trackSegments } from "../lib/track";
import { ago, dogColor, dogEmoji, resolveView, trackerLabel, viewKey, type DrawState, type Dog, type Hub, type SignalPoint, type Tracker, type TrailView, type Zone } from "../lib/types";

// MapLibre's web worker can't be bundled by Next; it is copied to /public by the copy-worker script.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export interface Focus { lat: number; lon: number; n: number }
/** A temporary flag on the map, e.g. "Maple's top speed was here". `n` changes to re-show the same place. */
export interface Flag { lat: number; lon: number; label: string; n: number }
/** How far the hub actually reached, over the dogs on screen. */
export interface CoverageInfo { metres: number; dogName: string; hubName: string }

const hexToRgba = (hex: string, a: number) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
// Recent trails fade all the way out at the far end; day-long trails keep a faint floor so the whole day stays visible.
// Steeper than linear: the half-way point of the window is already faint, so an hour of running around stays readable.
const FADE_TO_ZERO = ["interpolate", ["linear"], ["get", "a"], 0, 0.95, 0.3, 0.5, 0.6, 0.18, 0.85, 0.05, 1, 0] as maplibregl.ExpressionSpecification;
const FADE_TO_FLOOR = ["interpolate", ["linear"], ["get", "a"], 0, 0.9, 1, 0.15] as maplibregl.ExpressionSpecification;

const EMPTY = { type: "FeatureCollection" as const, features: [] };

/** GeoJSON for the shape being drawn: a polygon outline/fill for polygon mode, a circle preview for circle mode. */
function drawGeoJSON(draw: DrawState | null) {
  if (!draw || draw.points.length === 0) return EMPTY;
  const pts = draw.points;
  const feats: GeoJSON.Feature[] = pts.map((p) => ({ type: "Feature", properties: { kind: "vertex" }, geometry: { type: "Point", coordinates: p } }));
  if (draw.mode === "circle") {
    if (pts.length >= 2) {
      const r = distanceM(pts[0][1], pts[0][0], pts[1][1], pts[1][0]);
      feats.push({ type: "Feature", properties: { kind: "shape" }, geometry: { type: "Polygon", coordinates: [circleRing(pts[0][1], pts[0][0], r)] } });
    }
  } else if (pts.length >= 3) {
    feats.push({ type: "Feature", properties: { kind: "shape" }, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
  } else if (pts.length === 2) {
    feats.push({ type: "Feature", properties: { kind: "shape" }, geometry: { type: "LineString", coordinates: pts } });
  }
  return { type: "FeatureCollection" as const, features: feats };
}

const zonesGeoJSON = (zones: Zone[]) => ({
  type: "FeatureCollection" as const,
  features: zones.map((z): GeoJSON.Feature => ({
    type: "Feature", properties: { id: z.id, name: z.name, color: z.color }, geometry: { type: "Polygon", coordinates: [z.ring] },
  })),
});

/** A hub pin turns red when the hub is offline. */
function node_status(el: HTMLElement, h: Hub) { el.classList.toggle("offline", h.status === "offline"); }

export type BaseLayer = "map" | "satellite";

/** Each dog has a heat-map layer (underneath) and a trail layer; only one of them has data at a time. */
function ensureLayers(m: maplibregl.Map, d: Dog) {
  if (!m.getSource(`h-${d.id}`)) {
    m.addSource(`h-${d.id}`, { type: "geojson", data: EMPTY });
    m.addLayer({ id: `h-${d.id}`, type: "heatmap", source: `h-${d.id}`, paint: {
      "heatmap-intensity": 1, "heatmap-opacity": 0.9,
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 12, 4, 15, 12, 17, 22, 19, 40],
    } });
  }
  if (!m.getSource(`cg-${d.id}`)) {
    m.addSource(`cg-${d.id}`, { type: "geojson", data: EMPTY });
    m.addLayer({ id: `cg-${d.id}`, type: "line", source: `cg-${d.id}`, layout: { "line-cap": "round" },
      paint: { "line-color": "#6b7280", "line-width": 3, "line-dasharray": [1.5, 1.5], "line-opacity": 0.9 } });
  }
  if (!m.getSource(`c-${d.id}`)) {
    m.addSource(`c-${d.id}`, { type: "geojson", data: EMPTY });
    m.addLayer({ id: `c-${d.id}`, type: "circle", source: `c-${d.id}`, paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 17, 5, 19, 8],
      "circle-color": ["step", ["get", "q"], QUALITY[0].color, 1, QUALITY[1].color, 2, QUALITY[2].color, 3, QUALITY[3].color],
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 0.8, "circle-opacity": 0.92,
    } });
  }
  if (!m.getSource(`t-${d.id}`)) {
    m.addSource(`t-${d.id}`, { type: "geojson", data: EMPTY });
    m.addLayer({ id: `t-${d.id}`, type: "line", source: `t-${d.id}`,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": dogColor(d), "line-width": 3.5, "line-opacity": FADE_TO_ZERO } });
  }
}

export function MapView({ dogs, trackers, zones, hubs, draw, placing, focus, flag, base, view, onDrawClick, onZoneClick, onPlaceHub, onCoverage }: {
  dogs: Dog[]; trackers: Tracker[]; zones: Zone[]; hubs: Hub[]; draw: DrawState | null; placing: boolean; focus: Focus | null; flag: Flag | null; base: BaseLayer; view: TrailView;
  onDrawClick: (lat: number, lon: number) => void; onZoneClick: (id: string) => void; onPlaceHub: (lat: number, lon: number) => void; onCoverage?: (info: CoverageInfo | null) => void;
}) {
  const live = useRef({ draw, zones, base, placing, onDrawClick, onZoneClick, onPlaceHub });
  live.current = { draw, zones, base, placing, onDrawClick, onZoneClick, onPlaceHub };
  const hubsRef = useRef(hubs);
  hubsRef.current = hubs;
  const hubMarkers = useRef(new Map<string, maplibregl.Marker>());
  const coverageData = useRef(new Map<string, SignalPoint[]>());
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const dogMarkers = useRef(new Map<string, maplibregl.Marker>());
  const trackerMarkers = useRef(new Map<string, maplibregl.Marker>());
  const lastTrack = useRef(new Map<string, { at: number; key: string }>());
  const viewRef = useRef(view);
  viewRef.current = view;
  const vKey = viewKey(view);
  const flagMarker = useRef<maplibregl.Marker | null>(null);
  const fitted = useRef(false);
  const dogsRef = useRef(dogs);
  dogsRef.current = dogs; // the async draw loop below must always see the latest dogs, not the ones from when it started
  const drawing = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });
  // `isStyleLoaded()` is false whenever any tile is loading, and "load" fires only once, so gate on our own flag.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({
      container: el.current, center: [-98, 39], zoom: 3,
      style: {
        version: 8,
        sources: {
          osm: { type: "raster", tileSize: 256, attribution: "© OpenStreetMap contributors",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] },
          sat: { type: "raster", tileSize: 256, maxzoom: 18, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] },
        },
        layers: [
          { id: "osm", type: "raster", source: "osm", layout: { visibility: live.current.base === "map" ? "visible" : "none" } },
          { id: "sat", type: "raster", source: "sat", layout: { visibility: live.current.base === "satellite" ? "visible" : "none" } },
        ],
      },
    });
    m.addControl(new maplibregl.NavigationControl());
    map.current = m;
    // Handy for poking at layers from the browser console while developing; never exposed in production builds.
    if (process.env.NODE_ENV !== "production") (window as unknown as { __map?: maplibregl.Map }).__map = m;
    m.on("load", () => {
      setReady(true);
      m.addSource("zones", { type: "geojson", data: zonesGeoJSON(live.current.zones) });
      m.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.16 } });
      m.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": ["get", "color"], "line-width": 2.5 } });
      m.addSource("draw", { type: "geojson", data: drawGeoJSON(live.current.draw) });
      m.addLayer({ id: "draw-fill", type: "fill", source: "draw", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#8b5cf6", "fill-opacity": 0.2 } });
      m.addLayer({ id: "draw-line", type: "line", source: "draw", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#8b5cf6", "line-width": 2.5, "line-dasharray": [2, 1] } });
      m.addLayer({ id: "draw-points", type: "circle", source: "draw", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": "#8b5cf6", "circle-stroke-width": 3 } });
    });
    m.on("click", (e) => {
      const { draw: d, placing: place, onDrawClick: click, onZoneClick: zoneClick, onPlaceHub: placeHub } = live.current;
      if (place) return placeHub(e.lngLat.lat, e.lngLat.lng);
      if (d) return click(e.lngLat.lat, e.lngLat.lng);
      if (!m.getLayer("zones-fill")) return;
      // A dog or tracker pin sits above zones; only open a zone when the click hit empty zone area.
      const hit = m.queryRenderedFeatures(e.point, { layers: ["zones-fill"] })[0];
      if (hit) zoneClick(String(hit.properties?.id));
    });
    return () => { m.remove(); map.current = null; dogMarkers.current.clear(); trackerMarkers.current.clear(); setReady(false); };
  }, []);

  useEffect(() => {
    if (focus && map.current) map.current.flyTo({ center: [focus.lon, focus.lat], zoom: 17 });
  }, [focus]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      if (m.getLayer("osm")) m.setLayoutProperty("osm", "visibility", base === "map" ? "visible" : "none");
      if (m.getLayer("sat")) m.setLayoutProperty("sat", "visibility", base === "satellite" ? "visible" : "none");
      // Zone outlines need more weight on busy imagery.
      if (m.getLayer("zones-line")) m.setPaintProperty("zones-line", "line-width", base === "satellite" ? 3.5 : 2.5);
      if (m.getLayer("zones-fill")) m.setPaintProperty("zones-fill", "fill-opacity", base === "satellite" ? 0.22 : 0.16);
    };
    if (ready) apply();
  }, [base, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => (m.getSource("zones") as maplibregl.GeoJSONSource | undefined)?.setData(zonesGeoJSON(zones));
    if (ready) apply();
  }, [zones, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => (m.getSource("draw") as maplibregl.GeoJSONSource | undefined)?.setData(drawGeoJSON(draw));
    if (ready) apply();
    m.getCanvas().style.cursor = draw || placing ? "crosshair" : "";
  }, [draw, placing, ready]);

  // Dogs: marker + recent trail.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = async () => {
      const dogs = dogsRef.current;
      const live = new Set(dogs.map((d) => d.id));
      for (const [id, mk] of dogMarkers.current) {
        if (live.has(id)) continue;
        mk.remove(); dogMarkers.current.delete(id);
        for (const prefix of ["t", "h", "c", "cg"]) {
          if (m.getLayer(`${prefix}-${id}`)) m.removeLayer(`${prefix}-${id}`);
          if (m.getSource(`${prefix}-${id}`)) m.removeSource(`${prefix}-${id}`);
        }
        lastTrack.current.delete(id);
        coverageData.current.delete(id);
      }
      const bounds = new maplibregl.LngLatBounds();
      for (const d of dogs) {
        if (d.lat == null || d.lon == null) continue;
        bounds.extend([d.lon, d.lat]);
        let mk = dogMarkers.current.get(d.id);
        if (!mk) {
          const node = document.createElement("div");
          node.className = "pin";
          node.innerHTML = '<span class="emo"></span><div class="arrowwrap"><i></i></div>';
          mk = new maplibregl.Marker({ element: node }).setLngLat([d.lon, d.lat]).addTo(m);
          dogMarkers.current.set(d.id, mk);
        }
        const node = mk.getElement();
        (node.querySelector(".emo") as HTMLElement).textContent = dogEmoji(d);
        node.style.background = dogColor(d);
        // A small arrow on the rim shows the direction of travel, only while the dog is actually moving.
        const wrap = node.querySelector(".arrowwrap") as HTMLElement;
        const moving = d.heading != null && (d.speed ?? 0) >= 1 && Date.now() / 1000 - (d.pos_ts ?? 0) < 120;
        wrap.style.display = moving ? "block" : "none";
        if (moving) wrap.style.transform = `rotate(${d.heading}deg)`;
        (wrap.firstElementChild as HTMLElement).style.borderBottomColor = dogColor(d);
        mk.setLngLat([d.lon, d.lat]).setPopup(new maplibregl.Popup({ offset: 18 }).setText(`${d.name} · ${ago(d.pos_ts)}`));

        // Rolling windows refresh every few seconds; fixed ones (yesterday, custom) are fetched once.
        const v = resolveView(viewRef.current);
        const key = viewKey(viewRef.current);
        const seen = lastTrack.current.get(d.id);
        if (seen && seen.key === key && (!v.rolling || Date.now() / 1000 - seen.at < v.refreshS)) continue;
        lastTrack.current.set(d.id, { at: Date.now() / 1000, key });
        ensureLayers(m, d);
        const trail = m.getSource(`t-${d.id}`) as maplibregl.GeoJSONSource;
        const heat = m.getSource(`h-${d.id}`) as maplibregl.GeoJSONSource;
        const cover = m.getSource(`c-${d.id}`) as maplibregl.GeoJSONSource;
        const gaps = m.getSource(`cg-${d.id}`) as maplibregl.GeoJSONSource;
        if (v.kind !== "coverage") { cover.setData(EMPTY); gaps.setData(EMPTY); coverageData.current.delete(d.id); }
        if (v.kind === "coverage") {
          const sig = await api.signal(d.id, v.from, v.to).catch(() => ({ points: [], gaps: [] }));
          cover.setData(signalGeoJSON(sig.points));
          gaps.setData(gapsGeoJSON(sig.gaps));
          trail.setData(EMPTY); heat.setData(EMPTY);
          coverageData.current.set(d.id, sig.points);
        } else if (v.kind === "trails") {
          const track = await api.track(d.id, v.from, v.to).catch(() => []);
          m.setPaintProperty(`t-${d.id}`, "line-opacity", v.fadeToZero ? FADE_TO_ZERO : FADE_TO_FLOOR);
          m.setPaintProperty(`t-${d.id}`, "line-color", dogColor(d));
          trail.setData(trackSegments(track, v.from, v.to));
          heat.setData(EMPTY);
        } else {
          const cells = await api.heat(d.id, v.from, v.to).catch(() => []);
          const maxW = Math.max(1, ...cells.map((c) => c.w));
          const c = dogColor(d);
          m.setPaintProperty(`h-${d.id}`, "heatmap-weight", ["interpolate", ["linear"], ["get", "w"], 0, 0, maxW, 1]);
          m.setPaintProperty(`h-${d.id}`, "heatmap-color", ["interpolate", ["linear"], ["heatmap-density"],
            0, hexToRgba(c, 0), 0.15, hexToRgba(c, 0.25), 0.45, hexToRgba(c, 0.55), 0.75, hexToRgba(c, 0.8), 1, hexToRgba(c, 0.95)]);
          heat.setData({ type: "FeatureCollection", features: cells.map((cell) => ({
            type: "Feature", properties: { w: cell.w }, geometry: { type: "Point", coordinates: [cell.lon, cell.lat] } })) });
          trail.setData(EMPTY);
        }
      }
      reportCoverage();
      if (!fitted.current && !bounds.isEmpty()) {
        m.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 0 });
        fitted.current = true;
      }
    };
    if (!ready) return;
    // Run one pass at a time; if data changed meanwhile, run again once so the latest positions always land.
    const run = async () => {
      const st = drawing.current;
      if (st.running) { st.again = true; return; }
      st.running = true;
      try { do { st.again = false; await draw(); } while (st.again); } finally { st.running = false; }
    };
    void run();
  }, [dogs, ready, vKey]);

  /** The farthest report any dog sent that the (placed) hub heard, so "how far do we reach?" has a number. */
  const reportCoverage = () => {
    if (!onCoverage) return;
    const hub = hubsRef.current.find((h) => h.lat != null && h.lon != null);
    if (!hub || viewRef.current.mode !== "coverage") return onCoverage(null);
    let best: CoverageInfo | null = null;
    for (const [dogId, pts] of coverageData.current) {
      const far = farthestHeard(hub, pts);
      if (far && (!best || far.metres > best.metres)) best = { metres: far.metres, dogName: dogsRef.current.find((d) => d.id === dogId)?.name ?? "A dog", hubName: hub.name };
    }
    onCoverage(best);
  };

  // Hubs have no GPS: once placed on the map they get a 📡 pin, so range can be read against it.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const placed = hubs.filter((h) => h.lat != null && h.lon != null);
    const ids = new Set(placed.map((h) => h.id));
    for (const [id, mk] of hubMarkers.current) if (!ids.has(id)) { mk.remove(); hubMarkers.current.delete(id); }
    for (const h of placed) {
      let mk = hubMarkers.current.get(h.id);
      if (!mk) {
        const node = document.createElement("div");
        node.className = "pin hub";
        node.textContent = "📡";
        mk = new maplibregl.Marker({ element: node }).setLngLat([h.lon!, h.lat!]).addTo(m);
        hubMarkers.current.set(h.id, mk);
      }
      node_status(mk.getElement(), h);
      mk.setLngLat([h.lon!, h.lat!]).setPopup(new maplibregl.Popup({ offset: 18 }).setText(`LoRa hub ${h.name} · ${h.status}`));
    }
    reportCoverage();
  }, [hubs, ready]);

  // A temporary flag, e.g. where a dog hit its top speed.
  useEffect(() => {
    const m = map.current;
    flagMarker.current?.remove(); flagMarker.current = null;
    if (!m || !flag) return;
    const node = document.createElement("div");
    node.className = "pin flag";
    node.textContent = "🏁";
    flagMarker.current = new maplibregl.Marker({ element: node }).setLngLat([flag.lon, flag.lat])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setText(flag.label)).addTo(m);
    flagMarker.current.togglePopup();
    m.flyTo({ center: [flag.lon, flag.lat], zoom: Math.max(m.getZoom(), 17) });
    const t = setTimeout(() => { flagMarker.current?.remove(); flagMarker.current = null; }, 30_000);
    return () => clearTimeout(t);
  }, [flag]);

  // Unclaimed trackers: grey "?" pins, so you can tell which physical collar is which before naming it.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const unclaimed = trackers.filter((t) => t.dog_id == null && t.has_position && t.lat != null && t.lon != null);
    const ids = new Set(unclaimed.map((t) => t.id));
    for (const [id, mk] of trackerMarkers.current) if (!ids.has(id)) { mk.remove(); trackerMarkers.current.delete(id); }
    for (const t of unclaimed) {
      let mk = trackerMarkers.current.get(t.id);
      if (!mk) {
        const node = document.createElement("div");
        node.className = "pin unclaimed";
        node.textContent = "?";
        mk = new maplibregl.Marker({ element: node }).setLngLat([t.lon!, t.lat!]).addTo(m);
        trackerMarkers.current.set(t.id, mk);
      }
      mk.setLngLat([t.lon!, t.lat!]).setPopup(new maplibregl.Popup({ offset: 18 }).setText(`New tracker ${trackerLabel(t)} · ${ago(t.pos_ts)}`));
    }
  }, [trackers]);

  return <div ref={el} className="map" />;
}
