import { describe, expect, it } from "vitest";
import { mapConcurrent, WorkQueue } from "./queue.ts";

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WorkQueue", () => {
  it("runs interactive work ahead of queued backfill", async () => {
    const queue = new WorkQueue(1);
    const order: string[] = [];

    // Occupy the single slot so the rest genuinely queue behind it.
    const blocker = queue.submit("blocker", "backfill", async () => {
      await tick(20);
      order.push("blocker");
    });

    queue.submit("backfill", "backfill", async () => void order.push("backfill"));
    queue.submit("extract", "extract", async () => void order.push("extract"));
    queue.submit("mention", "interactive", async () => void order.push("mention"));

    await blocker;
    await queue.drain();

    expect(order).toEqual(["blocker", "mention", "extract", "backfill"]);
  });

  it("keeps equal priorities in submission order", async () => {
    const queue = new WorkQueue(1);
    const order: number[] = [];

    const blocker = queue.submit("blocker", "backfill", () => tick(10));
    for (const n of [1, 2, 3]) {
      queue.submit(`job${n}`, "extract", async () => void order.push(n));
    }

    await blocker;
    await queue.drain();
    expect(order).toEqual([1, 2, 3]);
  });

  it("respects the concurrency ceiling", async () => {
    const queue = new WorkQueue(2);
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        queue.submit("job", "extract", async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await tick(5);
          inFlight -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("drain finishes queued work rather than stranding it", async () => {
    const queue = new WorkQueue(1);
    const done: number[] = [];

    queue.submit("slow", "backfill", async () => {
      await tick(10);
      done.push(0);
    });
    queue.submit("queued", "backfill", async () => void done.push(1));

    await queue.drain();
    expect(done).toEqual([0, 1]);
  });

  it("close refuses new work but still drains what was accepted", async () => {
    const queue = new WorkQueue(1);
    const done: number[] = [];
    queue.submit("accepted", "backfill", async () => {
      await tick(10);
      done.push(1);
    });

    await queue.close();
    expect(done).toEqual([1]);
    await expect(queue.submit("late", "interactive", async () => 1)).rejects.toThrow(
      /closed/,
    );
  });

  it("rejects the caller without stalling the queue", async () => {
    const queue = new WorkQueue(1);
    const failed = queue.submit("boom", "extract", async () => {
      throw new Error("boom");
    });

    await expect(failed).rejects.toThrow("boom");
    await expect(queue.submit("ok", "extract", async () => 42)).resolves.toBe(42);
  });
});

describe("mapConcurrent", () => {
  it("preserves input order in its results", async () => {
    const out = await mapConcurrent([5, 1, 3], 2, async (value) => {
      await tick(value);
      return value * 2;
    });
    expect(out).toEqual([10, 2, 6]);
  });

  it("handles an empty input", async () => {
    expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
  });
});
