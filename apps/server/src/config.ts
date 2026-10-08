export const config = {
  mqttUrl: process.env.MQTT_URL ?? "mqtt://localhost:1883",
  mqttUser: process.env.MQTT_USER,
  mqttPass: process.env.MQTT_PASS,
  // Meshtastic default root topic is msh/<REGION>; the "#" picks up every channel + gateway.
  mqttTopic: process.env.MQTT_TOPIC ?? "msh/#",
  // Channel PSK as base64 (what `meshtastic --info` / the app shows). "AQ==" is the default key.
  channelPsk: process.env.CHANNEL_PSK ?? "AQ==",
  dbPath: process.env.DB_PATH ?? "./data/dog-tracker.db",
  port: Number(process.env.PORT ?? 4000),
};
