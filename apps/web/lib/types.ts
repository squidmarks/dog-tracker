export interface Live {
  battery: number | null; voltage: number | null; last_heard: number | null;
  lat: number | null; lon: number | null; pos_ts: number | null; speed: number | null; sats: number | null;
  gateway: string | null; rssi: number | null; snr: number | null;
}
export interface Dog extends Live {
  id: string; name: string; color: string | null; emoji: string | null; breed: string | null; notes: string | null;
  tracker: string | null; sim?: boolean;
}
/** A radio heard on the channel. Unclaimed ones with a GPS fix are the "new trackers" inbox. */
export interface Tracker extends Live {
  id: string; long_name: string | null; short_name: string | null;
  has_position: boolean; dog_id: string | null; dog_name: string | null; sim?: boolean;
}
export interface TrackPoint { ts: number; lat: number; lon: number }
export interface SimState {
  enabled: boolean; scenarios: string[];
  dogs: { id: string; name: string; scenario: string; silentUntil: number }[];
}

export type AlertOn = "exit" | "enter" | "both" | "none";
export interface Zone {
  id: string; name: string; color: string; ring: [number, number][]; alertOn: AlertOn; home: boolean; dogs: string[] | null;
}
export type EventType = "zone_exit" | "zone_enter" | "silent" | "reporting" | "low_battery" | "battery_ok";
export interface DogEvent {
  id: string; ts: number; type: EventType; dogId: string; dogName: string; zoneId?: string; zoneName?: string;
  lat?: number | null; lon?: number | null; alert: boolean; message: string;
}
export interface Settings { staleMinutes: number; lowBatteryPct: number; fenceMarginM: number }
/** Zone drawing in progress on the map. Points are [lon, lat]; a circle is [centre, edge]. */
export interface DrawState { mode: "polygon" | "circle"; points: [number, number][]; zoneId?: string }

export const EVENT_ICON: Record<EventType, string> = {
  zone_exit: "🚪", zone_enter: "📍", silent: "📡", reporting: "✅", low_battery: "🪫", battery_ok: "🔋",
};
export const ALERT_LABEL: Record<AlertOn, string> = {
  exit: "Alert when a dog leaves", enter: "Alert when a dog enters", both: "Alert on both", none: "Log only, no alerts",
};

export const PALETTE = ["#e4572e", "#2e86ab", "#76b041", "#a23b72", "#f2a541", "#17bebb", "#6c5ce7", "#8d6e63"];
export const EMOJIS = ["🐕", "🐶", "🐩", "🦮", "🐕‍🦺", "🐾"];
// Mongo ObjectIds end in an incrementing counter, so the last hex digits spread dogs across the palette.
export const dogColor = (d: Pick<Dog, "id" | "color">) => d.color ?? PALETTE[parseInt(d.id.slice(-4), 16) % PALETTE.length];
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
