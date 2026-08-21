import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client";

/**
 * `out/main/` in dev, `resources/app.asar.unpacked/` once packaged — electron-builder puts
 * the folder there (08.7). UNOTTR_MIGRATIONS_DIR is the escape hatch for tests.
 */
export function migrationsDir(): string {
  return process.env.UNOTTR_MIGRATIONS_DIR || join(__dirname, "../../drizzle");
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: migrationsDir() });
}
