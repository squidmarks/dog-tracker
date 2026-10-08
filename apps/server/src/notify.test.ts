import { describe, expect, it, vi } from "vitest";
import type { DogEvent } from "./db.js";
import { createNotifier } from "./notify.js";

const ev = (over: Partial<DogEvent> = {}): DogEvent =>
  ({ id: "1", ts: 1700000000, type: "zone_exit", dogId: "d", dogName: "Ozzie", alert: true, message: "Ozzie left Yard", ...over });

describe("Pushover notifier", () => {
  it("is disabled and silent without credentials", async () => {
    const f = vi.fn();
    const n = createNotifier({}, f as unknown as typeof fetch);
    expect(n.enabled).toBe(false);
    expect(await n.notify(ev())).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("sends alerts at high priority with a link back to the app", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    const n = createNotifier({ PUSHOVER_TOKEN: "t", PUSHOVER_USER: "u", PUBLIC_URL: "https://dogs.example" }, f as unknown as typeof fetch);
    expect(await n.notify(ev())).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.pushover.net/1/messages.json");
    const body = new URLSearchParams(init.body);
    expect(Object.fromEntries(body)).toMatchObject({ token: "t", user: "u", title: "Ozzie", message: "Ozzie left Yard", priority: "1", url: "https://dogs.example" });
  });

  it("does not push non-alert events, and survives network errors", async () => {
    const f = vi.fn().mockRejectedValue(new Error("offline"));
    const n = createNotifier({ PUSHOVER_TOKEN: "t", PUSHOVER_USER: "u" }, f as unknown as typeof fetch);
    expect(await n.notify(ev({ alert: false }))).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(await n.notify(ev({ type: "low_battery" }))).toBe(false);   // fetch rejects: logged, not thrown
  });
});
