import type { Dog, DogEvent, Settings, SimState, Tracker, TrackPoint, Zone } from "./types";

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}
const send = (method: string, url: string, body?: unknown) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  dogs: () => fetch("/api/dogs").then((r) => json<Dog[]>(r)),
  trackers: () => fetch("/api/trackers").then((r) => json<Tracker[]>(r)),
  sim: () => fetch("/api/sim").then((r) => json<SimState>(r)),
  track: (dogId: string, hours = 6) => fetch(`/api/dogs/${dogId}/track?hours=${hours}`).then((r) => json<TrackPoint[]>(r)),
  createDog: (input: Partial<Dog>) => send("POST", "/api/dogs", input).then((r) => json<Dog>(r)),
  updateDog: (id: string, input: Partial<Dog>) => send("PATCH", `/api/dogs/${id}`, input).then((r) => json<Dog>(r)),
  deleteDog: (id: string) => send("DELETE", `/api/dogs/${id}`).then((r) => json<{ ok: true }>(r)),
  zones: () => fetch("/api/zones").then((r) => json<Zone[]>(r)),
  createZone: (input: Record<string, unknown>) => send("POST", "/api/zones", input).then((r) => json<Zone>(r)),
  updateZone: (id: string, input: Record<string, unknown>) => send("PATCH", `/api/zones/${id}`, input).then((r) => json<Zone>(r)),
  deleteZone: (id: string) => send("DELETE", `/api/zones/${id}`).then((r) => json<{ ok: true }>(r)),
  events: (limit = 30) => fetch(`/api/events?limit=${limit}`).then((r) => json<DogEvent[]>(r)),
  settings: () => fetch("/api/settings").then((r) => json<Settings>(r)),
  updateSettings: (input: Partial<Settings>) => send("PUT", "/api/settings", input).then((r) => json<Settings>(r)),
  trigger: (trackerId: string, scenario: string) =>
    send("POST", `/api/sim/${encodeURIComponent(trackerId)}/${scenario}?minutes=30`).then((r) => json<{ ok: true }>(r)),
  clearSim: () => send("DELETE", "/api/sim/nodes").then((r) => json<{ removed: number }>(r)),
};
