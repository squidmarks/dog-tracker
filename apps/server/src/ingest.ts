import mqtt from "mqtt";
import { config } from "./config.js";
import { decodeEnvelope, expandPsk, type MeshEvent } from "./decode.js";
import { serial } from "./queue.js";
import { STATUS_TOPIC } from "./ha.js";
import type { Db } from "./db.js";

export function createClient() {
  return mqtt.connect(config.mqttUrl, {
    username: config.mqttUser, password: config.mqttPass,
    will: { topic: STATUS_TOPIC, payload: Buffer.from("offline"), retain: true, qos: 0 },
  });
}

/** Run `fn` on every (re)connect, and right now if the client is already connected. The "connect" event can fire before
 *  a late listener is attached (startup does database work first), and a missed one means never subscribing. */
export function onConnect(client: Pick<mqtt.MqttClient, "on" | "connected">, fn: () => void) {
  client.on("connect", fn);
  if (client.connected) fn();
}

/** What the radio feed is doing, for /api/health: so a silent failure to subscribe shows up instead of hiding. */
export const ingestHealth = { connected: false, subscribedAt: null as number | null, lastMessageAt: null as number | null, lastPacketAt: null as number | null };

export interface IngestHooks {
  /** Any uplink arrived through this gateway (the last topic segment, e.g. !49b7716c). */
  onGateway?: (gatewayId: string) => unknown;
  /** One line of the broker's own log (connect/disconnect), published on $SYS/broker/log/#. */
  onBrokerLog?: (line: string) => unknown;
}

export function startIngest(client: mqtt.MqttClient, db: Db, onEvent: (ev: MeshEvent) => void | Promise<void>, hooks: IngestHooks = {}) {
  const key = expandPsk(config.channelPsk);
  const enqueue = serial();

  onConnect(client, () => {
    console.log(`[mqtt] connected ${config.mqttUrl}, subscribing ${config.mqttTopic}`);
    ingestHealth.connected = true;
    client.subscribe([config.mqttTopic, "$SYS/broker/log/#"], (err) => {
      if (err) console.error("[mqtt] subscribe failed:", err.message);
      else ingestHealth.subscribedAt = Math.floor(Date.now() / 1000);
    });
  });
  client.on("close", () => { ingestHealth.connected = false; });
  client.on("error", (e) => console.error("[mqtt]", e.message));
  client.on("message", (topic, payload) => {
    ingestHealth.lastMessageAt = Math.floor(Date.now() / 1000);
    if (topic.startsWith("$SYS/broker/log/")) { enqueue(async () => { await hooks.onBrokerLog?.(payload.toString()); }); return; }
    if (!topic.startsWith("msh/") || topic.includes("/json/") || topic.includes("/stat/")) return;
    ingestHealth.lastPacketAt = Math.floor(Date.now() / 1000);
    const gateway = topic.slice(topic.lastIndexOf("/") + 1);
    if (gateway.startsWith("!")) enqueue(async () => { await hooks.onGateway?.(gateway); });
    for (const ev of decodeEnvelope(payload, key)) {
      enqueue(async () => { if (await db.apply(ev)) await onEvent(ev); });
    }
  });
  return client;
}
