import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, type DogEvent } from "./db.js";
import { circleRing } from "./geo.js";
import { Monitor } from "./rules.js";
import { freshDb, hasMongo } from "./testdb.js";

const C = { lat: 45, lon: -64 };
const north = (m: number) => C.lat + m / 111_195;
let db: Db, monitor: Monitor, events: DogEvent[], dogId: string;

const fix = async (id: number, metresNorth: number, ts = 100) => {
  await db.apply({ kind: "position", node: "!aaaa0001", packetId: id, gateway: "!g", rssi: -80, snr: 5, ts, lat: north(metresNorth), lon: C.lon, alt: null, speed: null, sats: 8 }, ts);
  await monitor.onPosition("!aaaa0001", north(metresNorth), C.lon);
};

describe.skipIf(!hasMongo)("Monitor (Mongo)", () => {
  beforeEach(async () => {
    db = await freshDb();
    events = [];
    monitor = new Monitor(db, (e) => { events.push(e); });
    await fix(1, 10);                                                      // tracker exists, inside the yard
    dogId = await db.createDog({ name: "Ozzie", tracker: "!aaaa0001" });
    await db.createZone({ name: "Yard", ring: circleRing(C.lat, C.lon, 40), alertOn: "exit", home: true });
    await monitor.reload(true);                                            // seeds membership from the last position
  });
  afterEach(async () => { await db.close(); });

  it("raises an alert when the dog leaves a zone, and a quiet event when it returns", async () => {
    await fix(2, 60); expect(events).toHaveLength(0);                      // first fix outside: debounce
    await fix(3, 65);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "zone_exit", zoneName: "Yard", dogName: "Ozzie", alert: true, message: "Ozzie left Yard" });
    await fix(4, 20); await fix(5, 18);
    expect(events[1]).toMatchObject({ type: "zone_enter", alert: false });  // alertOn=exit: entering is logged, not alerted
    expect(await db.events()).toHaveLength(2);
    expect(monitor.isInside(dogId, (await db.zones())[0].id)).toBe(true);
  });

  it("a dog with alerts turned off logs events quietly", async () => {
    await db.updateDog(dogId, { alerts: false });
    await fix(2, 60); await fix(3, 65);
    expect(events[0]).toMatchObject({ type: "zone_exit", alert: false });
    expect((await db.dog(dogId))!.alerts).toBe(false);
  });

  it("marks events from simulated trackers as sim", async () => {
    await db.apply({ kind: "position", node: "!fa000001", packetId: 1, gateway: "!g", rssi: -80, snr: 5, ts: 100, lat: north(10), lon: C.lon, alt: null, speed: null, sats: 8 }, 100);
    await db.createDog({ name: "Sim", tracker: "!fa000001" });
    await monitor.reload(true);
    for (const [i, m] of [60, 65].entries()) {
      await db.apply({ kind: "position", node: "!fa000001", packetId: 10 + i, gateway: "!g", rssi: -80, snr: 5, ts: 200 + i, lat: north(m), lon: C.lon, alt: null, speed: null, sats: 8 }, 200 + i);
      await monitor.onPosition("!fa000001", north(m), C.lon);
    }
    expect(events.find((e) => e.dogName === "Sim")).toMatchObject({ type: "zone_exit", sim: true });
  });

  it("alertOn=enter makes a danger zone: entering is the alert", async () => {
    await db.createZone({ name: "Pond", ring: circleRing(north(200), C.lon, 20), alertOn: "enter" });
    await monitor.reload();
    await fix(2, 190); await fix(3, 195);
    const e = events.find((x) => x.zoneName === "Pond");
    expect(e).toMatchObject({ type: "zone_enter", alert: true });
  });

  it("only applies a zone to the dogs it lists", async () => {
    const other = await db.createDog({ name: "Maple" });
    await db.createZone({ name: "Maple only", ring: circleRing(north(300), C.lon, 20), alertOn: "both", dogs: [other] });
    await monitor.reload();
    await fix(2, 295); await fix(3, 300);
    expect(events.filter((x) => x.zoneName === "Maple only")).toHaveLength(0);
  });

  it("flags a silent tracker once, then recovery", async () => {
    await db.updateSettings({ staleMinutes: 10 });
    const t0 = 1000;
    await db.apply({ kind: "telemetry", node: "!aaaa0001", battery: 90, voltage: 4 }, t0);
    await monitor.tick(t0 + 60);                                           // seeds flags silently
    await monitor.tick(t0 + 11 * 60);
    await monitor.tick(t0 + 12 * 60);                                      // still silent: no repeat
    expect(events.filter((e) => e.type === "silent")).toHaveLength(1);
    expect(events.find((e) => e.type === "silent")).toMatchObject({ alert: true });
    await db.apply({ kind: "telemetry", node: "!aaaa0001", battery: 90, voltage: 4 }, t0 + 13 * 60);
    await monitor.tick(t0 + 13 * 60 + 5);
    expect(events.find((e) => e.type === "reporting")).toMatchObject({ alert: false });
  });

  it("alerts on low battery but never for the 'charging' marker", async () => {
    await db.apply({ kind: "telemetry", node: "!aaaa0001", battery: 80, voltage: 4 }, 1000);
    await monitor.tick(1010);                                              // seed
    await db.apply({ kind: "telemetry", node: "!aaaa0001", battery: 15, voltage: 3.4 }, 1020);
    await monitor.tick(1030);
    expect(events.filter((e) => e.type === "low_battery")).toHaveLength(1);
    await db.apply({ kind: "telemetry", node: "!aaaa0001", battery: 101, voltage: 4.3 }, 1040);
    await monitor.tick(1050);
    expect(events.at(-1)).toMatchObject({ type: "battery_ok", alert: false });
  });
});
