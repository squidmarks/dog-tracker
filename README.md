# dog-tracker

Live GPS tracking for the dogs using Meshtastic: SenseCAP T1000-E collars → LoRa → Heltec WiFi LoRa 32 V4
base station → MQTT (Mosquitto on `home`) → `apps/server` (decode + Mongo + API/SSE) → `apps/web` (Next.js map).

No custom firmware: all three devices run stock Meshtastic. See [docs/base-station-setup.md](docs/base-station-setup.md).

## Data
Mongo (the shared instance on `home`, database `dogtracker`): `nodes` (trackers/radios, discovered), `positions`,
`dogs`, and `dog_trackers` (which dog carried which tracker when). Trackers appear in the web app's **New trackers**
inbox; creating a dog claims one. Simulated trackers (`!fa......`, `SIM_DOGS=2`) are for dev/demo.

## Dev
Needs a tunnel to Mongo on `home` and a gitignored `.env.local`:
```
scripts/dev-env.sh          # writes .env.local (Mongo creds fetched from home; dev data goes to dogtracker_dev)
scripts/mongo-tunnel.sh     # localhost:27018 -> Mongo on home
SIM_DOGS=2 MQTT_URL=mqtt://127.0.0.1:1 npm run dev   # simulated dogs, no broker needed
```
```
npm install
npm test                         # decoder/geo/sim tests; db + api tests need the tunnel and skip without it
```
Server on :4000, web on :3000 (proxies `/api` to the server).

## Deploy (home, tailnet)
See `deploy/docker-compose.yml`.
