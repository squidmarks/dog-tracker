import type { Db, DogEvent, EventType, Zone } from "./db.js";
import { Membership } from "./geo.js";
import { isSimNode } from "./sim.js";

type Emit = (e: DogEvent) => void | Promise<void>;
interface LiveDog {
  id: string; name: string; tracker: string | null; last_heard: number | null; battery: number | null;
  lat: number | null; lon: number | null; alerts?: boolean;
}

const appliesTo = (z: Zone, dogId: string) => z.dogs === null || z.dogs.includes(dogId);
const alerts = (z: Zone, kind: "enter" | "exit") => z.alertOn === "both" || z.alertOn === kind;

/** Turns positions, silence and battery levels into events (zone enter/exit, silent, low battery). */
export class Monitor {
  private membership = new Membership();
  private zones: Zone[] = [];
  private flags = new Map<string, { silent: boolean; lowBattery: boolean }>();
  private lastMargin = -1;

  /** `hubsDown` reports that no hub is online, so silent dogs are explained by that one alert instead of one each. */
  constructor(private db: Db, private emit: Emit, private hubsDown: () => boolean = () => false) {}

  /** Reload zones and settings (call after either changes), and seed membership from each dog's last known position. */
  async reload(reseed = false) {
    const [zones, settings] = await Promise.all([this.db.zones(), this.db.settings()]);
    this.zones = zones;
    const reset = reseed || settings.fenceMarginM !== this.lastMargin;
    if (reset) { this.membership = new Membership(settings.fenceMarginM); this.lastMargin = settings.fenceMarginM; }
    // Seed every (dog, zone) we have no state for from the dog's last known position, without raising events.
    for (const d of (await this.db.dogs()) as unknown as LiveDog[]) {
      if (d.lat == null || d.lon == null) continue;
      for (const z of this.zones) {
        if (appliesTo(z, d.id) && !this.membership.has(`${d.id}:${z.id}`)) this.membership.update(`${d.id}:${z.id}`, d.lat, d.lon, z.ring);
      }
    }
  }

  /** The zone the simulator should treat as the yard: the first "home" zone, else the first zone. */
  playRing(): [number, number][] | null { return (this.zones.find((z) => z.home) ?? this.zones[0])?.ring ?? null; }

  isInside(dogId: string, zoneId: string): boolean | undefined { return this.membership.isInside(`${dogId}:${zoneId}`); }
  zonesFor(dogId: string): Zone[] { return this.zones.filter((z) => appliesTo(z, dogId)); }

  private async observe(dog: LiveDog, lat: number, lon: number) {
    for (const z of this.zones) {
      if (!appliesTo(z, dog.id)) continue;
      const t = this.membership.update(`${dog.id}:${z.id}`, lat, lon, z.ring);
      if (!t) continue;
      await this.event(dog, t === "exit" ? "zone_exit" : "zone_enter", alerts(z, t),
        t === "exit" ? `${dog.name} left ${z.name}` : `${dog.name} entered ${z.name}`, { zone: z, lat, lon });
    }
  }

  /** A position arrived for the dog carrying `node`. */
  async onPosition(node: string, lat: number, lon: number) {
    const id = await this.db.dogIdForNode(node);
    if (!id) return;
    const dog = (await this.db.dog(id)) as unknown as LiveDog | undefined;
    if (dog) await this.observe(dog, lat, lon);
  }

  /** Periodic checks for silence and low battery. `now` is injectable for tests. */
  async tick(now = Math.floor(Date.now() / 1000)) {
    const settings = await this.db.settings();
    for (const dog of (await this.db.dogs()) as unknown as LiveDog[]) {
      if (!dog.tracker) continue;
      const first = !this.flags.has(dog.id);
      const f = this.flags.get(dog.id) ?? { silent: false, lowBattery: false };
      this.flags.set(dog.id, f);

      let isSilent = dog.last_heard == null || now - dog.last_heard > settings.staleMinutes * 60;
      if (isSilent && this.hubsDown()) isSilent = f.silent; // can't hear anyone: the hub alert covers it
      if (isSilent !== f.silent) {
        f.silent = isSilent;
        if (!first) {
          const mins = dog.last_heard ? Math.round((now - dog.last_heard) / 60) : settings.staleMinutes;
          await this.event(dog, isSilent ? "silent" : "reporting", isSilent,
            isSilent ? `${dog.name} hasn't reported for ${mins} min` : `${dog.name} is reporting again`, { lat: dog.lat, lon: dog.lon });
        }
      }

      // 101 means "charging/powered", never low.
      const isLow = dog.battery != null && dog.battery <= 100 && dog.battery <= settings.lowBatteryPct;
      const recovered = dog.battery != null && (dog.battery > 100 || dog.battery > settings.lowBatteryPct + 5);
      if (isLow && !f.lowBattery) {
        f.lowBattery = true;
        if (!first) await this.event(dog, "low_battery", true, `${dog.name}'s battery is at ${dog.battery}%`, { lat: dog.lat, lon: dog.lon });
      } else if (f.lowBattery && recovered) {
        f.lowBattery = false;
        if (!first) await this.event(dog, "battery_ok", false, `${dog.name}'s battery is back to ${dog.battery! > 100 ? "charging" : dog.battery + "%"}`);
      }
    }
  }

  private async event(dog: LiveDog, type: EventType, alert: boolean, message: string,
    extra: { zone?: Zone; lat?: number | null; lon?: number | null } = {}) {
    const saved = await this.db.addEvent({
      ts: Math.floor(Date.now() / 1000), type, dogId: dog.id, dogName: dog.name,
      alert: alert && dog.alerts !== false, // a muted dog still logs events, just quietly
      message,
      ...(dog.tracker && isSimNode(dog.tracker) ? { sim: true } : {}),
      ...(extra.zone ? { zoneId: extra.zone.id, zoneName: extra.zone.name } : {}),
      lat: extra.lat ?? null, lon: extra.lon ?? null,
    });
    await this.emit(saved);
  }
}
