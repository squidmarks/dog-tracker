import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db.js";
import { freshDb, hasMongo } from "./testdb.js";

let db: Db;
const pos = (node: string, id: number, ts: number, lat = 45, lon = -64) =>
  db.apply({ kind: "position", node, packetId: id, gateway: "!g", rssi: -80, snr: 5, ts, lat, lon, alt: null, speed: null, sats: 8 }, ts);

describe.skipIf(!hasMongo)("trackers and dogs (Mongo)", () => {
  beforeEach(async () => { db = await freshDb(); });
  afterEach(async () => { await db.close(); });

  it("lists unclaimed trackers and flags which have a GPS position", async () => {
    await pos("!aaaa0001", 1, 100);
    await db.apply({ kind: "nodeinfo", node: "!bbbb0002", longName: "Base", shortName: "BASE" });
    const t = await db.trackers();
    expect(t.find((x) => x.id === "!aaaa0001")).toMatchObject({ has_position: true, dog_id: null });
    expect(t.find((x) => x.id === "!bbbb0002")).toMatchObject({ has_position: false, long_name: "Base" });
  });

  it("ignores a duplicate uplink of the same packet", async () => {
    expect(await pos("!aaaa0001", 1, 100)).toBe(true);
    expect(await pos("!aaaa0001", 1, 100)).toBe(false);
  });

  it("creates a dog with a tracker and exposes its live position", async () => {
    await pos("!aaaa0001", 1, 100, 45.5, -64.5);
    const id = await db.createDog({ name: "Ozzie", tracker: "!aaaa0001" }, 200);
    expect(await db.dog(id)).toMatchObject({ name: "Ozzie", tracker: "!aaaa0001", lat: 45.5, lon: -64.5 });
    expect((await db.trackers())[0].dog_name).toBe("Ozzie");
    expect(await db.dogIdForNode("!aaaa0001")).toBe(id);
  });

  it("refuses to give one tracker to two dogs, and requires a name", async () => {
    await pos("!aaaa0001", 1, 100);
    await db.createDog({ name: "Ozzie", tracker: "!aaaa0001" });
    await expect(db.createDog({ name: "Maple", tracker: "!aaaa0001" })).rejects.toThrow(/already belongs to Ozzie/);
    await expect(db.createDog({ name: "  " })).rejects.toThrow(/needs a name/);
    expect(await db.dogs()).toHaveLength(1); // the failed create left no half-made dog
  });

  it("rejects an unknown tracker without creating the dog", async () => {
    await expect(db.createDog({ name: "Ozzie", tracker: "!nope0000" })).rejects.toThrow(/Unknown tracker/);
    expect(await db.dogs()).toHaveLength(0);
  });

  it("keeps a dog's history across a collar swap", async () => {
    await pos("!aaaa0001", 1, 100, 45.0);
    const id = await db.createDog({ name: "Ozzie", tracker: "!aaaa0001" }, 150);
    await pos("!aaaa0001", 2, 200, 45.1);
    await pos("!bbbb0002", 3, 300, 46.0);          // new collar, still unclaimed
    await db.updateDog(id, { tracker: "!bbbb0002" }, 310);
    await pos("!bbbb0002", 4, 400, 46.1);
    await pos("!aaaa0001", 5, 500, 47.0);          // old collar after hand-over: not Ozzie's
    expect((await db.dogTrack(id, 0)).map((p) => p.lat)).toEqual([45.0, 45.1, 46.1]);
    expect((await db.dog(id))!.tracker).toBe("!bbbb0002");
    expect((await db.trackers()).find((t) => t.id === "!aaaa0001")!.dog_id).toBeNull();
  });

  it("limits a dog's track to a time window", async () => {
    for (const [i, ts] of [100, 200, 300, 400].entries()) await pos("!aaaa0001", i + 1, ts, 45 + i / 1000);
    const id = await db.createDog({ name: "Ozzie", tracker: "!aaaa0001" }, 50);
    expect((await db.dogTrack(id, 150, 350)).map((p) => p.ts)).toEqual([200, 300]);
    expect((await db.dogTrack(id, 250)).map((p) => p.ts)).toEqual([300, 400]);
  });

  it("a failed swap leaves the dog on its current tracker", async () => {
    await pos("!aaaa0001", 1, 100);
    await pos("!bbbb0002", 2, 100);
    const ozzie = await db.createDog({ name: "Ozzie", tracker: "!aaaa0001" });
    await db.createDog({ name: "Maple", tracker: "!bbbb0002" });
    await expect(db.updateDog(ozzie, { tracker: "!bbbb0002", name: "Renamed" })).rejects.toThrow(/already belongs to Maple/);
    expect(await db.dog(ozzie)).toMatchObject({ name: "Ozzie", tracker: "!aaaa0001" });
  });

  it("unlinks, edits and deletes dogs", async () => {
    await pos("!aaaa0001", 1, 100);
    const id = await db.createDog({ name: "Ozzie", tracker: "!aaaa0001" });
    await db.updateDog(id, { name: "Oz", breed: "Lab", tracker: null });
    expect(await db.dog(id)).toMatchObject({ name: "Oz", breed: "Lab", tracker: null });
    expect(await db.deleteDog(id)).toBe(true);
    expect(await db.dogs()).toHaveLength(0);
    expect(await db.updateDog("000000000000000000000000", { name: "x" })).toBe(false);
    expect(await db.updateDog("not-an-id", { name: "x" })).toBe(false);
  });

  it("removes only simulated trackers and their dogs", async () => {
    await pos("!fa000001", 1, 100);
    await pos("!aaaa0001", 2, 100);
    await db.createDog({ name: "Sim", tracker: "!fa000001" });
    await db.createDog({ name: "Real", tracker: "!aaaa0001" });
    const removed = await db.deleteSimNodes();
    expect(removed.nodes).toBe(1);
    expect(removed.dogIds).toHaveLength(1);
    expect((await db.dogs()).map((d) => d.name)).toEqual(["Real"]);
    expect((await db.trackers()).map((t) => t.id)).toEqual(["!aaaa0001"]);
  });
});
