"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DogDialog, type DogDialogState } from "../components/DogDialog";
import { BatterySpark } from "../components/BatterySpark";
import { MapView, type BaseLayer, type Flag, type Focus } from "../components/MapView";
import { SettingsDialog } from "../components/SettingsDialog";
import { DogStats, STATS_PERIODS, usePeriodStats, type StatsPeriod } from "../components/DogStats";
import { ZoneDialog, type ZoneDialogState } from "../components/ZoneDialog";
import { api } from "../lib/api";
import { distanceM } from "../lib/geo";
import type { Units } from "../lib/units";
import {
  ago, ALERT_LABEL, batteryLabel, dogColor, dogEmoji, EVENT_ICON, trackerLabel,
  minutesLabel, RANGE_LABEL, RECENT_STOPS, type Dog, type DogEvent, type DrawState, type Hub, type RangePreset, type SimState, type TrailView, type Tracker, type Zone,
} from "../lib/types";

const STALE_AFTER_S = 15 * 60;

// <input type="datetime-local"> works in the browser's local time and wants "YYYY-MM-DDTHH:mm".
const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (ts?: number) => {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).getTime() / 1000 : undefined);

export default function Page() {
  const [dogs, setDogs] = useState<Dog[]>([]);
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [sim, setSim] = useState<SimState | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const [dialog, setDialog] = useState<DogDialogState | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [events, setEvents] = useState<DogEvent[]>([]);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [zoneDialog, setZoneDialog] = useState<ZoneDialogState | null>(null);
  const [draw, setDraw] = useState<DrawState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [base, setBase] = useState<BaseLayer>("map");
  const [view, setView] = useState<TrailView>({ mode: "recent", minutes: 30 });
  const [flag, setFlag] = useState<Flag | null>(null);
  const [units, setUnits] = useState<Units>("imperial");
  const [period, setPeriod] = useState<StatsPeriod>("today");
  const { rows: statRows, fastest } = usePeriodStats(period);
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const focusN = useRef(0);

  // Remember the map style per browser (it's only a convenience, so storage may be unavailable).
  useEffect(() => {
    try {
      if (localStorage.getItem("dt-base") === "satellite") setBase("satellite");
      if (localStorage.getItem("dt-units") === "metric") setUnits("metric");
    } catch { /* ignore */ }
  }, []);
  const chooseUnits = (u: Units) => { setUnits(u); try { localStorage.setItem("dt-units", u); } catch { /* ignore */ } };
  const chooseBase = (b: BaseLayer) => { setBase(b); try { localStorage.setItem("dt-base", b); } catch { /* ignore */ } };

  /** Positions arrive every few seconds; they only change dogs and trackers, so don't refetch the rest each time. */
  const loadLive = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([api.dogs(), api.trackers()]);
      setDogs(d); setTrackers(t); setLoadError(null);
    } catch (e) { setLoadError((e as Error).message); }
  }, []);

  const load = useCallback(async () => {
    try {
      const [d, t, z, ev, h] = await Promise.all([api.dogs(), api.trackers(), api.zones(), api.events(25), api.hubs()]);
      setDogs(d); setTrackers(t); setZones(z); setEvents(ev); setHubs(h); setLoadError(null);
    } catch (e) { setLoadError((e as Error).message); }
    api.sim().then(setSim).catch(() => setSim(null));
  }, []);

  // Initial load, live updates via SSE (coalesced to ~1/s), and a slow poll as a safety net.
  useEffect(() => {
    load();
    let pending: ReturnType<typeof setTimeout> | null = null;
    let needFull = false;
    const es = new EventSource("/api/stream");
    es.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (!["position", "telemetry", "nodeinfo"].includes(msg.kind)) needFull = true;   // dogs/zones/hubs/event changed
        if (msg.kind === "event" && msg.event?.alert) {
          const id = msg.event.id as string;
          setToasts((t) => [...t, { id, text: msg.event.message }]);
          setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 10_000);
        }
      } catch { /* ignore keep-alives */ }
      if (!pending) pending = setTimeout(() => { pending = null; const full = needFull; needFull = false; (full ? load : loadLive)(); }, 1000);
    };
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => { es.close(); clearInterval(poll); clearInterval(tick); if (pending) clearTimeout(pending); };
  }, [load, loadLive]);

  const flyTo = (lat: number | null, lon: number | null) => {
    if (lat != null && lon != null) setFocus({ lat, lon, n: ++focusN.current });
  };

  // --- Zone drawing ---
  const startDraw = (mode: DrawState["mode"], zone?: Zone) => setDraw({ mode, points: [], zoneId: zone?.id });
  const onDrawClick = (lat: number, lon: number) => setDraw((d) => {
    if (!d) return d;
    if (d.mode === "circle") return { ...d, points: d.points.length === 0 ? [[lon, lat]] : [d.points[0], [lon, lat]] };
    return { ...d, points: [...d.points, [lon, lat]] };
  });
  const canFinish = !!draw && (draw.mode === "circle" ? draw.points.length === 2 : draw.points.length >= 3);
  const finishDraw = async () => {
    if (!draw || !canFinish) return;
    const geometry = draw.mode === "circle"
      ? { circle: { lat: draw.points[0][1], lon: draw.points[0][0], radiusM: Math.round(distanceM(draw.points[0][1], draw.points[0][0], draw.points[1][1], draw.points[1][0])) } }
      : { ring: [...draw.points, draw.points[0]] };
    if (draw.zoneId) {
      try { await api.updateZone(draw.zoneId, geometry); load(); } catch (e) { alert((e as Error).message); }
    } else setZoneDialog({ geometry });
    setDraw(null);
  };
  useEffect(() => {
    if (!draw) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDraw(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draw]);

  const inbox = trackers.filter((t) => t.dog_id == null && t.has_position);
  const others = trackers.filter((t) => t.dog_id == null && !t.has_position);

  const assign = async (t: Tracker, dogId: string) => {
    if (!dogId) return;
    try { await api.updateDog(dogId, { tracker: t.id }); load(); }
    catch (e) { alert((e as Error).message); }
  };

  return (
    <div className="app">
      <aside className="side">
        <h1>🐕 Dog Tracker <button className="link gear" aria-label="Alert settings" onClick={() => setSettingsOpen(true)}>⚙ Settings</button></h1>
        {loadError && <p className="error">Can&apos;t reach the server: {loadError}</p>}

        {inbox.length > 0 && (
          <section className="inbox">
            <h2>New trackers <span className="count">{inbox.length}</span></h2>
            {inbox.map((t) => (
              <div key={t.id} className="card tracker" onClick={() => flyTo(t.lat, t.lon)}>
                <b>{trackerLabel(t)}{t.sim && <span className="badge">sim</span>}</b>
                <div className="meta">
                  Seen {ago(t.pos_ts, now)}{t.battery != null && ` · 🔋 ${batteryLabel(t.battery)}`} · {t.id}
                </div>
                <div className="btns" onClick={(e) => e.stopPropagation()}>
                  <button className="primary" onClick={() => setDialog({ tracker: t.id })}>Create dog</button>
                  {dogs.length > 0 && (
                    <select value="" onChange={(e) => assign(t, e.target.value)} aria-label="Assign to existing dog">
                      <option value="">Assign to…</option>
                      {dogs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        <section>
          <h2>Dogs <span className="count">{dogs.length}</span>
            <span className="grow" />
            <button className="link" onClick={() => setDialog({})}>+ Add</button></h2>
          {dogs.length > 0 && (
            <div className="seg period" role="group" aria-label="Activity period">
              {(Object.keys(STATS_PERIODS) as StatsPeriod[]).map((p) => (
                <button key={p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>{STATS_PERIODS[p]}</button>
              ))}
            </div>
          )}
          {dogs.length === 0 && (
            <p className="meta">{inbox.length ? "Create a dog for a new tracker above." : "No dogs yet. Switch on a tracker, or add a dog and link it later."}</p>
          )}
          {dogs.map((d) => {
            const stale = !d.pos_ts || now - d.pos_ts > STALE_AFTER_S;
            return (
              <div key={d.id} className="card dog" onClick={() => flyTo(d.lat, d.lon)}>
                <b>
                  <span className="dot" style={{ background: dogColor(d) }}>{dogEmoji(d)}</span>
                  {d.name}{fastest === d.id && <span title="Fastest in this period">🏆</span>}{!d.alerts && <span title="Alerts off">🔕</span>}{d.sim && <span className="badge">sim</span>}
                  <button className="link edit" aria-label={`Edit ${d.name}`}
                    onClick={(e) => { e.stopPropagation(); setDialog({ dog: d }); }}>Edit</button>
                </b>
                {d.breed && <div className="meta">{d.breed}</div>}
                {d.tracker ? (
                  <>
                    <div className={`meta ${stale ? "stale" : ""}`}>
                      {d.pos_ts ? `Position ${ago(d.pos_ts, now)}` : "No position yet"}
                      {d.battery != null && ` · 🔋 ${batteryLabel(d.battery)}`}
                    </div>
                    <div className="meta">
                      {d.sats != null && `${d.sats} sats · `}{d.rssi != null && `RSSI ${Math.round(d.rssi)} · `}
                      {d.temperature != null && `🌡 ${Math.round(d.temperature)}°C · `}heard {ago(d.last_heard, now)}
                    </div>
                    <BatterySpark dogId={d.id} />
                    <DogStats row={statRows.get(d.id)} period={period} units={units}
                      onTopSpeed={(row, label) => { const t = row.stats.topSpeed; if (t) setFlag({ lat: t.lat, lon: t.lon, label, n: Date.now() }); }} />
                  </>
                ) : <div className="meta stale">No tracker linked</div>}
              </div>
            );
          })}
        </section>

        <section>
          <h2>Zones <span className="count">{zones.length}</span>
            <span className="grow" />
            <button className="link" onClick={() => startDraw("polygon")}>+ Draw</button>
            <button className="link" onClick={() => startDraw("circle")}>+ Circle</button></h2>
          {zones.length === 0 && <p className="meta">Draw the yard so you&apos;re alerted when a dog leaves it.</p>}
          {zones.map((z) => (
            <div key={z.id} className="card zone" onClick={() => setZoneDialog({ zone: z })}>
              <b><span className="swatch" style={{ background: z.color }} />{z.name}{z.home && <span className="badge home">home</span>}</b>
              <div className="meta">
                {ALERT_LABEL[z.alertOn]} · {z.dogs === null ? "all dogs" : z.dogs.map((id) => dogs.find((d) => d.id === id)?.name ?? "?").join(", ")}
              </div>
            </div>
          ))}
        </section>

        <section>
          <h2>Recent events</h2>
          {events.length === 0 && <p className="meta">Nothing yet. Alerts and notable changes show up here.</p>}
          {events.map((e) => (
            <div key={e.id} className={`event ${e.alert ? "alert" : ""}`}
              onClick={() => flyTo(e.lat ?? null, e.lon ?? null)}>
              <span className="ico">{EVENT_ICON[e.type]}</span>
              <span className="msg">{e.message}{e.sim && <span className="badge">sim</span>}</span>
              <span className="when">{ago(e.ts, now)}</span>
            </div>
          ))}
        </section>

        {hubs.length > 0 && (
          <section>
            <h2>LoRa hubs <span className="count">{hubs.length}</span></h2>
            {hubs.map((h) => (
              <div key={h.id} className="card hub">
                <b><span className={`status ${h.status}`} />{h.name}</b>
                <div className={`meta ${h.status === "offline" ? "stale" : ""}`}>
                  {h.status === "online" ? "Online" : "Offline"} since {ago(h.since, now).replace(" ago", " ago")}
                  {h.lastPacket && h.status === "online" ? ` · last packet ${ago(h.lastPacket, now)}` : ""}
                </div>
              </div>
            ))}
          </section>
        )}

        {dogs.length > 0 && <p className="hint">Distance ignores GPS wobble and gaps in reporting, so it&apos;s a slight underestimate. Top speed can only be as fast as the reports that caught it.</p>}

        {others.length > 0 && (
          <details className="others">
            <summary>Other devices ({others.length})</summary>
            {others.map((t) => (
              <div key={t.id} className="meta">{trackerLabel(t)} · {t.id} · heard {ago(t.last_heard, now)}</div>
            ))}
            <p className="meta">Seen on the channel but with no GPS position (base stations, for example).</p>
          </details>
        )}

        {sim?.enabled && (
          <section className="simpanel">
            <h2>Simulator</h2>
            {sim.dogs.map((sd) => (
              <div key={sd.id} className="simdog">
                <div>{sd.name} <span className="meta">· {sd.silentUntil > now ? "silent" : sd.scenario}</span></div>
                <div className="btns">
                  {sim.scenarios.map((sc) => (
                    <button key={sc} onClick={() => api.trigger(sd.id, sc).then(load)}>{sc === "silent" ? "go silent 30m" : sc}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="btns">
              <button onClick={() => confirm("Remove all simulated trackers and their dogs?") && api.clearSim().then(load)}>Clear simulated data</button>
            </div>
          </section>
        )}
      </aside>

      <div className="mapwrap">
        <MapView dogs={dogs} trackers={trackers} zones={zones} draw={draw} focus={focus} flag={flag} base={base} view={view}
          onDrawClick={onDrawClick} onZoneClick={(id) => { const z = zones.find((x) => x.id === id); if (z) setZoneDialog({ zone: z }); }} />
        <div className="mapctl">
          <div className="basectl" role="group" aria-label="Map style">
            <button className={base === "map" ? "on" : ""} onClick={() => chooseBase("map")}>Map</button>
            <button className={base === "satellite" ? "on" : ""} onClick={() => chooseBase("satellite")}>Satellite</button>
          </div>
          <div className="rangectl">
            <div className="seg" role="group" aria-label="Trail mode">
              <button className={view.mode === "recent" ? "on" : ""} onClick={() => setView({ mode: "recent", minutes: 30 })}>Recent</button>
              <button className={view.mode === "history" ? "on" : ""} onClick={() => setView({ mode: "history", range: { preset: "today" }, style: "heat" })}>History</button>
            </div>
            {view.mode === "recent" ? (
              <>
                <label className="slider">Trail length
                  <input type="range" min={0} max={RECENT_STOPS.length - 1} step={1}
                    value={Math.max(0, RECENT_STOPS.indexOf(view.minutes))}
                    onChange={(e) => setView({ mode: "recent", minutes: RECENT_STOPS[Number(e.target.value)] })} />
                  <b>{minutesLabel(view.minutes)}</b>
                </label>
                <div className="legend" aria-hidden><span>now</span><i className="fade" /><span>{minutesLabel(view.minutes)} ago</span></div>
              </>
            ) : (
              <>
                <div className="row2">
                  <select aria-label="History range" value={view.range.preset} onChange={(e) => {
                    const preset = e.target.value as RangePreset;
                    const start = new Date(); start.setHours(0, 0, 0, 0);
                    setView({ ...view, range: preset === "custom" ? { preset, customFrom: start.getTime() / 1000, customTo: undefined } : { preset } });
                  }}>
                    {(Object.keys(RANGE_LABEL) as RangePreset[]).map((k) => <option key={k} value={k}>{RANGE_LABEL[k]}</option>)}
                  </select>
                  <span className="seg small" role="group" aria-label="History style">
                    <button className={view.style === "heat" ? "on" : ""} onClick={() => setView({ ...view, style: "heat" })}>Heat map</button>
                    <button className={view.style === "trails" ? "on" : ""} onClick={() => setView({ ...view, style: "trails" })}>Trails</button>
                  </span>
                </div>
                {view.range.preset === "custom" && (
                  <div className="custom">
                    <label>From<input type="datetime-local" value={toLocalInput(view.range.customFrom)}
                      onChange={(e) => setView({ ...view, range: { ...view.range, customFrom: fromLocalInput(e.target.value) } })} /></label>
                    <label>To<input type="datetime-local" value={toLocalInput(view.range.customTo)}
                      onChange={(e) => setView({ ...view, range: { ...view.range, customTo: fromLocalInput(e.target.value) } })} /></label>
                    <button onClick={() => setView({ ...view, range: { ...view.range, customTo: undefined } })} disabled={view.range.customTo == null}>To now</button>
                  </div>
                )}
                <div className="legend" aria-hidden><span>{view.style === "heat" ? "less time" : "older"}</span><i className={view.style === "heat" ? "heat" : ""} /><span>{view.style === "heat" ? "more time" : "newer"}</span></div>
              </>
            )}
          </div>
        </div>
        {hubs.some((h) => h.status === "offline") && (
          <div className="hubbanner" role="alert">
            ⚠️ {hubs.filter((h) => h.status === "offline").map((h) => `LoRa hub ${h.name} has been offline for ${ago(h.since, now).replace(" ago", "")}`).join(" · ")}.
            {" "}Collars can&apos;t report until it&apos;s back.
          </div>
        )}
        {draw && (
          <div className="drawbar">
            <span>{draw.mode === "circle"
              ? (draw.points.length === 0 ? "Click the centre of the circle" : "Click on the edge to set the radius")
              : `Click the map to add corners (${draw.points.length})`}</span>
            {draw.mode === "polygon" && <button onClick={() => setDraw({ ...draw, points: draw.points.slice(0, -1) })} disabled={!draw.points.length}>Undo</button>}
            <button className="primary" onClick={finishDraw} disabled={!canFinish}>Finish</button>
            <button onClick={() => setDraw(null)}>Cancel</button>
          </div>
        )}
        <div className="toasts">
          {toasts.map((t) => <div key={t.id} className="toast" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>⚠️ {t.text}</div>)}
        </div>
      </div>
      <DogDialog state={dialog} trackers={trackers} onClose={() => setDialog(null)} onSaved={load} />
      <ZoneDialog state={zoneDialog} dogs={dogs} onClose={() => setZoneDialog(null)} onSaved={load}
        onRedraw={(z) => startDraw("polygon", z)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} units={units} onUnits={chooseUnits} />
    </div>
  );
}
