import { randomUUID } from "node:crypto";
import type { Db } from "./db/index.ts";
export function instanceId(db: Db): string {
  db.prepare(
    "INSERT OR IGNORE INTO service_state(key,value) VALUES('instance-id',?)",
  ).run(randomUUID());
  return db
    .prepare<[], { value: string }>(
      "SELECT value FROM service_state WHERE key='instance-id'",
    )
    .get()!.value;
}
