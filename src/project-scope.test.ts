import { expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { openAndMigrate } from "./db/index.ts";
import { SourceIndex } from "./index/index.ts";
import { TaskStore } from "./tasks/store.ts";
import { bindProject, projectKey } from "./project-scope.ts";
it("retires the previous project's Drive index and prevents old research from resuming or delivering", () => {
  const db = openAndMigrate(":memory:");
  try {
    const cfg = {
      ...loadConfig({}),
      discordGuildId: "g1",
      driveSourceFolderId: "old",
    };
    const index = new SourceIndex(db);
    const tasks = new TaskStore(db);
    bindProject(cfg, db, index);
    index.upsert({
      kind: "drive",
      externalId: "d",
      url: "https://drive.google.com/d",
      ts: 1,
      text: "private previous project",
    });
    const t = tasks.create(
      {
        kind: "research",
        question: "Old project",
        userId: "u",
        channelId: "c",
      },
      cfg,
    );
    tasks.update(t.id, { runner_thread_id: "old-thread" });
    const next = { ...cfg, driveSourceFolderId: "new" };
    bindProject(next, db, index);
    expect(index.search("private")).toEqual([]);
    expect(tasks.get(t.id)?.status).toBe("cancelled");
    expect(tasks.get(t.id)?.runner_thread_id).toBeNull();
    expect(tasks.list("u", 10, projectKey(next))).toEqual([]);
  } finally {
    db.close();
  }
});
