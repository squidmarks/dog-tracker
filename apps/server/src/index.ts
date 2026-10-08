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
const { app, broadcast } = createApp(db, {
  onDogChanged: ha.onDogChanged,
  onDogDeleted: ha.onDogDeleted,
  getSim: () => sim,
});

const onNewEvent = (ev: MeshEvent) => { broadcast(ev); ha.onEvent(ev.node); };
startIngest(client, db, onNewEvent);

if (config.simDogs > 0) {
  const centre = config.yard ?? { lat: 45.1705877, lon: -64.7541067, radiusM: 40 };
  sim = startSimulator({
    count: config.simDogs, centre, yardRadiusM: config.yard?.radiusM ?? 40, tickS: config.simTickS,
    apply: (ev) => { if (db.apply(ev)) onNewEvent(ev); },
  });
  console.log(`[sim] ${config.simDogs} simulated trackers around ${centre.lat},${centre.lon}`);
}

app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
