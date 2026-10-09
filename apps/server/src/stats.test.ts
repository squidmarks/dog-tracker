import { describe, expect, it } from "vitest";
import { cleanFixes, computeStats, coverageGaps, heatCells, simplify, type Fix } from "./stats.js";

const LAT0 = 45, LON0 = -64;
const M = 111_195, COS = Math.cos((LAT0 * Math.PI) / 180);
/** A fix `eastM`/`northM` metres from the origin. */
const at = (ts: number, eastM: number, northM: number, extra: Partial<Fix> = {}): Fix =>
  ({ ts, lat: LAT0 + northM / M, lon: LON0 + eastM / (M * COS), ...extra });

describe("distance", () => {
  it("does not count a resting dog's GPS wobble as travel", () => {
    const wobble = [[0, 0], [3, 1], [-2, 3], [1, -3], [-3, -1], [2, 2], [0, -2], [3, -2]];
    const fixes = Array.from({ length: 200 }, (_, i) => { const [x, y] = wobble[i % wobble.length]; return at(i * 15, x, y); });
    expect(computeStats(fixes).distanceM).toBeLessThan(20);              // naive summing would be ~800 m
  });

  it("measures a straight walk accurately", () => {
    const fixes = Array.from({ length: 21 }, (_, i) => at(i * 20, i * 10, 0)); // 200 m east at 0.5 m/s
    expect(computeStats(fixes).distanceM).toBeCloseTo(200, -1);
  });

  it("follows a turn", () => {
    const fixes = [...Array.from({ length: 11 }, (_, i) => at(i * 10, i * 10, 0)), ...Array.from({ length: 10 }, (_, i) => at(110 + i * 10, 100, (i + 1) * 10))];
    expect(computeStats(fixes).distanceM).toBeCloseTo(200, -1);
  });

  it("never joins fixes across a long silence", () => {
    const fixes = [at(0, 0, 0), at(30, 50, 0), at(3600, 5000, 0), at(3630, 5050, 0)]; // collar carried 5 km while off
    expect(computeStats(fixes).distanceM).toBeCloseTo(100, -1);
  });
});

describe("top speed", () => {
  it("uses the collar's reported speed when it's the best evidence", () => {
    const fixes = [at(0, 0, 0, { speed: 1 }), at(10, 20, 0, { speed: 9 }), at(20, 40, 0, { speed: 2 })];
    expect(computeStats(fixes).topSpeed).toMatchObject({ mps: 9, source: "reported" });
  });

  it("derives a speed from consecutive fixes when no speed was reported", () => {
    const fixes = [at(0, 0, 0), at(10, 30, 0), at(20, 40, 0)];              // 3 m/s then 1 m/s
    const top = computeStats(fixes).topSpeed!;
    expect(top.source).toBe("derived");
    expect(top.mps).toBeCloseTo(3, 1);
    expect(top.lon).toBeCloseTo(LON0 + 30 / (M * COS), 6);                    // located where the burst ended
  });

  it("ignores a one-off GPS spike", () => {
    const fixes = [at(0, 0, 0), at(10, 5, 0), at(20, 800, 600), at(30, 10, 0), at(40, 12, 0)];
    const s = computeStats(fixes);
    expect(s.topSpeed === null || s.topSpeed.mps < 2).toBe(true);
    expect(s.distanceM).toBeLessThan(40);
  });

  it("rejects physically impossible speeds", () => {
    const fixes = [at(0, 0, 0, { speed: 60 }), at(10, 20, 0, { speed: 8 })];
    expect(computeStats(fixes).topSpeed).toMatchObject({ mps: 8 });
  });

  it("has no top speed for a dog that never moved", () => {
    expect(computeStats([at(0, 0, 0), at(30, 1, 1), at(60, 0, 1)]).topSpeed).toBeNull();
  });
});

describe("moving time and quality", () => {
  it("counts time spent moving but not time standing or silent", () => {
    const fixes = [at(0, 0, 0), at(10, 0, 0), at(20, 0, 0),                      // standing 20 s
      at(30, 15, 0), at(40, 30, 0), at(50, 45, 0),                               // moving 30 s
      at(2000, 45, 0)];                                                          // long silence
    const s = computeStats(fixes);
    expect(s.movingS).toBe(30);
    expect(s.medianIntervalS).toBe(10);
  });

  it("drops fixes the collar itself flagged as poor", () => {
    const fixes = [at(0, 0, 0), at(10, 500, 0, { hdop: 9 }), at(20, 5, 0, { sats: 2 }), at(30, 10, 0)];
    expect(cleanFixes(fixes).map((f) => f.ts)).toEqual([0, 30]);
  });

  it("handles empty and single fixes", () => {
    expect(computeStats([])).toMatchObject({ fixes: 0, distanceM: 0, topSpeed: null });
    expect(computeStats([at(0, 0, 0)]).distanceM).toBe(0);
  });
});

describe("simplify", () => {
  it("keeps the corners of an L and drops points on a straight line", () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 0.5 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 20 }];
    expect(simplify(pts, 2)).toEqual([0, 2, 4]);
  });
});

describe("heatCells", () => {
  it("weights cells by time spent, not by number of fixes", () => {
    const fixes = [at(0, 0, 0), at(100, 0, 0.5), at(110, 200, 0), at(120, 400, 0)];  // 100 s at the origin, then moving on
    const cells = heatCells(fixes, 5, 120);
    expect(cells[0].w).toBeGreaterThanOrEqual(100);
    expect(cells[0].lon).toBeCloseTo(LON0, 5);
    expect(cells.length).toBeGreaterThanOrEqual(3);
  });
  it("caps the number of cells", () => {
    const fixes = Array.from({ length: 500 }, (_, i) => at(i * 5, i * 20, 0));
    expect(heatCells(fixes, 5, 120, 50)).toHaveLength(50);
  });
});

describe("coverageGaps", () => {
  const steady = (from: number, to: number, step = 30, east = 0) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => at(from + i * step, east + i, 0));

  it("finds the silence where coverage dropped out, with where the dog was either side of it", () => {
    const fixes = [...steady(0, 300), ...steady(1200, 1500, 30, 400)];     // reporting every 30 s, silent from 300 s to 1200 s
    const gaps = coverageGaps(fixes);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ seconds: 900, from: { ts: 300 }, to: { ts: 1200 } });
    expect(gaps[0].to.lon).toBeGreaterThan(gaps[0].from.lon);
  });

  it("ignores ordinary spacing and slow reporters, and silences too long to be a signal drop", () => {
    expect(coverageGaps(steady(0, 3000, 30))).toEqual([]);
    expect(coverageGaps(steady(0, 6000, 600))).toEqual([]);                // reports every 10 min: not a gap
    expect(coverageGaps([at(0, 0, 0), at(8 * 3600, 5, 0)])).toEqual([]);   // 8 h: collar off or charging
  });

  it("handles nothing and one fix", () => {
    expect(coverageGaps([])).toEqual([]);
    expect(coverageGaps([at(0, 0, 0)])).toEqual([]);
  });
});
