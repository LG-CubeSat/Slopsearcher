import {
  Routes,
  type Client,
  type GuildMember,
  type RESTGetAPIGuildMessagesSearchResult,
} from "discord.js";
import type { SourceIndex } from "../index/index.ts";
import { delay } from "../util.ts";
import { toSourceInput } from "./normalize.ts";

export function discordUserId(value: string): string | null {
  const match = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/.exec(value.trim());
  return match?.[1] ?? match?.[2] ?? null;
}
const identity = (member: GuildMember) => ({
  id: member.id,
  username: member.user.username,
  globalName: member.user.globalName,
  displayName: member.displayName,
  bot: member.user.bot,
});
export async function resolveDiscordMember(
  client: Client,
  guildId: string,
  query: string,
) {
  const guild = await client.guilds.fetch(guildId);
  const id = discordUserId(query);
  if (id) {
    try {
      const member = await guild.members.fetch({ user: id, force: true });
      return { matches: [identity(member)], ambiguous: false };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        Number(error.code) === 10007
      )
        return {
          matches: [{ id, currentMember: false }],
          ambiguous: false,
          note: "This ID is not a current server member. Historical messages can still be searched by ID.",
        };
      throw error;
    }
  }
  const name = query.trim().replace(/^@/, "");
  if (!name || name.length > 100)
    throw new Error(
      "Provide a user mention, user ID, username or server nickname",
    );
  const members = [
    ...(await guild.members.search({ query: name, limit: 20 })).values(),
  ];
  const exact = members.filter((m) =>
    [m.user.username, m.user.globalName, m.displayName].some(
      (n) => n?.toLowerCase() === name.toLowerCase(),
    ),
  );
  const matches = (exact.length ? exact : members).map(identity);
  return {
    matches,
    ambiguous: matches.length > 1,
    mayHaveMoreMatches: members.length === 20,
    note: "If multiple people match, ask which one or request a mention. Never choose a different author from nearby messages.",
  };
}
export interface MemberMessage {
  id: string;
  authorId: string;
  author: string;
  displayName: string;
  channelId: string;
  channel: string | null;
  at: string;
  url: string;
  text: string;
}

/** Native author-ID search, restricted before the API call and checked again on
 * every returned hit. Fetch messages live to exclude stale/deleted search hits.
 */
export async function recentMemberMessages(
  client: Client,
  guildId: string,
  channelIds: string[],
  userId: string,
  limit: number,
  index: SourceIndex,
  stopped: () => boolean,
) {
  const channels = [...new Set(channelIds)];
  const permitted = new Set(channels);
  const checkedAt = new Date().toISOString();
  const snapshot = (BigInt(Date.now() - 1420070400000) << 22n).toString();
  const results = new Map<string, MemberMessage>();
  let complete = true;
  // Discord accepts up to 500 channel filters. Never send an unfiltered query.
  for (let start = 0; start < channels.length; start += 500) {
    const batch = channels.slice(start, start + 500);
    const batchSet = new Set(batch);
    let before = snapshot;
    let found = 0;
    let exhausted = false;
    for (let page = 0; page < 5 && found < limit; page++) {
      if (stopped()) throw new Error("Message lookup cancelled");
      const query = new URLSearchParams({
        author_id: userId,
        sort_by: "timestamp",
        sort_order: "desc",
        limit: "25",
        max_id: before,
        include_nsfw: "true",
      });
      for (const id of batch) query.append("channel_id", id);
      let response: RESTGetAPIGuildMessagesSearchResult | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (stopped()) throw new Error("Message lookup cancelled");
        response = (await client.rest.get(Routes.guildMessagesSearch(guildId), {
          query,
        })) as RESTGetAPIGuildMessagesSearchResult;
        if ("messages" in response) break;
        if (response.code !== 110000)
          throw new Error("Discord message search is unavailable");
        if (attempt < 2)
          await delay(
            Math.min(
              30000,
              Math.max(1000, Number(response.retry_after || 1) * 1000),
            ),
          );
      }
      if (!response || !("messages" in response))
        throw new Error(
          "Discord is still indexing message search. Try again shortly; do not infer an answer from nearby discussion.",
        );
      if (response.doing_deep_historical_index) complete = false;
      const hits = response.messages
        .flat()
        .filter(
          (m) =>
            permitted.has(m.channel_id) &&
            batchSet.has(m.channel_id) &&
            m.author.id === userId &&
            BigInt(m.id) < BigInt(before),
        )
        .sort((a, b) =>
          BigInt(a.id) > BigInt(b.id)
            ? -1
            : BigInt(a.id) < BigInt(b.id)
              ? 1
              : 0,
        );
      if (!hits.length) {
        if (response.messages.some((group) => group.length)) complete = false;
        exhausted = true;
        break;
      }
      const seen = new Set<string>();
      for (const hit of hits) {
        if (found >= limit) break;
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        if (stopped()) throw new Error("Message lookup cancelled");
        try {
          const channel = await client.channels.fetch(hit.channel_id);
          if (
            !channel?.isTextBased() ||
            !("messages" in channel) ||
            !("guildId" in channel) ||
            channel.guildId !== guildId
          )
            throw new Error("Message channel is unavailable");
          const message = await channel.messages.fetch({
            message: hit.id,
            force: true,
            cache: false,
          });
          if (
            message.author.id !== userId ||
            message.channelId !== hit.channel_id ||
            message.system
          )
            continue;
          const source = toSourceInput(message, guildId);
          if (source && !message.author.bot) index.upsert(source);
          results.set(message.id, {
            id: message.id,
            authorId: message.author.id,
            author: message.author.username,
            displayName:
              message.member?.displayName ??
              message.author.globalName ??
              message.author.username,
            channelId: message.channelId,
            channel: "name" in channel ? channel.name : null,
            at: message.createdAt.toISOString(),
            url: message.url,
            text:
              source?.text.slice(0, 12000) ??
              (message.stickers.size
                ? `[Sticker: ${message.stickers.map((s) => s.name).join(", ")}]`
                : "[Message without text; open the source link]"),
          });
          found++;
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            Number(error.code) === 10008
          ) {
            index.retire("discord", hit.id);
            continue;
          }
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            [10003, 50001, 50013].includes(Number(error.code))
          ) {
            // A newly inaccessible channel prevents claiming complete coverage.
            complete = false;
            continue;
          }
          throw error;
        }
      }
      before = hits.at(-1)!.id;
    }
    if (found < limit && !exhausted) complete = false;
  }
  const messages = [...results.values()]
    .sort((a, b) =>
      BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0,
    )
    .slice(0, limit);
  return {
    userId,
    checkedAt,
    complete,
    channelCount: channels.length,
    coverage:
      "Configured Discord channels readable by both the requester and the response audience. Results are sorted newest first and verified live by author ID; this does not cover private or inaccessible channels outside that scope.",
    messages,
  };
}
