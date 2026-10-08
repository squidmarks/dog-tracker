import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, DogEvent } from "./db.js";
import { createPusher, type WebPushLike } from "./push.js";
import { freshDb, hasMongo } from "./testdb.js";

const ev = (over: Partial<DogEvent> = {}): DogEvent =>
  ({ id: "1", ts: 1700000000, type: "zone_exit", dogId: "d1", dogName: "Ozzie", alert: true, message: "Ozzie left Yard", ...over });
const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` }, label: `device ${n}` });

describe("web push is off without VAPID keys", () => {
  it("does nothing", async () => {
    const lib: WebPushLike = { setVapidDetails: vi.fn(), sendNotification: vi.fn() };
    const p = createPusher({} as Db, {}, lib);
    expect(p.enabled).toBe(false);
    expect(await p.notify(ev())).toBe(0);
    expect(lib.setVapidDetails).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasMongo)("web push (Mongo)", () => {
  let db: Db, lib: WebPushLike & { sendNotification: ReturnType<typeof vi.fn> };
  const env = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:x@example.com" };

  beforeEach(async () => {
    db = await freshDb();
    lib = { setVapidDetails: vi.fn(), sendNotification: vi.fn().mockResolvedValue({}) };
  });
  afterEach(async () => { await db.close(); });

  it("stores one subscription per device (upsert) and rejects junk", async () => {
    await db.savePushSubscription(sub(1));
    await db.savePushSubscription({ ...sub(1), label: "renamed" });
    await db.savePushSubscription(sub(2));
    expect((await db.pushSubscriptions()).map((s) => s.label)).toEqual(["renamed", "device 2"]);
    await expect(db.savePushSubscription({ endpoint: "", keys: { p256dh: "", auth: "" }, label: "x" })).rejects.toThrow(/Invalid/);
    expect(await db.removePushSubscription(sub(1).endpoint)).toBe(true);
  });

  it("pushes alerts to every device with the dog's name as the title", async () => {
    await db.savePushSubscription(sub(1)); await db.savePushSubscription(sub(2));
    const p = createPusher(db, env, lib);
    expect(p.enabled).toBe(true);
    expect(lib.setVapidDetails).toHaveBeenCalledWith("mailto:x@example.com", "pub", "priv");
    expect(await p.notify(ev())).toBe(2);
    const [target, payload, opts] = lib.sendNotification.mock.calls[0];
    expect(target.endpoint).toBe("https://push.example/1");
    expect(JSON.parse(payload)).toMatchObject({ title: "Ozzie", body: "Ozzie left Yard", url: "/" });
    expect(opts).toMatchObject({ urgency: "high" });
  });

  it("titles hub alerts 'LoRa hub' and skips non-alert events", async () => {
    await db.savePushSubscription(sub(1));
    const p = createPusher(db, env, lib);
    await p.notify(ev({ type: "hub_offline", dogId: "", dogName: "Dog Base", hubId: "!49b7716c", message: "LoRa hub Dog Base went offline" }));
    expect(JSON.parse(lib.sendNotification.mock.calls[0][1]).title).toBe("LoRa hub");
    lib.sendNotification.mockClear();
    expect(await p.notify(ev({ alert: false }))).toBe(0);
    expect(lib.sendNotification).not.toHaveBeenCalled();
  });

  it("forgets devices the push service says are gone, keeps the others on other errors", async () => {
    await db.savePushSubscription(sub(1)); await db.savePushSubscription(sub(2)); await db.savePushSubscription(sub(3));
    lib.sendNotification
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error("flaky"), { statusCode: 500 }))
      .mockResolvedValueOnce({});
    const p = createPusher(db, env, lib);
    expect(await p.notify(ev())).toBe(1);
    expect((await db.pushSubscriptions()).map((s) => s.endpoint)).toEqual([sub(2).endpoint, sub(3).endpoint]);
  });
});
