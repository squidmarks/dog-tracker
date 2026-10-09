/** Activity statistics from a dog's GPS fixes: distance, top speed, moving time, and a dwell heat map. */
export interface Fix { ts: number; lat: number; lon: number; speed?: number | null; hdop?: number | null; sats?: number | null }

export interface TopSpeed { mps: number; ts: number; lat: number; lon: number; source: "reported" | "derived" }
export interface Stats {
  fixes: number;
  /** Metres travelled, after removing GPS wobble. A lower bound: sparse fixes cut corners. */
  distanceM: number;
  /** Seconds the dog was actually moving (gaps in reporting don't count). */
  movingS: number;
  topSpeed: TopSpeed | null;
  /** Typical gap between fixes: top speed and distance are only as good as this is small. */
  medianIntervalS: number | null;
}

export const TUNING = {
  /** Movement smaller than this is GPS noise, not travel (a resting dog's fix wanders a few metres). */
  noiseM: 6,
  /** Never join fixes across a silence longer than this (collar off, out of range, charging elsewhere). */
  maxGapS: 30 * 60,
  /** Time between fixes beyond this isn't credited as moving time. */
  maxMovingStepS: 3 * 60,
  /** Derived speed needs fixes this close in time to mean anything. */
  maxSpeedStepS: 60,
  /** Anything faster is a GPS glitch (a greyhound tops out near 18 m/s). */
  maxDogMps: 20,
  minMovingMps: 0.6,
  /** Fixes with worse precision than this are ignored when the collar says how precise it was. */
  maxHdop: 5,
  minSats: 4,
  /** A lone fix this far from both neighbours, which are close to each other, is a spike. */
  spikeM: 25,
};

const M_PER_DEG = 111_195;
const proj = (lat0: number) => (f: { lat: number; lon: number }) => ({
  x: (f.lon * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)), y: f.lat * M_PER_DEG,
});
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Time-order, drop poor-quality fixes and lone spikes. */
export function cleanFixes(input: Fix[], t = TUNING): Fix[] {
  const seen = new Set<number>();
  let f = [...input].sort((a, b) => a.ts - b.ts).filter((p) => {
    if (seen.has(p.ts)) return false;
    seen.add(p.ts);
    if (p.hdop != null && p.hdop > t.maxHdop) return false;
    if (p.sats != null && p.sats < t.minSats) return false;
    return true;
  });
  if (f.length < 3) return f;
  const P = proj(f[0].lat);
  f = f.filter((p, i) => {
    if (i === 0 || i === f.length - 1) return true;
    const [a, b, c] = [P(f[i - 1]), P(p), P(f[i + 1])];
    const out = dist(a, b), back = dist(b, c);
    return !(out > t.spikeM && back > t.spikeM && dist(a, c) < 0.5 * Math.min(out, back));
  });
  return f;
}

/** Douglas-Peucker: indices of the points that survive simplification at tolerance `tol` metres. */
export function simplify(pts: { x: number; y: number }[], tol: number): number[] {
  const keep = new Set<number>([0, pts.length - 1]);
  const stack: [number, number][] = pts.length > 2 ? [[0, pts.length - 1]] : [];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    const a = pts[s], b = pts[e], dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pts[i].x - a.x) * dx + (pts[i].y - a.y) * dy) / len2));
      const d = Math.hypot(pts[i].x - (a.x + t * dx), pts[i].y - (a.y + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > tol) { keep.add(idx); stack.push([s, idx], [idx, e]); }
  }
  return [...keep].sort((x, y) => x - y);
}

/** Split fixes into runs with no silence longer than maxGapS. */
function runs(f: Fix[], t = TUNING): Fix[][] {
  const out: Fix[][] = [];
  let cur: Fix[] = [];
  for (const p of f) {
    if (cur.length && p.ts - cur[cur.length - 1].ts > t.maxGapS) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function computeStats(input: Fix[], t = TUNING): Stats {
  const f = cleanFixes(input, t);
  const stats: Stats = { fixes: f.length, distanceM: 0, movingS: 0, topSpeed: null, medianIntervalS: null };
  if (f.length < 2) return stats;
  const P = proj(f[0].lat);
  const gaps: number[] = [];
  let best: TopSpeed | null = null;
  const offer = (c: TopSpeed) => {
    if (c.mps > t.maxDogMps) return;
    if (!best || c.mps > best.mps || (c.mps === best.mps && c.source === "reported")) best = c;
  };

  for (const run of runs(f, t)) {
    const pts = run.map(P);
    // Distance: simplify away the wobble, then add up what's left.
    const keep = simplify(pts, t.noiseM);
    for (let i = 1; i < keep.length; i++) stats.distanceM += dist(pts[keep[i - 1]], pts[keep[i]]);

    for (let i = 0; i < run.length; i++) {
      const p = run[i];
      if (p.speed != null && p.speed >= 1) offer({ mps: p.speed, ts: p.ts, lat: p.lat, lon: p.lon, source: "reported" });
      if (i === 0) continue;
      const dt = p.ts - run[i - 1].ts, d = dist(pts[i - 1], pts[i]);
      if (dt <= 5 * 60) gaps.push(dt);
      const v = dt > 0 ? d / dt : 0;
      if (dt >= 1 && dt <= t.maxSpeedStepS && d > t.noiseM) offer({ mps: v, ts: p.ts, lat: p.lat, lon: p.lon, source: "derived" });
      const moving = (d > t.noiseM && v >= t.minMovingMps) || (p.speed != null && p.speed >= 1);
      if (moving && dt <= t.maxMovingStepS) stats.movingS += dt;
    }
  }
  stats.topSpeed = best;
  if (gaps.length) { gaps.sort((a, b) => a - b); stats.medianIntervalS = gaps[Math.floor(gaps.length / 2)]; }
  return stats;
}

export interface HeatCell { lat: number; lon: number; /** Seconds spent here. */ w: number }

/** Where the dog spent its time: fixes binned into ~cellM squares, each weighted by how long the dog stayed. */
export function heatCells(input: Fix[], cellM = 5, maxDwellS = 120, maxCells = 5000, t = TUNING): HeatCell[] {
  const f = cleanFixes(input, t);
  if (!f.length) return [];
  const dLat = cellM / M_PER_DEG;
  const cells = new Map<string, { n: number; lat: number; lon: number; w: number }>();
  f.forEach((p, i) => {
    const next = f[i + 1];
    const dwell = next ? Math.min(next.ts - p.ts, maxDwellS) : 30;
    const dLon = cellM / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180));
    const key = `${Math.round(p.lat / dLat)}:${Math.round(p.lon / dLon)}`;
    const c = cells.get(key) ?? { n: 0, lat: 0, lon: 0, w: 0 };
    c.n++; c.lat += p.lat; c.lon += p.lon; c.w += Math.max(dwell, 1);
    cells.set(key, c);
  });
  return [...cells.values()].map((c) => ({ lat: c.lat / c.n, lon: c.lon / c.n, w: Math.round(c.w) }))
    .sort((a, b) => b.w - a.w).slice(0, maxCells);
}
