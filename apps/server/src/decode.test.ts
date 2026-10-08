import { create, toBinary } from "@bufbuild/protobuf";
import { Mesh, Mqtt, Portnums } from "@meshtastic/protobufs";
import { describe, expect, it } from "vitest";
import { decodeEnvelope, decryptPacket, expandPsk } from "./decode.js";

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
});
