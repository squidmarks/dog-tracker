import { describe, expect, it } from "vitest";
import { discoveryMessages, startOfToday } from "./ha.js";

describe("Home Assistant discovery", () => {
  const msgs = discoveryMessages({ id: "abc", name: "Ozzie" }, [{ id: "z1", name: "Yard" }], true);
  const byKey = (k: string) => msgs.find((m) => m.topic.endsWith(`/${k}/config`))!;

  it("creates one device per dog with an entity for each thing we track", () => {
    expect(new Set(msgs.map((m) => (m.payload as { device: { name: string } }).device.name))).toEqual(new Set(["Ozzie"]));
    for (const k of ["location", "zone_z1", "alerts", "reporting", "battery", "last_seen", "signal", "distance_today", "top_speed_today", "moving_today", "collar_temperature", "satellites"]) {
      expect(byKey(k), k).toBeDefined();
    }
  });

  it("reports activity in SI units so Home Assistant can show them in yours", () => {
    expect(byKey("distance_today").payload).toMatchObject({ device_class: "distance", unit_of_measurement: "m" });
    expect(byKey("top_speed_today").payload).toMatchObject({ device_class: "speed", unit_of_measurement: "m/s" });
    expect(byKey("collar_temperature").payload).toMatchObject({ device_class: "temperature", unit_of_measurement: "°C" });
  });

  it("gives every entity a unique, stable id tied to the dog (not the radio)", () => {
    const ids = msgs.map((m) => (m.payload as { unique_id: string }).unique_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => i.startsWith("dogtracker_dogabc_"))).toBe(true);
  });
});

describe("startOfToday", () => {
  it("is local midnight", () => {
    const noon = new Date(2026, 9, 8, 12, 30, 0);
    const s = startOfToday(noon);
    expect(new Date(s * 1000).getHours()).toBe(0);
    expect(noon.getTime() / 1000 - s).toBe(12.5 * 3600);
  });
});
