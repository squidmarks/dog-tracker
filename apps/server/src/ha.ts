import type { MqttClient } from "mqtt";
import { config } from "./config.js";
import type { Db, DogEvent, Zone } from "./db.js";
import type { Hub } from "./hubs.js";
import type { Monitor } from "./rules.js";

const PREFIX = "dogtracker";
export const STATUS_TOPIC = `${PREFIX}/status`;
const EVENT_TYPES = ["zone_exit", "zone_enter", "silent", "reporting", "low_battery", "battery_ok"];

/** Home Assistant entities hang off the DOG (not the radio), so they survive a collar swap. */
const slug = (dogId: string) => `dog${dogId}`;

interface DogRow {
  id: string; name: string;
  battery: number | null; last_heard: number | null;
  lat: number | null; lon: number | null; pos_ts: number | null;
  speed: number | null; sats: number | null; gateway: string | null; rssi: number | null;
}

const topics = (dogId: string) => {
  const t = (leaf: string) => `${PREFIX}/${slug(dogId)}/${leaf}`;
  return { t, zone: (zoneId: string) => t(`zone/${zoneId}`) };
};

export function discoveryMessages(dog: Pick<DogRow, "id" | "name">, zones: Pick<Zone, "id" | "name">[], hasHomeZone: boolean) {
  const s = slug(dog.id);
  const { t, zone } = topics(dog.id);
  const device = { identifiers: [`${PREFIX}_${s}`], name: dog.name, manufacturer: "Meshtastic", model: "GPS tracker" };
  const base = { device, availability_topic: STATUS_TOPIC };
  const cfg = (component: string, key: string, body: object) => ({
    topic: `homeassistant/${component}/${PREFIX}_${s}/${key}/config`,
    payload: { ...base, unique_id: `${PREFIX}_${s}_${key}`, ...body },
  });
  return [
    cfg("device_tracker", "location", {
      name: null, source_type: "gps", state_topic: hasHomeZone ? t("tracker_state") : undefined,
      json_attributes_topic: t("attributes"), payload_reset: "None", icon: "mdi:dog",
    }),
    ...zones.map((z) => cfg("binary_sensor", `zone_${z.id}`, {
      name: `In ${z.name}`, state_topic: zone(z.id), icon: "mdi:map-marker-radius",
    })),
    cfg("event", "alerts", { name: "Alerts", state_topic: t("event"), event_types: EVENT_TYPES, icon: "mdi:bell-alert" }),
    cfg("binary_sensor", "reporting", {
      name: "Reporting", state_topic: t("reporting"), device_class: "connectivity", entity_category: "diagnostic",
    }),
    cfg("sensor", "battery", {
      name: "Battery", state_topic: t("battery"), device_class: "battery", unit_of_measurement: "%", state_class: "measurement",
    }),
    cfg("sensor", "last_seen", { name: "Last seen", state_topic: t("last_seen"), device_class: "timestamp" }),
    cfg("sensor", "signal", {
      name: "Signal", state_topic: t("rssi"), device_class: "signal_strength", unit_of_measurement: "dBm", entity_category: "diagnostic",
    }),
    cfg("sensor", "satellites", { name: "Satellites", state_topic: t("sats"), entity_category: "diagnostic", icon: "mdi:satellite-variant" }),
  ];
}

const STATE_LEAVES = ["attributes", "tracker_state", "battery", "last_seen", "rssi", "sats", "reporting"];

/** Publishes every dog that has reported a position to Home Assistant over MQTT Discovery. */
export function startHa(client: MqttClient, db: Db, monitor: Monitor, listHubs: () => Promise<Hub[]> = async () => []) {
  /** Which zone sensors each dog currently has in HA, so deleted/changed zones can be retracted. */
  const published = new Map<string, Map<string, string>>(); // dogId -> (zoneId -> zone name)
  const pub = (topic: string, payload: string | object | null, retain = true) =>
    client.publish(topic, payload == null ? "None" : typeof payload === "string" ? payload : JSON.stringify(payload), { retain });
  const iso = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString() : null);

  const publishDiscovery = (d: DogRow) => {
    const zones = monitor.zonesFor(d.id);
    const hasHome = zones.some((z) => z.home);
    for (const m of discoveryMessages(d, zones, hasHome)) pub(m.topic, m.payload);
    // Retract sensors for zones that no longer apply to this dog (deleted, renamed or re-scoped).
    const was = published.get(d.id) ?? new Map<string, string>();
    const now = new Map(zones.map((z) => [z.id, z.name]));
    for (const zoneId of was.keys()) {
      if (now.has(zoneId)) continue;
      client.publish(`homeassistant/binary_sensor/${PREFIX}_${slug(d.id)}/zone_${zoneId}/config`, "", { retain: true });
      client.publish(topics(d.id).zone(zoneId), "", { retain: true });
    }
    published.set(d.id, now);
  };

  const publishState = (d: DogRow, now = Date.now() / 1000) => {
    const { t, zone } = topics(d.id);
    if (d.lat != null && d.lon != null) {
      pub(t("attributes"), {
        latitude: d.lat, longitude: d.lon, gps_accuracy: config.gpsAccuracyM,
        speed_ms: d.speed, last_position: iso(d.pos_ts), gateway: d.gateway,
      });
    }
    const zones = monitor.zonesFor(d.id);
    let anyHomeKnown = false, inHome = false;
    for (const z of zones) {
      const inside = monitor.isInside(d.id, z.id);
      if (inside === undefined) continue;
      pub(zone(z.id), inside ? "ON" : "OFF");
      if (z.home) { anyHomeKnown = true; inHome ||= inside; }
    }
    if (anyHomeKnown) pub(t("tracker_state"), inHome ? "home" : "not_home");
    // 101 is Meshtastic's "powered/charging" marker; HA wants 0-100.
    if (d.battery != null) pub(t("battery"), String(Math.min(100, d.battery)));
    pub(t("last_seen"), iso(d.last_heard));
    if (d.rssi != null) pub(t("rssi"), String(Math.round(d.rssi)));
    if (d.sats != null) pub(t("sats"), String(d.sats));
    pub(t("reporting"), d.last_heard && now - d.last_heard <= staleS() ? "ON" : "OFF");
  };

  let staleMinutes = 20;
  const staleS = () => staleMinutes * 60;
  const tracked = async () => ((await db.dogs()) as unknown as DogRow[]).filter((d) => d.lat != null);
  const known = new Set<string>();

  const syncOne = async (id: string) => {
    const d = (await tracked()).find((x) => x.id === id);
    if (!d) return;
    if (!known.has(id)) { publishDiscovery(d); known.add(id); }
    publishState(d);
  };
  /** One connectivity sensor per LoRa hub, so Home Assistant can alert (or dashboard) on a dead hub too. */
  const publishHubs = async () => {
    for (const h of await listHubs()) {
      const s = h.id.replace(/^!/, "");
      pub(`homeassistant/binary_sensor/${PREFIX}_hub_${s}/online/config`, {
        availability_topic: STATUS_TOPIC, unique_id: `${PREFIX}_hub_${s}_online`, name: "Online", device_class: "connectivity",
        state_topic: `${PREFIX}/hub/${s}/online`,
        device: { identifiers: [`${PREFIX}_hub_${s}`], name: `LoRa hub ${h.name}`, manufacturer: "Meshtastic", model: "LoRa gateway" },
      });
      pub(`${PREFIX}/hub/${s}/online`, h.status === "online" ? "ON" : "OFF");
    }
  };

  let syncing = false;
  const syncAll = async (rediscover = false) => {
    if (rediscover) known.clear();
    if (syncing) return; // a periodic sync may overlap a slow DB call; skip rather than pile up
    syncing = true;
    try {
      staleMinutes = (await db.settings()).staleMinutes;
      for (const d of await tracked()) {
        if (!known.has(d.id)) { publishDiscovery(d); known.add(d.id); }
        publishState(d);
      }
      await publishHubs();
    } catch (e) { console.error("[ha]", e); }
    finally { syncing = false; }
  };
  /** Remove a dog's entities from Home Assistant (empty retained payloads). */
  const retract = (id: string) => {
    known.delete(id);
    for (const m of discoveryMessages({ id, name: "" }, [...(published.get(id) ?? new Map()).keys()].map((zid) => ({ id: zid, name: "" })), true)) {
      client.publish(m.topic, "", { retain: true });
    }
    const { t, zone } = topics(id);
    for (const leaf of STATE_LEAVES) client.publish(t(leaf), "", { retain: true });
    for (const zid of published.get(id)?.keys() ?? []) client.publish(zone(zid), "", { retain: true });
    published.delete(id);
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
    /** Zones or settings changed: republish every dog's sensors (and retract stale ones). */
    onZonesChanged: () => syncAll(true),
    /** An alert/info event: fires the dog's HA "Alerts" event entity (automations trigger on it). */
    publishEvent: (e: DogEvent) => {
      if (!e.dogId) return; // hub events have no dog; Home Assistant gets the hub's own sensor instead
      pub(topics(e.dogId).t("event"), { event_type: e.type, message: e.message, zone: e.zoneName ?? null, alert: e.alert, lat: e.lat ?? null, lon: e.lon ?? null }, false);
    },
    syncAll,
    publishHubs: () => publishHubs().catch((e) => console.error("[ha]", e)),
  };
}
