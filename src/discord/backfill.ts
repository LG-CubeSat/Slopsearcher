import { projectKey } from "../project-scope.ts";
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type ThreadChannel,
  type GuildTextBasedChannel,
} from "discord.js";
import { channelConfigured, type Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { getCursor, setCursor } from "../db/cursors.ts";
import type { SourceIndex } from "../index/index.ts";
import { logger } from "../log.ts";
import { mapConcurrent, type WorkQueue } from "../queue.ts";
import { toSourceInput } from "./normalize.ts";
import { walkHistory } from "./history.ts";
const log = logger("discord-sync");
export function indexableChannels(
  guild: Guild,
  cfg: Config,
): GuildTextBasedChannel[] {
  return [...guild.channels.cache.values()].filter(
    (c): c is GuildTextBasedChannel => {
      if (
        !c.isTextBased() ||
        c.type === ChannelType.GuildVoice ||
        c.type === ChannelType.GuildStageVoice
      )
        return false;
      if (!channelConfigured(cfg, c.id, c.parentId) || !guild.members.me)
        return false;
      const p = c.permissionsFor(guild.members.me);
      return Boolean(
        p?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ]),
      );
    },
  );
}
export async function syncChannel(
  channel: GuildTextBasedChannel,
  cfg: Config,
  db: Db,
  index: SourceIndex,
  queue: WorkQueue,
  full = false,
  stopped = () => false,
): Promise<void> {
  const scope = "discord-history-v2";
  const cursor = getCursor(db, scope, channel.id);
  const progressScope = full ? "discord-reconcile" : "discord-catchup";
  const before =
    getCursor(db, progressScope, `${channel.id}:before`) ?? undefined;
  const started =
    Number(getCursor(db, progressScope, `${channel.id}:started`)) || Date.now();
  setCursor(db, progressScope, `${channel.id}:started`, String(started));
  let newest =
    getCursor(db, progressScope, `${channel.id}:newest`) ?? undefined;
  let count = 0;
  const complete = await walkHistory({
    ...(before ? { before } : {}),
    ...(!full && cursor ? { stopAt: cursor } : {}),
    stopped,
    fetch: (before) =>
      queue.submit(`history:${channel.id}`, "backfill", async () => {
        const rows = await channel.messages.fetch({
          limit: cfg.backfillPageSize,
          ...(before ? { before } : {}),
          cache: false,
        });
        return [...rows.values()];
      }),
    consume: async (page) => {
      for (const m of page) {
        if (!newest || BigInt(m.id) > BigInt(newest)) newest = m.id;
        if (m.author.bot) continue;
        const source = toSourceInput(m, cfg.discordGuildId);
        if (source) {
          index.upsert(source);
          count++;
        }
      }
    },
    checkpoint: (nextBefore) =>
      db.transaction(() => {
        setCursor(db, progressScope, `${channel.id}:before`, nextBefore);
        if (newest)
          setCursor(db, progressScope, `${channel.id}:newest`, newest);
      })(),
  });
  if (!complete) return;
  db.transaction(() => {
    if (newest && (!cursor || BigInt(newest) > BigInt(cursor)))
      setCursor(db, scope, channel.id, newest);
    if (full) {
      const missing = db
        .prepare<[string, number], { external_id: string }>(
          "SELECT external_id FROM sources WHERE kind='discord' AND channel_id=? AND deleted_at IS NULL AND fetched_at < ?",
        )
        .all(channel.id, started);
      for (const row of missing) index.retire("discord", row.external_id);
      setCursor(
        db,
        "discord-reconcile",
        `${channel.id}:completed`,
        String(Date.now()),
      );
    }
    for (const key of ["before", "started", "newest"])
      db.prepare("DELETE FROM cursors WHERE scope=? AND key=?").run(
        progressScope,
        `${channel.id}:${key}`,
      );
  })();
  if (count)
    log.info(
      `#${channel.name}: checked ${count} messages${full ? " (reconciliation)" : ""}`,
    );
}
export async function runBackfill(
  client: Client,
  cfg: Config,
  db: Db,
  index: SourceIndex,
  queue: WorkQueue,
  full = false,
  stopped = () => false,
): Promise<void> {
  const guild = await client.guilds.fetch(cfg.discordGuildId);
  await guild.channels.fetch();
  await guild.channels.fetchActiveThreads();
  // Include known investigation channels even when their origin is whitelisted.
  const researchIds = db
    .prepare<[string], { discord_channel_id: string }>(
      "SELECT discord_channel_id FROM tasks WHERE discord_channel_id IS NOT NULL AND project_key=?",
    )
    .all(projectKey(cfg))
    .map((t) => t.discord_channel_id);
  const effectiveCfg = cfg.discordChannelIds.length
    ? { ...cfg, discordChannelIds: [...cfg.discordChannelIds, ...researchIds] }
    : cfg;
  const parents = [...guild.channels.cache.values()];
  for (const c of parents) {
    if (
      !channelConfigured(effectiveCfg, c.id, c.parentId) ||
      !("threads" in c) ||
      !guild.members.me ||
      !c
        .permissionsFor(guild.members.me)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ])
    )
      continue;
    const modes =
      c.type === ChannelType.GuildText
        ? (["public", "private"] as const)
        : (["public"] as const);
    for (const type of modes) {
      try {
        let before: Date | ThreadChannel | undefined;
        for (;;) {
          if (stopped()) throw new Error("Synchronization stopped");
          const page = await c.threads.fetchArchived(
            {
              type,
              fetchAll: false,
              limit: 100,
              ...(before ? { before } : {}),
            },
            true,
          );
          if (!page.hasMore || !page.threads.size) break;
          const last = page.threads.last();
          if (!last) break;
          const nextBefore =
            type === "private"
              ? last
              : last.archiveTimestamp
                ? new Date(last.archiveTimestamp)
                : undefined;
          if (!nextBefore || String(before) === String(nextBefore)) break;
          before = nextBefore;
        }
      } catch (e) {
        if (stopped()) throw e;
        log.warn(`Could not list archived ${type} threads in ${c.id}`, e);
      }
    }
  }
  let failed = false;
  await mapConcurrent(
    indexableChannels(guild, effectiveCfg),
    cfg.backfillConcurrency,
    async (c) => {
      try {
        const previous = Number(
          getCursor(db, "discord-reconcile", `${c.id}:completed`),
        );
        const needsFull =
          full &&
          (!previous ||
            Date.now() - previous >= cfg.reconcileIntervalSeconds * 1000);
        await syncChannel(c, cfg, db, index, queue, needsFull, stopped);
      } catch (e) {
        failed = true;
        log.warn(
          `Sync failed for #${c.name}; keeping its existing index until a successful pass`,
          e,
        );
      }
    },
  );
  if (failed || stopped())
    throw new Error(
      "Discord sync did not complete; unfinished channels will resume on the next pass",
    );
}
