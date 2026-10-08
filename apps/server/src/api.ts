import express from "express";
import type { Db, DogInput, DogLive } from "./db.js";
import type { MeshEvent } from "./decode.js";
import { isSimNode, SCENARIOS, type Scenario, startSimulator } from "./sim.js";

export type Sim = ReturnType<typeof startSimulator>;

export interface Hooks {
  onDogChanged: (id: number) => void;
  onDogDeleted: (id: number) => void;
  getSim: () => Sim | null;
}

/** Accept only the editable dog fields from a request body. */
function dogInput(body: Record<string, unknown> | undefined): DogInput {
  const out: DogInput = {};
  for (const k of ["name", "color", "emoji", "breed", "notes", "tracker"] as const) {
    if (body && k in body) (out as Record<string, unknown>)[k] = body[k] === "" ? null : body[k];
  }
  if (out.name === null) out.name = "";
  return out;
}

export function createApp(db: Db, hooks: Hooks) {
  const app = express();
  app.use(express.json());
  const streams = new Set<express.Response>();

  const dogSim = (d: DogLive) => ({ ...d, sim: isSimNode(d.tracker ?? "") });

  // --- Trackers: every radio heard on the channel; the unclaimed ones with a GPS fix are the "inbox" ---
  app.get("/api/trackers", (_req, res) => res.json((db.trackers() as { id: string }[]).map((t) => ({ ...t, sim: isSimNode(t.id) }))));

  // --- Dogs ---
  app.get("/api/dogs", (_req, res) => res.json(db.dogs().map(dogSim)));

  app.post("/api/dogs", (req, res) => {
    try {
      const id = db.createDog(dogInput(req.body));
      hooks.onDogChanged(id);
      res.status(201).json(dogSim(db.dog(id)!));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.patch("/api/dogs/:id", (req, res) => {
    const id = Number(req.params.id);
    try {
      if (!db.updateDog(id, dogInput(req.body))) return res.status(404).json({ error: "unknown dog" });
      hooks.onDogChanged(id);
      res.json(dogSim(db.dog(id)!));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.delete("/api/dogs/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!db.deleteDog(id)) return res.status(404).json({ error: "unknown dog" });
    hooks.onDogDeleted(id);
    res.json({ ok: true });
  });

  app.get("/api/dogs/:id/track", (req, res) => {
    const hours = Math.min(Number(req.query.hours ?? 24), 24 * 30);
    res.json(db.dogTrack(Number(req.params.id), Math.floor(Date.now() / 1000) - hours * 3600));
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
  app.delete("/api/sim/nodes", (_req, res) => {
    const removed = db.deleteSimNodes();
    res.json({ removed });
  });

  // Server-sent events: the web UI refetches on each event.
  app.get("/api/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(": hello\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
  });

  const broadcast = (ev: MeshEvent | { kind: "dogs" }) => {
    for (const s of streams) s.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  // Dog edits made in one browser tab should refresh the others.
  const { onDogChanged, onDogDeleted } = hooks;
  hooks.onDogChanged = (id) => { onDogChanged(id); broadcast({ kind: "dogs" }); };
  hooks.onDogDeleted = (id) => { onDogDeleted(id); broadcast({ kind: "dogs" }); };

  return { app, broadcast };
}
