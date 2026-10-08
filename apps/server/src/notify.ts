import type { DogEvent } from "./db.js";

const PRIORITY: Partial<Record<DogEvent["type"], number>> = { zone_exit: 1, zone_enter: 1, silent: 1, low_battery: 0 };

/** Pushover notifications for alert events. Off until PUSHOVER_TOKEN and PUSHOVER_USER are set. */
export function createNotifier(env = process.env, fetchImpl: typeof fetch = fetch) {
  const token = env.PUSHOVER_TOKEN, user = env.PUSHOVER_USER, appUrl = env.PUBLIC_URL;
  return {
    enabled: !!(token && user),
    async notify(e: DogEvent): Promise<boolean> {
      if (!token || !user || !e.alert) return false;
      const body = new URLSearchParams({
        token, user, title: e.dogName, message: e.message,
        priority: String(PRIORITY[e.type] ?? 0), timestamp: String(e.ts),
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
