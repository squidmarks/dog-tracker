"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { currentSubscription, disablePush, enablePush, pushSupport, type PushSupport } from "../lib/push";
import type { Notifications, Settings } from "../lib/types";

const SUPPORT_NOTE: Record<Exclude<PushSupport, "ok">, string> = {
  "needs-install": "On iPhone, add this site to your Home Screen first (Share, then Add to Home Screen), then open it from there and come back here.",
  unsupported: "This browser doesn't support native notifications.",
  denied: "Notifications are blocked for this site. Allow them in the browser or iOS Settings, then try again.",
};

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<Settings>({ staleMinutes: 20, lowBatteryPct: 20, fenceMarginM: 5, hubSilentMinutes: 45, pushoverEnabled: true });
  const [notes, setNotes] = useState<Notifications | null>(null);
  const [mine, setMine] = useState<string | null>(null);        // this device's push endpoint, when subscribed
  const [support, setSupport] = useState<PushSupport>("ok");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setSupport(pushSupport());
    const [s, n, sub] = await Promise.all([api.settings(), api.notifications(), currentSubscription().catch(() => null)]);
    setForm(s); setNotes(n); setMine(sub?.endpoint ?? null);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      setError(null); setMsg(null);
      refresh().catch((e) => setError(e.message));
      if (!el.open) el.showModal();
    } else if (el.open) el.close();
  }, [open, refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setMsg(null);
    try { await fn(); setMsg(label); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const num = (k: "staleMinutes" | "lowBatteryPct" | "fenceMarginM" | "hubSilentMinutes") => (
    <input type="number" min={0} step="any" value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
  );
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api.updateSettings(form); onClose(); } catch (err) { setError((err as Error).message); }
  };

  const iAmSubscribed = !!mine && !!notes?.webPush.devices.some((d) => d.endpoint === mine);

  return (
    <dialog ref={ref} className="dialog wide" onClose={onClose} onCancel={onClose}>
      <form onSubmit={save}>
        <h2>Settings</h2>

        <h3>Alert thresholds</h3>
        <label>Dog not reporting after (minutes){num("staleMinutes")}</label>
        <label>Low battery at (%){num("lowBatteryPct")}</label>
        <label>Hub offline if silent for (minutes){num("hubSilentMinutes")}</label>
        <p className="hint">Backstop only: normally a hub is flagged offline about a minute after it drops off the network.</p>
        <label>Fence margin (metres){num("fenceMarginM")}</label>
        <p className="hint">A dog must be this far past a zone edge, on two readings in a row, before it counts as in or out.</p>

        <h3>How should alerts reach you?</h3>
        <p className="hint">Use either, or both. Alerts are zone exits, silent dogs, low batteries and hub outages.</p>

        <div className="channel">
          <label className="check">
            <input type="checkbox" checked={form.pushoverEnabled} disabled={!notes?.pushover.configured}
              onChange={(e) => { const v = e.target.checked; setForm({ ...form, pushoverEnabled: v }); run(v ? "Pushover on" : "Pushover off", () => api.updateSettings({ pushoverEnabled: v })); }} />
            <b>Pushover</b> <span className="meta">— reliable, with priority levels</span>
          </label>
          {notes && !notes.pushover.configured && <p className="hint">Not set up on the server (needs a Pushover token and user key).</p>}
          {notes?.pushover.configured && (
            <button type="button" disabled={busy} onClick={() => run("Test sent through Pushover", () => api.testPushover())}>Send test</button>
          )}
        </div>

        <div className="channel">
          <b>Native notifications on this device</b> <span className="meta">— straight from the app, no extra service</span>
          {notes && !notes.webPush.configured && <p className="hint">Not set up on the server yet (needs VAPID keys).</p>}
          {notes?.webPush.configured && support !== "ok" && <p className="hint">{SUPPORT_NOTE[support]}</p>}
          {notes?.webPush.configured && support === "ok" && (
            <div className="btnrow">
              {!iAmSubscribed ? (
                <button type="button" className="primary" disabled={busy || !notes.webPush.publicKey}
                  onClick={() => run("Notifications turned on for this device", () => enablePush(notes.webPush.publicKey!))}>Turn on for this device</button>
              ) : (
                <>
                  <button type="button" disabled={busy} onClick={() => run("Test sent. It should appear in a moment", () => api.testPush(mine!))}>Send test</button>
                  <button type="button" disabled={busy} onClick={() => run("Notifications turned off for this device", () => disablePush())}>Turn off</button>
                </>
              )}
            </div>
          )}
          {notes && notes.webPush.devices.length > 0 && (
            <ul className="devices">
              {notes.webPush.devices.map((d) => (
                <li key={d.endpoint}>
                  {d.label}{d.endpoint === mine && " (this device)"}
                  {d.endpoint !== mine && (
                    <button type="button" className="link" onClick={() => run("Device removed", () => api.unsubscribePush(d.endpoint))}>Remove</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {msg && <p className="ok">{msg}</p>}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>Close</button>
          <button type="submit" className="primary">Save thresholds</button>
        </div>
      </form>
    </dialog>
  );
}
