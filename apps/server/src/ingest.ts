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

export function startIngest(client: mqtt.MqttClient, db: Db, onEvent: (ev: MeshEvent) => void) {
  const key = expandPsk(config.channelPsk);
  const enqueue = serial();

  client.on("connect", () => {
    console.log(`[mqtt] connected ${config.mqttUrl}, subscribing ${config.mqttTopic}`);
    client.subscribe(config.mqttTopic);
  });
  client.on("error", (e) => console.error("[mqtt]", e.message));
  client.on("message", (topic, payload) => {
    if (!topic.startsWith("msh/") || topic.includes("/json/") || topic.includes("/stat/")) return;
    for (const ev of decodeEnvelope(payload, key)) {
      enqueue(async () => { if (await db.apply(ev)) onEvent(ev); });
    }
  });
  return client;
}
