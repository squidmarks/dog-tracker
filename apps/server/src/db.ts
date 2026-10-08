import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MeshEvent } from "./decode.js";

export type Db = ReturnType<typeof openDb>;

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      long_name TEXT, short_name TEXT,
      name TEXT,              -- user-assigned name ("Maple"), wins over long_name
      color TEXT,
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
  `);

  const touch = db.prepare(`INSERT INTO nodes (id, last_heard) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET last_heard = max(coalesce(last_heard, 0), excluded.last_heard)`);
  const insPos = db.prepare(`INSERT OR IGNORE INTO positions
    (node, packet_id, ts, lat, lon, alt, speed, sats, gateway, rssi, snr)
    VALUES (@node, @packetId, @ts, @lat, @lon, @alt, @speed, @sats, @gateway, @rssi, @snr)`);
  const setInfo = db.prepare("UPDATE nodes SET long_name = ?, short_name = ? WHERE id = ?");
  const setTelem = db.prepare("UPDATE nodes SET battery = ?, voltage = ? WHERE id = ?");

  return {
    raw: db,
    /** Apply an event. Returns true when it was new (not a duplicate uplink). */
    apply(ev: MeshEvent, now = Math.floor(Date.now() / 1000)): boolean {
      touch.run(ev.node, now);
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
    nodes() {
      return db.prepare(`
        SELECT n.*, p.lat, p.lon, p.ts AS pos_ts, p.speed, p.sats, p.gateway, p.rssi, p.snr
        FROM nodes n
        LEFT JOIN positions p ON p.id = (SELECT id FROM positions WHERE node = n.id ORDER BY ts DESC LIMIT 1)
        ORDER BY coalesce(n.name, n.long_name, n.id)`).all();
    },
    track(node: string, sinceTs: number) {
      return db.prepare("SELECT ts, lat, lon, speed FROM positions WHERE node = ? AND ts >= ? ORDER BY ts")
        .all(node, sinceTs);
    },
    rename(node: string, name: string | null, color: string | null) {
      return db.prepare("UPDATE nodes SET name = ?, color = ? WHERE id = ?").run(name, color, node).changes > 0;
    },
  };
}
