import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./api.js";
import { openDb, type Db } from "./db.js";

let db: Db, base: string, close: () => void;
const hooks = { onDogChanged: vi.fn(), onDogDeleted: vi.fn(), getSim: () => null };
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() as any };
};

beforeEach(async () => {
  hooks.onDogChanged.mockClear(); hooks.onDogDeleted.mockClear();
  db = openDb(":memory:");
  db.apply({ kind: "position", node: "!aaaa0001", packetId: 1, gateway: "!g", rssi: -80, snr: 5, ts: 100, lat: 45, lon: -64, alt: null, speed: null, sats: 8 }, 100);
  const server = createApp(db, { ...hooks }).app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterEach(() => close());

describe("dogs API", () => {
  it("lists a new tracker as unclaimed, then claims it by creating a dog", async () => {
    expect((await call("GET", "/api/trackers")).body[0]).toMatchObject({ id: "!aaaa0001", dog_id: null, has_position: 1 });
    const created = await call("POST", "/api/dogs", { name: "Ozzie", tracker: "!aaaa0001", color: "#e4572e" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Ozzie", tracker: "!aaaa0001", lat: 45 });
    expect((await call("GET", "/api/trackers")).body[0]).toMatchObject({ dog_name: "Ozzie" });
    expect(hooks.onDogChanged).toHaveBeenCalledTimes(1);
  });

  it("rejects a nameless dog and a double-claimed tracker with 409", async () => {
    expect((await call("POST", "/api/dogs", { name: "" })).status).toBe(409);
    await call("POST", "/api/dogs", { name: "Ozzie", tracker: "!aaaa0001" });
    const dup = await call("POST", "/api/dogs", { name: "Maple", tracker: "!aaaa0001" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already belongs to Ozzie/);
  });

  it("edits, unlinks and deletes", async () => {
    const { body: dog } = await call("POST", "/api/dogs", { name: "Ozzie", tracker: "!aaaa0001" });
    const edited = await call("PATCH", `/api/dogs/${dog.id}`, { breed: "Lab", tracker: "" });
    expect(edited.body).toMatchObject({ breed: "Lab", tracker: null });
    expect((await call("PATCH", "/api/dogs/999", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", `/api/dogs/${dog.id}`)).status).toBe(200);
    expect(hooks.onDogDeleted).toHaveBeenCalledWith(dog.id);
    expect((await call("GET", "/api/dogs")).body).toEqual([]);
  });
});
