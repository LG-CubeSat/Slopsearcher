import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db/index.ts";
import type { SourceIndex } from "./index/index.ts";
export function projectKey(cfg: Config): string {
  return createHash("sha256")
    .update(JSON.stringify([cfg.discordGuildId, cfg.driveSourceFolderId]))
    .digest("hex");
}
/** Changing project configuration must not expose a previous project's index
 * or resume an agent whose thread contains sources from the old scope. */
export function bindProject(cfg: Config, db: Db, index: SourceIndex): void {
  db.transaction(() => {
    const state = (key: string) =>
      db
        .prepare<[string], { value: string }>(
          "SELECT value FROM service_state WHERE key=?",
        )
        .get(key)?.value;
    const previousGuild = state("project.guild");
    const previousDrive = state("project.drive");
    const key = projectKey(cfg);
    db.prepare(
      "UPDATE tasks SET status='cancelled',error='Project configuration changed; start a new task for the current project',runner_thread_id=NULL,report_text=NULL,progress_json='{}',delivery_pending=0,updated_at=? WHERE project_key != ? AND status IN ('pending','running','paused')",
    ).run(Date.now(), key);
    db.prepare(
      "UPDATE tasks SET delivery_pending=0 WHERE project_key != ?",
    ).run(key);
    const changed =
      (previousGuild !== undefined && previousGuild !== cfg.discordGuildId) ||
      (previousDrive !== undefined &&
        previousDrive !== cfg.driveSourceFolderId);
    for (const row of db
      .prepare<[string], { external_id: string }>(
        "SELECT external_id FROM sources WHERE kind='discord' AND deleted_at IS NULL AND url NOT LIKE ?",
      )
      .all(`https://discord.com/channels/${cfg.discordGuildId}/%`))
      index.retire("discord", row.external_id);
    if (previousDrive !== cfg.driveSourceFolderId) {
      for (const row of db
        .prepare<[], { external_id: string }>(
          "SELECT external_id FROM sources WHERE kind='drive' AND deleted_at IS NULL",
        )
        .all())
        index.retire("drive", row.external_id);
      db.prepare("DELETE FROM drive_files").run();
    }
    if (changed) {
      db.prepare(
        "UPDATE tasks SET status='cancelled',error='Project configuration changed; start a new task for the current project',runner_thread_id=NULL,report_text=NULL,progress_json='{}',delivery_pending=0,updated_at=? WHERE status IN ('pending','running','paused')",
      ).run(Date.now());
      db.prepare("UPDATE tasks SET delivery_pending=0").run();
      db.prepare(
        "DELETE FROM service_state WHERE key='discord-reconciled'",
      ).run();
    }
    const save = db.prepare(
      "INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
    save.run("project.guild", cfg.discordGuildId);
    save.run("project.drive", cfg.driveSourceFolderId);
  })();
}
