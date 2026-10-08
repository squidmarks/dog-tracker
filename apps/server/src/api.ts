import express from "express";
import type { Db } from "./db.js";
import type { MeshEvent } from "./decode.js";

export function createApp(db: Db, onRename: (id: string) => void = () => {}) {
  const app = express();
  app.use(express.json());
  const streams = new Set<express.Response>();

  app.get("/api/nodes", (_req, res) => res.json(db.nodes()));

  app.get("/api/nodes/:id/track", (req, res) => {
    const hours = Math.min(Number(req.query.hours ?? 24), 24 * 30);
    res.json(db.track(req.params.id, Math.floor(Date.now() / 1000) - hours * 3600));
  });

  app.patch("/api/nodes/:id", (req, res) => {
    const { name = null, color = null } = req.body ?? {};
    if (db.rename(req.params.id, name, color)) { onRename(req.params.id); res.json({ ok: true }); }
    else res.status(404).json({ error: "unknown node" });
  });

  // Server-sent events: the web UI refetches /api/nodes (or patches state) on each event.
  app.get("/api/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(": hello\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
  });

  const broadcast = (ev: MeshEvent) => {
    for (const s of streams) s.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  return { app, broadcast };
}
