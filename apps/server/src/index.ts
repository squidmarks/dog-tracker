import { createApp, type Sim } from "./api.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import type { MeshEvent } from "./decode.js";
import { circleRing } from "./geo.js";
import { startHa } from "./ha.js";
import { HubMonitor } from "./hubs.js";
import { createClient, startIngest } from "./ingest.js";
import { createNotifier } from "./notify.js";
import { createPusher } from "./push.js";
import { serial } from "./queue.js";
import { Monitor } from "./rules.js";
import { circleArea, ringArea, startSimulator } from "./sim.js";

const db = await openDb(config.mongoUrl, config.mongoDb);
console.log(`[db] connected to Mongo database ${config.mongoDb}`);

// First run only: turn the YARD_* env settings into a real, editable zone.
if (config.yard && (await db.zones()).length === 0) {
  await db.createZone({ name: "Yard", ring: circleRing(config.yard.lat, config.yard.lon, config.yard.radiusM), alertOn: "exit", home: true });
  console.log("[zones] seeded 'Yard' from YARD_LAT/YARD_LON");
}

const client = createClient();
const notifier = createNotifier();
const pusher = createPusher(db);
console.log(`[pushover] ${notifier.enabled ? "enabled" : "disabled (set PUSHOVER_TOKEN and PUSHOVER_USER)"}`);
console.log(`[webpush] ${pusher.enabled ? "enabled" : "disabled (set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)"}`);

let sim: Sim | null = null;
let broadcast: (ev: Parameters<ReturnType<typeof createApp>["broadcast"]>[0]) => void = () => {};

/** Fan an event out: live UI, Home Assistant, and (when alerting and switched on) the phone. */
const deliver = async (e: import("./db.js").DogEvent) => {
  console.log(`[event] ${e.alert ? "ALERT " : ""}${e.message}`);
  broadcast({ kind: "event", event: e });
  ha.publishEvent(e);
  if (!e.alert) return;
  // Each channel is independent: Pushover has a server-wide switch, Web Push goes to every subscribed device.
  if ((await db.settings()).pushoverEnabled) await notifier.notify(e);
  await pusher.notify(e);
};

const hubs = new HubMonitor(db, async (e) => { await deliver(e); broadcast({ kind: "hubs" }); void ha.publishHubs(); });
const monitor = new Monitor(db, deliver, () => hubs.allDown());
const ha = startHa(client, db, monitor, () => hubs.list());
await hubs.load();
await monitor.reload(true);
setInterval(() => monitor.tick().catch((e) => console.error("[monitor]", e)), 30_000).unref();
setInterval(() => hubs.tick().catch((e) => console.error("[hubs]", e)), 15_000).unref();

const api = createApp(db, {
  onDogChanged: ha.onDogChanged,
  onDogDeleted: ha.onDogDeleted,
  onZonesChanged: async () => { await monitor.reload(true); await ha.onZonesChanged(); },
  listHubs: () => hubs.list(),
  setHubLocation: (id, lat, lon) => hubs.setLocation(id, lat, lon),
  onSnoozeChanged: () => monitor.onSnoozeChanged(),
  notifications: {
    pushoverConfigured: notifier.enabled,
    webPushConfigured: pusher.enabled,
    vapidPublicKey: pusher.publicKey,
    testPushover: () => notifier.test(),
    testWebPush: async (endpoint) => {
      const sub = (await db.pushSubscriptions()).find((s) => s.endpoint === endpoint);
      return sub ? pusher.sendTo(sub, { title: "Dog Tracker", body: "Test notification. Native notifications work on this device.", tag: "test", url: "/" }) : false;
    },
  },
  getSim: () => sim,
});
broadcast = api.broadcast;

/** A new (non-duplicate) packet was stored: evaluate zones first so Home Assistant sees the new membership. */
const onNewEvent = async (ev: MeshEvent) => {
  try {
    if (ev.kind === "position") await monitor.onPosition(ev.node, ev.lat, ev.lon);
    broadcast(ev);
    await ha.onEvent(ev.node);
  } catch (e) { console.error("[event]", e); }
};
startIngest(client, db, onNewEvent, {
  onGateway: (id) => hubs.onPacket(id),
  onBrokerLog: (line) => hubs.onBrokerLog(line),
});

if (config.simDogs > 0) {
  const centre = config.yard ?? { lat: 45.1705877, lon: -64.7541067, radiusM: 40 };
  const enqueue = serial();
  // The simulated dogs live in your real yard zone (and follow it when you redraw it); a plain circle until one exists.
  const getArea = () => { const ring = monitor.playRing(); return ring ? ringArea(centre, ring) : circleArea(config.yard?.radiusM ?? 40); };
  sim = startSimulator({
    count: config.simDogs, centre, getArea, getHub: () => hubs.located(), tickS: config.simTickS,
    apply: (ev) => enqueue(async () => { if (await db.apply(ev)) await onNewEvent(ev); }),
  });
  console.log(`[sim] ${config.simDogs} simulated trackers around ${centre.lat},${centre.lon}`);
}

api.app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
