import { expect, it } from "vitest";
import { Collection, type GuildTextBasedChannel } from "discord.js";
import { openAndMigrate } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { SourceIndex } from "../index/index.ts";
import { WorkQueue } from "../queue.ts";
import { syncChannel } from "./backfill.ts";
const message = (id: string) => ({
  id,
  content: `Radio source ${id}`,
  channelId: "c",
  channel: { name: "radio" },
  mentions: { users: new Map(), roles: new Map(), channels: new Map() },
  attachments: new Map(),
  embeds: [],
  author: { bot: false, username: "member" },
  createdTimestamp: Number(id),
});
it("resumes a full history reconciliation without retiring previously completed pages", async () => {
  const db = openAndMigrate(":memory:");
  const index = new SourceIndex(db);
  const q = new WorkQueue(1);
  const cfg = { ...loadConfig({}), discordGuildId: "g", backfillPageSize: 2 };
  let stopped = false;
  let first = true;
  const channel = {
    id: "c",
    name: "radio",
    messages: {
      fetch: async ({ before }: { before?: string }) => {
        const page = ["6", "5", "4", "3", "2", "1"]
          .filter((id) => !before || BigInt(id) < BigInt(before))
          .slice(0, 2);
        if (first) {
          first = false;
          stopped = true;
        }
        return new Collection(page.map((id) => [id, message(id)]));
      },
    },
  } as unknown as GuildTextBasedChannel;
  try {
    index.upsert({
      kind: "discord",
      externalId: "999",
      channelId: "c",
      url: "https://discord.com/channels/g/c/999",
      ts: 1,
      text: "Removed source",
    });
    db.prepare("UPDATE sources SET fetched_at=1").run();
    await syncChannel(channel, cfg, db, index, q, true, () => stopped);
    expect(index.search("Radio")).toHaveLength(2);
    expect(index.getByExternalId("discord", "999")).not.toBeNull();
    stopped = false;
    await syncChannel(channel, cfg, db, index, q, true, () => stopped);
    expect(index.search("Radio")).toHaveLength(6);
    expect(index.getByExternalId("discord", "999")).toBeNull();
    expect(
      db
        .prepare(
          "SELECT value FROM cursors WHERE scope='discord-history-v2' AND key='c'",
        )
        .get(),
    ).toEqual({ value: "6" });
  } finally {
    await q.close();
    db.close();
  }
});
