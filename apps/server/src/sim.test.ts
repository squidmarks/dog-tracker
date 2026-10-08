import { describe, expect, it } from "vitest";
import { circleRing } from "./geo.js";
import { type Area, circleArea, isSimNode, ringArea, stepDog, toLatLon, type SimDog } from "./sim.js";

const dog = (over: Partial<SimDog> = {}): SimDog =>
  ({ id: "!fa000001", name: "t", x: 0, y: 0, heading: 0, scenario: "wander", silentUntil: 0, battery: 80, paused: 0, ...over });

const run = (d: SimDog, area: Area, steps: number, dt: number, until?: () => boolean) => {
  for (let i = 0; i < steps && !(until?.()); i++) stepDog(d, dt, area);
};

describe("simulator", () => {
  it("recognises simulated node ids", () => {
    expect(isSimNode("!fa000001")).toBe(true);
    expect(isSimNode("!49b7716c")).toBe(false);
  });

  it("converts metres to lat/lon", () => {
    expect(toLatLon({ lat: 45, lon: -64 }, 0, 111.195).lat).toBeCloseTo(45.001, 5);
  });

  describe.each([
    ["a circle", circleArea(40)],
    // A lopsided yard NOT centred on the reference point (the case that broke "return"): a 60 x 30 m rectangle 80 m east.
    ["an off-centre polygon", ringArea({ lat: 45, lon: -64 }, [
      [-64 + 50 / 78_600, 45 - 15 / 111_195], [-64 + 110 / 78_600, 45 - 15 / 111_195],
      [-64 + 110 / 78_600, 45 + 15 / 111_195], [-64 + 50 / 78_600, 45 + 15 / 111_195], [-64 + 50 / 78_600, 45 - 15 / 111_195]])],
  ])("in %s", (_name, area) => {
    const start = () => dog({ x: area.centre.x, y: area.centre.y });

    it("keeps a wandering dog inside, even on big time steps", () => {
      const d = start();
      for (let i = 0; i < 4000; i++) { stepDog(d, 15, area); expect(area.signedDist(d.x, d.y)).toBeLessThan(0); }
    });

    it("an escaping dog leaves the area; a returning dog comes back inside and resumes wandering", () => {
      const d = start();
      d.scenario = "escape";
      run(d, area, 200, 5, () => area.signedDist(d.x, d.y) > 15);
      expect(area.signedDist(d.x, d.y)).toBeGreaterThan(15);
      d.scenario = "return";
      run(d, area, 400, 5, () => d.scenario !== "return");
      expect(d.scenario).toBe("wander");
      expect(area.signedDist(d.x, d.y)).toBeLessThan(-10);
    });

    it("return makes visible progress from the first step", () => {
      const d = start();
      d.scenario = "escape";
      run(d, area, 200, 5, () => area.signedDist(d.x, d.y) > 15);
      const before = Math.hypot(d.x - area.centre.x, d.y - area.centre.y);
      d.scenario = "return";
      stepDog(d, 5, area);
      expect(Math.hypot(d.x - area.centre.x, d.y - area.centre.y)).toBeLessThan(before - 5);
    });
  });

  it("builds a ring area whose centre is inside the ring", () => {
    const area = ringArea({ lat: 45, lon: -64 }, circleRing(45, -64, 30));
    expect(area.signedDist(area.centre.x, area.centre.y)).toBeLessThan(0);
  });
});
