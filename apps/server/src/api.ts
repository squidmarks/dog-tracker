import express from "express";
import type { Db, DogInput, DogLive, Settings, ZoneInput } from "./db.js";
import { decimate } from "./decimate.js";
import { computeStats, coverageGaps, heatCells } from "./stats.js";
import { circleRing } from "./geo.js";
import type { Hub } from "./hubs.js";
import type { MeshEvent } from "./decode.js";
import { isSimNode, SCENARIOS, type Scenario, startSimulator } from "./sim.js";

const MAX_TRACK_POINTS = 2500;

export type Sim = ReturnType<typeof startSimulator>;

export interface Hooks {
  onDogChanged: (id: string) => unknown;
  onDogDeleted: (id: string) => unknown;
  /** Zones or alert settings changed. */
  onZonesChanged: () => unknown;
  listHubs: () => Promise<Hub[]>;
  setHubLocation: (id: string, lat: number | null, lon: number | null) => Promise<boolean>;
  onSnoozeChanged: () => unknown;
  notifications: {
    pushoverConfigured: boolean;
    webPushConfigured: boolean;
    vapidPublicKey: string | null;
    testPushover: () => Promise<boolean>;
    testWebPush: (endpoint: string) => Promise<boolean>;
  };
  getSim: () => Sim | null;
}

/** Accept only the editable dog fields from a request body. */
function dogInput(body: Record<string, unknown> | undefined): DogInput {
  const out: DogInput = {};
  for (const k of ["name", "color", "emoji", "breed", "notes", "tracker", "alerts"] as const) {
    if (body && k in body) (out as Record<string, unknown>)[k] = body[k] === "" ? null : body[k];
  }
  if (out.name === null) out.name = "";
  return out;
}

/** Zone bodies may carry `circle: {lat, lon, radiusM}` instead of a ring (the "circle shortcut"). */
function zoneInput(body: Record<string, any> | undefined): ZoneInput {
  const out: ZoneInput = {};
  if (!body) return out;
  for (const k of ["name", "color", "alertOn", "home", "dogs"] as const) if (k in body) (out as any)[k] = body[k];
  if (body.circle) {
    const { lat, lon, radiusM } = body.circle;
    if (![lat, lon, radiusM].every((n) => Number.isFinite(n)) || radiusM <= 0 || radiusM > 5000) throw new Error("Invalid circle");
    out.ring = circleRing(lat, lon, radiusM);
  } else if (body.ring) out.ring = body.ring;
  return out;
}

export function createApp(db: Db, hooks: Hooks) {
  const app = express();
  app.use(express.json());
  const streams = new Set<express.Response>();

  const dogSim = (d: DogLive) => ({ ...d, sim: isSimNode(d.tracker ?? "") });

  // --- Trackers: every radio heard on the channel; the unclaimed ones with a GPS fix are the "inbox" ---
  app.get("/api/trackers", async (_req, res) => res.json((await db.trackers()).map((t) => ({ ...t, sim: isSimNode(t.id) }))));

  // --- Dogs ---
  app.get("/api/dogs", async (_req, res) => res.json((await db.dogs()).map(dogSim)));

  app.post("/api/dogs", async (req, res) => {
    try {
      const id = await db.createDog(dogInput(req.body));
      await hooks.onDogChanged(id);
      res.status(201).json(dogSim((await db.dog(id))!));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.patch("/api/dogs/:id", async (req, res) => {
    const id = req.params.id;
    try {
      if (!(await db.updateDog(id, dogInput(req.body)))) return res.status(404).json({ error: "unknown dog" });
      await hooks.onDogChanged(id);
      res.json(dogSim((await db.dog(id))!));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.delete("/api/dogs/:id", async (req, res) => {
    const id = req.params.id;
    if (!(await db.deleteDog(id))) return res.status(404).json({ error: "unknown dog" });
    await hooks.onDogDeleted(id);
    res.json({ ok: true });
  });

  /** Shared by the track, stats, heat and telemetry endpoints: `from`/`to` (epoch seconds) or `hours` back from now. */
  const windowOf = (req: express.Request, defaultHours = 24): { from: number; to: number } | null => {
    const nowS = Math.floor(Date.now() / 1000);
    const MAX_SPAN = 31 * 24 * 3600;
    const to = req.query.to != null ? Number(req.query.to) : nowS;
    let from = req.query.from != null ? Number(req.query.from) : to - Math.min(Number(req.query.hours ?? defaultHours), 24 * 31) * 3600;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
    from = Math.max(from, to - MAX_SPAN);
    return { from, to };
  };
  const badRange = (res: express.Response) => res.status(400).json({ error: "bad time range" });

  // Track for a window, capped at 31 days and thinned to MAX_TRACK_POINTS so a week-long view doesn't ship
  // thousands of points per dog.
  app.get("/api/dogs/:id/track", async (req, res) => {
    const w = windowOf(req);
    if (!w) return badRange(res);
    res.json(decimate(await db.dogTrack(req.params.id, w.from, w.to), MAX_TRACK_POINTS));
  });

  // Distance, top speed and moving time for one dog over a window.
  app.get("/api/dogs/:id/stats", async (req, res) => {
    const w = windowOf(req);
    if (!w) return badRange(res);
    res.json(computeStats(await db.dogTrack(req.params.id, w.from, w.to)));
  });

  // Stats for every dog at once (the leaderboard).
  app.get("/api/stats", async (req, res) => {
    const w = windowOf(req);
    if (!w) return badRange(res);
    const dogs = await db.dogs();
    res.json(await Promise.all(dogs.map(async (d) => ({
      dogId: d.id, name: d.name, emoji: d.emoji, color: d.color, sim: isSimNode(d.tracker ?? ""),
      stats: computeStats(await db.dogTrack(d.id, w.from, w.to)),
    }))));
  });

  // Where the dog spent its time: aggregated cells weighted by seconds, for the heat map (long views).
  app.get("/api/dogs/:id/heat", async (req, res) => {
    const w = windowOf(req);
    if (!w) return badRange(res);
    const cell = Math.min(50, Math.max(2, Number(req.query.cell ?? 5)));
    res.json(heatCells(await db.dogTrack(req.params.id, w.from, w.to), cell));
  });

  // Signal quality along the route, and the stretches where the dog went silent: the coverage map.
  app.get("/api/dogs/:id/signal", async (req, res) => {
    const w = windowOf(req, 24 * 7);
    if (!w) return badRange(res);
    const track = await db.dogTrack(req.params.id, w.from, w.to);
    const points = track.filter((p) => p.snr != null || p.rssi != null).map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, snr: p.snr, rssi: p.rssi }));
    res.json({ points: decimate(points, 3000), gaps: coverageGaps(track) });
  });

  // Battery, voltage and collar temperature history, for the battery chart.
  app.get("/api/dogs/:id/telemetry", async (req, res) => {
    const w = windowOf(req, 48);
    if (!w) return badRange(res);
    res.json(decimate(await db.dogTelemetry(req.params.id, w.from, w.to), 600));
  });

  // --- Zones ---
  app.get("/api/zones", async (_req, res) => res.json(await db.zones()));
  app.post("/api/zones", async (req, res) => {
    try {
      const id = await db.createZone(zoneInput(req.body));
      await hooks.onZonesChanged();
      res.status(201).json((await db.zones()).find((z) => z.id === id));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.patch("/api/zones/:id", async (req, res) => {
    try {
      if (!(await db.updateZone(req.params.id, zoneInput(req.body)))) return res.status(404).json({ error: "unknown zone" });
      await hooks.onZonesChanged();
      res.json((await db.zones()).find((z) => z.id === req.params.id));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.delete("/api/zones/:id", async (req, res) => {
    if (!(await db.deleteZone(req.params.id))) return res.status(404).json({ error: "unknown zone" });
    await hooks.onZonesChanged();
    res.json({ ok: true });
  });

  // --- Notification channels: Pushover (one account, server-wide) and Web Push (one subscription per device) ---
  app.get("/api/notifications", async (_req, res) => {
    const [settings, devices] = await Promise.all([db.settings(), db.pushSubscriptions()]);
    res.json({
      pushover: { configured: hooks.notifications.pushoverConfigured, enabled: settings.pushoverEnabled },
      webPush: {
        configured: hooks.notifications.webPushConfigured, publicKey: hooks.notifications.vapidPublicKey,
        devices: devices.map(({ endpoint, label, createdAt, lastOk }) => ({ endpoint, label, createdAt, lastOk: lastOk ?? null })),
      },
    });
  });
  app.post("/api/push/subscribe", async (req, res) => {
    try {
      const { subscription, label } = req.body ?? {};
      await db.savePushSubscription({ endpoint: subscription?.endpoint, keys: subscription?.keys, label: String(label ?? "Device").slice(0, 60) });
      res.status(201).json({ ok: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.delete("/api/push/subscribe", async (req, res) => {
    const endpoint = String(req.body?.endpoint ?? "");
    (await db.removePushSubscription(endpoint)) ? res.json({ ok: true }) : res.status(404).json({ error: "unknown device" });
  });
  app.post("/api/push/test", async (req, res) => {
    const ok = await hooks.notifications.testWebPush(String(req.body?.endpoint ?? ""));
    ok ? res.json({ ok: true }) : res.status(502).json({ error: "The push service didn't accept the test (is this device still subscribed?)" });
  });
  app.post("/api/pushover/test", async (_req, res) => {
    const ok = await hooks.notifications.testPushover();
    ok ? res.json({ ok: true }) : res.status(502).json({ error: hooks.notifications.pushoverConfigured ? "Pushover rejected the message" : "Pushover isn't configured on the server" });
  });

  // --- Walking mode: snooze the exit/silence alerts for a while ---
  const MAX_SNOOZE_MIN = 8 * 60;
  const snoozeState = async () => { const until = await db.snooze(); return { active: until != null, until }; };
  app.get("/api/snooze", async (_req, res) => res.json(await snoozeState()));
  app.put("/api/snooze", async (req, res) => {
    const minutes = req.body?.minutes;
    if (minutes != null && (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > MAX_SNOOZE_MIN)) {
      return res.status(400).json({ error: `minutes must be between 0 and ${MAX_SNOOZE_MIN}, or null to end walking mode` });
    }
    await db.setSnooze(minutes ? Math.floor(Date.now() / 1000) + Math.round(minutes * 60) : null);
    await hooks.onSnoozeChanged();
    broadcast({ kind: "snooze" });
    res.json(await snoozeState());
  });

  // --- LoRa hubs (gateways) ---
  app.get("/api/hubs", async (_req, res) => res.json(await hooks.listHubs()));
  // Hubs have no GPS: place one on the map (or clear it with nulls) so range can be measured from it.
  app.patch("/api/hubs/:id", async (req, res) => {
    const { lat = null, lon = null } = req.body ?? {};
    if ((lat === null) !== (lon === null) || (lat !== null && (typeof lat !== "number" || typeof lon !== "number"))) return res.status(400).json({ error: "lat and lon must both be numbers, or both null" });
    try {
      if (!(await hooks.setHubLocation(req.params.id, lat, lon))) return res.status(404).json({ error: "unknown hub" });
      broadcast({ kind: "hubs" });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // --- Activity (events) and alert settings ---
  app.get("/api/events", async (req, res) => res.json(await db.events(Number(req.query.limit ?? 50))));
  app.get("/api/settings", async (_req, res) => res.json(await db.settings()));
  app.put("/api/settings", async (req, res) => {
    try {
      const s: Settings = await db.updateSettings(req.body ?? {});
      await hooks.onZonesChanged();
      res.json(s);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // --- Simulator controls (only when SIM_DOGS > 0) ---
  app.get("/api/sim", (_req, res) => {
    const sim = hooks.getSim();
    res.json({ enabled: !!sim, scenarios: SCENARIOS,
      dogs: sim?.dogs.map((d) => ({ id: d.id, name: d.name, scenario: d.scenario, silentUntil: d.silentUntil })) ?? [] });
  });
  app.post("/api/sim/:id/:scenario", (req, res) => {
    const sim = hooks.getSim();
    const scenario = req.params.scenario as Scenario;
    if (!sim || !SCENARIOS.includes(scenario)) return res.status(400).json({ error: "bad request" });
    const minutes = Number(req.query.minutes ?? 30);
    sim.trigger(req.params.id, scenario, minutes) ? res.json({ ok: true }) : res.status(404).json({ error: "unknown sim tracker" });
  });
  app.delete("/api/sim/nodes", async (_req, res) => {
    const { nodes, dogIds } = await db.deleteSimNodes();
    for (const id of dogIds) await hooks.onDogDeleted(id); // retract their Home Assistant entities too
    res.json({ removed: nodes });
  });

  // Server-sent events: the web UI refetches on each event.
  app.get("/api/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(": hello\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
  });

  const broadcast = (ev: MeshEvent | { kind: "dogs" | "zones" | "hubs" | "snooze" } | { kind: "event"; event: unknown }) => {
    for (const s of streams) s.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  // Dog edits made in one browser tab should refresh the others.
  const { onDogChanged, onDogDeleted } = hooks;
  hooks.onDogChanged = async (id) => { await onDogChanged(id); broadcast({ kind: "dogs" }); };
  hooks.onDogDeleted = async (id) => { await onDogDeleted(id); broadcast({ kind: "dogs" }); };
  const onZonesChanged = hooks.onZonesChanged;
  hooks.onZonesChanged = async () => { await onZonesChanged(); broadcast({ kind: "zones" }); };

  return { app, broadcast };
}
