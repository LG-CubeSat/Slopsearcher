import { logger } from "./log.ts";
const log = logger("scheduler");
/** Schedule after completion, so slow refreshes never overlap themselves. */
export class Scheduler {
  #stopped = false;
  #timers = new Set<NodeJS.Timeout>();
  #running = new Set<Promise<void>>();
  every(
    name: string,
    intervalMs: number,
    work: () => void | Promise<void>,
    immediate = false,
  ): void {
    const run = () => {
      if (this.#stopped) return;
      const pending = Promise.resolve()
        .then(work)
        .catch((e) =>
          log.error(`${name} failed; retrying on the next interval`, e),
        )
        .finally(() => {
          this.#running.delete(pending);
          if (!this.#stopped) schedule(intervalMs);
        });
      this.#running.add(pending);
    };
    const schedule = (ms: number) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        run();
      }, ms);
      this.#timers.add(timer);
    };
    if (immediate) run();
    else schedule(intervalMs);
  }
  cancel(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#running]);
  }
}
