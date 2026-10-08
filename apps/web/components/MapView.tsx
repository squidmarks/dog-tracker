"use client";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { ago, dogColor, dogEmoji, trackerLabel, type Dog, type Tracker } from "../lib/types";

// MapLibre's web worker can't be bundled by Next; it is copied to /public by the copy-worker script.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const TRACK_HOURS = 6;
const TRACK_REFRESH_S = 10;

export interface Focus { lat: number; lon: number; n: number }

export function MapView({ dogs, trackers, focus }: { dogs: Dog[]; trackers: Tracker[]; focus: Focus | null }) {
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
    return () => { m.remove(); map.current = null; dogMarkers.current.clear(); trackerMarkers.current.clear(); };
  }, []);

  useEffect(() => {
    if (focus && map.current) map.current.flyTo({ center: [focus.lon, focus.lat], zoom: 17 });
  }, [focus]);

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
