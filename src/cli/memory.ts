import { loadConfig } from "../config.ts";
import { openAndMigrate } from "../db/index.ts";
import { MemoryStore } from "../memory/store.ts";
import { MemoryService } from "../memory/service.ts";
import { CodexRunner } from "../research/codex.ts";
const cfg = loadConfig();
const db = openAndMigrate(cfg.dbPath);
try {
  const runner = new CodexRunner(cfg);
  if (!(await runner.isReady()))
    throw new Error("Sign in the bot's Codex profile before extracting memory");
  const before = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) n FROM sources WHERE extracted_hash=content_hash AND deleted_at IS NULL",
    )
    .get()!.n;
  await new MemoryService(
    { ...cfg, memoryEnabled: true },
    new MemoryStore(db),
    runner,
  ).refresh();
  const after = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) n FROM sources WHERE extracted_hash=content_hash AND deleted_at IS NULL",
    )
    .get()!.n;
  console.log({
    sourcesProcessed: after - before,
    activeNotes: db
      .prepare(
        "SELECT COUNT(*) count FROM memories WHERE stale_at IS NULL AND superseded_by IS NULL",
      )
      .get(),
  });
} finally {
  db.close();
}
