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

describe("Membership", () => {
  const ring = circleRing(C.lat, C.lon, 40);
  const fix = (m: Membership, metresNorth: number) => m.update("d:z", north(metresNorth), C.lon, ring);

  it("first fix seeds state silently", () => {
    const m = new Membership();
    expect(fix(m, 100)).toBeNull();
    expect(m.isInside("d:z")).toBe(false);
  });

  it("leaving needs two fixes past the margin, or one fix far past the edge", () => {
    const m = new Membership({ exitMargin: 5 } as never);       // (legacy key ignored) defaults: margin 5, fast 8
    fix(m, 10);
    expect(fix(m, 44)).toBeNull();                              // 4 m past the 40 m fence: inside the 5 m margin
    expect(fix(m, 46.5)).toBeNull();                            // 6.5 m past: first confirmed fix
    expect(fix(m, 47)).toBe("exit");                            // second in a row
    const m2 = new Membership();
    fix(m2, 10);
    expect(fix(m2, 52)).toBe("exit");                           // 12 m past the fence: one fix is enough
    expect(m2.isInside("d:z")).toBe(false);
  });

  it("a single spike just past the margin does not raise an exit, and a spike resets the count", () => {
    const m = new Membership();
    fix(m, 10);
    expect(fix(m, 46)).toBeNull();
    expect(fix(m, 12)).toBeNull();                              // back in: streak reset
    expect(fix(m, 46)).toBeNull();
    expect(m.isInside("d:z")).toBe(true);
  });

  it("coming back counts after ONE fix inside, so indoor GPS wobble near the fence still ends an episode", () => {
    const m = new Membership();
    fix(m, 100);
    expect(fix(m, 41)).toBeNull();                              // just inside the fence, within the 3 m margin: still out
    expect(fix(m, 30)).toBe("enter");                           // 10 m inside: one fix
    expect(m.isInside("d:z")).toBe(true);
  });

  it("honours custom rules", () => {
    const m = new Membership({ fastExitM: 20, exitMarginM: 10, exitConfirm: 3, enterMarginM: 8 });
    fix(m, 10);
    expect(fix(m, 55)).toBeNull();                              // 15 m past: not far enough for the fast path
    expect(fix(m, 55)).toBeNull();
    expect(fix(m, 55)).toBe("exit");                            // third in a row
    expect(fix(m, 36)).toBeNull();                              // 4 m inside: under the 8 m re-entry margin
    expect(fix(m, 30)).toBe("enter");
  });

  it("forgets a dog's zones", () => {
    const m = new Membership();
    fix(m, 10);
    m.forget("d:");
    expect(m.has("d:z")).toBe(false);
  });
});
