import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./api.js";
import type { Db } from "./db.js";
import { freshDb, hasMongo } from "./testdb.js";

let db: Db, base: string, close: () => void;
const hooks = { onDogChanged: vi.fn(), onDogDeleted: vi.fn(), onZonesChanged: vi.fn(), listHubs: async () => [],
  notifications: { pushoverConfigured: true, webPushConfigured: true, vapidPublicKey: "PUBKEY", testPushover: async () => true, testWebPush: async (e: string) => e === "https://push.example/ok" },
  getSim: () => null };
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() as any };
};

describe.skipIf(!hasMongo)("dogs API (Mongo)", () => {
  beforeEach(async () => {
    hooks.onDogChanged.mockClear(); hooks.onDogDeleted.mockClear(); hooks.onZonesChanged.mockClear();
    db = await freshDb();
    await db.apply({ kind: "position", node: "!aaaa0001", packetId: 1, gateway: "!g", rssi: -80, snr: 5, ts: 100, lat: 45, lon: -64, alt: null, speed: null, sats: 8 }, 100);
    const server = createApp(db, { ...hooks }).app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterEach(async () => { close(); await db.close(); });

  it("lists a new tracker as unclaimed, then claims it by creating a dog", async () => {
    expect((await call("GET", "/api/trackers")).body[0]).toMatchObject({ id: "!aaaa0001", dog_id: null, has_position: true });
    const created = await call("POST", "/api/dogs", { name: "Ozzie", tracker: "!aaaa0001", color: "#e4572e" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Ozzie", tracker: "!aaaa0001", lat: 45 });
    expect((await call("GET", "/api/trackers")).body[0]).toMatchObject({ dog_name: "Ozzie" });
    expect(hooks.onDogChanged).toHaveBeenCalledTimes(1);
  });

  it("rejects a nameless dog and a double-claimed tracker with 409", async () => {
    expect((await call("POST", "/api/dogs", { name: "" })).status).toBe(409);
    await call("POST", "/api/dogs", { name: "Ozzie", tracker: "!aaaa0001" });
    const dup = await call("POST", "/api/dogs", { name: "Maple", tracker: "!aaaa0001" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already belongs to Ozzie/);
  });

  it("serves a dog's track for an explicit window and rejects a bad one", async () => {
    for (const [i, ts] of [100, 200, 300].entries())
      await db.apply({ kind: "position", node: "!aaaa0001", packetId: 10 + i, gateway: "!g", rssi: -80, snr: 5, ts, lat: 45 + i / 1000, lon: -64, alt: null, speed: null, sats: 8 }, ts);
    const { body: dog } = await call("POST", "/api/dogs", { name: "Ozzie", tracker: "!aaaa0001" });
    expect((await call("GET", `/api/dogs/${dog.id}/track?from=150&to=350`)).body.map((p: any) => p.ts)).toEqual([200, 300]);
    expect((await call("GET", `/api/dogs/${dog.id}/track?from=500&to=100`)).status).toBe(400);
  });

  it("reports stats, heat and telemetry for a dog", async () => {
    const fix = (i: number, ts: number, lonOff: number, speed: number) =>
      db.apply({ kind: "position", node: "!aaaa0001", packetId: 100 + i, gateway: "!g", rssi: -80, snr: 5, ts, lat: 45, lon: -64 + lonOff / 78_600, alt: null, speed, sats: 9 }, ts);
    await fix(0, 1000, 0, 0); await fix(1, 1010, 60, 7); await fix(2, 1020, 90, 3);   // a 90 m dash
    await db.apply({ kind: "telemetry", node: "!aaaa0001", battery: 71, voltage: 3.9 }, 1015);
    const { body: dog } = await call("POST", "/api/dogs", { name: "Ozzie", tracker: "!aaaa0001" });

    const stats = (await call("GET", `/api/dogs/${dog.id}/stats?from=900&to=1100`)).body;
    expect(stats.fixes).toBe(3);
    expect(stats.distanceM).toBeGreaterThan(80);
    expect(stats.distanceM).toBeLessThan(100);
    expect(stats.topSpeed).toMatchObject({ mps: 7, source: "reported" });

    const board = (await call("GET", "/api/stats?from=900&to=1100")).body;
    expect(board).toMatchObject([{ name: "Ozzie", stats: { fixes: 3 } }]);

    const heat = (await call("GET", `/api/dogs/${dog.id}/heat?from=900&to=1100`)).body;
    expect(heat.length).toBeGreaterThan(0);
    expect(heat[0]).toHaveProperty("w");

    expect((await call("GET", `/api/dogs/${dog.id}/telemetry?from=900&to=1100`)).body).toMatchObject([{ ts: 1015, battery: 71 }]);
    expect((await call("GET", `/api/dogs/${dog.id}/stats?from=5&to=1`)).status).toBe(400);
  });

  it("edits, unlinks and deletes", async () => {
    const { body: dog } = await call("POST", "/api/dogs", { name: "Ozzie", tracker: "!aaaa0001" });
    const edited = await call("PATCH", `/api/dogs/${dog.id}`, { breed: "Lab", tracker: "" });
    expect(edited.body).toMatchObject({ breed: "Lab", tracker: null, alerts: true });
    expect((await call("PATCH", `/api/dogs/${dog.id}`, { alerts: false })).body.alerts).toBe(false);
    expect((await call("PATCH", "/api/dogs/000000000000000000000000", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", `/api/dogs/${dog.id}`)).status).toBe(200);
    expect(hooks.onDogDeleted).toHaveBeenCalledWith(dog.id);
    expect((await call("GET", "/api/dogs")).body).toEqual([]);
  });
});

describe.skipIf(!hasMongo)("zones, events and settings API (Mongo)", () => {
  beforeEach(async () => {
    hooks.onZonesChanged.mockClear();
    db = await freshDb();
    const server = createApp(db, { ...hooks }).app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterEach(async () => { close(); await db.close(); });

  it("creates a zone from a circle, validates it, and tells the engine", async () => {
    const created = await call("POST", "/api/zones", { name: "Yard", circle: { lat: 45, lon: -64, radiusM: 40 }, alertOn: "exit", home: true });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Yard", alertOn: "exit", home: true, dogs: null });
    expect(created.body.ring.length).toBe(33);
    expect(hooks.onZonesChanged).toHaveBeenCalledTimes(1);
    expect((await call("POST", "/api/zones", { name: "", circle: { lat: 45, lon: -64, radiusM: 40 } })).status).toBe(400);
    expect((await call("POST", "/api/zones", { name: "Tiny", ring: [[0, 0], [1, 1]] })).status).toBe(400);
    expect((await call("POST", "/api/zones", { name: "Bad", circle: { lat: 45, lon: -64, radiusM: 99999 } })).status).toBe(400);
  });

  it("edits and deletes zones", async () => {
    const { body: z } = await call("POST", "/api/zones", { name: "Yard", circle: { lat: 45, lon: -64, radiusM: 40 } });
    const edited = await call("PATCH", `/api/zones/${z.id}`, { name: "Back yard", alertOn: "both" });
    expect(edited.body).toMatchObject({ name: "Back yard", alertOn: "both" });
    expect(edited.body.ring).toEqual(z.ring);                       // geometry untouched by a rename
    expect((await call("PATCH", "/api/zones/000000000000000000000000", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", `/api/zones/${z.id}`)).status).toBe(200);
    expect((await call("GET", "/api/zones")).body).toEqual([]);
  });

  it("reads and updates alert settings", async () => {
    expect((await call("GET", "/api/settings")).body).toEqual({ staleMinutes: 20, lowBatteryPct: 20, fenceMarginM: 5, hubSilentMinutes: 45, pushoverEnabled: true });
    expect((await call("PUT", "/api/settings", { staleMinutes: 45 })).body.staleMinutes).toBe(45);
    expect((await call("PUT", "/api/settings", { staleMinutes: -3 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { pushoverEnabled: false })).body.pushoverEnabled).toBe(false);
  });

  it("lists recent events newest first", async () => {
    await db.addEvent({ ts: 100, type: "silent", dogId: "d", dogName: "Ozzie", alert: true, message: "a" });
    await db.addEvent({ ts: 200, type: "reporting", dogId: "d", dogName: "Ozzie", alert: false, message: "b" });
    expect((await call("GET", "/api/events?limit=5")).body.map((e: any) => e.message)).toEqual(["b", "a"]);
  });
});

describe.skipIf(!hasMongo)("notification channels API (Mongo)", () => {
  beforeEach(async () => {
    db = await freshDb();
    const server = createApp(db, { ...hooks }).app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterEach(async () => { close(); await db.close(); });

  it("registers a device, lists it, tests it, and removes it", async () => {
    const sub = { endpoint: "https://push.example/ok", keys: { p256dh: "p", auth: "a" } };
    expect((await call("POST", "/api/push/subscribe", { subscription: sub, label: "Geoff's iPhone" })).status).toBe(201);
    const n = (await call("GET", "/api/notifications")).body;
    expect(n.pushover).toEqual({ configured: true, enabled: true });
    expect(n.webPush).toMatchObject({ configured: true, publicKey: "PUBKEY" });
    expect(n.webPush.devices).toMatchObject([{ endpoint: sub.endpoint, label: "Geoff's iPhone" }]);
    expect((await call("POST", "/api/push/test", { endpoint: sub.endpoint })).status).toBe(200);
    expect((await call("POST", "/api/push/test", { endpoint: "https://push.example/gone" })).status).toBe(502);
    expect((await call("DELETE", "/api/push/subscribe", { endpoint: sub.endpoint })).status).toBe(200);
    expect((await call("DELETE", "/api/push/subscribe", { endpoint: sub.endpoint })).status).toBe(404);
    expect((await call("GET", "/api/notifications")).body.webPush.devices).toEqual([]);
  });

  it("rejects a malformed subscription", async () => {
    expect((await call("POST", "/api/push/subscribe", { subscription: { endpoint: "x" }, label: "bad" })).status).toBe(400);
  });

  it("can switch Pushover off and tests it on demand", async () => {
    await call("PUT", "/api/settings", { pushoverEnabled: false });
    expect((await call("GET", "/api/notifications")).body.pushover.enabled).toBe(false);
    expect((await call("POST", "/api/pushover/test")).status).toBe(200);
  });
});
