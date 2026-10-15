import Database from "better-sqlite3";
import { loadConfig } from "../config.ts";
try {
  const db = new Database(loadConfig().dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const heartbeat = db
      .prepare<[], { value: string }>(
        "SELECT value FROM service_state WHERE key='runtime-heartbeat'",
      )
      .get();
    if (!heartbeat || Date.now() - Number(heartbeat.value) > 120000)
      throw new Error("Bot heartbeat is missing or stale");
    console.log("healthy");
  } finally {
    db.close();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : "Bot health check failed");
  process.exitCode = 1;
}
