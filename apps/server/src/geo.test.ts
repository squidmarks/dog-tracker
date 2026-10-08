import { describe, expect, it } from "vitest";
import { distanceM, Yard } from "./geo.js";

describe("geo", () => {
  it("measures ~111 km per degree of latitude", () => {
    expect(Math.round(distanceM(45, -64, 46, -64) / 1000)).toBe(111);
  });

  it("applies hysteresis at the fence line", () => {
    const yard = new Yard(45, -64, 40, 8);
    const at = (m: number) => 45 + m / 111_195; // metres north of centre
    expect(yard.update("a", at(10), -64)).toBe(true);
    expect(yard.update("a", at(45), -64)).toBe(true);  // inside radius+margin: still in
    expect(yard.update("a", at(60), -64)).toBe(false);
    expect(yard.update("a", at(45), -64)).toBe(false); // must come back within radius
    expect(yard.update("a", at(30), -64)).toBe(true);
  });
});
