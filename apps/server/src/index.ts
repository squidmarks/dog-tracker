import { createApp } from "./api.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { startIngest } from "./ingest.js";

const db = openDb(config.dbPath);
const { app, broadcast } = createApp(db);
startIngest(db, broadcast);
app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
