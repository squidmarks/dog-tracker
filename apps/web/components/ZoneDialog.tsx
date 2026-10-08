"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { ALERT_LABEL, PALETTE, type AlertOn, type Dog, type Zone } from "../lib/types";

export interface ZoneDialogState {
  /** Existing zone to edit; omit when creating. */
  zone?: Zone;
  /** Geometry for a new zone: a ring, or a circle the server turns into one. */
  geometry?: { ring: [number, number][] } | { circle: { lat: number; lon: number; radiusM: number } };
}

export function ZoneDialog({ state, dogs, onClose, onSaved, onRedraw }: {
  state: ZoneDialogState | null; dogs: Dog[]; onClose: () => void; onSaved: () => void;
  onRedraw: (zone: Zone) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({ name: "", color: PALETTE[0], alertOn: "exit" as AlertOn, home: true, allDogs: true, dogs: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = state?.zone;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (state) {
      const z = state.zone;
      setForm({
        name: z?.name ?? "", color: z?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)],
        alertOn: z?.alertOn ?? "exit", home: z?.home ?? true, allDogs: z ? z.dogs === null : true, dogs: z?.dogs ?? [],
      });
      setError(null);
      if (!el.open) el.showModal();
    } else if (el.open) el.close();
  }, [state]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name, color: form.color, alertOn: form.alertOn, home: form.home,
        dogs: form.allDogs ? null : form.dogs,
      };
      if (editing) await api.updateZone(editing.id, body);
      else await api.createZone({ ...body, ...state?.geometry });
      onSaved(); onClose();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!editing || !confirm(`Delete the zone "${editing.name}"?`)) return;
    setBusy(true);
    try { await api.deleteZone(editing.id); onSaved(); onClose(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const toggleDog = (id: string) =>
    setForm((f) => ({ ...f, dogs: f.dogs.includes(id) ? f.dogs.filter((d) => d !== id) : [...f.dogs, id] }));

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <form onSubmit={save}>
        <h2>{editing ? `Edit zone: ${editing.name}` : "New zone"}</h2>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus required placeholder="Yard, Pond, Road…" /></label>
        <div>
          <span className="lbl">Colour</span>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button type="button" key={c} aria-label={c} className={form.color === c ? "sel" : ""}
                style={{ background: c }} onClick={() => setForm({ ...form, color: c })} />
            ))}
          </div>
        </div>
        <label>Alerts
          <select value={form.alertOn} onChange={(e) => setForm({ ...form, alertOn: e.target.value as AlertOn })}>
            {(Object.keys(ALERT_LABEL) as AlertOn[]).map((k) => <option key={k} value={k}>{ALERT_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.home} onChange={(e) => setForm({ ...form, home: e.target.checked })} />
          Counts as &ldquo;home&rdquo; in Home Assistant
        </label>
        <div>
          <span className="lbl">Applies to</span>
          <label className="check">
            <input type="checkbox" checked={form.allDogs} onChange={(e) => setForm({ ...form, allDogs: e.target.checked })} /> All dogs
          </label>
          {!form.allDogs && dogs.map((d) => (
            <label key={d.id} className="check indent">
              <input type="checkbox" checked={form.dogs.includes(d.id)} onChange={() => toggleDog(d.id)} /> {d.name}
            </label>
          ))}
          {!form.allDogs && dogs.length === 0 && <p className="hint">No dogs yet.</p>}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          {editing && <button type="button" className="danger" onClick={remove} disabled={busy}>Delete</button>}
          {editing && <button type="button" onClick={() => { onRedraw(editing); onClose(); }}>Redraw shape</button>}
          <span className="spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !form.name.trim()}>{editing ? "Save" : "Create zone"}</button>
        </div>
      </form>
    </dialog>
  );
}
