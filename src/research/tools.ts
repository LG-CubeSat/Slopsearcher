import { z } from "zod";
import type { SourceIndex } from "../index/index.ts";
import type { SourceRow } from "../index/types.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { DiscordService, AccessScope } from "../discord/client.ts";
import type { DriveService } from "../drive/service.ts";
import type { ToolDefinition } from "./types.ts";
const searchInput = z.object({
  query: z.string().min(1).max(500),
  kind: z.enum(["discord", "drive"]).optional(),
  channelId: z.string().optional(),
  limit: z.number().int().min(1).max(30).optional(),
});
const openInput = z.object({
  id: z.number().int().positive(),
  offset: z.number().int().min(0).optional(),
  length: z.number().int().min(100).max(24000).optional(),
});
const conversationInput = z.object({
  id: z.number().int().positive(),
  radius: z.number().int().min(1).max(30).optional(),
});
export function projectTools(
  index: SourceIndex,
  memory: MemoryStore,
  discord: DiscordService,
  drive: DriveService | null,
  scope: AccessScope,
): { tools: ToolDefinition[]; usedChannels: Set<string> } {
  const allowed = new Set(scope.channelIds);
  const usedChannels = new Set<string>();
  const canRead = (s: SourceRow) =>
    s.kind === "drive" || Boolean(s.channel_id && allowed.has(s.channel_id));
  const record = (s: SourceRow) => {
    if (s.channel_id) usedChannels.add(s.channel_id);
  };
  const get = (id: number): SourceRow => {
    const source = index.getById(id);
    if (!source || !canRead(source))
      throw new Error(
        "Source is missing or outside this conversation's access scope",
      );
    record(source);
    return source;
  };
  const tools: ToolDefinition[] = [
    {
      name: "search_project",
      description:
        "Search project Discord messages and Drive documents by keywords or part numbers. Returns source IDs and URLs; open a source for more text. Try multiple focused searches rather than relying on a single broad query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: ["discord", "drive"] },
          channelId: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const input = searchInput.parse(args);
        if (input.channelId && !allowed.has(input.channelId))
          throw new Error("Channel not allowed");
        return index
          .search(input.query, {
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.channelId ? { channelId: input.channelId } : {}),
            limit: input.limit ?? 15,
            allowedChannelIds: scope.channelIds,
          })
          .map((s) => {
            record(s);
            return {
              id: s.id,
              kind: s.kind,
              title: s.title,
              channel: s.channel_name,
              author: s.author,
              url: s.url,
              time: new Date(s.ts).toISOString(),
              checkedAt: new Date(s.fetched_at).toISOString(),
              snippet: s.snippet,
              excerpt: s.text.slice(0, 1800),
            };
          });
      },
    },
    {
      name: "open_source",
      description:
        "Open an indexed source by numeric ID. Discord content is refreshed live. Drive content is refreshed from the configured folder. Use offset to read later parts of a long document.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "integer" },
          offset: { type: "integer" },
          length: { type: "integer" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const input = openInput.parse(args);
        let s = get(input.id);
        if (s.kind === "discord") await discord.refreshSource(s);
        else if (drive) await drive.sync();
        s = get(input.id);
        const offset = input.offset ?? 0;
        const length = input.length ?? 12000;
        return {
          id: s.id,
          kind: s.kind,
          url: s.url,
          title: s.title,
          author: s.author,
          channelId: s.channel_id,
          parentMessageId: s.parent_id,
          checkedAt: new Date(s.fetched_at).toISOString(),
          offset,
          totalCharacters: s.text.length,
          text: s.text.slice(offset, offset + length),
          more: offset + length < s.text.length,
        };
      },
    },
    {
      name: "open_conversation",
      description:
        "Fetch the live Discord discussion before and after an indexed Discord message. Use this to understand decisions and reply context behind a search result.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer" }, radius: { type: "integer" } },
        required: ["id"],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const input = conversationInput.parse(args);
        const s = get(input.id);
        if (s.kind !== "discord")
          throw new Error("This tool requires a Discord source");
        const context = (await discord.conversation(s, input.radius ?? 8)) as {
          before: SourceRow[];
          anchor: SourceRow;
          after: SourceRow[];
        } | null;
        if (!context) return null;
        return [...context.before, context.anchor, ...context.after]
          .filter(canRead)
          .map((row) => ({
            id: row.id,
            author: row.author,
            text: row.text.slice(0, 6000),
            url: row.url,
            at: new Date(row.ts).toISOString(),
          }));
      },
    },
    {
      name: "search_memory",
      description:
        "Search compact project facts, decisions, requirements, rationale and unresolved questions. Notes are derived from cited sources and may need confirmation from the original discussion.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      invoke: async (args) => {
        const { query } = z
          .object({ query: z.string().min(1).max(500) })
          .parse(args);
        return memory.search(query, (s) => {
          const readable = canRead(s);
          if (readable) record(s);
          return readable;
        });
      },
    },
  ];
  return { tools, usedChannels };
}
