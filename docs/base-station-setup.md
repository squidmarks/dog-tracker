# Base station + collar setup (stock Meshtastic, no custom firmware)

## 1. Flash
- Heltec WiFi LoRa 32 V4: flash stable Meshtastic from https://flasher.meshtastic.org (select "Heltec V4").
- SenseCAP T1000-E: ships with Meshtastic; update via the Meshtastic app / drag-drop UF2 if needed.

## 2. One private channel for the dog gear (all three devices)
Make a **private** channel as the primary channel (not LongFast/default) so strangers' nodes
are ignored and your positions are encrypted. Set the **same name + PSK** on all three devices
(set it on one in the app, then share the QR code). Put the PSK in `CHANNEL_PSK` for the server.
Region: **US** (915 MHz).

## 3. Collars (T1000-E)
- Role: `TRACKER` (or `CLIENT_MUTE`); never router.
- Position: smart position off; broadcast interval ~60-120 s (battery vs. freshness); GPS mode enabled.
- Name each device after the dog (`Maple`, ...) — long/short name show up in the UI too.
- Device telemetry on (battery); interval 15-30 min is plenty.

## 4. Base station (Heltec V4)
- Role: `CLIENT` (or `ROUTER_LATE` if you add more fixed nodes). Mount it high, antenna vertical.
- Network: enter WiFi SSID/password (2.4 GHz). Mobile/travel: any WiFi that can reach the broker.
- MQTT module: enabled, address `<broker host>`, username/password from the broker,
  root topic default (`msh/US`), **Encryption enabled: yes**, JSON: no, TLS: per broker,
  **Map reporting: off**.
- On the *channel* you use: **Uplink enabled = on**. (Downlink off.)

## 5. Verify
`mosquitto_sub -h home -u meshtastic -P ... -t 'msh/#' -v` should show packets under
`msh/US/2/e/<ChannelName>/!<gatewayid>` as soon as a collar sends a position.
