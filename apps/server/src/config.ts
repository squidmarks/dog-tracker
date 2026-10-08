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
  // Yard geofence (circle). Leave unset to skip the in-yard sensors.
  yard: process.env.YARD_LAT && process.env.YARD_LON
    ? { lat: Number(process.env.YARD_LAT), lon: Number(process.env.YARD_LON), radiusM: Number(process.env.YARD_RADIUS_M ?? 40) }
    : null,
  staleMinutes: Number(process.env.STALE_MINUTES ?? 20),
  gpsAccuracyM: Number(process.env.GPS_ACCURACY_M ?? 15),
};
