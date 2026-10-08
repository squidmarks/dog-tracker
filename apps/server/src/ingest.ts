import mqtt from "mqtt";
import { config } from "./config.js";
import { decodeEnvelope, expandPsk, type MeshEvent } from "./decode.js";
import type { Db } from "./db.js";

export function startIngest(db: Db, onEvent: (ev: MeshEvent) => void) {
  const key = expandPsk(config.channelPsk);
  const client = mqtt.connect(config.mqttUrl, { username: config.mqttUser, password: config.mqttPass });

  client.on("connect", () => {
    console.log(`[mqtt] connected ${config.mqttUrl}, subscribing ${config.mqttTopic}`);
    client.subscribe(config.mqttTopic);
  });
  client.on("error", (e) => console.error("[mqtt]", e.message));
  client.on("message", (topic, payload) => {
    if (topic.includes("/json/") || topic.includes("/stat/")) return;
    for (const ev of decodeEnvelope(payload, key)) {
      if (db.apply(ev)) onEvent(ev);
    }
  });
  return client;
}
