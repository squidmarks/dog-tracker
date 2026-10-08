import type { MqttClient } from "mqtt";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { Yard } from "./geo.js";

const PREFIX = "dogtracker";
export const STATUS_TOPIC = `${PREFIX}/status`;

/** Home Assistant entities hang off the DOG (not the radio), so they survive a collar swap. */
const slug = (dogId: string) => `dog${dogId}`;

interface DogRow {
  id: string; name: string; emoji: string | null;
  battery: number | null; last_heard: number | null;
  lat: number | null; lon: number | null; pos_ts: number | null;
  speed: number | null; sats: number | null; gateway: string | null; rssi: number | null;
}

export function discoveryMessages(dog: Pick<DogRow, "id" | "name" | "emoji">, hasYard: boolean) {
  const s = slug(dog.id);
  const device = {
    identifiers: [`${PREFIX}_${s}`], name: dog.name, manufacturer: "Meshtastic", model: "GPS tracker",
  };
  const base = { device, availability_topic: STATUS_TOPIC };
  const t = (leaf: string) => `${PREFIX}/${s}/${leaf}`;
  const cfg = (component: string, key: string, body: object) => ({
    topic: `homeassistant/${component}/${PREFIX}_${s}/${key}/config`,
    payload: { ...base, unique_id: `${PREFIX}_${s}_${key}`, ...body },
  });
  return [
    cfg("device_tracker", "location", {
      name: null, source_type: "gps", state_topic: hasYard ? t("tracker_state") : undefined,
      json_attributes_topic: t("attributes"), payload_reset: "None", icon: "mdi:dog",
    }),
    ...(hasYard ? [cfg("binary_sensor", "in_yard", {
      name: "In yard", state_topic: t("in_yard"), icon: "mdi:fence",
    })] : []),
    cfg("binary_sensor", "reporting", {
      name: "Reporting", state_topic: t("reporting"), device_class: "connectivity", entity_category: "diagnostic",
    }),
    cfg("sensor", "battery", {
      name: "Battery", state_topic: t("battery"), device_class: "battery",
      unit_of_measurement: "%", state_class: "measurement",
    }),
    cfg("sensor", "last_seen", {
      name: "Last seen", state_topic: t("last_seen"), device_class: "timestamp",
    }),
    cfg("sensor", "signal", {
      name: "Signal", state_topic: t("rssi"), device_class: "signal_strength",
      unit_of_measurement: "dBm", entity_category: "diagnostic",
    }),
    cfg("sensor", "satellites", {
      name: "Satellites", state_topic: t("sats"), entity_category: "diagnostic", icon: "mdi:satellite-variant",
    }),
  ];
}

const STATE_LEAVES = ["attributes", "in_yard", "tracker_state", "battery", "last_seen", "rssi", "sats", "reporting"];

/** Publishes every dog that has reported a position to Home Assistant over MQTT Discovery. */
export function startHa(client: MqttClient, db: Db) {
  const yard = config.yard ? new Yard(config.yard.lat, config.yard.lon, config.yard.radiusM) : null;
  const known = new Set<string>();
  const pub = (topic: string, payload: string | object | null, retain = true) =>
    client.publish(topic, payload == null ? "None" : typeof payload === "string" ? payload : JSON.stringify(payload), { retain });
  const iso = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString() : null);

  const publishDiscovery = (d: DogRow) => {
    for (const m of discoveryMessages(d, !!yard)) pub(m.topic, m.payload);
  };

  const publishState = (d: DogRow, now = Date.now() / 1000) => {
    const s = slug(d.id), t = (leaf: string) => `${PREFIX}/${s}/${leaf}`;
    if (d.lat != null && d.lon != null) {
      pub(t("attributes"), {
        latitude: d.lat, longitude: d.lon, gps_accuracy: config.gpsAccuracyM,
        speed_ms: d.speed, last_position: iso(d.pos_ts), gateway: d.gateway,
      });
      if (yard) {
        const inside = yard.update(s, d.lat, d.lon);
        pub(t("in_yard"), inside ? "ON" : "OFF");
        pub(t("tracker_state"), inside ? "home" : "not_home");
      }
    }
    // 101 is Meshtastic's "powered/charging" marker; HA wants 0-100.
    if (d.battery != null) pub(t("battery"), String(Math.min(100, d.battery)));
    pub(t("last_seen"), iso(d.last_heard));
    if (d.rssi != null) pub(t("rssi"), String(Math.round(d.rssi)));
    if (d.sats != null) pub(t("sats"), String(d.sats));
    pub(t("reporting"), d.last_heard && now - d.last_heard <= config.staleMinutes * 60 ? "ON" : "OFF");
  };

  const tracked = async () => ((await db.dogs()) as unknown as DogRow[]).filter((d) => d.lat != null);

  const syncOne = async (id: string) => {
    const d = (await tracked()).find((x) => x.id === id);
    if (!d) return;
    if (!known.has(id)) { publishDiscovery(d); known.add(id); }
    publishState(d);
  };
  let syncing = false;
  const syncAll = async (rediscover = false) => {
    if (rediscover) known.clear();
    if (syncing) return; // a periodic sync may overlap a slow DB call; skip rather than pile up
    syncing = true;
    try {
      for (const d of await tracked()) {
        if (!known.has(d.id)) { publishDiscovery(d); known.add(d.id); }
        publishState(d);
      }
    } catch (e) { console.error("[ha]", e); }
    finally { syncing = false; }
  };
  /** Remove a dog's entities from Home Assistant (empty retained payloads). */
  const retract = (id: string) => {
    known.delete(id);
    for (const m of discoveryMessages({ id, name: "", emoji: null }, true)) client.publish(m.topic, "", { retain: true });
    for (const leaf of STATE_LEAVES) client.publish(`${PREFIX}/${slug(id)}/${leaf}`, "", { retain: true });
  };

  client.on("connect", () => {
    pub(STATUS_TOPIC, "online");
    client.subscribe("homeassistant/status");
    void syncAll(true);
  });
  client.on("message", (topic, payload) => {
    if (topic === "homeassistant/status" && payload.toString() === "online") void syncAll(true);
  });
  // The "reporting" sensor has to flip on its own when packets stop arriving.
  setInterval(() => void syncAll(), 30_000).unref();

  return {
    /** A packet arrived from this tracker. */
    onEvent: async (node: string) => { const id = await db.dogIdForNode(node); if (id != null) await syncOne(id); },
    /** A dog was created or edited (name/tracker changes republish its device). */
    onDogChanged: async (id: string) => { known.delete(id); await syncOne(id); },
    onDogDeleted: retract,
    syncAll,
  };
}
