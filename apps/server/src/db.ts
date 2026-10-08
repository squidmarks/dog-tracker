import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MeshEvent } from "./decode.js";

export type Db = ReturnType<typeof openDb>;

export interface DogInput {
  name?: string; color?: string | null; emoji?: string | null; breed?: string | null; notes?: string | null;
  tracker?: string | null;
}

/** A dog with its tracker's live state (see dogs()). */
export interface DogLive { id: number; name: string; tracker: string | null; [k: string]: unknown }

/** Latest-position join shared by the dog and tracker listings. */
const LIVE = `
  n.battery, n.voltage, n.last_heard, n.long_name, n.short_name,
  p.lat, p.lon, p.ts AS pos_ts, p.speed, p.sats, p.gateway, p.rssi, p.snr
  FROM nodes n
  LEFT JOIN positions p ON p.id = (SELECT id FROM positions WHERE node = n.id ORDER BY ts DESC LIMIT 1)`;

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    -- A tracker is the radio hardware, discovered automatically from mesh traffic.
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      long_name TEXT, short_name TEXT,
      name TEXT, color TEXT,  -- legacy (pre-dogs); unused
      battery INTEGER, voltage REAL,
      last_heard INTEGER
    );
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY,
      node TEXT NOT NULL, packet_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, alt REAL, speed REAL, sats INTEGER,
      gateway TEXT, rssi REAL, snr REAL,
      UNIQUE (node, packet_id)  -- several base stations can uplink the same packet
    );
    CREATE INDEX IF NOT EXISTS positions_node_ts ON positions (node, ts);

    -- A dog is what the user cares about; it carries a tracker, and can be re-linked to a new one.
    CREATE TABLE IF NOT EXISTS dogs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL, color TEXT, emoji TEXT, breed TEXT, notes TEXT,
      created_at INTEGER NOT NULL
    );
    -- Assignment history: a dog's track is the positions of whichever tracker it carried at the time.
    CREATE TABLE IF NOT EXISTS dog_trackers (
      id INTEGER PRIMARY KEY,
      dog_id INTEGER NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
      node TEXT NOT NULL,
      since INTEGER NOT NULL, until INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_per_node ON dog_trackers (node) WHERE until IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_per_dog ON dog_trackers (dog_id) WHERE until IS NULL;
  `);

  const touch = db.prepare(`INSERT INTO nodes (id, last_heard) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET last_heard = max(coalesce(last_heard, 0), excluded.last_heard)`);
  const insPos = db.prepare(`INSERT OR IGNORE INTO positions
    (node, packet_id, ts, lat, lon, alt, speed, sats, gateway, rssi, snr)
    VALUES (@node, @packetId, @ts, @lat, @lon, @alt, @speed, @sats, @gateway, @rssi, @snr)`);
  const setInfo = db.prepare("UPDATE nodes SET long_name = ?, short_name = ? WHERE id = ?");
  const setTelem = db.prepare("UPDATE nodes SET battery = ?, voltage = ? WHERE id = ?");

  const now = () => Math.floor(Date.now() / 1000);
  const dogByNode = db.prepare("SELECT dog_id FROM dog_trackers WHERE node = ? AND until IS NULL");

  /** Point a dog at a tracker, closing its previous assignment. Throws if another dog has the tracker. */
  const assign = db.transaction((dogId: number, node: string, at: number) => {
    const holder = db.prepare(`SELECT d.id, d.name FROM dog_trackers dt JOIN dogs d ON d.id = dt.dog_id
      WHERE dt.node = ? AND dt.until IS NULL`).get(node) as { id: number; name: string } | undefined;
    if (holder?.id === dogId) return;
    if (holder) throw new Error(`Tracker ${node} already belongs to ${holder.name}`);
    if (!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(node)) throw new Error(`Unknown tracker ${node}`);
    db.prepare("UPDATE dog_trackers SET until = ? WHERE dog_id = ? AND until IS NULL").run(at, dogId);
    // A dog's first tracker brings its pre-claim history (the dog was created when the tracker showed up);
    // a replacement collar only counts from the hand-over, so a day on the charger isn't the dog's track.
    const first = !db.prepare("SELECT 1 FROM dog_trackers WHERE dog_id = ?").get(dogId);
    db.prepare("INSERT INTO dog_trackers (dog_id, node, since) VALUES (?, ?, ?)").run(dogId, node, first ? 0 : at);
  });
  const unassign = (dogId: number, at: number) =>
    db.prepare("UPDATE dog_trackers SET until = ? WHERE dog_id = ? AND until IS NULL").run(at, dogId);

  const FIELDS = ["name", "color", "emoji", "breed", "notes"] as const;

  return {
    raw: db,
    /** Apply an event. Returns true when it was new (not a duplicate uplink). */
    apply(ev: MeshEvent, at = now()): boolean {
      touch.run(ev.node, at);
      switch (ev.kind) {
        case "position":
          return insPos.run(ev).changes > 0;
        case "nodeinfo":
          setInfo.run(ev.longName, ev.shortName, ev.node);
          return true;
        case "telemetry":
          // 101 = "powered/charging" in Meshtastic; keep it, the UI interprets it.
          setTelem.run(ev.battery, ev.voltage, ev.node);
          return true;
      }
    },

    // --- trackers ---------------------------------------------------------
    /** Every node heard, with its latest position and which dog (if any) carries it. */
    trackers() {
      return db.prepare(`
        SELECT n.id, ${LIVE.replace("FROM nodes n", `,
          EXISTS (SELECT 1 FROM positions WHERE node = n.id) AS has_position,
          dt.dog_id, d.name AS dog_name
        FROM nodes n
        LEFT JOIN dog_trackers dt ON dt.node = n.id AND dt.until IS NULL
        LEFT JOIN dogs d ON d.id = dt.dog_id`)}
        ORDER BY n.last_heard DESC`).all();
    },
    dogIdForNode(node: string): number | null {
      return (dogByNode.get(node) as { dog_id: number } | undefined)?.dog_id ?? null;
    },

    // --- dogs -------------------------------------------------------------
    dogs() {
      return db.prepare(`
        SELECT d.id, d.name, d.color, d.emoji, d.breed, d.notes, d.created_at, dt.node AS tracker,
          n.battery, n.voltage, n.last_heard,
          p.lat, p.lon, p.ts AS pos_ts, p.speed, p.sats, p.gateway, p.rssi, p.snr
        FROM dogs d
        LEFT JOIN dog_trackers dt ON dt.dog_id = d.id AND dt.until IS NULL
        LEFT JOIN nodes n ON n.id = dt.node
        LEFT JOIN positions p ON p.id = (SELECT id FROM positions WHERE node = n.id ORDER BY ts DESC LIMIT 1)
        ORDER BY d.name COLLATE NOCASE`).all() as DogLive[];
    },
    dog(id: number): DogLive | undefined {
      return this.dogs().find((d) => d.id === id);
    },
    createDog(input: DogInput, at = now()): number {
      const name = input.name?.trim();
      if (!name) throw new Error("A dog needs a name");
      return db.transaction(() => {
        const id = Number(db.prepare(`INSERT INTO dogs (name, color, emoji, breed, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(name, input.color ?? null, input.emoji ?? null,
          input.breed ?? null, input.notes ?? null, at).lastInsertRowid);
        if (input.tracker) assign(id, input.tracker, at);
        return id;
      })();
    },
    /** Partial update. `tracker: null` unlinks; `tracker: "!id"` links (or swaps to) that tracker. */
    updateDog(id: number, input: DogInput, at = now()): boolean {
      return db.transaction(() => {
        if (!db.prepare("SELECT 1 FROM dogs WHERE id = ?").get(id)) return false;
        for (const f of FIELDS) {
          if (!(f in input)) continue;
          const v = input[f] ?? null;
          if (f === "name" && !String(v ?? "").trim()) throw new Error("A dog needs a name");
          db.prepare(`UPDATE dogs SET ${f} = ? WHERE id = ?`).run(typeof v === "string" ? v.trim() : v, id);
        }
        if ("tracker" in input) input.tracker ? assign(id, input.tracker, at) : unassign(id, at);
        return true;
      })();
    },
    deleteDog(id: number): boolean {
      return db.prepare("DELETE FROM dogs WHERE id = ?").run(id).changes > 0;
    },
    dogTrack(id: number, sinceTs: number) {
      return db.prepare(`
        SELECT p.ts, p.lat, p.lon, p.speed FROM positions p
        JOIN dog_trackers dt ON dt.node = p.node AND dt.dog_id = ?
          AND p.ts >= dt.since AND (dt.until IS NULL OR p.ts <= dt.until)
        WHERE p.ts >= ? ORDER BY p.ts`).all(id, sinceTs);
    },

    deleteSimNodes() {
      const glob = "'!fa[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'";
      db.exec(`DELETE FROM dogs WHERE id IN (SELECT dog_id FROM dog_trackers WHERE node GLOB ${glob});
               DELETE FROM dog_trackers WHERE node GLOB ${glob};
               DELETE FROM positions WHERE node GLOB ${glob}`);
      return db.prepare(`DELETE FROM nodes WHERE id GLOB ${glob}`).run().changes;
    },
  };
}
