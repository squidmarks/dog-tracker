"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Settings } from "../lib/types";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<Settings>({ staleMinutes: 20, lowBatteryPct: 20, fenceMarginM: 5 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      api.settings().then(setForm).catch((e) => setError(e.message));
      setError(null);
      if (!el.open) el.showModal();
    } else if (el.open) el.close();
  }, [open]);

  const num = (k: keyof Settings) => (
    <input type="number" min={0} step="any" value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
  );
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api.updateSettings(form); onClose(); } catch (err) { setError((err as Error).message); }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose}>
      <form onSubmit={save}>
        <h2>Alert settings</h2>
        <label>Not reporting after (minutes){num("staleMinutes")}</label>
        <label>Low battery at (%){num("lowBatteryPct")}</label>
        <label>Fence margin (metres){num("fenceMarginM")}</label>
        <p className="hint">A dog must be this far past a zone edge, on two readings in a row, before it counts as in or out. Raise it if GPS wobble causes false alerts.</p>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </dialog>
  );
}
