import type { DogEvent } from "./db.js";

const PRIORITY: Partial<Record<DogEvent["type"], number>> = { zone_exit: 1, zone_enter: 1, silent: 1, low_battery: 0, hub_offline: 1 };

/** Pushover notifications for alert events. Off until PUSHOVER_TOKEN and PUSHOVER_USER are set. */
export function createNotifier(env = process.env, fetchImpl: typeof fetch = fetch) {
  const token = env.PUSHOVER_TOKEN, user = env.PUSHOVER_USER, appUrl = env.PUBLIC_URL;
  return {
    enabled: !!(token && user),
    configured: !!(token && user),
    /** A clearly-labelled test message (sent only when someone presses the button). */
    async test(): Promise<boolean> {
      return this.send("Dog Tracker", "Test notification from Dog Tracker. If you can read this, Pushover alerts work.", 0, Math.floor(Date.now() / 1000));
    },
    async notify(e: DogEvent): Promise<boolean> {
      if (!e.alert) return false;
      return this.send(e.type.startsWith("hub_") ? "LoRa hub" : e.dogName, e.message, PRIORITY[e.type] ?? 0, e.ts);
    },
    async send(title: string, message: string, priority: number, ts: number): Promise<boolean> {
      if (!token || !user) return false;
      const body = new URLSearchParams({
        token, user, title, message, priority: String(priority), timestamp: String(ts),
        ...(appUrl ? { url: appUrl, url_title: "Open the map" } : {}),
      });
      try {
        const res = await fetchImpl("https://api.pushover.net/1/messages.json", { method: "POST", body });
        if (!res.ok) console.error("[pushover]", res.status, await res.text().catch(() => ""));
        return res.ok;
      } catch (err) {
        console.error("[pushover]", (err as Error).message);
        return false;
      }
    },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
