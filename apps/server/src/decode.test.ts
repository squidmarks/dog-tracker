import { create, toBinary } from "@bufbuild/protobuf";
import { Mesh, Mqtt, Portnums } from "@meshtastic/protobufs";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, decryptPacket, expandPsk, headingDegrees } from "./decode.js";
import { Telemetry } from "@meshtastic/protobufs";

const key = expandPsk("AQ==");

function envelope(from: number, id: number, portnum: Portnums.PortNum, inner: Uint8Array) {
  const data = toBinary(Mesh.DataSchema, create(Mesh.DataSchema, { portnum, payload: inner }));
  const encrypted = decryptPacket(key, id, from, data); // CTR is symmetric
  return toBinary(Mqtt.ServiceEnvelopeSchema, create(Mqtt.ServiceEnvelopeSchema, {
    gatewayId: "!abcd1234", channelId: "LongFast",
    packet: create(Mesh.MeshPacketSchema, { from, id, payloadVariant: { case: "encrypted", value: encrypted } }),
  }));
}

describe("decodeEnvelope", () => {
  it("expands the default PSK", () => {
    expect(expandPsk("AQ==").toString("hex")).toBe("d4f1bb3a20290759f0bcffabcf4e6901");
  });

  it("decrypts and decodes a position packet", () => {
    const pos = toBinary(Mesh.PositionSchema, create(Mesh.PositionSchema, {
      latitudeI: 352000000, longitudeI: -1203000000, altitude: 120, time: 1_800_000_000,
    }));
    const [ev] = decodeEnvelope(envelope(0xdeadbeef, 42, Portnums.PortNum.POSITION_APP, pos), key);
    expect(ev).toMatchObject({ kind: "position", node: "!deadbeef", lat: 35.2, lon: -120.3, alt: 120, gateway: "!abcd1234" });
  });

  it("ignores packets encrypted with a different key", () => {
    const pos = toBinary(Mesh.PositionSchema, create(Mesh.PositionSchema, { latitudeI: 1, longitudeI: 1 }));
    const other = expandPsk(Buffer.alloc(16, 7).toString("base64"));
    expect(decodeEnvelope(envelope(1, 2, Portnums.PortNum.POSITION_APP, pos), other)).toEqual([]);
  });

  it("reads speed, heading and precision from a position", () => {
    const pos = toBinary(Mesh.PositionSchema, create(Mesh.PositionSchema, {
      latitudeI: 352000000, longitudeI: -1203000000, groundSpeed: 9, groundTrack: 9_000_000, HDOP: 120, satsInView: 10,
    }));
    const [ev] = decodeEnvelope(envelope(0xdeadbeef, 43, Portnums.PortNum.POSITION_APP, pos), key);
    expect(ev).toMatchObject({ kind: "position", speed: 9, heading: 90, hdop: 1.2 });
  });

  it("reads the collar's temperature and light from environment telemetry", () => {
    const t = toBinary(Telemetry.TelemetrySchema, create(Telemetry.TelemetrySchema, {
      variant: { case: "environmentMetrics", value: create(Telemetry.EnvironmentMetricsSchema, { temperature: 17.5, lux: 42 }) },
    }));
    const [ev] = decodeEnvelope(envelope(0xdeadbeef, 44, Portnums.PortNum.TELEMETRY_APP, t), key);
    expect(ev).toEqual({ kind: "telemetry", node: "!deadbeef", battery: null, voltage: null, temperature: 17.5, lux: 42 });
  });
});

describe("headingDegrees", () => {
  it("handles both unit conventions and ignores a stationary dog", () => {
    expect(headingDegrees(31_614_000, 3)).toBeCloseTo(316.14);   // 1e-5 degrees (seen in real packets)
    expect(headingDegrees(9_000, 3)).toBe(90);                    // 1/100 degree
    expect(headingDegrees(9_000_000, 0)).toBeNull();
    expect(headingDegrees(undefined, 5)).toBeNull();
  });
});
