import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/** An OS-backed lock shared across PID namespaces and released after crashes.
 * Keep this database file: unlinking it could allow a second inode to be locked.
 * It is separate from the project database so normal SQLite writes stay free.
 */
export function runtimeLock(dbPath: string): () => void {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const path = `${dbPath}.runtime-lock.db`;
  const lock = new Database(path, { timeout: 0 });
  try {
    chmodSync(path, 0o600);
    lock.exec(
      "CREATE TABLE IF NOT EXISTS runtime_lock (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;",
    );
  } catch (error) {
    lock.close();
    if (error instanceof Database.SqliteError && error.code === "SQLITE_BUSY")
      throw new Error(`Another Slopsearcher process is using ${dbPath}`);
    throw error;
  }
  return () => {
    if (lock.open) lock.close();
  };
}
