export interface Dog {
  id: string; name: string | null; long_name: string | null; short_name: string | null; color: string | null;
  battery: number | null; voltage: number | null; last_heard: number | null;
  lat: number | null; lon: number | null; pos_ts: number | null; speed: number | null; sats: number | null;
  gateway: string | null; rssi: number | null; snr: number | null;
}
export interface TrackPoint { ts: number; lat: number; lon: number }

export const PALETTE = ["#e4572e", "#2e86ab", "#76b041", "#a23b72", "#f2a541"];
export const displayName = (d: Dog) => d.name ?? d.long_name ?? d.id;
export const colorOf = (d: Dog, i: number) => d.color ?? PALETTE[i % PALETTE.length];

export function ago(ts: number | null, now = Date.now() / 1000): string {
  if (!ts) return "never";
  const s = Math.max(0, now - ts);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
