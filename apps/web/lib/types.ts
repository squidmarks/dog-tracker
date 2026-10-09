export interface Live {
  battery: number | null; voltage: number | null; last_heard: number | null;
  lat: number | null; lon: number | null; pos_ts: number | null; speed: number | null; sats: number | null;
  gateway: string | null; rssi: number | null; snr: number | null;
  heading?: number | null; hdop?: number | null; temperature?: number | null; lux?: number | null;
}
export interface Dog extends Live {
  id: string; name: string; color: string | null; emoji: string | null; breed: string | null; notes: string | null;
  tracker: string | null; alerts: boolean; sim?: boolean;
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
export type EventType = "zone_exit" | "zone_enter" | "silent" | "reporting" | "low_battery" | "battery_ok" | "hub_offline" | "hub_online" | "snooze_ended";
export interface DogEvent {
  id: string; ts: number; type: EventType; dogId: string; dogName: string; zoneId?: string; zoneName?: string;
  lat?: number | null; lon?: number | null; alert: boolean; message: string; sim?: boolean;
  /** Would have alerted, but walking mode was on. */
  snoozed?: boolean;
}
export interface Settings {
  staleMinutes: number; lowBatteryPct: number; fenceMarginM: number; hubSilentMinutes: number; pushoverEnabled: boolean;
}
export interface Hub {
  id: string; name: string; status: "online" | "offline"; since: number; lastPacket: number | null;
  /** Set when the hub has been placed on the map (it has no GPS of its own). */
  lat: number | null; lon: number | null;
  /** A collar relayed through a phone (comes and goes with the walk): shown, but never alerts. */
  mobile?: boolean;
}
export interface SignalPoint { ts: number; lat: number; lon: number; snr: number | null; rssi: number | null }
export interface CoverageGap { from: { ts: number; lat: number; lon: number }; to: { ts: number; lat: number; lon: number }; seconds: number }
export interface Signal { points: SignalPoint[]; gaps: CoverageGap[] }
export interface Notifications {
  pushover: { configured: boolean; enabled: boolean };
  webPush: { configured: boolean; publicKey: string | null; devices: { endpoint: string; label: string; createdAt: number; lastOk: number | null }[] };
}
/** Zone drawing in progress on the map. Points are [lon, lat]; a circle is [centre, edge]. */
export interface DrawState { mode: "polygon" | "circle"; points: [number, number][]; zoneId?: string }

export const EVENT_ICON: Record<EventType, string> = {
  zone_exit: "🚪", zone_enter: "📍", silent: "📡", reporting: "✅", low_battery: "🪫", battery_ok: "🔋",
  hub_offline: "🔌", hub_online: "🛰️", snooze_ended: "⏰",
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

// --- Track window: which part of each dog's history to draw, fading with age ---
export type RangePreset = "hour" | "today" | "yesterday" | "week" | "custom";
export interface TrackRange { preset: RangePreset; customFrom?: number; customTo?: number }
export const RANGE_LABEL: Record<RangePreset, string> = {
  hour: "Last hour", today: "Today", yesterday: "Yesterday", week: "Last 7 days", custom: "Custom…",
};

/** Resolve a preset to concrete epoch seconds. `rolling` windows end "now" and move with the clock. */
export function resolveRange(r: TrackRange, nowS = Date.now() / 1000): { from: number; to: number; rolling: boolean } {
  const midnight = new Date(nowS * 1000); midnight.setHours(0, 0, 0, 0);
  const today0 = midnight.getTime() / 1000;
  switch (r.preset) {
    case "hour": return { from: nowS - 3600, to: nowS, rolling: true };
    case "today": return { from: today0, to: nowS, rolling: true };
    case "yesterday": return { from: today0 - 86400, to: today0, rolling: false };
    case "week": return { from: nowS - 7 * 86400, to: nowS, rolling: true };
    case "custom": {
      const to = r.customTo ?? nowS;
      return { from: r.customFrom ?? today0, to, rolling: r.customTo == null };
    }
  }
}
/** Identity of a range that doesn't change as the clock ticks (used to know when to refetch). */
export const rangeKey = (r: TrackRange) => `${r.preset}:${r.customFrom ?? ""}:${r.customTo ?? ""}`;

// --- What the trail layer shows -------------------------------------------------------------------------------
// "Recent" is a rolling window that fades to nothing at its far end; "History" is a fixed or day-based window,
// drawn as a heat map (where the dog spent its time) or as faded trails.
export const RECENT_STOPS = [5, 10, 15, 30, 60, 120, 240, 360]; // minutes, the slider's positions
export type TrailView =
  | { mode: "recent"; minutes: number }
  | { mode: "history"; range: TrackRange; style: "heat" | "trails" }
  /** Where the signal was strong or weak along the route, and where reports dropped out. */
  | { mode: "coverage"; range: TrackRange };

export const minutesLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${(m / 60).toFixed(1)} h`);

export interface ResolvedView {
  from: number; to: number; rolling: boolean;
  kind: "trails" | "heat" | "coverage";
  /** Recent trails fade all the way out; long trails keep a faint floor so the whole day stays legible. */
  fadeToZero: boolean;
  /** How often to refetch while the window is rolling, in seconds. */
  refreshS: number;
}

export function resolveView(v: TrailView, nowS = Date.now() / 1000): ResolvedView {
  if (v.mode === "recent") {
    return { from: nowS - v.minutes * 60, to: nowS, rolling: true, kind: "trails", fadeToZero: true, refreshS: 5 };
  }
  const r = resolveRange(v.range, nowS);
  if (v.mode === "coverage") return { ...r, kind: "coverage", fadeToZero: false, refreshS: 20 };
  return { ...r, kind: v.style === "heat" ? "heat" : "trails", fadeToZero: false, refreshS: v.style === "heat" ? 20 : 10 };
}
/** Identity of a view that doesn't change as the clock ticks (used to know when to refetch). */
export const viewKey = (v: TrailView) =>
  v.mode === "recent" ? `recent:${v.minutes}` : v.mode === "coverage" ? `coverage:${rangeKey(v.range)}` : `history:${rangeKey(v.range)}:${v.style}`;

// --- Activity stats (distances in metres, speeds in m/s; see lib/units.ts for display) ------------------------
export interface TopSpeed { mps: number; ts: number; lat: number; lon: number; source: "reported" | "derived" }
export interface Stats { fixes: number; distanceM: number; movingS: number; topSpeed: TopSpeed | null; medianIntervalS: number | null }
export interface LeaderRow { dogId: string; name: string; emoji: string | null; color: string | null; sim: boolean; stats: Stats }
export interface HeatCell { lat: number; lon: number; w: number }
export interface TelemetryPoint { ts: number; battery: number | null; voltage: number | null; temperature: number | null; lux: number | null }
