import { describe, expect, it } from "vitest";
import { isSimNode, stepDog, toLatLon, type SimDog } from "./sim.js";

const dog = (over: Partial<SimDog> = {}): SimDog =>
  ({ id: "!fa000001", name: "t", x: 0, y: 0, heading: 0, scenario: "wander", silentUntil: 0, battery: 80, paused: 0, ...over });

describe("simulator", () => {
  it("recognises simulated node ids", () => {
    expect(isSimNode("!fa000001")).toBe(true);
    expect(isSimNode("!49b7716c")).toBe(false);
  });

  it("keeps a wandering dog inside the yard", () => {
    const d = dog();
    for (let i = 0; i < 5000; i++) stepDog(d, 10, 40);
    expect(Math.hypot(d.x, d.y)).toBeLessThan(40);
  });

  it("an escaping dog leaves the yard, a returning dog comes back and resumes wandering", () => {
    const d = dog({ scenario: "escape" });
    for (let i = 0; i < 60; i++) stepDog(d, 10, 40);
    expect(Math.hypot(d.x, d.y)).toBeGreaterThan(40);
    d.scenario = "return";
    for (let i = 0; i < 200 && d.scenario === "return"; i++) stepDog(d, 10, 40);
    expect(d.scenario).toBe("wander");
    expect(Math.hypot(d.x, d.y)).toBeLessThan(40);
  });

  it("converts metres to lat/lon", () => {
    const p = toLatLon({ lat: 45, lon: -64 }, 0, 111.195);
    expect(p.lat).toBeCloseTo(45.001, 5);
  });
});
