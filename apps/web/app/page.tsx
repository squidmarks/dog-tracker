"use client";
import * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { ago, colorOf, displayName, type Dog, type SimState, type TrackPoint } from "../lib/types";

// MapLibre's web worker can't be bundled by Next; it is copied to /public by the copy-worker script.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const STALE_AFTER_S = 15 * 60;
const TRACK_HOURS = 6;

export default function Page() {
  const [dogs, setDogs] = useState<Dog[]>([]);
  const [now, setNow] = useState(Date.now() / 1000);
  const [sim, setSim] = useState<SimState | null>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const fitted = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/nodes");
    if (res.ok) setDogs(await res.json());
    const simRes = await fetch("/api/sim");
    if (simRes.ok) setSim(await simRes.json());
  }, []);

  const trigger = async (id: string, scenario: string) => {
    await fetch(`/api/sim/${encodeURIComponent(id)}/${scenario}?minutes=30`, { method: "POST" });
    load();
  };

  // Initial load, live updates via SSE, and a slow poll as a safety net.
  useEffect(() => {
    load();
    const es = new EventSource("/api/stream");
    es.onmessage = () => load();
    const poll = setInterval(load, 30_000);
    const tick = setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => { es.close(); clearInterval(poll); clearInterval(tick); };
  }, [load]);

  useEffect(() => {
    if (!mapEl.current || map.current) return;
    map.current = new maplibregl.Map({
      container: mapEl.current,
      center: [-98, 39], zoom: 3,
      style: {
        version: 8,
        sources: { osm: { type: "raster", tileSize: 256, attribution: "© OpenStreetMap contributors",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] } },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    map.current.addControl(new maplibregl.NavigationControl());
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  // Markers + trails
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = async () => {
      const bounds = new maplibregl.LngLatBounds();
      for (const [i, d] of dogs.entries()) {
        if (d.lat == null || d.lon == null) continue;
        bounds.extend([d.lon, d.lat]);
        let mk = markers.current.get(d.id);
        if (!mk) {
          const el = document.createElement("div");
          el.style.cssText = "width:18px;height:18px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px #0006";
          mk = new maplibregl.Marker({ element: el }).setLngLat([d.lon, d.lat]).addTo(m);
          markers.current.set(d.id, mk);
        }
        mk.getElement().style.background = colorOf(d, i);
        mk.setLngLat([d.lon, d.lat]).setPopup(new maplibregl.Popup({ offset: 14 }).setText(`${displayName(d)} · ${ago(d.pos_ts)}`));

        const track: TrackPoint[] = await (await fetch(`/api/nodes/${encodeURIComponent(d.id)}/track?hours=${TRACK_HOURS}`)).json();
        const data = { type: "Feature" as const, properties: {},
          geometry: { type: "LineString" as const, coordinates: track.map((p) => [p.lon, p.lat]) } };
        const src = m.getSource(`t-${d.id}`) as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(data);
        else if (m.isStyleLoaded()) {
          m.addSource(`t-${d.id}`, { type: "geojson", data });
          m.addLayer({ id: `t-${d.id}`, type: "line", source: `t-${d.id}`,
            paint: { "line-color": colorOf(d, i), "line-width": 3, "line-opacity": 0.7 } });
        }
      }
      if (!fitted.current && !bounds.isEmpty()) {
        m.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 0 });
        fitted.current = true;
      }
    };
    if (m.isStyleLoaded()) draw(); else m.once("load", draw);
  }, [dogs]);

  return (
    <div className="app">
      <aside className="side">
        <h1>🐕 Dog Tracker</h1>
        {dogs.length === 0 && <p className="meta">Waiting for the first packet from a collar…</p>}
        {dogs.map((d, i) => {
          const stale = !d.pos_ts || now - d.pos_ts > STALE_AFTER_S;
          return (
            <div key={d.id} className="dog" onClick={() => d.lat != null && d.lon != null &&
              map.current?.flyTo({ center: [d.lon, d.lat], zoom: 17 })}>
              <b><span className="dot" style={{ background: colorOf(d, i) }} />{displayName(d)}{d.sim && <span className="badge">sim</span>}</b>
              <div className={`meta ${stale ? "stale" : ""}`}>
                {d.pos_ts ? `Position ${ago(d.pos_ts, now)}` : "No position yet"}
                {d.battery != null && ` · 🔋 ${d.battery > 100 ? "charging" : d.battery + "%"}`}
              </div>
              <div className="meta">
                {d.sats != null && `${d.sats} sats · `}{d.rssi != null && `RSSI ${Math.round(d.rssi)} · `}
                heard {ago(d.last_heard, now)}
              </div>
            </div>
          );
        })}
        {sim?.enabled && (
          <section className="simpanel">
            <h2>Simulator</h2>
            {sim.dogs.map((sd) => (
              <div key={sd.id} className="simdog">
                <div>{sd.name} <span className="meta">· {sd.silentUntil > now ? "silent" : sd.scenario}</span></div>
                <div className="btns">
                  {sim.scenarios.map((sc) => (
                    <button key={sc} onClick={() => trigger(sd.id, sc)}>{sc === "silent" ? "go silent 30m" : sc}</button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </aside>
      <div ref={mapEl} className="map" />
    </div>
  );
}
