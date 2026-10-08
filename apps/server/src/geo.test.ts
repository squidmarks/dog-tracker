import { describe, expect, it } from "vitest";
import { circleRing, distanceM, Membership, pointInRing, signedDistanceM } from "./geo.js";

const C = { lat: 45, lon: -64 };
const north = (m: number) => C.lat + m / 111_195;
const square = circleRing(C.lat, C.lon, 40, 4); // a diamond with vertices 40 m out

describe("geometry", () => {
  it("measures ~111 km per degree of latitude", () => {
    expect(Math.round(distanceM(45, -64, 46, -64) / 1000)).toBe(111);
  });

  it("builds a closed circle ring of the right radius", () => {
    const ring = circleRing(C.lat, C.lon, 40);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lo, la] of ring) {
      expect(distanceM(C.lat, C.lon, la, lo)).toBeGreaterThan(39);
      expect(distanceM(C.lat, C.lon, la, lo)).toBeLessThan(41);
    }
  });

  it("tests point-in-polygon", () => {
    expect(pointInRing(C.lat, C.lon, square)).toBe(true);
    expect(pointInRing(north(60), C.lon, square)).toBe(false);
  });

  it("gives signed distance to the edge (negative inside)", () => {
    const ring = circleRing(C.lat, C.lon, 40);
    expect(signedDistanceM(C.lat, C.lon, ring)).toBeCloseTo(-40, 0);
    expect(signedDistanceM(north(50), C.lon, ring)).toBeCloseTo(10, 0);
  });
});

describe("Membership hysteresis", () => {
  const ring = circleRing(C.lat, C.lon, 40);
  const fix = (m: Membership, metresNorth: number) => m.update("d:z", north(metresNorth), C.lon, ring);

  it("first fix seeds state silently", () => {
    const m = new Membership();
    expect(fix(m, 100)).toBeNull();
    expect(m.isInside("d:z")).toBe(false);
  });

  it("needs two confirmed fixes past the margin to exit", () => {
    const m = new Membership(5, 2);
    fix(m, 10);
    expect(fix(m, 44)).toBeNull();          // outside the fence but inside the 5 m margin: nothing
    expect(fix(m, 50)).toBeNull();          // first confirmed fix
    expect(fix(m, 52)).toBe("exit");        // second: event
    expect(m.isInside("d:z")).toBe(false);
  });

  it("a single GPS spike does not raise an exit", () => {
    const m = new Membership(5, 2);
    fix(m, 10);
    expect(fix(m, 80)).toBeNull();          // spike
    expect(fix(m, 12)).toBeNull();          // back in: streak reset
    expect(fix(m, 80)).toBeNull();
    expect(m.isInside("d:z")).toBe(true);
  });

  it("raises enter when a dog comes back well inside", () => {
    const m = new Membership(5, 2);
    fix(m, 100);
    expect(fix(m, 38)).toBeNull();          // just inside the fence, within the margin: still outside
    expect(fix(m, 20)).toBeNull();
    expect(fix(m, 18)).toBe("enter");
  });
});
