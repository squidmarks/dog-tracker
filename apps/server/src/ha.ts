import type { MqttClient } from "mqtt";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { Yard } from "./geo.js";

const PREFIX = "dogtracker";
export const STATUS_TOPIC = `${PREFIX}/status`;
const slug = (id: string) => id.replace(/^!/, "");

interface NodeRow {
  id: string; name: string | null; long_name: string | null;
  battery: number | null; last_heard: number | null;
  lat: number | null; lon: number | null; pos_ts: number | null;
  speed: number | null; sats: number | null; gateway: string | null; rssi: number | null;
}

export function discoveryMessages(n: Pick<NodeRow, "id" | "name" | "long_name">, hasYard: boolean) {
  const s = slug(n.id);
  const device = {
    identifiers: [`${PREFIX}_${s}`], name: n.name ?? n.long_name ?? `Dog ${s}`,
    manufacturer: "Meshtastic", model: "GPS tracker",
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

/** Publishes every tracked node (one with a position) to Home Assistant over MQTT Discovery. */
export function startHa(client: MqttClient, db: Db) {
  const yard = config.yard ? new Yard(config.yard.lat, config.yard.lon, config.yard.radiusM) : null;
  const known = new Set<string>();
  const pub = (topic: string, payload: string | object | null, retain = true) =>
    client.publish(topic, payload == null ? "None" : typeof payload === "string" ? payload : JSON.stringify(payload), { retain });
  const iso = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString() : null);

  const publishDiscovery = (n: NodeRow) => {
    for (const m of discoveryMessages(n, !!yard)) pub(m.topic, m.payload);
  };

  const publishState = (n: NodeRow, now = Date.now() / 1000) => {
    const s = slug(n.id), t = (leaf: string) => `${PREFIX}/${s}/${leaf}`;
    if (n.lat != null && n.lon != null) {
      pub(t("attributes"), {
        latitude: n.lat, longitude: n.lon, gps_accuracy: config.gpsAccuracyM,
        speed_ms: n.speed, last_position: iso(n.pos_ts), gateway: n.gateway,
      });
      if (yard) {
        const inside = yard.update(n.id, n.lat, n.lon);
        pub(t("in_yard"), inside ? "ON" : "OFF");
        pub(t("tracker_state"), inside ? "home" : "not_home");
      }
    }
    // 101 is Meshtastic's "powered/charging" marker; HA wants 0-100.
    if (n.battery != null) pub(t("battery"), String(Math.min(100, n.battery)));
    pub(t("last_seen"), iso(n.last_heard));
    if (n.rssi != null) pub(t("rssi"), String(n.rssi));
    if (n.sats != null) pub(t("sats"), String(n.sats));
    pub(t("reporting"), n.last_heard && now - n.last_heard <= config.staleMinutes * 60 ? "ON" : "OFF");
  };

  const tracked = () => (db.nodes() as NodeRow[]).filter((n) => n.lat != null); // skips base stations (no GPS)

  const syncOne = (id: string) => {
    const n = tracked().find((x) => x.id === id);
    if (!n) return;
    if (!known.has(id)) { publishDiscovery(n); known.add(id); }
    publishState(n);
  };
  const syncAll = (rediscover = false) => {
    if (rediscover) known.clear();
    for (const n of tracked()) {
      if (!known.has(n.id)) { publishDiscovery(n); known.add(n.id); }
      publishState(n);
    }
  };

  client.on("connect", () => {
    pub(STATUS_TOPIC, "online");
    client.subscribe("homeassistant/status");
    syncAll(true);
  });
  client.on("message", (topic, payload) => {
    if (topic === "homeassistant/status" && payload.toString() === "online") syncAll(true);
  });
  // The "reporting" sensor has to flip on its own when packets stop arriving.
  setInterval(() => syncAll(), 30_000).unref();

  return { onEvent: (id: string) => syncOne(id), syncAll, rename: (id: string) => { known.delete(id); syncOne(id); } };
}
