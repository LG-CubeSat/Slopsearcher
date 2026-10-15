import { expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate } from "./db/index.ts";
import { SourceIndex } from "./index/index.ts";
import { createBackup } from "./backup.ts";
it("backs up a live WAL database with searchable content and owner-only permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slop-backup-"));
  const path = join(dir, "live.db");
  const db = openAndMigrate(path);
  try {
    new SourceIndex(db).upsert({
      kind: "drive",
      externalId: "d",
      url: "https://drive.google.com/d",
      text: "A durable radio decision",
      ts: 1,
    });
    const backup = await createBackup(db, path);
    const restored = openAndMigrate(backup);
    try {
      expect(new SourceIndex(restored).search("radio")).toHaveLength(1);
      expect(statSync(backup).mode & 0o077).toBe(0);
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
