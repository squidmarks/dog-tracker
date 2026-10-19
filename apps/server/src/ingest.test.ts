import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { onConnect } from "./ingest.js";

/** A stand-in MQTT client: an event emitter with the `connected` flag the real one has. */
const fakeClient = (connected: boolean) => Object.assign(new EventEmitter(), { connected }) as unknown as Parameters<typeof onConnect>[0] & EventEmitter;

describe("onConnect", () => {
  it("runs on a later connect, and again on every reconnect", () => {
    const c = fakeClient(false);
    const fn = vi.fn();
    onConnect(c, fn);
    expect(fn).not.toHaveBeenCalled();
    c.emit("connect"); c.emit("connect");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("runs straight away when the client connected before the listener was attached (the startup race)", () => {
    const c = fakeClient(true);                       // "connect" already fired; attaching a listener now would never hear it
    const fn = vi.fn();
    onConnect(c, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    c.emit("connect");                                // and still follows later reconnects
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
