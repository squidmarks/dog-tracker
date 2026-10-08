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

/** Per-(dog, zone) membership with hysteresis and debounce, so GPS jitter at a fence line doesn't raise alerts.
 *  A flip needs the point to be `marginM` past the boundary on `confirm` consecutive fixes. */
export class Membership {
  private state = new Map<string, { inside: boolean; streak: number }>();
  constructor(private marginM = 5, private confirm = 2) {}

  /** Returns "enter" / "exit" on a confirmed transition, otherwise null. The first fix only seeds the state. */
  update(key: string, lat: number, lon: number, ring: Ring): "enter" | "exit" | null {
    const d = signedDistanceM(lat, lon, ring);
    const s = this.state.get(key);
    if (!s) { this.state.set(key, { inside: d <= 0, streak: 0 }); return null; }
    const wantsFlip = s.inside ? d > this.marginM : d < -this.marginM;
    if (!wantsFlip) { s.streak = 0; return null; }
    if (++s.streak < this.confirm) return null;
    s.inside = !s.inside;
    s.streak = 0;
    return s.inside ? "enter" : "exit";
  }

  has(key: string): boolean { return this.state.has(key); }
  isInside(key: string): boolean | undefined { return this.state.get(key)?.inside; }
  forget(prefix: string) { for (const k of this.state.keys()) if (k.startsWith(prefix)) this.state.delete(k); }
}
