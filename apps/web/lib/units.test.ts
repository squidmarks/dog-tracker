import { describe, expect, it } from "vitest";
import { batteryHoursLeft, formatDistance, formatDuration, formatSpeed } from "./units";

describe("formatting", () => {
  it("shows miles and mph by default", () => {
    expect(formatDistance(1609.344)).toBe("1.00 mi");
    expect(formatDistance(250)).toBe("0.16 mi");
    expect(formatDistance(20_000)).toBe("12.4 mi");
    expect(formatSpeed(10)).toBe("22.4 mph");
  });
  it("can show metric", () => {
    expect(formatDistance(250, "metric")).toBe("250 m");
    expect(formatDistance(1500, "metric")).toBe("1.50 km");
    expect(formatSpeed(10, "metric")).toBe("36.0 km/h");
  });
  it("formats durations", () => {
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(3720)).toBe("1 h 02 min");
  });
});

describe("batteryHoursLeft", () => {
  const series = (start: number, perHour: number, hours: number, step = 0.5) =>
    Array.from({ length: Math.floor(hours / step) + 1 }, (_, i) => ({ ts: 1000 + i * step * 3600, battery: start - perHour * i * step }));

  it("extrapolates a steady drain", () => {
    expect(batteryHoursLeft(series(80, 2, 6))!).toBeCloseTo(34, 0);        // 68% left, 2%/h
  });
  it("gives nothing for a flat or charging battery, or too little data", () => {
    expect(batteryHoursLeft(series(80, 0, 6))).toBeNull();
    expect(batteryHoursLeft(series(40, -5, 4))).toBeNull();                 // rising
    expect(batteryHoursLeft(series(80, 2, 0.5))).toBeNull();                // under 30 min of history
    expect(batteryHoursLeft([])).toBeNull();
  });
  it("ignores the 'charging' marker", () => {
    const s = [...series(80, 2, 3), { ts: 1000 + 4 * 3600, battery: 101 }];
    expect(batteryHoursLeft(s)).not.toBeNull();
  });
});
