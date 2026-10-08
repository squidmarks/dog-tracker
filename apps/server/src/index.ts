import { createApp } from "./api.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { startHa } from "./ha.js";
import { createClient, startIngest } from "./ingest.js";

const db = openDb(config.dbPath);
const client = createClient();
const ha = startHa(client, db);
const { app, broadcast } = createApp(db, ha.rename);
startIngest(client, db, (ev) => {
  broadcast(ev);
  ha.onEvent(ev.node);
});
app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
