import { describe, expect, it } from "vitest";
import { decimate } from "./decimate.js";

describe("decimate", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => i);
  it("leaves short tracks alone", () => expect(decimate([1, 2, 3], 10)).toEqual([1, 2, 3]));
  it("caps the size and keeps both ends in order", () => {
    const out = decimate(pts, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(999);
    expect([...out].sort((a, b) => a - b)).toEqual(out);
  });
});
