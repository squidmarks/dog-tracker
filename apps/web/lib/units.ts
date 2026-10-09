/** Display formatting. The server speaks SI (metres, m/s); people read miles and mph (or km and km/h). */
export type Units = "imperial" | "metric";

const M_PER_MILE = 1609.344;
const MPS_TO_MPH = 2.2369363;

export function formatDistance(m: number, u: Units = "imperial"): string {
  if (u === "metric") return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
  const mi = m / M_PER_MILE;
  return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
}

export function formatSpeed(mps: number, u: Units = "imperial"): string {
  return u === "metric" ? `${(mps * 3.6).toFixed(1)} km/h` : `${(mps * MPS_TO_MPH).toFixed(1)} mph`;
}

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Battery runtime estimate from a (time, percent) series: a least-squares slope over the points given.
 *  Returns hours until empty, or null when there's no clear downward trend (charging, flat, too little data). */
export function batteryHoursLeft(points: { ts: number; battery: number | null }[]): number | null {
  const p = points.filter((x): x is { ts: number; battery: number } => x.battery != null && x.battery <= 100);
  if (p.length < 4 || p[p.length - 1].ts - p[0].ts < 30 * 60) return null;
  const t0 = p[0].ts, n = p.length;
  const xs = p.map((x) => (x.ts - t0) / 3600), ys = p.map((x) => x.battery);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;      // % per hour
  return slope < -0.05 ? ys[n - 1] / -slope : null;
}
