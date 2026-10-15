import { ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildTextBasedChannel } from "discord.js";
import { channelConfigured, type Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { getCursor, setCursor } from "../db/cursors.ts";
import type { SourceIndex } from "../index/index.ts";
import { logger } from "../log.ts";
import { mapConcurrent, type WorkQueue } from "../queue.ts";
import { toSourceInput } from "./normalize.ts";
import { walkHistory } from "./history.ts";
const log = logger("discord-sync");
export function indexableChannels(guild: Guild, cfg: Config): GuildTextBasedChannel[] {
  return [...guild.channels.cache.values()].filter((c): c is GuildTextBasedChannel => {
    if (!c.isTextBased() || c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) return false;
    if (!channelConfigured(cfg, c.id, c.parentId) || !guild.members.me) return false;
    const p = c.permissionsFor(guild.members.me);
    return Boolean(p?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));
  });
}
export async function syncChannel(channel: GuildTextBasedChannel, cfg: Config, db: Db, index: SourceIndex, queue: WorkQueue, full = false, stopped = () => false): Promise<void> {
  const scope = "discord-history-v2";
  const cursor = getCursor(db, scope, channel.id);
  const cutoff = full ? undefined : cursor ?? undefined;
  const partial = full ? undefined : getCursor(db, "discord-backfill-before", channel.id) ?? undefined;
  const started = Date.now();
  let newest: string | undefined;
  let count = 0;
  const complete = await walkHistory({
    ...(partial ? { before: partial } : {}), ...(cutoff ? { stopAt: cutoff } : {}), stopped,
    fetch: before => queue.submit(`history:${channel.id}`, "backfill", async () => {
      const rows = await channel.messages.fetch({ limit: cfg.backfillPageSize, ...(before ? { before } : {}), cache: false });
      return [...rows.values()];
    }),
    consume: async page => {
      for (const m of page) {
        if (!newest || BigInt(m.id) > BigInt(newest)) newest = m.id;
        // Keep bot replies out of knowledge to avoid reinforcing generated claims.
        if (m.author.bot) continue;
        const source = toSourceInput(m, cfg.discordGuildId);
        if (source) { index.upsert(source); count++; }
      }
    },
    checkpoint: before => { if (!cursor && !full) setCursor(db, "discord-backfill-before", channel.id, before); },
  });
  if (complete) {
    // After an interrupted initial scan, the last page's newest is older than
    // the actual head. A catch-up scan starts from this conservative watermark.
    if (newest && (!cursor || BigInt(newest) > BigInt(cursor))) setCursor(db, scope, channel.id, newest);
    db.prepare("DELETE FROM cursors WHERE scope = 'discord-backfill-before' AND key = ?").run(channel.id);
    if (full) {
      const missing = db.prepare<[string, number], { external_id: string }>("SELECT external_id FROM sources WHERE kind = 'discord' AND channel_id = ? AND deleted_at IS NULL AND fetched_at < ?").all(channel.id, started);
      for (const row of missing) index.retire("discord", row.external_id);
    }
  }
  if (count) log.info(`#${channel.name}: checked ${count} messages${full ? " (reconciliation)" : ""}`);
}
export async function runBackfill(client: Client, cfg: Config, db: Db, index: SourceIndex, queue: WorkQueue, full = false, stopped = () => false): Promise<void> {
  const guild = await client.guilds.fetch(cfg.discordGuildId);
  await guild.channels.fetch();
  await guild.channels.fetchActiveThreads();
  // Archive history matters too; paginate archived public threads per parent.
  for (const c of guild.channels.cache.values()) {
    if (!channelConfigured(cfg, c.id, c.parentId) || !("threads" in c) || !c.isTextBased()) continue;
    try {
      let before: Date | undefined;
      for (;;) {
        if (stopped()) return;
        const page = await c.threads.fetchArchived({ type: "public", limit: 100, ...(before ? { before } : {}) }, true);
        if (!page.hasMore || !page.threads.size) break;
        const last = page.threads.last()?.archiveTimestamp;
        if (!last || before?.getTime() === last) break;
        before = new Date(last);
      }
    } catch (e) { log.warn(`Could not list archived threads in ${c.id}`, e); }
  }
  await mapConcurrent(indexableChannels(guild, cfg), cfg.backfillConcurrency, async c => {
    try { await syncChannel(c, cfg, db, index, queue, full, stopped); }
    catch (e) { log.warn(`Sync failed for #${c.name}; keeping its existing index until a successful pass`, e); }
  });
}
