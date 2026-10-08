import webpush from "web-push";
import type { Db, DogEvent, PushSubscriptionDoc } from "./db.js";

export interface PushPayload { title: string; body: string; tag?: string; url?: string }

/** The slice of the web-push library we use, so tests can fake it. */
export interface WebPushLike {
  setVapidDetails(subject: string, pub: string, priv: string): void;
  sendNotification(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, opts?: object): Promise<unknown>;
}

/** Native browser/iOS notifications (Web Push). Off until the server has VAPID keys. */
export function createPusher(db: Db, env = process.env, lib: WebPushLike = webpush as unknown as WebPushLike) {
  const publicKey = env.VAPID_PUBLIC_KEY, privateKey = env.VAPID_PRIVATE_KEY;
  const enabled = !!(publicKey && privateKey);
  if (enabled) lib.setVapidDetails(env.VAPID_SUBJECT ?? "mailto:dogtracker@example.com", publicKey!, privateKey!);

  /** Deliver to one device; a gone subscription (404/410) is forgotten. Returns whether it was accepted. */
  async function sendTo(sub: PushSubscriptionDoc, payload: PushPayload): Promise<boolean> {
    try {
      await lib.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      await db.touchPushSubscription(sub.endpoint);
      return true;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await db.removePushSubscription(sub.endpoint);
      else console.error("[webpush]", status ?? "", (e as Error).message);
      return false;
    }
  }

  return {
    enabled,
    publicKey: publicKey ?? null,
    sendTo,
    /** Tell every subscribed device. Only alert events are pushed. */
    async notify(e: DogEvent): Promise<number> {
      if (!enabled || !e.alert) return 0;
      const payload: PushPayload = {
        title: e.type.startsWith("hub_") ? "LoRa hub" : e.dogName,
        body: e.message, tag: `${e.type}:${e.dogId || e.hubId || ""}`, url: "/",
      };
      let ok = 0;
      for (const sub of await db.pushSubscriptions()) if (await sendTo(sub, payload)) ok++;
      return ok;
    },
  };
}
export type Pusher = ReturnType<typeof createPusher>;
