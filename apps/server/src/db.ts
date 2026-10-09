import { type Collection, MongoClient, MongoServerError, ObjectId } from "mongodb";
import type { MeshEvent } from "./decode.js";

/** A stored fix as served to the UI and the stats engine. */
export interface TrackPoint {
  ts: number; lat: number; lon: number; speed: number | null; heading: number | null; hdop: number | null; sats: number | null;
  /** Signal at the receiving hub: SNR in dB (the better quality measure for LoRa) and RSSI in dBm. */
  snr: number | null; rssi: number | null;
}

export type Db = Awaited<ReturnType<typeof openDb>>;

export interface DogInput {
  name?: string; color?: string | null; emoji?: string | null; breed?: string | null; notes?: string | null;
  tracker?: string | null;
  /** Send alerts (push + toast) for this dog. Default true; false keeps events in the timeline but quiet. */
  alerts?: boolean;
}

/** A dog with its tracker's live state (see dogs()). */
export interface DogLive { id: string; name: string; tracker: string | null; [k: string]: unknown }

interface NodeDoc {
  _id: string; long_name?: string | null; short_name?: string | null;
  battery?: number | null; voltage?: number | null; temperature?: number | null; lux?: number | null; last_heard?: number;
}
/** One telemetry reading, kept for charts (battery life) and trends. */
export interface TelemetryPoint { ts: number; battery: number | null; voltage: number | null; temperature: number | null; lux: number | null }
interface PositionDoc {
  node: string; packet_id: number; ts: number; lat: number; lon: number;
  alt: number | null; speed: number | null; sats: number | null; gateway: string | null; rssi: number | null; snr: number | null;
  heading?: number | null; hdop?: number | null;
}
interface DogDoc { _id: ObjectId; name: string; color: string | null; emoji: string | null; breed: string | null; notes: string | null; alerts?: boolean; created_at: number }
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

export type EventType = "zone_exit" | "zone_enter" | "silent" | "reporting" | "low_battery" | "battery_ok" | "hub_offline" | "hub_online";
export interface DogEvent {
  id: string; ts: number; type: EventType;
  /** Empty for hub events; `dogName` then carries the hub's name. */
  dogId: string; dogName: string; hubId?: string;
  zoneId?: string; zoneName?: string; lat?: number | null; lon?: number | null;
  /** Worth interrupting the user for (drives push notifications and the highlighted timeline style). */
  alert: boolean; message: string;
  /** Raised by a simulated tracker: shown in the UI, but never pushed to the phone. */
  sim?: boolean;
}

export interface Settings {
  staleMinutes: number; lowBatteryPct: number; fenceMarginM: number;
  /** Fallback only: a hub that is silent this long without a broker disconnect is treated as offline. */
  hubSilentMinutes: number;
  /** Deliver alerts through Pushover (needs PUSHOVER_TOKEN/USER on the server). Web Push is per device. */
  pushoverEnabled: boolean;
}
export const DEFAULT_SETTINGS: Settings = { staleMinutes: 20, lowBatteryPct: 20, fenceMarginM: 5, hubSilentMinutes: 45, pushoverEnabled: true };
const NUMERIC_SETTINGS = ["staleMinutes", "lowBatteryPct", "fenceMarginM", "hubSilentMinutes"] as const;

export type HubStatus = "online" | "offline";
export interface HubDoc {
  id: string; status: HubStatus; since: number; lastPacket: number | null;
  /** Where the hub stands (it has no GPS, so you place it on the map); needed to measure range. */
  lat?: number | null; lon?: number | null;
}
export interface PushSubscriptionDoc {
  endpoint: string; keys: { p256dh: string; auth: string }; label: string; createdAt: number; lastOk?: number;
}

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
  const hubsCol: Collection<{ _id: string; status: HubStatus; since: number; lastPacket: number | null; lat?: number | null; lon?: number | null }> = db.collection("hubs");
  const pushCol: Collection<PushSubscriptionDoc> = db.collection("push_subscriptions");
  const telemetryCol: Collection<TelemetryPoint & { node: string }> = db.collection("telemetry");

  await positions.createIndex({ node: 1, packet_id: 1 }, { unique: true }); // several base stations can uplink the same packet
  await positions.createIndex({ node: 1, ts: -1 });
  await assignments.createIndex({ node: 1 }, { unique: true, partialFilterExpression: { open: true } });
  await assignments.createIndex({ dogId: 1 }, { unique: true, partialFilterExpression: { open: true } });
  await assignments.createIndex({ dogId: 1, since: 1 });
  await eventsCol.createIndex({ ts: -1 });
  await pushCol.createIndex({ endpoint: 1 }, { unique: true });
  await telemetryCol.createIndex({ node: 1, ts: -1 });

  const latestPosition = (node: string) => positions.find({ node }).sort({ ts: -1 }).limit(1).next();

  const liveFields = (n: NodeDoc | null, p: PositionDoc | null) => ({
    battery: n?.battery ?? null, voltage: n?.voltage ?? null, temperature: n?.temperature ?? null, lux: n?.lux ?? null,
    last_heard: n?.last_heard ?? null, heading: p?.heading ?? null, hdop: p?.hdop ?? null,
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
              sats: ev.sats, gateway: ev.gateway, rssi: ev.rssi, snr: ev.snr, heading: ev.heading ?? null, hdop: ev.hdop ?? null,
            });
            return true;
          } catch (e) {
            if (e instanceof MongoServerError && e.code === DUPLICATE_KEY) return false;
            throw e;
          }
        case "nodeinfo":
          await nodes.updateOne({ _id: ev.node }, { $set: { long_name: ev.longName, short_name: ev.shortName } });
          return true;
        case "telemetry": {
          // 101 = "powered/charging" in Meshtastic; keep it, the UI interprets it. Environment packets carry no
          // battery, so only the fields actually present are written (they mustn't blank each other out).
          const set: Partial<NodeDoc> = {};
          if (ev.battery != null) set.battery = ev.battery;
          if (ev.voltage != null) set.voltage = ev.voltage;
          if (ev.temperature != null) set.temperature = ev.temperature;
          if (ev.lux != null) set.lux = ev.lux;
          if (Object.keys(set).length) {
            await nodes.updateOne({ _id: ev.node }, { $set: set });
            await telemetryCol.insertOne({ node: ev.node, ts: at, battery: ev.battery ?? null, voltage: ev.voltage ?? null, temperature: ev.temperature ?? null, lux: ev.lux ?? null });
          }
          return true;
        }
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
          alerts: d.alerts !== false, created_at: d.created_at, tracker: node, ...liveFields(n, p) };
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
        breed: input.breed ?? null, notes: input.notes ?? null, alerts: input.alerts !== false, created_at: at,
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
      if ("alerts" in input) set.alerts = input.alerts !== false;
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
    async dogTrack(id: string, sinceTs: number, untilTs = Infinity) {
      const _id = oid(id);
      if (!_id) return [];
      const out: TrackPoint[] = [];
      for (const a of await assignments.find({ dogId: _id }).sort({ since: 1 }).toArray()) {
        const ts: Record<string, number> = { $gte: Math.max(a.since, sinceTs) };
        const hi = Math.min(a.until ?? Infinity, untilTs);
        if (Number.isFinite(hi)) ts.$lte = hi;
        for (const p of await positions.find({ node: a.node, ts }).sort({ ts: 1 }).toArray()) {
          out.push({ ts: p.ts, lat: p.lat, lon: p.lon, speed: p.speed, heading: p.heading ?? null, hdop: p.hdop ?? null, sats: p.sats ?? null, snr: p.snr ?? null, rssi: p.rssi ?? null });
        }
      }
      return out;
    },

    /** The dog's telemetry over a window (battery, voltage, collar temperature), across whichever collars it wore. */
    async dogTelemetry(id: string, sinceTs: number, untilTs = Infinity): Promise<TelemetryPoint[]> {
      const _id = oid(id);
      if (!_id) return [];
      const out: TelemetryPoint[] = [];
      for (const a of await assignments.find({ dogId: _id }).sort({ since: 1 }).toArray()) {
        const ts: Record<string, number> = { $gte: Math.max(a.since, sinceTs) };
        const hi = Math.min(a.until ?? Infinity, untilTs);
        if (Number.isFinite(hi)) ts.$lte = hi;
        for (const t of await telemetryCol.find({ node: a.node, ts }).sort({ ts: 1 }).toArray()) {
          out.push({ ts: t.ts, battery: t.battery, voltage: t.voltage, temperature: t.temperature, lux: t.lux });
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
      const doc: Partial<Settings> = (await settingsCol.findOne({ _id: "alerts" })) ?? {};
      const stored: Partial<Settings> = {};
      for (const k of NUMERIC_SETTINGS) if (typeof doc[k] === "number") stored[k] = doc[k];
      if (typeof doc.pushoverEnabled === "boolean") stored.pushoverEnabled = doc.pushoverEnabled;
      return { ...DEFAULT_SETTINGS, ...stored };
    },
    async updateSettings(input: Partial<Settings>): Promise<Settings> {
      const set: Partial<Settings> = {};
      for (const k of NUMERIC_SETTINGS) {
        if (!(k in input)) continue;
        const v = Number(input[k]);
        if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
        set[k] = v;
      }
      if ("pushoverEnabled" in input) set.pushoverEnabled = input.pushoverEnabled !== false;
      if (Object.keys(set).length) await settingsCol.updateOne({ _id: "alerts" }, { $set: set }, { upsert: true });
      return api.settings();
    },

    // --- hubs (LoRa gateways) --------------------------------------------
    async hubs(): Promise<HubDoc[]> {
      return (await hubsCol.find().toArray()).map(({ _id, ...h }) => ({ id: _id, ...h }));
    },
    async saveHub(h: HubDoc): Promise<void> {
      const { id, lat: _lat, lon: _lon, ...rest } = h;   // location is set separately, so a status save never clobbers it
      await hubsCol.updateOne({ _id: id }, { $set: rest }, { upsert: true });
    },
    async setHubLocation(id: string, lat: number | null, lon: number | null): Promise<boolean> {
      if (lat != null && lon != null && !(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new Error("Location out of range");
      const result = lat == null || lon == null
        ? await hubsCol.updateOne({ _id: id }, { $unset: { lat: "" as const, lon: "" as const } })
        : await hubsCol.updateOne({ _id: id }, { $set: { lat, lon } });
      return result.matchedCount > 0;
    },
    /** True when this node has ever reported a GPS position: it's a tracker (a collar), not a fixed hub. */
    async hasPositions(node: string): Promise<boolean> {
      return !!(await positions.findOne({ node }, { projection: { _id: 1 } }));
    },
    /** Best display name for a node: its Meshtastic long name, else its id. */
    async nodeName(id: string): Promise<string> {
      return (await nodes.findOne({ _id: id }))?.long_name || id;
    },

    // --- web push subscriptions (one per device) -------------------------
    async pushSubscriptions(): Promise<PushSubscriptionDoc[]> {
      return (await pushCol.find().sort({ createdAt: 1 }).toArray()).map(({ _id, ...p }: any) => p);
    },
    async savePushSubscription(sub: Omit<PushSubscriptionDoc, "createdAt">, at = now()): Promise<void> {
      if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("Invalid push subscription");
      await pushCol.updateOne({ endpoint: sub.endpoint }, { $set: { keys: sub.keys, label: sub.label }, $setOnInsert: { createdAt: at } }, { upsert: true });
    },
    async removePushSubscription(endpoint: string): Promise<boolean> {
      return (await pushCol.deleteOne({ endpoint })).deletedCount > 0;
    },
    async touchPushSubscription(endpoint: string, at = now()): Promise<void> {
      await pushCol.updateOne({ endpoint }, { $set: { lastOk: at } });
    },

    /** Remove simulated trackers, their positions and any dogs that carried them. Returns the removed dog ids so callers can retract them elsewhere (Home Assistant). */
    async deleteSimNodes(): Promise<{ nodes: number; dogIds: string[] }> {
      const ids = (await nodes.find({}, { projection: { _id: 1 } }).toArray()).map((n) => n._id).filter((i) => SIM_NODE.test(i));
      if (!ids.length) return { nodes: 0, dogIds: [] };
      const dogIds = [...new Set((await assignments.find({ node: { $in: ids } }).toArray()).map((a) => a.dogId))];
      await dogsCol.deleteMany({ _id: { $in: dogIds } });
      await assignments.deleteMany({ node: { $in: ids } });
      await positions.deleteMany({ node: { $in: ids } });
      const removed = (await nodes.deleteMany({ _id: { $in: ids } })).deletedCount;
      return { nodes: removed, dogIds: dogIds.map(String) };
    },

    /** Test helper: empty every collection (the app user can't drop databases, by design). */
    wipe: async () => { await Promise.all([nodes, positions, dogsCol, assignments, zonesCol, eventsCol, settingsCol, hubsCol, pushCol, telemetryCol].map((c: Collection<any>) => c.deleteMany({}))); },
    close: () => client.close(),
  };
  return api;
}
