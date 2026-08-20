import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client";

/**
 * `out/main/` in dev, `resources/app.asar.unpacked/` once packaged — electron-builder puts
 * the folder there (08.7). UNOTTR_MIGRATIONS_DIR is the escape hatch for tests.
 */
export function migrationsDir(): string {
  return process.env.UNOTTR_MIGRATIONS_DIR || join(__dirname, "../../drizzle");
}

/**
 * Also stamps `user_version = 4`, which drizzle does not use and sqlite does not care about.
 * It exists so the rust cli (still the only working pipeline until 08.5) sees a schema at its
 * own latest version and refuses to re-apply migrations over these tables. Delete with
 * `crates/` in 08.7.
 */
export function runMigrations(db: Db): void {
  adoptRustSchema(db);
  migrate(db, { migrationsFolder: migrationsDir() });
  db.$client.pragma("user_version = 4");
}

/** 0000_init + 0001_fts, the two that rust V4 already describes. Everything after is ours to run. */
const RUST_V4_MIGRATIONS = 2;

/**
 * The other half of the bridge. A database the rust build created already has these tables,
 * so drizzle's migrator would die on `CREATE TABLE recordings`. Rust V4 and `0000_init.sql`
 * + `0001_fts.sql` describe the same schema, so record them as applied instead of running
 * them. Only for `user_version = 4` — an older rust db is genuinely incompatible and gets
 * the normal (loud) failure. Delete with `crates/` in 08.7.
 */
function adoptRustSchema(db: Db): void {
  const sqlite = db.$client;
  const table = (name: string): boolean =>
    sqlite.prepare("select 1 from sqlite_master where type='table' and name=?").get(name) !== undefined;

  if (table("__drizzle_migrations") || !table("recordings")) return;
  if ((sqlite.pragma("user_version", { simple: true }) as number) !== 4) return;

  // hashes are content-derived, so a throwaway database produces exactly the rows this one needs
  const donor = new Database(":memory:");
  migrate(drizzle(donor), { migrationsFolder: migrationsDir() });
  const rows = (
    donor
      .prepare("select id, hash, created_at from __drizzle_migrations order by id")
      .all() as { id: number; hash: string; created_at: number }[]
  ).slice(0, RUST_V4_MIGRATIONS);
  donor.close();

  sqlite.exec(
    "create table if not exists __drizzle_migrations (id integer primary key autoincrement, hash text not null, created_at numeric)",
  );
  const insert = sqlite.prepare("insert into __drizzle_migrations (id, hash, created_at) values (?, ?, ?)");
  for (const r of rows) insert.run(r.id, r.hash, r.created_at);
}
