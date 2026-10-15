import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openAndMigrate, type Db } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { SourceIndex } from "../index/index.ts";
import { MemoryStore } from "../memory/store.ts";
import { TaskStore } from "./store.ts";
import { TaskWorker } from "./worker.ts";
import type { ResearchRunner, RunRequest } from "../research/types.ts";
import type { DiscordService } from "../discord/client.ts";
import type { DriveService } from "../drive/service.ts";
let db: Db;
let tasks: TaskStore;
let gateway: any;
let worker: TaskWorker;
let runner: ResearchRunner;
const cfg = {
  ...loadConfig({}),
  userCooldownSeconds: 0,
  researchConcurrency: 1,
};
async function idle() {
  for (let i = 0; i < 200 && !worker.idle; i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(worker.idle).toBe(true);
}
beforeEach(() => {
  db = openAndMigrate(":memory:");
  tasks = new TaskStore(db);
  gateway = {
    imageContext: vi.fn(async () => ({
      images: [],
      notes: [],
      sourceChannels: [],
    })),
    scope: vi.fn(async () => ({
      channelIds: ["origin", "research"],
      destinationId: "research",
      userId: "u",
    })),
    createResearchChannel: vi.fn(async () => "research"),
    send: vi.fn(async () => {}),
    deliver: vi.fn(async () => "result"),
  };
  runner = {
    run: vi.fn(async (r: RunRequest) => {
      r.onThread?.("thread");
      return {
        threadId: "thread",
        text: JSON.stringify({
          done: true,
          summary: "Done",
          report: "A cited research report",
        }),
      };
    }),
  };
  worker = new TaskWorker(
    cfg,
    tasks,
    runner,
    new SourceIndex(db),
    new MemoryStore(db),
    gateway as DiscordService,
    null,
  );
});
afterEach(async () => {
  await worker.stop();
  db.close();
});
const create = () =>
  tasks.create(
    {
      kind: "research",
      question: "Radio research",
      userId: "u",
      channelId: "origin",
    },
    cfg,
  );
it("creates a research channel, persists its runner thread, and delivers without repeating inference", async () => {
  const task = create();
  worker.tick();
  await idle();
  expect(tasks.get(task.id)?.status).toBe("completed");
  expect(tasks.get(task.id)?.runner_thread_id).toBe("thread");
  tasks.update(task.id, { next_run_at: 0 });
  await worker.deliver();
  expect(gateway.deliver).toHaveBeenCalledOnce();
  worker.tick();
  await idle();
  expect(runner.run).toHaveBeenCalledOnce();
});
it("checkpoints and resumes a multi-turn investigation", async () => {
  vi.mocked(runner.run).mockImplementationOnce(async (r) => {
    r.onThread?.("thread");
    return {
      threadId: "thread",
      text: JSON.stringify({
        done: false,
        summary: "More needed",
        report: "Findings so far",
      }),
    };
  });
  const task = create();
  worker.tick();
  await idle();
  expect(tasks.get(task.id)?.status).toBe("pending");
  expect(tasks.get(task.id)?.turn_count).toBe(1);
  tasks.update(task.id, { next_run_at: 0 });
  worker.tick();
  await idle();
  expect(vi.mocked(runner.run).mock.calls[1]?.[0].threadId).toBe("thread");
  expect(tasks.get(task.id)?.status).toBe("completed");
});
it("cancels the active runner and keeps the task cancelled", async () => {
  vi.mocked(runner.run).mockImplementation(
    (r) =>
      new Promise((_, reject) =>
        r.signal?.addEventListener("abort", () => reject(Error("cancelled"))),
      ),
  );
  const task = create();
  worker.tick();
  await new Promise((r) => setTimeout(r, 5));
  worker.cancel(task.id);
  await idle();
  expect(tasks.get(task.id)?.status).toBe("cancelled");
});
it("withholds completed reports if source channel access changes", async () => {
  const task = create();
  worker.tick();
  await idle();
  gateway.scope.mockResolvedValue({ channelIds: ["research"] });
  tasks.update(task.id, { next_run_at: 0 });
  await worker.deliver();
  expect(gateway.deliver).not.toHaveBeenCalled();
  expect(tasks.get(task.id)?.delivery_pending).toBe(1);
});
it("retries failed turns with backoff and eventually reports failure", async () => {
  vi.mocked(runner.run).mockRejectedValue(Error("provider offline"));
  const task = create();
  for (let i = 0; i < 3; i++) {
    tasks.update(task.id, { next_run_at: 0 });
    worker.tick();
    await idle();
  }
  expect(tasks.get(task.id)?.status).toBe("failed");
  expect(tasks.get(task.id)?.attempts).toBe(3);
});
it("delivers local reports even if Drive upload fails", async () => {
  const drive = {
    saveReport: vi.fn(async () => {
      throw Error("Drive offline");
    }),
  };
  worker = new TaskWorker(
    { ...cfg, driveReportsFolderId: "reports" },
    tasks,
    runner,
    new SourceIndex(db),
    new MemoryStore(db),
    gateway as DiscordService,
    drive as unknown as DriveService,
  );
  const task = create();
  worker.tick();
  await idle();
  tasks.update(task.id, { next_run_at: 0 });
  await worker.deliver();
  expect(gateway.deliver).toHaveBeenCalledOnce();
  expect(tasks.get(task.id)?.output_message_id).toBe("result");
  expect(tasks.get(task.id)?.delivery_pending).toBe(1);
});
it("waits for backend sign-in without spending retries and resumes automatically", async () => {
  runner.isReady = vi.fn(async () => false);
  const task = create();
  worker.tick();
  await idle();
  expect(tasks.get(task.id)?.status).toBe("pending");
  expect(tasks.get(task.id)?.attempts).toBe(0);
  expect(runner.run).not.toHaveBeenCalled();
  vi.mocked(runner.isReady).mockResolvedValue(true);
  tasks.update(task.id, { next_run_at: 0 });
  worker.tick();
  await idle();
  expect(tasks.get(task.id)?.status).toBe("completed");
});
