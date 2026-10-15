import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";

export class BrowserArtifacts {
  constructor(
    private cfg: Config,
    private db: Db,
  ) {}
  private path(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid screenshot ID");
    return join(dirname(this.cfg.dbPath), "browser-screenshots", `${id}.jpg`);
  }
  async save(taskId: number, url: string, title: string, image: Buffer) {
    const count = this.db
      .prepare<[number], { n: number }>(
        "SELECT COUNT(*) n FROM browser_screenshots WHERE task_id=?",
      )
      .get(taskId)!.n;
    if (count >= 5)
      throw new Error("At most five shared screenshots are allowed per task");
    if (image.length > 2 * 1024 * 1024)
      throw new Error("Screenshot exceeds 2 MiB");
    const id = randomUUID();
    const path = this.path(id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, image, { mode: 0o600, flag: "wx" });
    try {
      this.db
        .prepare(
          "INSERT INTO browser_screenshots(id,task_id,url,title,created_at) VALUES(?,?,?,?,?)",
        )
        .run(id, taskId, url, title.slice(0, 300), Date.now());
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
    return { id, filename: `screenshot-${id}.jpg` };
  }
  async files(taskId: number) {
    const rows = this.db
      .prepare<[number], { id: string; url: string; title: string }>(
        "SELECT id,url,title FROM browser_screenshots WHERE task_id=? ORDER BY created_at,id LIMIT 5",
      )
      .all(taskId);
    const files = [];
    for (const row of rows) {
      const data = await readFile(this.path(row.id));
      files.push({
        data,
        name: `screenshot-${row.id}.jpg`,
        description: `${row.title} — ${row.url}`.slice(0, 1000),
      });
    }
    return files;
  }
  async cleanup(): Promise<void> {
    const cutoff =
      Date.now() - this.cfg.browserScreenshotRetentionDays * 86400000;
    const rows = this.db
      .prepare<[number], { id: string }>(
        "SELECT s.id FROM browser_screenshots s JOIN tasks t ON t.id=s.task_id WHERE s.created_at<? AND t.delivery_pending=0 AND t.status IN ('completed','failed','cancelled')",
      )
      .all(cutoff);
    for (const row of rows) {
      await unlink(this.path(row.id)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.db.prepare("DELETE FROM browser_screenshots WHERE id=?").run(row.id);
    }
  }
}
