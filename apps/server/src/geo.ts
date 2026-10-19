export type Ring = [number, number][]; // GeoJSON order: [lon, lat], closed (first point repeated last)

const M_PER_DEG = 111_195;

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** A closed polygon ring approximating a circle (the "circle zone" shortcut). */
export function circleRing(lat: number, lon: number, radiusM: number, points = 32): Ring {
  const ring: Ring = [];
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points;
    ring.push([
      lon + (Math.cos(a) * radiusM) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)),
      lat + (Math.sin(a) * radiusM) / M_PER_DEG,
    ]);
  }
  ring.push(ring[0]);
  return ring;
}

export function pointInRing(lat: number, lon: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance in metres from the point to the ring's edge: negative when inside, positive when outside. */
export function signedDistanceM(lat: number, lon: number, ring: Ring): number {
  const cos = Math.cos((lat * Math.PI) / 180);
  const px = 0, py = 0;
  const toXY = ([lo, la]: [number, number]) => [(lo - lon) * M_PER_DEG * cos, (la - lat) * M_PER_DEG];
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = toXY(ring[i]), [bx, by] = toXY(ring[i + 1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    min = Math.min(min, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return pointInRing(lat, lon, ring) ? -min : min;
}

export interface FenceRules {
  /** Leaving: a fix this far past the edge counts, but must repeat `exitConfirm` times in a row. */
  exitMarginM: number; exitConfirm: number;
  /** Leaving: ONE fix this far past the edge is enough (a dog 15 m outside isn't GPS noise). */
  fastExitM: number;
  /** Coming back: a fix this far inside the edge counts (so one is enough; indoor GPS rarely gives two). */
  enterMarginM: number; enterConfirm: number;
}
export const DEFAULT_FENCE: FenceRules = { exitMarginM: 5, exitConfirm: 2, fastExitM: 8, enterMarginM: 3, enterConfirm: 1 };

/**
 * Per-(dog, zone) membership. It's deliberately lopsided: it takes real evidence to say a dog has LEFT (consumer GPS
 * wanders 10 m or more, and a false alarm is annoying), but only a little to say it's BACK (so alerts and collar beeps
 * stop promptly, even when the GPS is poor near the fence or indoors).
 */
export class Membership {
  private state = new Map<string, { inside: boolean; streak: number }>();
  private rules: FenceRules;
  constructor(rules: Partial<FenceRules> = {}) { this.rules = { ...DEFAULT_FENCE, ...rules }; }

  /** Returns "enter" / "exit" on a confirmed transition, otherwise null. The first fix only seeds the state. */
  update(key: string, lat: number, lon: number, ring: Ring): "enter" | "exit" | null {
    const d = signedDistanceM(lat, lon, ring);
    const s = this.state.get(key);
    if (!s) { this.state.set(key, { inside: d <= 0, streak: 0 }); return null; }
    const r = this.rules;
    if (s.inside) {
      if (d > r.fastExitM) { s.inside = false; s.streak = 0; return "exit"; }
    }
    return this.step(s, d);
  }

  private step(s: { inside: boolean; streak: number }, d: number): "enter" | "exit" | null {
    const r = this.rules;
    const [margin, confirm] = s.inside ? [r.exitMarginM, r.exitConfirm] : [r.enterMarginM, r.enterConfirm];
    const crossed = s.inside ? d > margin : d < -margin;
    if (!crossed) { s.streak = 0; return null; }
    if (++s.streak < confirm) return null;
    s.inside = !s.inside;
    s.streak = 0;
    return s.inside ? "enter" : "exit";
  }

  has(key: string): boolean { return this.state.has(key); }
  isInside(key: string): boolean | undefined { return this.state.get(key)?.inside; }
  forget(prefix: string) { for (const k of this.state.keys()) if (k.startsWith(prefix)) this.state.delete(k); }
}
