import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "./db/index.ts";
export async function createBackup(db: Db, dbPath: string): Promise<string> {
  const dir = join(dirname(dbPath), "backups"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = join(dir, `slopsearcher-${Date.now()}.db`);
  await db.backup(destination);
  const previous = readdirSync(dir).filter(n => /^slopsearcher-\d+\.db$/.test(n)).sort().reverse();
  for (const name of previous.slice(7)) unlinkSync(join(dir, name));
  return destination;
}
