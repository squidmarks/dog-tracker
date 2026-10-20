import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Beeper } from "./beeper.js";
import type { SendResult } from "./collar.js";
import type { Db } from "./db.js";
import { circleRing } from "./geo.js";
import { Monitor } from "./rules.js";
import { freshDb, hasMongo } from "./testdb.js";

const C = { lat: 45, lon: -64 };
const north = (m: number) => C.lat + m / 111_195;
const T = 10_000;

describe.skipIf(!hasMongo)("Beeper (Mongo)", () => {
  let db: Db, monitor: Monitor, beeper: Beeper, sent: string[], reply: SendResult, logs: string[], dogId: string;

  const fix = async (id: number, metresNorth: number) => {
    await db.apply({ kind: "position", node: "!aaaa0001", packetId: id, gateway: "!g", rssi: -80, snr: 5, ts: 100, lat: north(metresNorth), lon: C.lon, alt: null, speed: null, sats: 8 }, 100);
    await monitor.onPosition("!aaaa0001", north(metresNorth), C.lon);
  };
  const leave = async (base = 0) => { await fix(base + 1, 60); await fix(base + 2, 65); };
  const comeBack = async (base = 0) => { await fix(base + 3, 20); await fix(base + 4, 18); };

  beforeEach(async () => {
    db = await freshDb();
    sent = []; logs = []; reply = { sent: true, acked: true };
    monitor = new Monitor(db, () => {});
    beeper = new Beeper(db, monitor, async (node) => { sent.push(node); return reply; }, (l) => logs.push(l));
    await fix(1000, 10);                                           // the tracker exists, inside the yard
    dogId = await db.createDog({ name: "Ozzie", tracker: "!aaaa0001", beep: true });
    await db.createZone({ name: "Yard", ring: circleRing(C.lat, C.lon, 40), alertOn: "exit", home: true });
    await monitor.reload(true);
  });
  afterEach(async () => { await db.close(); });

  it("stays quiet while the tag is on the charger, even if it sits outside the yard", async () => {
    await db.apply({ kind: "telemetry", node: "!aaaa0001", battery: 101, voltage: 4.2 }, 100);
    await leave();
    await beeper.tick(T); await beeper.tick(T + 60);
    expect(sent).toEqual([]);
  });

  it("stays quiet while the dog is inside", async () => {
    await beeper.tick(T); await beeper.tick(T + 60);
    expect(sent).toEqual([]);
  });

  it("beeps as soon as the exit is confirmed, then once per interval, not in between", async () => {
    await leave();
    await beeper.tick(T);                  expect(sent).toHaveLength(1);
    await beeper.tick(T + 10);             expect(sent).toHaveLength(1);       // too soon
    await beeper.tick(T + 29);             expect(sent).toHaveLength(1);
    await beeper.tick(T + 30);             expect(sent).toHaveLength(2);       // the 30 s interval
    await beeper.tick(T + 60);             expect(sent).toHaveLength(3);
    expect(new Set(sent)).toEqual(new Set(["!aaaa0001"]));                     // always to that dog's own collar
  });

  it("stops the moment the dog is back inside, and starts afresh on the next exit", async () => {
    await leave();
    await beeper.tick(T); await beeper.tick(T + 30);
    await comeBack();
    await beeper.tick(T + 40); await beeper.tick(T + 100);
    expect(sent).toHaveLength(2);
    expect(logs.some((l) => /stopped after 2 beeps/.test(l))).toBe(true);
    await leave(10);
    await beeper.tick(T + 200);
    expect(sent).toHaveLength(3);                                              // a new episode beeps straight away
  });

  it("gives up after the cap so a lost collar doesn't beep itself flat", async () => {
    await db.updateSettings({ beepMaxMinutes: 2, beepIntervalS: 30 });
    await leave();
    for (const t of [0, 30, 60, 90, 120]) await beeper.tick(T + t);            // within 2 minutes: 5 beeps
    expect(sent).toHaveLength(5);
    await beeper.tick(T + 150); await beeper.tick(T + 600);
    expect(sent).toHaveLength(5);
  });

  it("honours a different interval", async () => {
    await db.updateSettings({ beepIntervalS: 10 });
    await leave();
    for (const t of [0, 10, 20]) await beeper.tick(T + t);
    expect(sent).toHaveLength(3);
  });

  it("is silent during walking mode, and picks up again if the dog is still out afterwards", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    await db.setSnooze(nowS + 3600, { mode: "return", startedAt: nowS });
    await leave();
    await beeper.tick(nowS + 5); await beeper.tick(nowS + 100);
    expect(sent).toEqual([]);
    await db.setSnooze(null);
    await beeper.tick(nowS + 200);
    expect(sent).toHaveLength(1);
  });

  it("only beeps dogs that have it switched on and a tracker", async () => {
    await db.updateDog(dogId, { beep: false });
    await leave();
    await beeper.tick(T);
    expect(sent).toEqual([]);
  });

  it("keeps going after a failed send, and tries again next interval", async () => {
    reply = { sent: false, acked: false, error: "could not connect to the hub" };
    await leave();
    await beeper.tick(T); await beeper.tick(T + 30);
    expect(sent).toHaveLength(2);
    expect(logs.filter((l) => /FAILED: could not connect/.test(l))).toHaveLength(2);
  });

  it("a test beep goes out whatever the dog is doing, and says why when it can't", async () => {
    expect(await beeper.test(dogId)).toEqual({ sent: true, acked: true });
    expect(sent).toEqual(["!aaaa0001"]);
    expect(await beeper.test("000000000000000000000000")).toMatchObject({ sent: false, error: "unknown dog" });
    const loose = await db.createDog({ name: "Loose" });
    expect(await beeper.test(loose)).toMatchObject({ sent: false, error: expect.stringMatching(/no tracker/) });
  });

  it("never overlaps two ticks when a send is slow", async () => {
    let release!: () => void;
    beeper = new Beeper(db, monitor, (node) => new Promise((res) => { sent.push(node); release = () => res({ sent: true, acked: true }); }), (l) => logs.push(l));
    await leave();
    const first = beeper.tick(T);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await beeper.tick(T + 31);                         // while the first is still sending: ignored
    expect(sent).toHaveLength(1);
    release(); await first;
  });
});
