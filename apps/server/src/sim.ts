import type { MeshEvent } from "./decode.js";

/** Simulated nodes use the reserved id range !fa000000+, so they're recognisable (and deletable) everywhere. */
export const isSimNode = (id: string) => /^!fa[0-9a-f]{6}$/.test(id);

export type Scenario = "wander" | "escape" | "return" | "silent";
export const SCENARIOS: Scenario[] = ["wander", "escape", "return", "silent"];

export interface SimDog {
  id: string; name: string;
  x: number; y: number;          // metres east / north of the yard centre
  heading: number;               // radians, 0 = east
  scenario: Scenario;
  silentUntil: number;           // epoch seconds; no packets before this
  battery: number;
  paused: number;                // ticks left standing still
}

const M_PER_DEG_LAT = 111_195;

export function toLatLon(centre: { lat: number; lon: number }, x: number, y: number) {
  return { lat: centre.lat + y / M_PER_DEG_LAT, lon: centre.lon + x / (M_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180)) };
}

/** Advance one dog by dt seconds. `rand` is injectable for tests. Returns nothing; mutates the dog. */
export function stepDog(d: SimDog, dt: number, yardRadiusM: number, rand: () => number = Math.random): void {
  const dist = Math.hypot(d.x, d.y);
  let speed = 0;
  switch (d.scenario) {
    case "wander":
    case "silent":
      if (d.paused > 0) { d.paused--; break; }
      if (rand() < 0.08) { d.paused = 2 + Math.floor(rand() * 6); break; }
      d.heading += (rand() - 0.5) * 1.2;
      // Steer back if drifting toward the fence so a wandering dog stays in the yard.
      if (dist > yardRadiusM * 0.8) d.heading = Math.atan2(-d.y, -d.x) + (rand() - 0.5) * 0.6;
      speed = 0.3 + rand() * 1.4;
      break;
    case "escape":
      if (d.paused === 0 && Math.hypot(d.x, d.y) < yardRadiusM + 5) d.heading = Math.atan2(d.y || 0.01, d.x || 0.01);
      d.heading += (rand() - 0.5) * 0.2;
      speed = 2.5 + rand();   // a trot/run
      break;
    case "return":
      d.heading = Math.atan2(-d.y, -d.x) + (rand() - 0.5) * 0.3;
      speed = 2 + rand();
      if (dist < yardRadiusM * 0.5) d.scenario = "wander";
      break;
  }
  d.x += Math.cos(d.heading) * speed * dt;
  d.y += Math.sin(d.heading) * speed * dt;
  d.battery = Math.max(1, d.battery - dt * 0.0006); // ~2%/hour
}

export function startSimulator(opts: {
  count: number; centre: { lat: number; lon: number }; yardRadiusM: number;
  tickS: number; apply: (ev: MeshEvent) => void;
}) {
  const names = ["Sim Maple", "Sim Birch", "Sim Juniper", "Sim Willow"];
  let packetId = 1_000_000;
  const dogs: SimDog[] = Array.from({ length: opts.count }, (_, i) => ({
    id: "!fa" + (i + 1).toString(16).padStart(6, "0"), name: names[i % names.length],
    x: (Math.random() - 0.5) * opts.yardRadiusM, y: (Math.random() - 0.5) * opts.yardRadiusM,
    heading: Math.random() * Math.PI * 2, scenario: "wander", silentUntil: 0, battery: 70 + Math.random() * 30, paused: 0,
  }));

  const nowS = () => Math.floor(Date.now() / 1000);
  const emit = (d: SimDog) => {
    const ll = toLatLon(opts.centre, d.x, d.y);
    opts.apply({ kind: "position", node: d.id, packetId: packetId++, gateway: "!sim00001", rssi: -70 - Math.hypot(d.x, d.y) / 8,
      snr: 6, ts: nowS(), lat: ll.lat, lon: ll.lon, alt: 20, speed: null, sats: 8 + Math.floor(Math.random() * 4) });
  };

  for (const d of dogs) {
    opts.apply({ kind: "nodeinfo", node: d.id, longName: d.name, shortName: d.name.slice(-4) });
    opts.apply({ kind: "telemetry", node: d.id, battery: Math.round(d.battery), voltage: 3.7 + d.battery / 250 });
    emit(d);
  }

  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    for (const d of dogs) {
      stepDog(d, opts.tickS, opts.yardRadiusM);
      if (nowS() < d.silentUntil) continue;
      emit(d);
      if (tick % 30 === 0) opts.apply({ kind: "telemetry", node: d.id, battery: Math.round(d.battery), voltage: 3.7 + d.battery / 250 });
    }
  }, opts.tickS * 1000);
  timer.unref();

  return {
    dogs,
    /** silent: stop reporting for `minutes` (the dog keeps moving). Others switch the movement mode. */
    trigger(id: string, scenario: Scenario, minutes = 30): boolean {
      const d = dogs.find((x) => x.id === id);
      if (!d) return false;
      if (scenario === "silent") d.silentUntil = nowS() + minutes * 60;
      else { d.scenario = scenario; d.silentUntil = 0; }
      return true;
    },
    stop: () => clearInterval(timer),
  };
}
