import { describe, expect, it } from "vitest";
import { farthestHeard, gapsGeoJSON, quality, QUALITY, signalGeoJSON } from "./coverage";

describe("quality", () => {
  it("buckets by SNR", () => {
    expect([8, 5, 4.9, 0, -0.1, -10, -10.1, -16].map((snr) => quality({ snr, rssi: null }))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
  it("falls back to RSSI, and to 'marginal' when told nothing", () => {
    expect([-80, -100, -110, -125].map((rssi) => quality({ snr: null, rssi }))).toEqual([0, 1, 2, 3]);
    expect(quality({ snr: null, rssi: null })).toBe(2);
  });
  it("prefers SNR over RSSI when both are present", () => {
    expect(quality({ snr: 8, rssi: -130 })).toBe(0);
  });
  it("has a colour for every bucket", () => {
    expect(QUALITY).toHaveLength(4);
    expect(new Set(QUALITY.map((q) => q.color)).size).toBe(4);
  });
});

describe("geojson builders", () => {
  it("makes one point per report carrying its quality, [lon, lat]", () => {
    const fc = signalGeoJSON([{ ts: 1, lat: 45, lon: -64, snr: 8, rssi: -90 }, { ts: 2, lat: 45.1, lon: -64.1, snr: -12, rssi: -120 }]);
    expect(fc.features.map((f) => f.properties!.q)).toEqual([0, 3]);
    expect((fc.features[1].geometry as GeoJSON.Point).coordinates).toEqual([-64.1, 45.1]);
  });
  it("draws each silent stretch as a straight line between the reports either side", () => {
    const fc = gapsGeoJSON([{ from: { ts: 1, lat: 45, lon: -64 }, to: { ts: 901, lat: 45.01, lon: -64.01 }, seconds: 900 }]);
    expect((fc.features[0].geometry as GeoJSON.LineString).coordinates).toEqual([[-64, 45], [-64.01, 45.01]]);
  });
});

describe("farthestHeard", () => {
  const pts = [{ ts: 1, lat: 45.0, lon: -64, snr: 5, rssi: -90 }, { ts: 2, lat: 45.003, lon: -64, snr: -8, rssi: -112 }, { ts: 3, lat: 45.001, lon: -64, snr: 2, rssi: -100 }];
  it("measures the greatest distance from the placed hub", () => {
    const far = farthestHeard({ lat: 45, lon: -64 }, pts)!;
    expect(far.point.ts).toBe(2);
    expect(far.metres).toBeGreaterThan(330);
    expect(far.metres).toBeLessThan(340);
  });
  it("says nothing until the hub is placed or there's data", () => {
    expect(farthestHeard({ lat: null, lon: null }, pts)).toBeNull();
    expect(farthestHeard({ lat: 45, lon: -64 }, [])).toBeNull();
  });
});
