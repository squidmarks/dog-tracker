import { openDb, type Db } from "./db.js";

/** Mongo-backed tests use an isolated database (dogtracker_test) and skip when MONGO_URL isn't set. */
export const mongoUrl = process.env.MONGO_URL;
export const hasMongo = !!mongoUrl;
export const testDbName = process.env.TEST_MONGO_DB ?? "dogtracker_test";

export async function freshDb(): Promise<Db> {
  const db = await openDb(mongoUrl!, testDbName);
  await db.wipe();
  return db;
}
