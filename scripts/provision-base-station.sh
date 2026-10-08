#!/usr/bin/env bash
# Apply the secret parts of the base-station config to a Heltec connected over USB.
# Pulls the channel key + MQTT password from the tracker's .env on `home`; prompts for WiFi.
# Usage: scripts/provision-base-station.sh [/dev/cu.usbmodemXXXX] [broker-host]
# (Non-secret settings: see docs/base-station-setup.md. Close any browser tab holding the port first.)
set -euo pipefail
PORT="${1:-$(ls /dev/cu.usbmodem* | head -1)}"
BROKER="${2:-192.168.68.105}"   # `home` on the LAN; use a reachable address when travelling
MQ="$(command -v meshtastic || echo ~/.local/bin/meshtastic)"

ENV="$(ssh home 'cat ~/dog-tracker/deploy/.env')"
PSK="$(sed -n 's/^CHANNEL_PSK=//p' <<<"$ENV")"
MQTT_PASS="$(sed -n 's/^MQTT_PASS=//p' <<<"$ENV")"
[ -n "$PSK" ] && [ -n "$MQTT_PASS" ] || { echo "could not read secrets from home" >&2; exit 1; }

read -r -p "WiFi SSID (Enter to keep what the board has): " SSID
WIFI=()
if [ -n "$SSID" ]; then
  read -r -s -p "WiFi password: " WIFIPW; echo
  WIFI=(--set network.wifi_ssid "$SSID" --set network.wifi_psk "$WIFIPW" --set network.wifi_enabled true)
fi

"$MQ" --port "$PORT" ${WIFI[@]+"${WIFI[@]}"} \
  --set mqtt.address "$BROKER" --set mqtt.password "$MQTT_PASS" \
  --ch-index 0 --ch-set psk "base64:$PSK"
echo "Done. The board reboots; check with: $MQ --port $PORT --info"
