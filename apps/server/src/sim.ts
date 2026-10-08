import type { MeshEvent } from "./decode.js";
import { type Ring, signedDistanceM } from "./geo.js";

/** Simulated nodes use the reserved id range !fa000000+, so they're recognisable (and deletable) everywhere. */
export const isSimNode = (id: string) => /^!fa[0-9a-f]{6}$/.test(id);

export type Scenario = "wander" | "escape" | "return" | "silent";
export const SCENARIOS: Scenario[] = ["wander", "escape", "return", "silent"];

export interface SimDog {
  id: string; name: string;
  x: number; y: number;          // metres east / north of the area's reference point
  heading: number;               // radians, 0 = east
  scenario: Scenario;
  silentUntil: number;           // epoch seconds; no packets before this
  battery: number;
  paused: number;                // seconds left standing still
}

/** Where the dogs live: signed distance to the edge (negative inside) and a point near the middle, in metres. */
export interface Area { signedDist(x: number, y: number): number; centre: { x: number; y: number } }

const M_PER_DEG_LAT = 111_195;

export function toLatLon(ref: { lat: number; lon: number }, x: number, y: number) {
  return { lat: ref.lat + y / M_PER_DEG_LAT, lon: ref.lon + x / (M_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180)) };
}

export const circleArea = (radiusM: number): Area => ({ signedDist: (x, y) => Math.hypot(x, y) - radiusM, centre: { x: 0, y: 0 } });

/** A real zone polygon (GeoJSON ring) as a play area, positioned relative to `ref`. */
export function ringArea(ref: { lat: number; lon: number }, ring: Ring): Area {
  const cos = Math.cos((ref.lat * Math.PI) / 180);
  const pts = ring.slice(0, -1);
  const cx = pts.reduce((s, [lo]) => s + (lo - ref.lon) * M_PER_DEG_LAT * cos, 0) / pts.length;
  const cy = pts.reduce((s, [, la]) => s + (la - ref.lat) * M_PER_DEG_LAT, 0) / pts.length;
  return {
    centre: { x: cx, y: cy },
    signedDist: (x, y) => { const p = toLatLon(ref, x, y); return signedDistanceM(p.lat, p.lon, ring); },
  };
}

const EDGE_BUFFER = 6; // wandering dogs keep this far inside the edge

/** Advance one dog by dt seconds. `rand` is injectable for tests. Mutates the dog. */
export function stepDog(d: SimDog, dt: number, area: Area, rand: () => number = Math.random): void {
  const toCentre = () => Math.atan2(area.centre.y - d.y, area.centre.x - d.x);
  const distToCentre = () => Math.hypot(area.centre.x - d.x, area.centre.y - d.y);
  let speed = 0;
  switch (d.scenario) {
    case "wander":
    case "silent":
      if (d.paused > 0) { d.paused -= dt; break; }
      if (rand() < 0.012 * dt) { d.paused = 8 + rand() * 25; break; }   // stand and sniff for a bit
      d.heading += (rand() - 0.5) * 1.0;
      if (area.signedDist(d.x, d.y) > -EDGE_BUFFER * 2) d.heading = toCentre() + (rand() - 0.5) * 0.6;
      speed = 0.4 + rand() * 1.2;
      break;
    case "escape":
      // Head straight out through the nearest part of the fence line, away from the middle.
      d.paused = 0;
      if (area.signedDist(d.x, d.y) < -3) d.heading = Math.atan2(d.y - area.centre.y || 0.01, d.x - area.centre.x || 0.01);
      d.heading += (rand() - 0.5) * 0.15;
      speed = 2 + rand() * 0.8;   // a trot
      break;
    case "return":
      d.paused = 0;
      d.heading = toCentre() + (rand() - 0.5) * 0.2;
      speed = Math.min(2 + rand() * 0.8, distToCentre() / dt);   // never overshoot the middle
      if (area.signedDist(d.x, d.y) < -10) d.scenario = "wander";
      break;
  }
  d.x += Math.cos(d.heading) * speed * dt;
  d.y += Math.sin(d.heading) * speed * dt;
  // A wandering dog respects the fence even on a big time step: pull it back inside.
  if (d.scenario === "wander" || d.scenario === "silent") {
    for (let i = 0; i < 40 && area.signedDist(d.x, d.y) > -EDGE_BUFFER; i++) {
      const dx = area.centre.x - d.x, dy = area.centre.y - d.y, len = Math.hypot(dx, dy) || 1;
      d.x += (dx / len) * 1.5; d.y += (dy / len) * 1.5;
    }
  }
  d.battery = Math.max(1, d.battery - dt * 0.0006); // ~2%/hour
}

export function startSimulator(opts: {
  count: number; centre: { lat: number; lon: number };
  /** Called every tick, so the dogs follow the zone as you edit it. */
  getArea: () => Area;
  tickS: number; apply: (ev: MeshEvent) => void;
}) {
  const names = ["Sim Maple", "Sim Birch", "Sim Juniper", "Sim Willow"];
  let packetId = Math.floor(Date.now() / 1000); // unique per run: (node, packet_id) must never repeat across restarts
  const start = opts.getArea();
  const dogs: SimDog[] = Array.from({ length: opts.count }, (_, i) => ({
    id: "!fa" + (i + 1).toString(16).padStart(6, "0"), name: names[i % names.length],
    x: start.centre.x + (Math.random() - 0.5) * 8, y: start.centre.y + (Math.random() - 0.5) * 8,
    heading: Math.random() * Math.PI * 2, scenario: "wander", silentUntil: 0, battery: 70 + Math.random() * 30, paused: 0,
  }));

  const nowS = () => Math.floor(Date.now() / 1000);
  const emit = (d: SimDog) => {
    const ll = toLatLon(opts.centre, d.x, d.y);
    opts.apply({ kind: "position", node: d.id, packetId: packetId++, gateway: "!sim00001", rssi: -70 - Math.hypot(d.x, d.y) / 8,
      snr: 6, ts: nowS(), lat: ll.lat, lon: ll.lon, alt: 20, speed: null, sats: 8 + Math.floor(Math.random() * 4) });
  };
  const battery = (d: SimDog) => opts.apply({ kind: "telemetry", node: d.id, battery: Math.round(d.battery), voltage: 3.7 + d.battery / 250 });

  for (const d of dogs) {
    opts.apply({ kind: "nodeinfo", node: d.id, longName: d.name, shortName: d.name.slice(-4) });
    battery(d);
    emit(d);
  }

  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const area = opts.getArea();
    for (const d of dogs) {
      stepDog(d, opts.tickS, area);
      if (nowS() < d.silentUntil) continue;
      emit(d);
      if (tick % 30 === 0) battery(d);
    }
  }, opts.tickS * 1000);
  timer.unref();

  return {
    dogs,
    /** silent: stop reporting for `minutes` (the dog keeps moving). Others switch the movement mode, and the
     *  dog reacts straight away (one step and a fresh position) instead of waiting for the next tick. */
    trigger(id: string, scenario: Scenario, minutes = 30): boolean {
      const d = dogs.find((x) => x.id === id);
      if (!d) return false;
      if (scenario === "silent") { d.silentUntil = nowS() + minutes * 60; return true; }
      d.scenario = scenario; d.silentUntil = 0; d.paused = 0;
      stepDog(d, opts.tickS, opts.getArea());
      emit(d);
      return true;
    },
    stop: () => clearInterval(timer),
  };
}
