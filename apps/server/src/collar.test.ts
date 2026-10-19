import net from "node:net";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Mesh, Portnums } from "@meshtastic/protobufs";
import { afterEach, describe, expect, it } from "vitest";
import { frame, FrameParser, nodeNum, sendTextViaHub } from "./collar.js";

/** A stand-in hub: speaks the same framing, finishes the handshake, and optionally acknowledges the packet. */
function fakeHub(opts: { handshake?: boolean; ack?: "ok" | "error" | "none" } = {}) {
  const { handshake = true, ack = "ok" } = opts;
  const received: Mesh.MeshPacket[] = [];
  const server = net.createServer((sock) => {
    const parser = new FrameParser();
    sock.write("some debug text the device prints\\n");                           // noise between frames must be tolerated
    sock.on("data", (chunk) => {
      for (const p of parser.push(chunk)) {
        const msg = fromBinary(Mesh.ToRadioSchema, p);
        if (msg.payloadVariant.case === "wantConfigId" && handshake) {
          sock.write(frame(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant: { case: "configCompleteId", value: msg.payloadVariant.value } }))));
        } else if (msg.payloadVariant.case === "packet") {
          const pkt = msg.payloadVariant.value;
          received.push(pkt);
          if (ack === "none") continue;
          const routing = toBinary(Mesh.RoutingSchema, create(Mesh.RoutingSchema, { variant: { case: "errorReason", value: ack === "ok" ? 0 : 5 } }));
          const reply = create(Mesh.MeshPacketSchema, { from: pkt.to, payloadVariant: { case: "decoded", value: create(Mesh.DataSchema, { portnum: Portnums.PortNum.ROUTING_APP, requestId: pkt.id, payload: routing }) } });
          sock.write(frame(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant: { case: "packet", value: reply } }))));
        }
      }
    });
  });
  return new Promise<{ port: number; received: Mesh.MeshPacket[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => server.close() })));
}

let closers: (() => void)[] = [];
afterEach(() => { closers.forEach((c) => c()); closers = []; });
const hub = async (o?: Parameters<typeof fakeHub>[0]) => { const h = await fakeHub(o); closers.push(h.close); return h; };
const fast = { connectTimeoutMs: 800, configTimeoutMs: 800, ackTimeoutMs: 400 };

describe("frame parsing", () => {
  it("reassembles frames split across chunks and skips text between them", () => {
    const a = frame(Uint8Array.from([1, 2, 3])), b = frame(Uint8Array.from([9]));
    const all = Buffer.concat([Buffer.from("junk"), a, Buffer.from("more junk"), b]);
    const p = new FrameParser();
    const out = [...p.push(all.subarray(0, 7)), ...p.push(all.subarray(7, 15)), ...p.push(all.subarray(15))];
    expect(out.map((x) => [...x])).toEqual([[1, 2, 3], [9]]);
  });
  it("turns a node id into its number", () => {
    expect(nodeNum("!2469fe85")).toBe(0x2469fe85);
    expect(nodeNum("!9b0b9a7c")).toBe(0x9b0b9a7c);          // above 2^31: must stay unsigned
  });
});

describe("sendTextViaHub", () => {
  it("hands a direct text message to the hub for the right node and reports the receipt", async () => {
    const h = await hub();
    const r = await sendTextViaHub({ host: "127.0.0.1", port: h.port, node: "!9b0b9a7c", text: "beep", ...fast });
    expect(r).toEqual({ sent: true, acked: true });
    expect(h.received).toHaveLength(1);
    const pkt = h.received[0];
    expect(pkt.to).toBe(0x9b0b9a7c);
    expect(pkt.wantAck).toBe(true);
    expect(pkt.channel).toBe(0);
    expect(pkt.payloadVariant.case).toBe("decoded");
    const d = (pkt.payloadVariant as { value: Mesh.Data }).value;
    expect(d.portnum).toBe(Portnums.PortNum.TEXT_MESSAGE_APP);
    expect(Buffer.from(d.payload).toString()).toBe("beep");
  });

  it("still counts as sent when no receipt comes back (the receipt can be lost)", async () => {
    const h = await hub({ ack: "none" });
    expect(await sendTextViaHub({ host: "127.0.0.1", port: h.port, node: "!2469fe85", text: "beep", ...fast })).toEqual({ sent: true, acked: false });
  });

  it("reports a negative receipt as sent but not acknowledged", async () => {
    const h = await hub({ ack: "error" });
    expect(await sendTextViaHub({ host: "127.0.0.1", port: h.port, node: "!2469fe85", text: "beep", ...fast })).toEqual({ sent: true, acked: false });
  });

  it("fails cleanly when the hub never finishes its start-up", async () => {
    const h = await hub({ handshake: false });
    const r = await sendTextViaHub({ host: "127.0.0.1", port: h.port, node: "!2469fe85", text: "beep", ...fast });
    expect(r).toMatchObject({ sent: false, acked: false });
    expect(r.error).toMatch(/start-up/);
    expect(h.received).toHaveLength(0);
  });

  it("fails cleanly when the hub is unreachable", async () => {
    const r = await sendTextViaHub({ host: "127.0.0.1", port: 1, node: "!2469fe85", text: "beep", ...fast });
    expect(r.sent).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
