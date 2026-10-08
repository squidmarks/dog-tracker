"use client";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { circleRing, distanceM } from "../lib/geo";
import { ago, dogColor, dogEmoji, trackerLabel, type DrawState, type Dog, type Tracker, type Zone } from "../lib/types";

// MapLibre's web worker can't be bundled by Next; it is copied to /public by the copy-worker script.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const TRACK_HOURS = 6;
const TRACK_REFRESH_S = 10;

export interface Focus { lat: number; lon: number; n: number }

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

export function MapView({ dogs, trackers, zones, draw, focus, onDrawClick, onZoneClick }: {
  dogs: Dog[]; trackers: Tracker[]; zones: Zone[]; draw: DrawState | null; focus: Focus | null;
  onDrawClick: (lat: number, lon: number) => void; onZoneClick: (id: string) => void;
}) {
  const live = useRef({ draw, zones, onDrawClick, onZoneClick });
  live.current = { draw, zones, onDrawClick, onZoneClick };
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const dogMarkers = useRef(new Map<string, maplibregl.Marker>());
  const trackerMarkers = useRef(new Map<string, maplibregl.Marker>());
  const lastTrack = useRef(new Map<string, number>());
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = new maplibregl.Map({
      container: el.current, center: [-98, 39], zoom: 3,
      style: {
        version: 8,
        sources: { osm: { type: "raster", tileSize: 256, attribution: "© OpenStreetMap contributors",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] } },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    m.addControl(new maplibregl.NavigationControl());
    map.current = m;
    m.on("load", () => {
      m.addSource("zones", { type: "geojson", data: zonesGeoJSON(live.current.zones) });
      m.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.16 } });
      m.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": ["get", "color"], "line-width": 2.5 } });
      m.addSource("draw", { type: "geojson", data: drawGeoJSON(live.current.draw) });
      m.addLayer({ id: "draw-fill", type: "fill", source: "draw", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#8b5cf6", "fill-opacity": 0.2 } });
      m.addLayer({ id: "draw-line", type: "line", source: "draw", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#8b5cf6", "line-width": 2.5, "line-dasharray": [2, 1] } });
      m.addLayer({ id: "draw-points", type: "circle", source: "draw", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": "#8b5cf6", "circle-stroke-width": 3 } });
    });
    m.on("click", (e) => {
      const { draw: d, onDrawClick: click, onZoneClick: zoneClick } = live.current;
      if (d) return click(e.lngLat.lat, e.lngLat.lng);
      if (!m.getLayer("zones-fill")) return;
      // A dog or tracker pin sits above zones; only open a zone when the click hit empty zone area.
      const hit = m.queryRenderedFeatures(e.point, { layers: ["zones-fill"] })[0];
      if (hit) zoneClick(String(hit.properties?.id));
    });
    return () => { m.remove(); map.current = null; dogMarkers.current.clear(); trackerMarkers.current.clear(); };
  }, []);

  useEffect(() => {
    if (focus && map.current) map.current.flyTo({ center: [focus.lon, focus.lat], zoom: 17 });
  }, [focus]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => (m.getSource("zones") as maplibregl.GeoJSONSource | undefined)?.setData(zonesGeoJSON(zones));
    if (m.isStyleLoaded() && m.getSource("zones")) apply(); else m.once("load", apply);
  }, [zones]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => (m.getSource("draw") as maplibregl.GeoJSONSource | undefined)?.setData(drawGeoJSON(draw));
    if (m.isStyleLoaded() && m.getSource("draw")) apply(); else m.once("load", apply);
    m.getCanvas().style.cursor = draw ? "crosshair" : "";
  }, [draw]);

  // Dogs: marker + recent trail.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = async () => {
      const live = new Set(dogs.map((d) => d.id));
      for (const [id, mk] of dogMarkers.current) {
        if (live.has(id)) continue;
        mk.remove(); dogMarkers.current.delete(id);
        if (m.getLayer(`t-${id}`)) m.removeLayer(`t-${id}`);
        if (m.getSource(`t-${id}`)) m.removeSource(`t-${id}`);
      }
      const bounds = new maplibregl.LngLatBounds();
      for (const d of dogs) {
        if (d.lat == null || d.lon == null) continue;
        bounds.extend([d.lon, d.lat]);
        let mk = dogMarkers.current.get(d.id);
        if (!mk) {
          const node = document.createElement("div");
          node.className = "pin";
          mk = new maplibregl.Marker({ element: node }).setLngLat([d.lon, d.lat]).addTo(m);
          dogMarkers.current.set(d.id, mk);
        }
        const node = mk.getElement();
        node.textContent = dogEmoji(d);
        node.style.background = dogColor(d);
        mk.setLngLat([d.lon, d.lat]).setPopup(new maplibregl.Popup({ offset: 18 }).setText(`${d.name} · ${ago(d.pos_ts)}`));

        const last = lastTrack.current.get(d.id) ?? 0;
        if (Date.now() / 1000 - last < TRACK_REFRESH_S) continue;
        lastTrack.current.set(d.id, Date.now() / 1000);
        const track = await api.track(d.id, TRACK_HOURS).catch(() => []);
        const data = { type: "Feature" as const, properties: {},
          geometry: { type: "LineString" as const, coordinates: track.map((p) => [p.lon, p.lat]) } };
        const src = m.getSource(`t-${d.id}`) as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(data);
        else {
          m.addSource(`t-${d.id}`, { type: "geojson", data });
          m.addLayer({ id: `t-${d.id}`, type: "line", source: `t-${d.id}`,
            paint: { "line-color": dogColor(d), "line-width": 3, "line-opacity": 0.7 } });
        }
      }
      if (!fitted.current && !bounds.isEmpty()) {
        m.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 0 });
        fitted.current = true;
      }
    };
    if (m.isStyleLoaded()) draw(); else m.once("load", draw);
  }, [dogs]);

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
