import { createDecipheriv } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { Mesh, Mqtt, Portnums, Telemetry } from "@meshtastic/protobufs";

const DEFAULT_KEY = Buffer.from("d4f1bb3a20290759f0bcffabcf4e6901", "hex");

/** Expand a Meshtastic channel PSK (base64) into an AES key. 1-byte PSKs index the well-known default key. */
export function expandPsk(pskBase64: string): Buffer {
  const raw = Buffer.from(pskBase64, "base64");
  if (raw.length === 1) {
    const key = Buffer.from(DEFAULT_KEY);
    key[15] = (key[15] + raw[0] - 1) & 0xff;
    return key;
  }
  if (raw.length === 16 || raw.length === 32) return raw;
  throw new Error(`Unsupported PSK length ${raw.length} (expected 1, 16 or 32 bytes)`);
}

export function decryptPacket(key: Buffer, packetId: number, fromNode: number, data: Uint8Array): Buffer {
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(packetId >>> 0, 0); // low 32 bits of the 64-bit packet id
  nonce.writeUInt32LE(fromNode >>> 0, 8);
  const decipher = createDecipheriv(key.length === 32 ? "aes-256-ctr" : "aes-128-ctr", key, nonce);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export type MeshEvent =
  | { kind: "position"; node: string; packetId: number; gateway: string; rssi: number | null; snr: number | null;
      ts: number; lat: number; lon: number; alt: number | null; speed: number | null; sats: number | null;
      /** Direction of travel in degrees from true north (0-360), when the collar sent one. */
      heading?: number | null;
      /** Dilution of precision (lower is better; ~1 is excellent, >5 is poor), when the collar sent one. */
      hdop?: number | null }
  | { kind: "nodeinfo"; node: string; longName: string; shortName: string }
  /** Device metrics carry battery/voltage; environment metrics carry the on-board temperature/light sensors. */
  | { kind: "telemetry"; node: string; battery: number | null; voltage: number | null;
      temperature?: number | null; lux?: number | null };

/** Meshtastic's ground_track is 1e-5 degrees in current firmware (1/100 degree in older docs): tell them apart by size. */
export function headingDegrees(groundTrack: number | undefined, groundSpeed: number | undefined): number | null {
  if (!groundTrack || !groundSpeed) return null; // a heading means nothing when the dog isn't moving
  const deg = groundTrack > 36_000 ? groundTrack / 1e5 : groundTrack / 100;
  return ((deg % 360) + 360) % 360;
}

export const nodeId = (n: number) => "!" + (n >>> 0).toString(16).padStart(8, "0");

/** Decode one MQTT payload (a ServiceEnvelope) into zero or more events. Returns [] for anything we don't track. */
export function decodeEnvelope(payload: Uint8Array, key: Buffer): MeshEvent[] {
  let env;
  try {
    env = fromBinary(Mqtt.ServiceEnvelopeSchema, payload);
  } catch {
    return []; // not protobuf (e.g. /json/ or /stat/ topics)
  }
  const pkt = env.packet;
  if (!pkt) return [];

  let data: Mesh.Data | undefined;
  if (pkt.payloadVariant.case === "decoded") {
    data = pkt.payloadVariant.value;
  } else if (pkt.payloadVariant.case === "encrypted") {
    try {
      data = fromBinary(Mesh.DataSchema, decryptPacket(key, pkt.id, pkt.from, pkt.payloadVariant.value));
    } catch {
      return []; // wrong key / other channel
    }
  }
  if (!data) return [];

  const node = nodeId(pkt.from);
  const gateway = env.gatewayId;
  const rssi = pkt.rxRssi || null;
  const snr = pkt.rxSnr || null;

  try {
    switch (data.portnum) {
      case Portnums.PortNum.POSITION_APP: {
        const p = fromBinary(Mesh.PositionSchema, data.payload);
        if (p.latitudeI == null || p.longitudeI == null || (p.latitudeI === 0 && p.longitudeI === 0)) return [];
        const ts = p.time || pkt.rxTime || Math.floor(Date.now() / 1000);
        return [{
          kind: "position", node, packetId: pkt.id, gateway, rssi, snr, ts,
          lat: p.latitudeI / 1e7, lon: p.longitudeI / 1e7,
          alt: p.altitude ?? null, speed: p.groundSpeed ?? null, sats: p.satsInView || null,
          heading: headingDegrees(p.groundTrack, p.groundSpeed),
          hdop: p.HDOP ? p.HDOP / 100 : p.PDOP ? p.PDOP / 100 : null,
        }];
      }
      case Portnums.PortNum.NODEINFO_APP: {
        const u = fromBinary(Mesh.UserSchema, data.payload);
        return [{ kind: "nodeinfo", node, longName: u.longName, shortName: u.shortName }];
      }
      case Portnums.PortNum.TELEMETRY_APP: {
        const t = fromBinary(Telemetry.TelemetrySchema, data.payload);
        if (t.variant.case === "deviceMetrics") {
          const m = t.variant.value;
          return [{ kind: "telemetry", node, battery: m.batteryLevel ?? null, voltage: m.voltage ?? null }];
        }
        if (t.variant.case === "environmentMetrics") {
          const m = t.variant.value;
          // The T1000-E's thermistor and light sensor arrive here. 0 is "not measured" for lux; temperature can be 0 °C.
          return [{ kind: "telemetry", node, battery: null, voltage: null, temperature: m.temperature ?? null, lux: m.lux || null }];
        }
        return [];
      }
    }
  } catch {
    /* malformed inner payload */
  }
  return [];
}
