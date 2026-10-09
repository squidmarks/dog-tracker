import type { Db, DogEvent, HubDoc, HubStatus } from "./db.js";

/** A Meshtastic gateway connects to the broker with its node id as the MQTT client id. */
export const isHubClient = (id: string) => /^![0-9a-f]{8}$/.test(id);

export type BrokerLogEvent = { type: "connect" | "disconnect"; client: string; reason?: string };

/** Parse one Mosquitto log line (from $SYS/broker/log/N) into a connect/disconnect, or null. */
export function parseBrokerLog(line: string): BrokerLogEvent | null {
  const text = line.replace(/^\d+:\s*/, "").trim(); // tolerate a leading epoch timestamp
  let m = /^New client connected from \S+ as (\S+) \(/.exec(text);
  if (m) return { type: "connect", client: m[1] };
  m = /^Client (\S+) \[\S+\] disconnected(?:: (.*?))?\.?$/.exec(text);
  if (m) return { type: "disconnect", client: m[1], reason: m[2] };
  m = /^Client (\S+) closed its connection\.?$/.exec(text);
  if (m) return { type: "disconnect", client: m[1], reason: "closed its connection" };
  return null;
}

export interface Hub extends HubDoc { name: string; lat: number | null; lon: number | null }

interface State extends HubDoc {
  /** Broker's view: true = connected now, false = disconnected, null = unknown (e.g. just after a restart). */
  connected: boolean | null;
  disconnectedAt: number | null;
}

/**
 * Tracks whether each LoRa hub (gateway) is online. The broker's connect/disconnect log is the fast signal; packets
 * are proof of life; and a hub that is silent for hubSilentMinutes with no broker word either way is the backstop.
 * A disconnect must last `graceS` before it counts, so a WiFi blip doesn't raise an alert.
 */
export class HubMonitor {
  private hubs = new Map<string, State>();
  constructor(private db: Db, private emit: (e: DogEvent) => void | Promise<void>, private graceS = 60) {}

  async load() {
    for (const h of await this.db.hubs()) this.hubs.set(h.id, { ...h, connected: null, disconnectedAt: null });  // keeps lat/lon too
  }

  private async get(id: string, now: number): Promise<State> {
    let h = this.hubs.get(id);
    if (!h) {
      h = { id, status: "online", since: now, lastPacket: null, connected: null, disconnectedAt: null };
      this.hubs.set(id, h);
      await this.db.saveHub(this.plain(h));
    }
    return h;
  }
  private plain = (h: State): HubDoc => ({ id: h.id, status: h.status, since: h.since, lastPacket: h.lastPacket });

  /** Place (or clear, with nulls) a hub on the map. Returns false for a hub we've never heard of. */
  async setLocation(id: string, lat: number | null, lon: number | null): Promise<boolean> {
    const h = this.hubs.get(id);
    if (!h || !(await this.db.setHubLocation(id, lat, lon))) return false;
    h.lat = lat; h.lon = lon;
    return true;
  }

  private async setStatus(h: State, status: HubStatus, now: number) {
    if (h.status === status) return;
    h.status = status; h.since = now;
    await this.db.saveHub(this.plain(h));
    const name = await this.db.nodeName(h.id);
    const e = await this.db.addEvent({
      ts: now, type: status === "offline" ? "hub_offline" : "hub_online", dogId: "", dogName: name, hubId: h.id,
      alert: status === "offline",
      message: status === "offline" ? `LoRa hub ${name} went offline. Collars can't report until it's back.` : `LoRa hub ${name} is back online`,
    });
    await this.emit(e);
  }

  async onBrokerLog(line: string, now = Math.floor(Date.now() / 1000)) {
    const ev = parseBrokerLog(line);
    if (!ev || !isHubClient(ev.client)) return;
    const h = await this.get(ev.client, now);
    if (ev.type === "connect") {
      h.connected = true; h.disconnectedAt = null;
      await this.setStatus(h, "online", now);
    } else if (ev.reason !== "session taken over") {   // a reconnect replacing the old session isn't a disconnect
      h.connected = false; h.disconnectedAt = now;
    }
  }

  /** Any uplink through this gateway proves it is alive. */
  async onPacket(gatewayId: string, now = Math.floor(Date.now() / 1000)) {
    if (!isHubClient(gatewayId)) return;
    const h = await this.get(gatewayId, now);
    h.lastPacket = now;
    // A packet after a logged disconnect means it reconnected. It never upgrades "unknown" to "connected":
    // only the broker's own log can say that, otherwise a hub that goes quiet after a restart would never time out.
    if (h.connected === false) { h.connected = true; h.disconnectedAt = null; }
    await this.setStatus(h, "online", now);
  }

  /** Periodic evaluation: apply the grace period and the silence backstop. */
  async tick(now = Math.floor(Date.now() / 1000)) {
    const silentS = (await this.db.settings()).hubSilentMinutes * 60;
    for (const h of this.hubs.values()) {
      if (h.status !== "online") continue;
      if (h.connected === false && h.disconnectedAt != null && now - h.disconnectedAt >= this.graceS) await this.setStatus(h, "offline", now);
      else if (h.connected === null && h.lastPacket != null && now - h.lastPacket > silentS) await this.setStatus(h, "offline", now);
    }
  }

  /** True when at least one hub is known and every known hub is offline: dogs can't be heard at all. */
  allDown(): boolean {
    return this.hubs.size > 0 && [...this.hubs.values()].every((h) => h.status === "offline");
  }

  /** The first hub that's been placed on the map (the simulator measures its distance from it). */
  located(): { lat: number; lon: number } | null {
    for (const h of this.hubs.values()) if (h.lat != null && h.lon != null) return { lat: h.lat, lon: h.lon };
    return null;
  }

  async list(): Promise<Hub[]> {
    return Promise.all([...this.hubs.values()].map(async (h) => ({ ...this.plain(h), lat: h.lat ?? null, lon: h.lon ?? null, name: await this.db.nodeName(h.id) })));
  }
}
