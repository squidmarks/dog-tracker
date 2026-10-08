"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { dogColor, EMOJIS, PALETTE, trackerLabel, type Dog, type Tracker } from "../lib/types";

export interface DogDialogState {
  /** Existing dog to edit; omit to create. */
  dog?: Dog;
  /** Pre-selected tracker when creating from the inbox. */
  tracker?: string;
}

export function DogDialog({ state, trackers, onClose, onSaved }: {
  state: DogDialogState | null; trackers: Tracker[]; onClose: () => void; onSaved: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({ name: "", emoji: "🐕", color: PALETTE[0], breed: "", notes: "", tracker: "", alerts: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = state?.dog;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (state) {
      const d = state.dog;
      setForm({
        name: d?.name ?? "", emoji: d?.emoji ?? "🐕", color: d ? dogColor(d) : PALETTE[Math.floor(Math.random() * PALETTE.length)],
        breed: d?.breed ?? "", notes: d?.notes ?? "", tracker: d?.tracker ?? state.tracker ?? "", alerts: d?.alerts ?? true,
      });
      setError(null);
      if (!el.open) el.showModal();
    } else if (el.open) el.close();
  }, [state]);

  // Trackers a dog may carry: its current one, plus any with a GPS fix that no dog has.
  const options = trackers.filter((t) => t.id === editing?.tracker || (t.dog_id == null && t.has_position));
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { name: form.name, emoji: form.emoji, color: form.color, breed: form.breed, notes: form.notes, tracker: form.tracker || null, alerts: form.alerts };
      if (editing) await api.updateDog(editing.id, body as Partial<Dog>);
      else await api.createDog(body as Partial<Dog>);
      onSaved(); onClose();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!editing || !confirm(`Delete ${editing.name}? Their tracker goes back to the new-trackers inbox.`)) return;
    setBusy(true);
    try { await api.deleteDog(editing.id); onSaved(); onClose(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <form onSubmit={save}>
        <h2>{editing ? `Edit ${editing.name}` : "New dog"}</h2>
        <label>Name<input value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus required /></label>
        <div className="row">
          <div>
            <span className="lbl">Icon</span>
            <div className="swatches">
              {EMOJIS.map((em) => (
                <button type="button" key={em} className={form.emoji === em ? "sel" : ""} onClick={() => set("emoji", em)}>{em}</button>
              ))}
            </div>
          </div>
        </div>
        <div>
          <span className="lbl">Colour</span>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button type="button" key={c} aria-label={c} className={form.color === c ? "sel" : ""}
                style={{ background: c }} onClick={() => set("color", c)} />
            ))}
          </div>
        </div>
        <label>Breed<input value={form.breed} onChange={(e) => set("breed", e.target.value)} /></label>
        <label>Notes<textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} /></label>
        <label>Tracker
          <select value={form.tracker} onChange={(e) => set("tracker", e.target.value)}>
            <option value="">None</option>
            {options.map((t) => <option key={t.id} value={t.id}>{trackerLabel(t)}{t.sim ? " (sim)" : ""} · {t.id}</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.alerts} onChange={(e) => set("alerts", e.target.checked)} />
          Send alerts for this dog (notifications and pop-ups)
        </label>
        {editing && form.tracker !== (editing.tracker ?? "") && editing.tracker && (
          <p className="hint">Swapping collars keeps {editing.name}&apos;s history; the old tracker returns to the inbox.</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          {editing && <button type="button" className="danger" onClick={remove} disabled={busy}>Delete</button>}
          <span className="spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !form.name.trim()}>{editing ? "Save" : "Create dog"}</button>
        </div>
      </form>
    </dialog>
  );
}
