import net from "node:net";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Mesh, Portnums } from "@meshtastic/protobufs";

/** Meshtastic's stream framing (serial and TCP): 0x94 0xC3, a 2-byte big-endian length, then a protobuf. */
const START1 = 0x94, START2 = 0xc3;
export const frame = (payload: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from([START1, START2, (payload.length >> 8) & 0xff, payload.length & 0xff]), Buffer.from(payload)]);

/** Splits an incoming byte stream into protobuf payloads. Anything between frames (the device may print debug text) is skipped. */
export class FrameParser {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): Uint8Array[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Uint8Array[] = [];
    for (;;) {
      const start = this.buf.findIndex((b, i) => b === START1 && this.buf[i + 1] === START2);
      if (start < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1)); break; }   // keep a possible lone 0x94
      if (this.buf.length < start + 4) { this.buf = this.buf.subarray(start); break; }
      const len = (this.buf[start + 2] << 8) | this.buf[start + 3];
      if (this.buf.length < start + 4 + len) { this.buf = this.buf.subarray(start); break; }
      out.push(this.buf.subarray(start + 4, start + 4 + len));
      this.buf = this.buf.subarray(start + 4 + len);
    }
    return out;
  }
}

export interface CollarMessage {
  host: string; port?: number;
  /** Destination node id, e.g. "!2469fe85". */
  node: string;
  text: string;
  channel?: number;
  /** How long to wait for the hub to accept the connection / finish its start-up dump / acknowledge. */
  connectTimeoutMs?: number; configTimeoutMs?: number; ackTimeoutMs?: number;
}
export interface SendResult {
  /** The message was handed to the hub for transmission. */
  sent: boolean;
  /** The destination (or a relay) sent back a positive receipt. Absence doesn't mean it failed: the receipt can be lost. */
  acked: boolean;
  error?: string;
}

export const nodeNum = (id: string) => parseInt(id.replace(/^!/, ""), 16) >>> 0;

/**
 * Send one text message to a node through the hub's TCP API. A short-lived connection per message: the hub's API takes
 * one client at a time, so we don't hold it (the Meshtastic app can still connect between beeps).
 */
export function sendTextViaHub(m: CollarMessage): Promise<SendResult> {
  const { host, port = 4403, connectTimeoutMs = 5000, configTimeoutMs = 15000, ackTimeoutMs = 4000 } = m;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const parser = new FrameParser();
    const configId = 1 + Math.floor(Math.random() * 0x7ffffffe);
    const packetId = 1 + Math.floor(Math.random() * 0x7ffffffe);
    let phase: "connecting" | "config" | "ack" | "done" = "connecting";
    let timer: NodeJS.Timeout | undefined;
    let sentAt = false;

    const finish = (r: SendResult) => {
      if (phase === "done") return;
      phase = "done";
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const arm = (ms: number, onTimeout: () => void) => { clearTimeout(timer); timer = setTimeout(onTimeout, ms); };
    const write = (toRadio: ReturnType<typeof create<typeof Mesh.ToRadioSchema>>) =>
      socket.write(frame(toBinary(Mesh.ToRadioSchema, toRadio)));

    arm(connectTimeoutMs, () => finish({ sent: false, acked: false, error: "could not connect to the hub" }));

    socket.on("connect", () => {
      phase = "config";
      arm(configTimeoutMs, () => finish({ sent: false, acked: false, error: "the hub didn't finish its start-up" }));
      write(create(Mesh.ToRadioSchema, { payloadVariant: { case: "wantConfigId", value: configId } }));
    });

    socket.on("data", (chunk) => {
      for (const payload of parser.push(chunk)) {
        let msg;
        try { msg = fromBinary(Mesh.FromRadioSchema, payload); } catch { continue; }
        if (phase === "config" && msg.payloadVariant.case === "configCompleteId" && msg.payloadVariant.value === configId) {
          phase = "ack";
          write(create(Mesh.ToRadioSchema, { payloadVariant: { case: "packet", value: create(Mesh.MeshPacketSchema, {
            to: nodeNum(m.node), channel: m.channel ?? 0, id: packetId, wantAck: true,
            // What the official clients send: without a priority the radio may treat this as background traffic.
            priority: Mesh.MeshPacket_Priority.RELIABLE, hopLimit: 3,
            payloadVariant: { case: "decoded", value: create(Mesh.DataSchema, { portnum: Portnums.PortNum.TEXT_MESSAGE_APP, payload: Buffer.from(m.text) }) },
          }) } }));
          sentAt = true;
          arm(ackTimeoutMs, () => finish({ sent: true, acked: false }));
        } else if (phase === "ack" && msg.payloadVariant.case === "packet") {
          const d = msg.payloadVariant.value.payloadVariant;
          if (d.case === "decoded" && d.value.portnum === Portnums.PortNum.ROUTING_APP && d.value.requestId === packetId) {
            let ok = false;
            try { const r = fromBinary(Mesh.RoutingSchema, d.value.payload); ok = r.variant.case === "errorReason" && r.variant.value === 0; } catch { /* unreadable receipt */ }
            finish({ sent: true, acked: ok });
          }
        }
      }
    });

    socket.on("error", (e) => finish({ sent: sentAt, acked: false, error: e.message }));
    socket.on("close", () => finish({ sent: sentAt, acked: false, error: sentAt ? undefined : "the hub closed the connection" }));
  });
}
