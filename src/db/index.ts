import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../log.ts";

export type Db = Database.Database;

const log = logger("db");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

/**
 * Opens the database with the pragmas the rest of the service assumes:
 * WAL so indexing writes never block a read, and foreign keys on so the
 * memory -> source citation link cannot dangle.
 */
export function openDb(path: string): Db {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const db = new Database(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM schema_migrations")
      .all()
      .map((row) => row.name),
  );

  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !applied.has(name));

  if (pending.length === 0) {
    log.debug("schema up to date");
    return;
  }

  const record = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const name of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    // Each migration is its own transaction: a failure half-way through one
    // file rolls that file back without losing the ones before it.
    db.transaction(() => {
      db.exec(sql);
      record.run(name, Date.now());
    })();
    log.info(`applied migration ${name}`);
  }
}

export function openAndMigrate(path: string): Db {
  const db = openDb(path);
  migrate(db);
  return db;
}

/** Nightly backup target; safe to run against a live WAL database. */
export function backupTo(db: Db, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  db.prepare("VACUUM INTO ?").run(destination);
}
