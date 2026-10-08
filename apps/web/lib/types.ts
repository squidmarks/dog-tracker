export interface Live {
  battery: number | null; voltage: number | null; last_heard: number | null;
  lat: number | null; lon: number | null; pos_ts: number | null; speed: number | null; sats: number | null;
  gateway: string | null; rssi: number | null; snr: number | null;
}
export interface Dog extends Live {
  id: number; name: string; color: string | null; emoji: string | null; breed: string | null; notes: string | null;
  tracker: string | null; sim?: boolean;
}
/** A radio heard on the channel. Unclaimed ones with a GPS fix are the "new trackers" inbox. */
export interface Tracker extends Live {
  id: string; long_name: string | null; short_name: string | null;
  has_position: number; dog_id: number | null; dog_name: string | null; sim?: boolean;
}
export interface TrackPoint { ts: number; lat: number; lon: number }
export interface SimState {
  enabled: boolean; scenarios: string[];
  dogs: { id: string; name: string; scenario: string; silentUntil: number }[];
}

export const PALETTE = ["#e4572e", "#2e86ab", "#76b041", "#a23b72", "#f2a541", "#17bebb", "#6c5ce7", "#8d6e63"];
export const EMOJIS = ["🐕", "🐶", "🐩", "🦮", "🐕‍🦺", "🐾"];
export const dogColor = (d: Pick<Dog, "id" | "color">) => d.color ?? PALETTE[d.id % PALETTE.length];
export const dogEmoji = (d: Pick<Dog, "emoji">) => d.emoji ?? "🐕";
export const trackerLabel = (t: Pick<Tracker, "id" | "long_name">) => t.long_name ?? t.id;

export function ago(ts: number | null, now = Date.now() / 1000): string {
  if (!ts) return "never";
  const s = Math.max(0, now - ts);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const batteryLabel = (b: number | null) => (b == null ? "" : b > 100 ? "charging" : `${b}%`);
