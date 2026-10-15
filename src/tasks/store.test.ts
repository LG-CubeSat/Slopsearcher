import { afterEach, beforeEach, expect, it } from "vitest";
import { openAndMigrate, type Db } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { TaskStore } from "./store.ts";
let db: Db;
let store: TaskStore;
const cfg = loadConfig({ USER_COOLDOWN_SECONDS: "0" });
beforeEach(() => {
  db = openAndMigrate(":memory:");
  store = new TaskStore(db);
});
afterEach(() => db.close());
const input = {
  kind: "research" as const,
  question: "Investigate radios",
  userId: "u",
  channelId: "c",
  messageId: "m",
};
it("deduplicates redelivered requests", () => {
  expect(store.create(input, cfg).id).toBe(store.create(input, cfg).id);
});
it("recovers research from the persisted thread and partial report", () => {
  const t = store.create(input, cfg);
  store.update(t.id, {
    status: "running",
    runner_thread_id: "thread-1",
    report_text: "findings",
    turn_count: 2,
  });
  store.recover();
  const r = store.next()!;
  expect(r.runner_thread_id).toBe("thread-1");
  expect(r.report_text).toBe("findings");
  expect(r.turn_count).toBe(2);
  expect(store.next()).toBeNull();
});
it("prioritizes questions over waiting research", () => {
  store.create(input, cfg);
  const q = store.create({ ...input, kind: "question", messageId: "m2" }, cfg);
  expect(store.next()?.id).toBe(q.id);
});
it("bounds the task queue", () => {
  store.create(input, cfg);
  expect(() =>
    store.create({ ...input, messageId: "m2" }, { ...cfg, maxPendingTasks: 1 }),
  ).toThrow("full");
});
it("retains a completed report for retrying delivery without repeating inference", () => {
  const t = store.create(input, cfg);
  store.update(t.id, {
    status: "completed",
    report_text: "report",
    delivery_pending: 1,
  });
  expect(store.next()).toBeNull();
  expect(store.deliveries()[0]?.report_text).toBe("report");
});
