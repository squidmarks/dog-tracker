export const config = {
  mqttUrl: process.env.MQTT_URL ?? "mqtt://localhost:1883",
  mqttUser: process.env.MQTT_USER,
  mqttPass: process.env.MQTT_PASS,
  // Meshtastic default root topic is msh/<REGION>; the "#" picks up every channel + gateway.
  mqttTopic: process.env.MQTT_TOPIC ?? "msh/#",
  // Channel PSK as base64 (what `meshtastic --info` / the app shows). "AQ==" is the default key.
  channelPsk: process.env.CHANNEL_PSK ?? "AQ==",
  // Mongo: user needs readWrite on the database. authSource=admin when the user lives in admin.
  mongoUrl: process.env.MONGO_URL ?? "mongodb://127.0.0.1:27018",
  mongoDb: process.env.MONGO_DB ?? "dogtracker",
  port: Number(process.env.PORT ?? 4000),
  // Yard geofence (circle). Leave unset to skip the in-yard sensors.
  yard: process.env.YARD_LAT && process.env.YARD_LON
    ? { lat: Number(process.env.YARD_LAT), lon: Number(process.env.YARD_LON), radiusM: Number(process.env.YARD_RADIUS_M ?? 40) }
    : null,
  // Simulated dogs (dev/demo): SIM_DOGS=2 starts two. They use node ids !fa000001+.
  simDogs: Number(process.env.SIM_DOGS ?? 0),
  simTickS: Number(process.env.SIM_TICK_S ?? 5),
  staleMinutes: Number(process.env.STALE_MINUTES ?? 20),
  gpsAccuracyM: Number(process.env.GPS_ACCURACY_M ?? 15),
};
