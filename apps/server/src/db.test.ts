import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";

let db: Db;
const pos = (node: string, id: number, ts: number, lat = 45, lon = -64) =>
  db.apply({ kind: "position", node, packetId: id, gateway: "!g", rssi: -80, snr: 5, ts, lat, lon, alt: null, speed: null, sats: 8 }, ts);

beforeEach(() => { db = openDb(":memory:"); });

describe("trackers and dogs", () => {
  it("lists unclaimed trackers and flags which have a GPS position", () => {
    pos("!aaaa0001", 1, 100);
    db.apply({ kind: "nodeinfo", node: "!bbbb0002", longName: "Base", shortName: "BASE" });
    const t = db.trackers() as { id: string; has_position: number; dog_id: number | null }[];
    expect(t.find((x) => x.id === "!aaaa0001")).toMatchObject({ has_position: 1, dog_id: null });
    expect(t.find((x) => x.id === "!bbbb0002")).toMatchObject({ has_position: 0 });
  });

  it("creates a dog with a tracker and exposes its live position", () => {
    pos("!aaaa0001", 1, 100, 45.5, -64.5);
    const id = db.createDog({ name: "Ozzie", tracker: "!aaaa0001" }, 200);
    expect(db.dog(id)).toMatchObject({ name: "Ozzie", tracker: "!aaaa0001", lat: 45.5, lon: -64.5 });
    expect((db.trackers() as { dog_name: string | null }[])[0].dog_name).toBe("Ozzie");
  });

  it("refuses to give one tracker to two dogs, and requires a name", () => {
    pos("!aaaa0001", 1, 100);
    db.createDog({ name: "Ozzie", tracker: "!aaaa0001" });
    expect(() => db.createDog({ name: "Maple", tracker: "!aaaa0001" })).toThrow(/already belongs to Ozzie/);
    expect(() => db.createDog({ name: "  " })).toThrow(/needs a name/);
    expect(db.dogs()).toHaveLength(1); // the failed create rolled back
  });

  it("keeps a dog's history across a collar swap", () => {
    pos("!aaaa0001", 1, 100, 45.0);
    const id = db.createDog({ name: "Ozzie", tracker: "!aaaa0001" }, 150);
    pos("!aaaa0001", 2, 200, 45.1);
    pos("!bbbb0002", 3, 300, 46.0);          // new collar, still unclaimed
    db.updateDog(id, { tracker: "!bbbb0002" }, 310);
    pos("!bbbb0002", 4, 400, 46.1);
    pos("!aaaa0001", 5, 500, 47.0);          // old collar after hand-over: not Ozzie's
    const lats = (db.dogTrack(id, 0) as { lat: number }[]).map((p) => p.lat);
    expect(lats).toEqual([45.0, 45.1, 46.1]);      // first claim includes pre-claim history; hand-over starts fresh
    expect((db.dog(id) as unknown as { tracker: string }).tracker).toBe("!bbbb0002");
    expect((db.trackers() as { id: string; dog_id: number | null }[]).find((t) => t.id === "!aaaa0001")!.dog_id).toBeNull();
  });

  it("unlinks, edits and deletes dogs", () => {
    pos("!aaaa0001", 1, 100);
    const id = db.createDog({ name: "Ozzie", tracker: "!aaaa0001" });
    db.updateDog(id, { name: "Oz", breed: "Lab", tracker: null });
    expect(db.dog(id)).toMatchObject({ name: "Oz", breed: "Lab", tracker: null });
    expect(db.deleteDog(id)).toBe(true);
    expect(db.dogs()).toHaveLength(0);
    expect(db.updateDog(999, { name: "x" })).toBe(false);
  });
});
