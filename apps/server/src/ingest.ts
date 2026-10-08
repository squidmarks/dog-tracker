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

export interface IngestHooks {
  /** Any uplink arrived through this gateway (the last topic segment, e.g. !49b7716c). */
  onGateway?: (gatewayId: string) => unknown;
  /** One line of the broker's own log (connect/disconnect), published on $SYS/broker/log/#. */
  onBrokerLog?: (line: string) => unknown;
}

export function startIngest(client: mqtt.MqttClient, db: Db, onEvent: (ev: MeshEvent) => void | Promise<void>, hooks: IngestHooks = {}) {
  const key = expandPsk(config.channelPsk);
  const enqueue = serial();

  client.on("connect", () => {
    console.log(`[mqtt] connected ${config.mqttUrl}, subscribing ${config.mqttTopic}`);
    client.subscribe([config.mqttTopic, "$SYS/broker/log/#"]);
  });
  client.on("error", (e) => console.error("[mqtt]", e.message));
  client.on("message", (topic, payload) => {
    if (topic.startsWith("$SYS/broker/log/")) { enqueue(async () => { await hooks.onBrokerLog?.(payload.toString()); }); return; }
    if (!topic.startsWith("msh/") || topic.includes("/json/") || topic.includes("/stat/")) return;
    const gateway = topic.slice(topic.lastIndexOf("/") + 1);
    if (gateway.startsWith("!")) enqueue(async () => { await hooks.onGateway?.(gateway); });
    for (const ev of decodeEnvelope(payload, key)) {
      enqueue(async () => { if (await db.apply(ev)) await onEvent(ev); });
    }
  });
  return client;
}
