import express from "express";
import type { Db, DogInput, DogLive, Settings, ZoneInput } from "./db.js";
import { decimate } from "./decimate.js";
import { circleRing } from "./geo.js";
import type { MeshEvent } from "./decode.js";
import { isSimNode, SCENARIOS, type Scenario, startSimulator } from "./sim.js";

const MAX_TRACK_POINTS = 2500;

export type Sim = ReturnType<typeof startSimulator>;

export interface Hooks {
  onDogChanged: (id: string) => unknown;
  onDogDeleted: (id: string) => unknown;
  /** Zones or alert settings changed. */
  onZonesChanged: () => unknown;
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

  // Track for a window: `hours` back from now, or an explicit `from`/`to` (epoch seconds). Capped at 31 days
  // and thinned to MAX_TRACK_POINTS so a week-long view doesn't ship thousands of points per dog.
  app.get("/api/dogs/:id/track", async (req, res) => {
    const nowS = Math.floor(Date.now() / 1000);
    const MAX_SPAN = 31 * 24 * 3600;
    let to = req.query.to != null ? Number(req.query.to) : nowS;
    let from = req.query.from != null ? Number(req.query.from) : to - Math.min(Number(req.query.hours ?? 24), 24 * 31) * 3600;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return res.status(400).json({ error: "bad time range" });
    from = Math.max(from, to - MAX_SPAN);
    res.json(decimate(await db.dogTrack(req.params.id, from, to), MAX_TRACK_POINTS));
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

  const broadcast = (ev: MeshEvent | { kind: "dogs" | "zones" } | { kind: "event"; event: unknown }) => {
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
