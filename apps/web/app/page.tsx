"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { DogDialog, type DogDialogState } from "../components/DogDialog";
import { MapView, type Focus } from "../components/MapView";
import { api } from "../lib/api";
import {
  ago, batteryLabel, dogColor, dogEmoji, trackerLabel,
  type Dog, type SimState, type Tracker,
} from "../lib/types";

const STALE_AFTER_S = 15 * 60;

export default function Page() {
  const [dogs, setDogs] = useState<Dog[]>([]);
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [sim, setSim] = useState<SimState | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const [dialog, setDialog] = useState<DogDialogState | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const focusN = useRef(0);

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([api.dogs(), api.trackers()]);
      setDogs(d); setTrackers(t); setLoadError(null);
    } catch (e) { setLoadError((e as Error).message); }
    api.sim().then(setSim).catch(() => setSim(null));
  }, []);

  // Initial load, live updates via SSE (coalesced to ~1/s), and a slow poll as a safety net.
  useEffect(() => {
    load();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource("/api/stream");
    es.onmessage = () => { if (!pending) pending = setTimeout(() => { pending = null; load(); }, 1000); };
    const poll = setInterval(load, 30_000);
    const tick = setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => { es.close(); clearInterval(poll); clearInterval(tick); if (pending) clearTimeout(pending); };
  }, [load]);

  const flyTo = (lat: number | null, lon: number | null) => {
    if (lat != null && lon != null) setFocus({ lat, lon, n: ++focusN.current });
  };

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
        <h1>🐕 Dog Tracker</h1>
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
            <button className="link" onClick={() => setDialog({})}>+ Add</button></h2>
          {dogs.length === 0 && (
            <p className="meta">{inbox.length ? "Create a dog for a new tracker above." : "No dogs yet. Switch on a tracker, or add a dog and link it later."}</p>
          )}
          {dogs.map((d) => {
            const stale = !d.pos_ts || now - d.pos_ts > STALE_AFTER_S;
            return (
              <div key={d.id} className="card dog" onClick={() => flyTo(d.lat, d.lon)}>
                <b>
                  <span className="dot" style={{ background: dogColor(d) }}>{dogEmoji(d)}</span>
                  {d.name}{d.sim && <span className="badge">sim</span>}
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
                      {d.sats != null && `${d.sats} sats · `}{d.rssi != null && `RSSI ${Math.round(d.rssi)} · `}heard {ago(d.last_heard, now)}
                    </div>
                  </>
                ) : <div className="meta stale">No tracker linked</div>}
              </div>
            );
          })}
        </section>

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

      <MapView dogs={dogs} trackers={trackers} focus={focus} />
      <DogDialog state={dialog} trackers={trackers} onClose={() => setDialog(null)} onSaved={load} />
    </div>
  );
}
