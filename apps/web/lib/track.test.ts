import { describe, expect, it } from "vitest";
import { trackSegments } from "./track";
import { resolveRange } from "./types";

const pt = (ts: number, lon: number) => ({ ts, lat: 45, lon });

describe("trackSegments", () => {
  // 4 points a minute apart, then a 30-minute silence, then 2 more points.
  const track = [pt(1000, 0), pt(1060, 1), pt(1120, 2), pt(1180, 3), pt(1180 + 1800, 4), pt(1180 + 1860, 5)];

  it("breaks the trail across a long silence instead of drawing a straight line over it", () => {
    expect(trackSegments(track, 1000, 3040).features).toHaveLength(4);
  });

  it("gives older segments a higher age, normalised to the window", () => {
    const ages = trackSegments(track, 1000, 3040).features.map((f) => (f.properties as { a: number }).a);
    expect(ages[0]).toBeGreaterThan(ages[2]);
    expect(ages[2]).toBeGreaterThan(ages[3]);
    for (const a of ages) { expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(1); }
  });

  it("handles empty and single-point tracks", () => {
    expect(trackSegments([], 0, 10).features).toHaveLength(0);
    expect(trackSegments([pt(5, 0)], 0, 10).features).toHaveLength(0);
  });
});

describe("resolveRange", () => {
  const noon = new Date(2026, 9, 8, 12, 0, 0).getTime() / 1000;

  it("today runs from local midnight to now and keeps rolling", () => {
    const r = resolveRange({ preset: "today" }, noon);
    expect(new Date(r.from * 1000).getHours()).toBe(0);
    expect([r.to, r.rolling]).toEqual([noon, true]);
  });

  it("yesterday is the previous local day and doesn't roll", () => {
    const today = resolveRange({ preset: "today" }, noon);
    const y = resolveRange({ preset: "yesterday" }, noon);
    expect(y.to - y.from).toBe(86400);
    expect(y.to).toBe(today.from);
    expect(y.rolling).toBe(false);
  });

  it("hour and week are rolling windows", () => {
    expect(resolveRange({ preset: "hour" }, noon).from).toBe(noon - 3600);
    expect(resolveRange({ preset: "week" }, noon).from).toBe(noon - 7 * 86400);
  });

  it("custom is fixed with an end, rolling without one", () => {
    expect(resolveRange({ preset: "custom", customFrom: 100, customTo: 200 }, noon)).toEqual({ from: 100, to: 200, rolling: false });
    expect(resolveRange({ preset: "custom", customFrom: 100 }, noon).rolling).toBe(true);
  });
});
