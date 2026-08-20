import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Db = ReturnType<typeof openDatabase>;

/**
 * WAL is what lets the ui read while the compute worker writes, so each process opens its
 * own handle rather than sharing one. Same pragmas as `db::tune` in the rust build.
 */
export function openDatabase(file: string): ReturnType<typeof drizzle<typeof schema>> {
  mkdirSync(dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");

  return drizzle(sqlite, { schema });
}
