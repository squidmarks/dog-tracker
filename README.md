# dog-tracker

Live GPS tracking for the dogs using Meshtastic: SenseCAP T1000-E collars → LoRa → Heltec WiFi LoRa 32 V4
base station → MQTT (Mosquitto on `home`) → `apps/server` (decode + SQLite + API/SSE) → `apps/web` (Next.js map).

No custom firmware: all three devices run stock Meshtastic. See [docs/base-station-setup.md](docs/base-station-setup.md).

## Dev
```
npm install
npm test                         # decoder tests
MQTT_URL=mqtt://home:1883 MQTT_USER=meshtastic MQTT_PASS=... CHANNEL_PSK=<base64> npm run dev
```
Server on :4000, web on :3000 (proxies `/api` to the server).

## Deploy (home, tailnet)
See `deploy/docker-compose.yml`.
