/** Always walk backwards from a fixed snapshot. Advancing an `after` cursor to
 * the newest message in a page can skip the entire middle of a large history. */
export interface HistoryMessage { id: string }
export async function walkHistory<T extends HistoryMessage>(opts: {
  fetch: (before?: string) => Promise<T[]>;
  consume: (page: T[]) => Promise<void>;
  before?: string;
  stopAt?: string;
  checkpoint?: (before: string) => void;
  stopped?: () => boolean;
}): Promise<boolean> {
  let before = opts.before;
  while (!opts.stopped?.()) {
    const page = await opts.fetch(before);
    if (!page.length) return true;
    page.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    const eligible = opts.stopAt ? page.filter(m => BigInt(m.id) > BigInt(opts.stopAt!)) : page;
    await opts.consume(eligible);
    if (eligible.length !== page.length) return true;
    const oldest = page[0]!.id;
    if (oldest === before) throw new Error("Discord history pagination did not advance");
    opts.checkpoint?.(oldest); before = oldest;
  }
  return false;
}
