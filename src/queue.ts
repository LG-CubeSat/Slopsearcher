import { logger } from "./log.ts";

/**
 * Lower number wins. The ordering is the whole point: a multi-hour backfill
 * must never make someone's @-mention wait, and extraction sits between the
 * two because it is useful but nobody is watching it happen.
 */
export const Priority = {
  interactive: 0,
  extract: 1,
  backfill: 2,
} as const;

export type PriorityName = keyof typeof Priority;

/**
 * The job's result type is erased at the point of submission: `settle` closes
 * over the caller's resolve/reject, so the queue itself only ever deals in
 * `Promise<void>` and needs no generic parameter.
 */
interface Job {
  name: string;
  priority: number;
  /** Tie-breaker so equal priorities stay FIFO rather than arbitrary. */
  seq: number;
  settle: () => Promise<void>;
}

const log = logger("queue");

/**
 * A single in-process scheduler for every unit of work that costs money or
 * rate limit. Everything funnels through here so that concurrency is bounded
 * globally rather than per-module, and so priority is actually respected
 * instead of being a comment on a Promise.all.
 */
export class WorkQueue {
  readonly #pending: Job[] = [];
  readonly #concurrency: number;
  #active = 0;
  #seq = 0;
  #closed = false;

  constructor(concurrency = 4) {
    this.#concurrency = Math.max(1, concurrency);
  }

  get size(): number {
    return this.#pending.length;
  }

  get active(): number {
    return this.#active;
  }

  submit<T>(
    name: string,
    priority: PriorityName,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new Error(`queue is closed; rejected job "${name}"`),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        name,
        priority: Priority[priority],
        seq: this.#seq++,
        settle: async () => {
          try {
            resolve(await run());
          } catch (error) {
            log.error(`job "${name}" failed`, error);
            reject(error);
          }
        },
      };
      // Insertion sort into a small array beats a heap at this scale and keeps
      // the ordering trivially auditable.
      const at = this.#pending.findIndex(
        (other) =>
          other.priority > job.priority ||
          (other.priority === job.priority && other.seq > job.seq),
      );
      if (at === -1) this.#pending.push(job);
      else this.#pending.splice(at, 0, job);

      this.#pump();
    });
  }

  #pump(): void {
    while (this.#active < this.#concurrency && this.#pending.length > 0) {
      const job = this.#pending.shift();
      if (!job) break;
      this.#active += 1;
      void this.#execute(job);
    }
  }

  async #execute(job: Job): Promise<void> {
    const started = Date.now();
    try {
      await job.settle();
    } finally {
      this.#active -= 1;
      log.debug(`job "${job.name}" took ${Date.now() - started}ms`);
      this.#pump();
    }
  }

  /**
   * Waits for everything already submitted -- queued as well as in-flight --
   * to finish. Deliberately does NOT pause the pump: on shutdown we want the
   * work that is already accepted to complete, not to be stranded.
   */
  async drain(): Promise<void> {
    while (this.#active > 0 || this.#pending.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Refuses further submissions, then drains. Use this at shutdown. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
  }
}

/**
 * Runs `worker` over `items` with a fixed ceiling on in-flight work. Used by
 * backfill to walk several channels at once without opening one request per
 * channel in the guild.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}
