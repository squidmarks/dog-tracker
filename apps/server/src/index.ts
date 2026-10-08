import { createApp, type Sim } from "./api.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { startHa } from "./ha.js";
import { createClient, startIngest } from "./ingest.js";
import type { MeshEvent } from "./decode.js";
import { startSimulator } from "./sim.js";

const db = openDb(config.dbPath);
const client = createClient();
const ha = startHa(client, db);
let sim: Sim | null = null;
const { app, broadcast } = createApp(db, ha.rename, () => sim);

const handle = (ev: MeshEvent) => {
  if (!db.apply(ev)) return;
  broadcast(ev);
  ha.onEvent(ev.node);
};
startIngest(client, db, (ev) => { broadcast(ev); ha.onEvent(ev.node); });

if (config.simDogs > 0) {
  const centre = config.yard ?? { lat: 45.1705877, lon: -64.7541067, radiusM: 40 };
  sim = startSimulator({ count: config.simDogs, centre, yardRadiusM: config.yard?.radiusM ?? 40, tickS: config.simTickS, apply: handle });
  console.log(`[sim] ${config.simDogs} simulated dogs around ${centre.lat},${centre.lon}`);
}

app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
