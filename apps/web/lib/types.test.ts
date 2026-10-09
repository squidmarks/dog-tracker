import { describe, expect, it } from "vitest";
import { minutesLabel, RECENT_STOPS, resolveView, viewKey } from "./types";

describe("resolveView", () => {
  const noon = new Date(2026, 9, 8, 12, 0, 0).getTime() / 1000;

  it("recent is a rolling window that fades to nothing", () => {
    const v = resolveView({ mode: "recent", minutes: 30 }, noon);
    expect(v).toMatchObject({ from: noon - 1800, to: noon, rolling: true, kind: "trails", fadeToZero: true });
  });

  it("history draws a heat map by default for a day, and keeps a floor on trails", () => {
    const heat = resolveView({ mode: "history", range: { preset: "today" }, style: "heat" }, noon);
    expect(heat).toMatchObject({ kind: "heat", fadeToZero: false, rolling: true });
    const trails = resolveView({ mode: "history", range: { preset: "yesterday" }, style: "trails" }, noon);
    expect(trails).toMatchObject({ kind: "trails", rolling: false });
  });

  it("a view's key changes with its settings but not with the clock", () => {
    const a = viewKey({ mode: "recent", minutes: 30 });
    expect(viewKey({ mode: "recent", minutes: 30 })).toBe(a);
    expect(viewKey({ mode: "recent", minutes: 60 })).not.toBe(a);
    expect(viewKey({ mode: "history", range: { preset: "today" }, style: "heat" }))
      .not.toBe(viewKey({ mode: "history", range: { preset: "today" }, style: "trails" }));
  });

  it("coverage looks at a day-based range, refreshes slowly, and has its own key", () => {
    const v = resolveView({ mode: "coverage", range: { preset: "week" } }, noon);
    expect(v).toMatchObject({ kind: "coverage", rolling: true, fadeToZero: false });
    expect(viewKey({ mode: "coverage", range: { preset: "week" } })).not.toBe(viewKey({ mode: "history", range: { preset: "week" }, style: "heat" }));
  });

  it("slider stops are ordered and labelled", () => {
    expect([...RECENT_STOPS].sort((x, y) => x - y)).toEqual(RECENT_STOPS);
    expect(minutesLabel(30)).toBe("30 min");
    expect(minutesLabel(120)).toBe("2 h");
    expect(minutesLabel(90)).toBe("1.5 h");
  });
});
