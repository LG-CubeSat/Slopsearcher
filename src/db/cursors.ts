import type { Db } from "./index.ts";

export type CursorScope =
  | "discord"
  | "drive"
  | "discord-history-v2"
  | "discord-backfill-before"
  | "discord-reconcile"
  | "discord-catchup";

export function getCursor(
  db: Db,
  scope: CursorScope,
  key: string,
): string | null {
  const row = db
    .prepare<[string, string], { value: string }>(
      "SELECT value FROM cursors WHERE scope = ? AND key = ?",
    )
    .get(scope, key);
  return row?.value ?? null;
}

export function setCursor(
  db: Db,
  scope: CursorScope,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO cursors (scope, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(scope, key, value, Date.now());
}
