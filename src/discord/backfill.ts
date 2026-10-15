import {
  ChannelType,
  PermissionsBitField,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { getCursor, setCursor } from "../db/cursors.ts";
import type { SourceIndex } from "../index/index.ts";
import type { SourceInput } from "../index/types.ts";
import { logger } from "../log.ts";
import { mapConcurrent, type WorkQueue } from "../queue.ts";
import { toSourceInput } from "./normalize.ts";

const log = logger("backfill");

/**
 * Which channels we are both configured for and actually allowed to read.
 * Silently skipping unreadable channels beats crashing a backfill half-way
 * through because one channel has restrictive permissions.
 */
export function indexableChannels(guild: Guild, cfg: Config): TextChannel[] {
  const wanted = new Set(cfg.discordChannelIds);
  const me = guild.members.me;

  return [...guild.channels.cache.values()].filter((channel): channel is TextChannel => {
    if (channel.type !== ChannelType.GuildText) return false;
    if (wanted.size > 0 && !wanted.has(channel.id)) return false;
    if (!me) return false;

    const perms = channel.permissionsFor(me);
    return Boolean(
      perms?.has(PermissionsBitField.Flags.ViewChannel) &&
        perms.has(PermissionsBitField.Flags.ReadMessageHistory),
    );
  });
}

/**
 * Walks a channel's history forward from the last indexed message.
 *
 * The cursor is advanced after every page, not at the end, so a crash or a
 * restart mid-backfill resumes where it stopped instead of restarting the
 * channel. Combined with the content-hash upsert, re-running is always safe.
 */
async function backfillChannel(
  channel: TextChannel,
  guildId: string,
  db: Db,
  index: SourceIndex,
  pageSize: number,
): Promise<number> {
  let after = getCursor(db, "discord", channel.id) ?? "0";
  let indexed = 0;

  for (;;) {
    const page = await channel.messages.fetch({ limit: pageSize, after });
    if (page.size === 0) break;

    // `after` returns newest-first; index oldest-first so the cursor only ever
    // moves forward and a partial page leaves a coherent prefix behind.
    const ordered = [...page.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp,
    );

    const inputs = ordered
      .map((message) => toSourceInput(message, guildId))
      .filter((input): input is SourceInput => input !== null);

    if (inputs.length > 0) {
      const result = index.upsertMany(inputs);
      indexed += result.inserted + result.updated;
    }

    const newest = ordered.at(-1);
    if (!newest) break;
    after = newest.id;
    setCursor(db, "discord", channel.id, after);

    log.debug(`#${channel.name}: +${page.size} (cursor ${after})`);
    if (page.size < pageSize) break;
  }

  if (indexed > 0) log.info(`#${channel.name}: indexed ${indexed} messages`);
  return indexed;
}

export async function runBackfill(
  client: Client,
  cfg: Config,
  db: Db,
  index: SourceIndex,
  queue: WorkQueue,
): Promise<number> {
  const guild = await client.guilds.fetch(cfg.discordGuildId);
  await guild.channels.fetch();

  const channels = indexableChannels(guild, cfg);
  log.info(`backfilling ${channels.length} channel(s)`);

  const counts = await mapConcurrent(
    channels,
    cfg.backfillConcurrency,
    (channel) =>
      // Lowest priority: a long backfill must yield to live questions.
      queue.submit(`backfill:#${channel.name}`, "backfill", () =>
        backfillChannel(channel, guild.id, db, index, cfg.backfillPageSize).catch(
          (error: unknown) => {
            log.warn(`#${channel.name} backfill failed; will retry next run`, error);
            return 0;
          },
        ),
      ),
  );

  const total = counts.reduce((sum, count) => sum + count, 0);
  log.info(`backfill complete: ${total} messages indexed`);
  return total;
}
