import { type Collection, MongoClient, MongoServerError, ObjectId } from "mongodb";
import type { MeshEvent } from "./decode.js";

export type Db = Awaited<ReturnType<typeof openDb>>;

export interface DogInput {
  name?: string; color?: string | null; emoji?: string | null; breed?: string | null; notes?: string | null;
  tracker?: string | null;
}

/** A dog with its tracker's live state (see dogs()). */
export interface DogLive { id: string; name: string; tracker: string | null; [k: string]: unknown }

interface NodeDoc {
  _id: string; long_name?: string | null; short_name?: string | null;
  battery?: number | null; voltage?: number | null; last_heard?: number;
}
interface PositionDoc {
  node: string; packet_id: number; ts: number; lat: number; lon: number;
  alt: number | null; speed: number | null; sats: number | null; gateway: string | null; rssi: number | null; snr: number | null;
}
interface DogDoc { _id: ObjectId; name: string; color: string | null; emoji: string | null; breed: string | null; notes: string | null; created_at: number }
/** Assignment history: a dog's track is the positions of whichever tracker it carried at the time.
 *  `open: true` marks the current assignment (and is unset on close) so partial unique indexes can enforce
 *  "one dog per tracker, one tracker per dog". */
interface AssignmentDoc { _id?: ObjectId; dogId: ObjectId; node: string; since: number; until: number | null; open?: true }

export type AlertOn = "exit" | "enter" | "both" | "none";
export interface Zone {
  id: string; name: string; color: string; ring: [number, number][];
  alertOn: AlertOn;
  /** Counts as "home" for Home Assistant presence (the dog's device_tracker reads `home` inside it). */
  home: boolean;
  /** Dog ids this zone applies to; null = every dog. */
  dogs: string[] | null;
}
export interface ZoneInput { name?: string; color?: string; ring?: [number, number][]; alertOn?: AlertOn; home?: boolean; dogs?: string[] | null }

export type EventType = "zone_exit" | "zone_enter" | "silent" | "reporting" | "low_battery" | "battery_ok";
export interface DogEvent {
  id: string; ts: number; type: EventType; dogId: string; dogName: string;
  zoneId?: string; zoneName?: string; lat?: number | null; lon?: number | null;
  /** Worth interrupting the user for (drives push notifications and the highlighted timeline style). */
  alert: boolean; message: string;
}

export interface Settings { staleMinutes: number; lowBatteryPct: number; fenceMarginM: number }
export const DEFAULT_SETTINGS: Settings = { staleMinutes: 20, lowBatteryPct: 20, fenceMarginM: 5 };

const DUPLICATE_KEY = 11000;
const SIM_NODE = /^!fa[0-9a-f]{6}$/;
const FIELDS = ["name", "color", "emoji", "breed", "notes"] as const;
const now = () => Math.floor(Date.now() / 1000);

const oid = (id: string): ObjectId | null => (ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : null);

const ALERT_ON: AlertOn[] = ["exit", "enter", "both", "none"];
function validateZone(z: ZoneInput): Omit<Zone, "id"> {
  const name = z.name?.trim();
  if (!name) throw new Error("A zone needs a name");
  const ring = z.ring ?? [];
  if (ring.length < 4) throw new Error("A zone needs at least three points");
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring : [...ring, ring[0]];
  for (const [lon, lat] of closed) {
    if (!(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) throw new Error("Zone coordinates out of range");
  }
  const alertOn = z.alertOn ?? "exit";
  if (!ALERT_ON.includes(alertOn)) throw new Error("alertOn must be exit, enter, both or none");
  return { name, color: z.color ?? "#2e86ab", ring: closed, alertOn, home: z.home ?? false, dogs: z.dogs && z.dogs.length ? z.dogs : null };
}

export async function openDb(url: string, dbName: string) {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(dbName);
  const nodes: Collection<NodeDoc> = db.collection("nodes");
  const positions: Collection<PositionDoc> = db.collection("positions");
  const dogsCol: Collection<DogDoc> = db.collection("dogs");
  const assignments: Collection<AssignmentDoc> = db.collection("dog_trackers");
  const zonesCol: Collection<Omit<Zone, "id"> & { _id: ObjectId }> = db.collection("zones");
  const eventsCol: Collection<Omit<DogEvent, "id"> & { _id: ObjectId }> = db.collection("events");
  const settingsCol: Collection<{ _id: string } & Partial<Settings>> = db.collection("settings");

  await positions.createIndex({ node: 1, packet_id: 1 }, { unique: true }); // several base stations can uplink the same packet
  await positions.createIndex({ node: 1, ts: -1 });
  await assignments.createIndex({ node: 1 }, { unique: true, partialFilterExpression: { open: true } });
  await assignments.createIndex({ dogId: 1 }, { unique: true, partialFilterExpression: { open: true } });
  await assignments.createIndex({ dogId: 1, since: 1 });
  await eventsCol.createIndex({ ts: -1 });

  const latestPosition = (node: string) => positions.find({ node }).sort({ ts: -1 }).limit(1).next();

  const liveFields = (n: NodeDoc | null, p: PositionDoc | null) => ({
    battery: n?.battery ?? null, voltage: n?.voltage ?? null, last_heard: n?.last_heard ?? null,
    lat: p?.lat ?? null, lon: p?.lon ?? null, pos_ts: p?.ts ?? null, speed: p?.speed ?? null, sats: p?.sats ?? null,
    gateway: p?.gateway ?? null, rssi: p?.rssi ?? null, snr: p?.snr ?? null,
  });

  /** Point a dog at a tracker, closing its previous assignment. Throws if another dog has the tracker. */
  async function assign(dogId: ObjectId, node: string, at: number) {
    const holder = await assignments.findOne({ node, open: true });
    if (holder?.dogId.equals(dogId)) return;
    if (holder) {
      const other = await dogsCol.findOne({ _id: holder.dogId });
      throw new Error(`Tracker ${node} already belongs to ${other?.name ?? "another dog"}`);
    }
    if (!(await nodes.findOne({ _id: node }))) throw new Error(`Unknown tracker ${node}`);
    // A dog's first tracker brings its pre-claim history (the dog was created when the tracker showed up);
    // a replacement collar only counts from the hand-over, so a day on the charger isn't the dog's track.
    const first = !(await assignments.findOne({ dogId }));
    const previous = await assignments.findOne({ dogId, open: true });
    if (previous) await assignments.updateOne({ _id: previous._id }, { $set: { until: at }, $unset: { open: "" } });
    try {
      await assignments.insertOne({ dogId, node, since: first ? 0 : at, until: null, open: true });
    } catch (e) {
      if (previous) await assignments.updateOne({ _id: previous._id }, { $set: { open: true, until: null } }); // restore
      if (e instanceof MongoServerError && e.code === DUPLICATE_KEY) throw new Error(`Tracker ${node} was just claimed by another dog`);
      throw e;
    }
  }
  const unassign = (dogId: ObjectId, at: number) =>
    assignments.updateMany({ dogId, open: true }, { $set: { until: at }, $unset: { open: "" } });

  const api = {
    /** Apply an event. Returns true when it was new (not a duplicate uplink). */
    async apply(ev: MeshEvent, at = now()): Promise<boolean> {
      await nodes.updateOne({ _id: ev.node }, { $max: { last_heard: at } }, { upsert: true });
      switch (ev.kind) {
        case "position":
          try {
            await positions.insertOne({
              node: ev.node, packet_id: ev.packetId, ts: ev.ts, lat: ev.lat, lon: ev.lon, alt: ev.alt, speed: ev.speed,
              sats: ev.sats, gateway: ev.gateway, rssi: ev.rssi, snr: ev.snr,
            });
            return true;
          } catch (e) {
            if (e instanceof MongoServerError && e.code === DUPLICATE_KEY) return false;
            throw e;
          }
        case "nodeinfo":
          await nodes.updateOne({ _id: ev.node }, { $set: { long_name: ev.longName, short_name: ev.shortName } });
          return true;
        case "telemetry":
          // 101 = "powered/charging" in Meshtastic; keep it, the UI interprets it.
          await nodes.updateOne({ _id: ev.node }, { $set: { battery: ev.battery, voltage: ev.voltage } });
          return true;
      }
    },

    // --- trackers ---------------------------------------------------------
    /** Every node heard, with its latest position and which dog (if any) carries it. */
    async trackers() {
      const [all, open, dogs] = await Promise.all([
        nodes.find().sort({ last_heard: -1 }).toArray(),
        assignments.find({ open: true }).toArray(),
        dogsCol.find().toArray(),
      ]);
      return Promise.all(all.map(async (n) => {
        const p = await latestPosition(n._id);
        const a = open.find((x) => x.node === n._id);
        const dog = a && dogs.find((d) => d._id.equals(a.dogId));
        return {
          id: n._id, long_name: n.long_name ?? null, short_name: n.short_name ?? null, ...liveFields(n, p),
          has_position: !!p, dog_id: dog ? String(dog._id) : null, dog_name: dog?.name ?? null,
        };
      }));
    },
    async dogIdForNode(node: string): Promise<string | null> {
      const a = await assignments.findOne({ node, open: true });
      return a ? String(a.dogId) : null;
    },

    // --- dogs -------------------------------------------------------------
    async dogs(): Promise<DogLive[]> {
      const [all, open] = await Promise.all([
        dogsCol.find().collation({ locale: "en", strength: 2 }).sort({ name: 1 }).toArray(),
        assignments.find({ open: true }).toArray(),
      ]);
      return Promise.all(all.map(async (d) => {
        const node = open.find((a) => a.dogId.equals(d._id))?.node ?? null;
        const [n, p] = node ? await Promise.all([nodes.findOne({ _id: node }), latestPosition(node)]) : [null, null];
        return { id: String(d._id), name: d.name, color: d.color, emoji: d.emoji, breed: d.breed, notes: d.notes,
          created_at: d.created_at, tracker: node, ...liveFields(n, p) };
      }));
    },
    async dog(id: string): Promise<DogLive | undefined> {
      return (await api.dogs()).find((d) => d.id === id);
    },
    async createDog(input: DogInput, at = now()): Promise<string> {
      const name = input.name?.trim();
      if (!name) throw new Error("A dog needs a name");
      const { insertedId } = await dogsCol.insertOne({
        _id: new ObjectId(), name, color: input.color ?? null, emoji: input.emoji ?? null,
        breed: input.breed ?? null, notes: input.notes ?? null, created_at: at,
      });
      if (input.tracker) {
        try { await assign(insertedId, input.tracker, at); }
        catch (e) { await dogsCol.deleteOne({ _id: insertedId }); throw e; } // no half-created dog
      }
      return String(insertedId);
    },
    /** Partial update. `tracker: null` unlinks; `tracker: "!id"` links (or swaps to) that tracker. */
    async updateDog(id: string, input: DogInput, at = now()): Promise<boolean> {
      const _id = oid(id);
      if (!_id || !(await dogsCol.findOne({ _id }))) return false;
      const set: Record<string, unknown> = {};
      for (const f of FIELDS) {
        if (!(f in input)) continue;
        const v = input[f] ?? null;
        if (f === "name" && !String(v ?? "").trim()) throw new Error("A dog needs a name");
        set[f] = typeof v === "string" ? v.trim() : v;
      }
      // Tracker first: if it fails (already claimed), nothing else has changed.
      if ("tracker" in input) { if (input.tracker) await assign(_id, input.tracker, at); else await unassign(_id, at); }
      if (Object.keys(set).length) await dogsCol.updateOne({ _id }, { $set: set });
      return true;
    },
    async deleteDog(id: string): Promise<boolean> {
      const _id = oid(id);
      if (!_id) return false;
      const { deletedCount } = await dogsCol.deleteOne({ _id });
      await assignments.deleteMany({ dogId: _id });
      return deletedCount > 0;
    },
    async dogTrack(id: string, sinceTs: number) {
      const _id = oid(id);
      if (!_id) return [];
      const out: { ts: number; lat: number; lon: number; speed: number | null }[] = [];
      for (const a of await assignments.find({ dogId: _id }).sort({ since: 1 }).toArray()) {
        const ts: Record<string, number> = { $gte: Math.max(a.since, sinceTs) };
        if (a.until != null) ts.$lte = a.until;
        for (const p of await positions.find({ node: a.node, ts }).sort({ ts: 1 }).toArray()) {
          out.push({ ts: p.ts, lat: p.lat, lon: p.lon, speed: p.speed });
        }
      }
      return out;
    },

    // --- zones ------------------------------------------------------------
    async zones(): Promise<Zone[]> {
      return (await zonesCol.find().sort({ name: 1 }).toArray()).map(({ _id, ...z }) => ({ id: String(_id), ...z }));
    },
    async createZone(input: ZoneInput): Promise<string> {
      const z = validateZone(input);
      return String((await zonesCol.insertOne({ _id: new ObjectId(), ...z })).insertedId);
    },
    async updateZone(id: string, input: ZoneInput): Promise<boolean> {
      const _id = oid(id);
      if (!_id) return false;
      const existing = await zonesCol.findOne({ _id });
      if (!existing) return false;
      const { _id: _ignored, ...current } = existing;
      await zonesCol.updateOne({ _id }, { $set: validateZone({ ...current, ...input }) });
      return true;
    },
    async deleteZone(id: string): Promise<boolean> {
      const _id = oid(id);
      return !!_id && (await zonesCol.deleteOne({ _id })).deletedCount > 0;
    },

    // --- events -----------------------------------------------------------
    async addEvent(e: Omit<DogEvent, "id">): Promise<DogEvent> {
      const _id = new ObjectId();
      await eventsCol.insertOne({ _id, ...e });
      return { id: String(_id), ...e };
    },
    async events(limit = 50): Promise<DogEvent[]> {
      const rows = await eventsCol.find().sort({ ts: -1, _id: -1 }).limit(Math.min(limit, 500)).toArray();
      return rows.map(({ _id, ...e }) => ({ id: String(_id), ...e }));
    },

    // --- settings ---------------------------------------------------------
    async settings(): Promise<Settings> {
      const doc = (await settingsCol.findOne({ _id: "alerts" })) ?? {};
      const stored = Object.fromEntries(Object.entries(doc).filter(([k, v]) => k in DEFAULT_SETTINGS && typeof v === "number"));
      return { ...DEFAULT_SETTINGS, ...stored };
    },
    async updateSettings(input: Partial<Settings>): Promise<Settings> {
      const set: Partial<Settings> = {};
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (!(k in input)) continue;
        const v = Number(input[k]);
        if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
        set[k] = v;
      }
      if (Object.keys(set).length) await settingsCol.updateOne({ _id: "alerts" }, { $set: set }, { upsert: true });
      return api.settings();
    },

    async deleteSimNodes(): Promise<number> {
      const ids = (await nodes.find({}, { projection: { _id: 1 } }).toArray()).map((n) => n._id).filter((i) => SIM_NODE.test(i));
      if (!ids.length) return 0;
      const dogIds = (await assignments.find({ node: { $in: ids } }).toArray()).map((a) => a.dogId);
      await dogsCol.deleteMany({ _id: { $in: dogIds } });
      await assignments.deleteMany({ node: { $in: ids } });
      await positions.deleteMany({ node: { $in: ids } });
      return (await nodes.deleteMany({ _id: { $in: ids } })).deletedCount;
    },

    /** Test helper: empty every collection (the app user can't drop databases, by design). */
    wipe: async () => { await Promise.all([nodes, positions, dogsCol, assignments, zonesCol, eventsCol, settingsCol].map((c) => c.deleteMany({}))); },
    close: () => client.close(),
  };
  return api;
}
