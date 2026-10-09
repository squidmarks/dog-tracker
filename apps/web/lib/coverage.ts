import { distanceM } from "./geo";
import type { CoverageGap, Hub, SignalPoint } from "./types";

/** Signal quality buckets, best to worst. LoRa works below the noise floor, so SNR is the honest measure: a long-range
 *  preset still decodes down to about -17 dB, and "near the limit" means the next step back is a dropped report. */
export const QUALITY = [
  { label: "Strong", color: "#2e9e5b", hint: "SNR 5 dB or better" },
  { label: "Good", color: "#9ccc3c", hint: "SNR 0 to 5 dB" },
  { label: "Marginal", color: "#f2a541", hint: "SNR -10 to 0 dB" },
  { label: "Near the limit", color: "#d64545", hint: "SNR below -10 dB" },
] as const;

/** Index into QUALITY (0 = strong). Falls back to RSSI when the hub didn't report an SNR. */
export function quality(p: Pick<SignalPoint, "snr" | "rssi">): number {
  if (p.snr != null) return p.snr >= 5 ? 0 : p.snr >= 0 ? 1 : p.snr >= -10 ? 2 : 3;
  if (p.rssi != null) return p.rssi >= -95 ? 0 : p.rssi >= -105 ? 1 : p.rssi >= -115 ? 2 : 3;
  return 2;
}

export function signalGeoJSON(points: SignalPoint[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: points.map((p) => ({
    type: "Feature", properties: { q: quality(p) }, geometry: { type: "Point", coordinates: [p.lon, p.lat] },
  })) };
}

/** Dashed lines across the stretches where reports dropped out. */
export function gapsGeoJSON(gaps: CoverageGap[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: gaps.map((g) => ({
    type: "Feature", properties: { seconds: g.seconds },
    geometry: { type: "LineString", coordinates: [[g.from.lon, g.from.lat], [g.to.lon, g.to.lat]] },
  })) };
}

/** The farthest report the hub actually heard, measured from where the hub was placed. */
export function farthestHeard(hub: Pick<Hub, "lat" | "lon">, points: SignalPoint[]): { metres: number; point: SignalPoint } | null {
  if (hub.lat == null || hub.lon == null || !points.length) return null;
  let best: { metres: number; point: SignalPoint } | null = null;
  for (const p of points) {
    const metres = distanceM(hub.lat, hub.lon, p.lat, p.lon);
    if (!best || metres > best.metres) best = { metres, point: p };
  }
  return best;
}
