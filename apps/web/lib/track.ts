import type { TrackPoint } from "./types";

export const MAX_GAP_S = 15 * 60; // a silent stretch longer than this breaks the trail instead of drawing a false straight line

/** Break a track into one short line per consecutive pair of points. `a` is its age within the window (0 = newest,
 *  1 = oldest), which the layer turns into opacity, so the trail fades by time rather than by distance. */
export function trackSegments(track: TrackPoint[], from: number, to: number): GeoJSON.FeatureCollection {
  const span = Math.max(1, to - from);
  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < track.length; i++) {
    const p0 = track[i - 1], p1 = track[i];
    if (p1.ts - p0.ts > MAX_GAP_S) continue;
    const a = Math.min(1, Math.max(0, 1 - ((p0.ts + p1.ts) / 2 - from) / span));
    features.push({ type: "Feature", properties: { a }, geometry: { type: "LineString", coordinates: [[p0.lon, p0.lat], [p1.lon, p1.lat]] } });
  }
  return { type: "FeatureCollection", features };
}
