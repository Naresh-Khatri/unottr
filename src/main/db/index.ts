import { dbFile } from "../paths";
import { type Db, openDatabase } from "./client";
import { runMigrations } from "./migrate";

let instance: Db | null = null;

/** Opened and migrated on first use, then reused for the life of the process. */
export function db(): Db {
  if (!instance) {
    instance = openDatabase(dbFile());
    runMigrations(instance);
  }
  return instance;
}

export function closeDatabase(): void {
  instance?.$client.close();
  instance = null;
}

export * from "./schema";
