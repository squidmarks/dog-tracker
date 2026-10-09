import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, DogEvent } from "./db.js";
import { HubMonitor, isHubClient, parseBrokerLog } from "./hubs.js";
import { freshDb, hasMongo } from "./testdb.js";

describe("parseBrokerLog", () => {
  it("reads connects", () => {
    expect(parseBrokerLog("New client connected from 192.168.68.135:63534 as !49b7716c (p4, c1, k15, u'meshtastic').")).toEqual({ type: "connect", client: "!49b7716c" });
  });
  it("reads disconnects with their reason", () => {
    expect(parseBrokerLog("Client !49b7716c [192.168.68.135:63536] disconnected: exceeded timeout.")).toEqual({ type: "disconnect", client: "!49b7716c", reason: "exceeded timeout" });
    expect(parseBrokerLog("Client !49b7716c [192.168.68.135:1] disconnected.")).toEqual({ type: "disconnect", client: "!49b7716c", reason: undefined });
    expect(parseBrokerLog("Client !49b7716c closed its connection.")).toMatchObject({ type: "disconnect", client: "!49b7716c" });
  });
  it("tolerates a leading timestamp and ignores other lines", () => {
    expect(parseBrokerLog("1791473798: Client !49b7716c [1.2.3.4:5] disconnected: exceeded timeout.")?.type).toBe("disconnect");
    expect(parseBrokerLog("Saving in-memory database to /mosquitto/data//mosquitto.db.")).toBeNull();
    expect(parseBrokerLog("New connection from 1.2.3.4:5 on port 1883.")).toBeNull();
  });
  it("only treats node-id client ids as hubs", () => {
    expect(isHubClient("!49b7716c")).toBe(true);
    for (const c of ["mqttjs_c12d7299", "auto-35810804-64BB", "hass-abc", "!xyz"]) expect(isHubClient(c)).toBe(false);
  });
});

describe.skipIf(!hasMongo)("HubMonitor (Mongo)", () => {
  let db: Db, hubs: HubMonitor, events: DogEvent[];
  const T0 = 10_000;
  const connect = `New client connected from 1.2.3.4:1 as !49b7716c (p4, c1, k15, u'meshtastic').`;
  const dropped = `Client !49b7716c [1.2.3.4:1] disconnected: exceeded timeout.`;

  beforeEach(async () => {
    db = await freshDb();
    events = [];
    hubs = new HubMonitor(db, (e) => { events.push(e); }, 60);
    await db.apply({ kind: "nodeinfo", node: "!49b7716c", longName: "Dog Base", shortName: "BASE" }, T0);
  });
  afterEach(async () => { await db.close(); });

  it("goes offline only after the grace period, with a high-priority alert", async () => {
    await hubs.onBrokerLog(connect, T0);
    await hubs.onBrokerLog(dropped, T0 + 100);
    await hubs.tick(T0 + 130);                       // 30 s: still within grace
    expect(events).toHaveLength(0);
    await hubs.tick(T0 + 170);                       // 70 s: offline
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "hub_offline", alert: true, dogName: "Dog Base", hubId: "!49b7716c", dogId: "" });
    expect(events[0].message).toMatch(/Dog Base went offline/);
    await hubs.tick(T0 + 400);                       // no repeat
    expect(events).toHaveLength(1);
    expect(hubs.allDown()).toBe(true);
  });

  it("a quick reconnect inside the grace period raises nothing", async () => {
    await hubs.onBrokerLog(connect, T0);
    await hubs.onBrokerLog(dropped, T0 + 100);
    await hubs.onBrokerLog(connect, T0 + 120);
    await hubs.tick(T0 + 400);
    expect(events).toHaveLength(0);
    expect(hubs.allDown()).toBe(false);
  });

  it("a replaced session is not a disconnect", async () => {
    await hubs.onBrokerLog(connect, T0);
    await hubs.onBrokerLog("Client !49b7716c [1.2.3.4:1] disconnected: session taken over.", T0 + 5);
    await hubs.tick(T0 + 500);
    expect(events).toHaveLength(0);
  });

  it("comes back online with a quiet event, on reconnect or on any packet", async () => {
    await hubs.onBrokerLog(connect, T0);
    await hubs.onBrokerLog(dropped, T0 + 100);
    await hubs.tick(T0 + 200);
    await hubs.onBrokerLog(connect, T0 + 300);
    expect(events.at(-1)).toMatchObject({ type: "hub_online", alert: false });
    await hubs.onBrokerLog(dropped, T0 + 400);
    await hubs.tick(T0 + 500);
    await hubs.onPacket("!49b7716c", T0 + 600);      // a packet is proof of life even without a connect line
    expect(events.at(-1)).toMatchObject({ type: "hub_online" });
    expect(hubs.allDown()).toBe(false);
  });

  it("falls back to silence when the broker says nothing (e.g. after a restart)", async () => {
    await db.updateSettings({ hubSilentMinutes: 10 });
    await hubs.onPacket("!49b7716c", T0);            // alive, broker state unknown
    await hubs.tick(T0 + 500);
    expect(events).toHaveLength(0);
    await hubs.tick(T0 + 700);                       // > 10 min silent
    expect(events[0]).toMatchObject({ type: "hub_offline", alert: true });
  });

  it("remembers where a hub was placed, without losing it when its status changes", async () => {
    await hubs.onBrokerLog(connect, T0);
    expect(await hubs.setLocation("!49b7716c", 45.17, -64.75)).toBe(true);
    expect(await hubs.setLocation("!unknown1", 1, 1)).toBe(false);
    await hubs.onBrokerLog(dropped, T0 + 100);
    await hubs.tick(T0 + 200);                                   // goes offline: a status save must not wipe the location
    const again = new HubMonitor(db, () => {}, 60);
    await again.load();
    expect(await again.list()).toMatchObject([{ id: "!49b7716c", status: "offline", lat: 45.17, lon: -64.75 }]);
    expect(again.located()).toEqual({ lat: 45.17, lon: -64.75 });
    await again.setLocation("!49b7716c", null, null);
    expect(again.located()).toBeNull();
    await expect(hubs.setLocation("!49b7716c", 200, 0)).rejects.toThrow(/out of range/);
  });

  it("treats a collar relayed through a phone as a mobile gateway: tracked, never alerted", async () => {
    const collar = "!c0ffee01";
    await db.apply({ kind: "position", node: collar, packetId: 1, gateway: "!g", rssi: -80, snr: 5, ts: T0, lat: 45, lon: -64, alt: null, speed: null, sats: 8 }, T0);
    await hubs.onBrokerLog(`New client connected from 1.2.3.4:1 as ${collar} (p4, c1, k15, u'meshtastic').`, T0);
    await hubs.onBrokerLog(`Client ${collar} [1.2.3.4:1] disconnected: exceeded timeout.`, T0 + 100);
    await hubs.tick(T0 + 300);                                         // the phone walked away
    expect(events).toHaveLength(0);                                    // no "hub offline" for a collar
    const listed = (await hubs.list()).find((h) => h.id === collar)!;
    expect(listed).toMatchObject({ mobile: true, status: "offline" });
  });

  it("a real hub next to a mobile gateway still alerts when it goes down", async () => {
    await db.apply({ kind: "position", node: "!c0ffee01", packetId: 1, gateway: "!g", rssi: -80, snr: 5, ts: T0, lat: 45, lon: -64, alt: null, speed: null, sats: 8 }, T0);
    await hubs.onPacket("!c0ffee01", T0);
    await hubs.onBrokerLog(connect, T0);
    await hubs.onBrokerLog(dropped, T0 + 100);
    await hubs.tick(T0 + 300);
    expect(events.map((e) => e.type)).toEqual(["hub_offline"]);
    expect((await hubs.list()).find((h) => h.id === "!49b7716c")).toMatchObject({ mobile: false });
  });

  it("ignores clients that aren't hubs and survives a restart", async () => {
    await hubs.onBrokerLog("New client connected from 1.2.3.4:1 as mqttjs_ab12 (p4, c1, k60, u'meshtastic').", T0);
    expect(await hubs.list()).toEqual([]);
    await hubs.onBrokerLog(connect, T0);
    await hubs.onBrokerLog(dropped, T0 + 100);
    await hubs.tick(T0 + 200);
    const again = new HubMonitor(db, () => {}, 60);   // fresh process
    await again.load();
    expect((await again.list())[0]).toMatchObject({ id: "!49b7716c", name: "Dog Base", status: "offline" });
  });
});
