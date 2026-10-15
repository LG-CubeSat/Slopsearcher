import { createHash } from "node:crypto";
import { instanceId } from "../instance.ts";
import { projectKey } from "../project-scope.ts";
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type Message,
  type TextChannel,
} from "discord.js";
import { channelConfigured, type Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { SourceIndex } from "../index/index.ts";
import type { SourceRow } from "../index/types.ts";
import { logger } from "../log.ts";
import type { WorkQueue } from "../queue.ts";
import { runBackfill } from "./backfill.ts";
import { toSourceInput } from "./normalize.ts";
import { audienceCompatible } from "./access.ts";
import type { Task } from "../tasks/store.ts";
import { chunks, noMentions } from "../util.ts";
const log = logger("discord");
export interface AccessScope {
  channelIds: string[];
  destinationId: string;
  userId: string;
}
export interface DiscordServiceOptions {
  cfg: Config;
  db: Db;
  index: SourceIndex;
  queue: WorkQueue;
  onMention?: (message: Message) => Promise<void>;
  onInteraction?: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
export class DiscordService {
  readonly client: Client;
  #syncing: Promise<void> | undefined;
  #stopping = false;
  #fullSync = false;
  #channelCreation: Promise<void> = Promise.resolve();
  readonly instanceId: string;
  constructor(private opts: DiscordServiceOptions) {
    this.instanceId = instanceId(opts.db);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
      allowedMentions: noMentions,
    });
  }
  async start(): Promise<void> {
    const { cfg, index } = this.opts;
    this.client.on(Events.Error, (e) => log.error("Gateway error", e));
    this.client.on(Events.MessageCreate, (m) => {
      void this.handleMessage(m).catch((e) =>
        log.error("Message handler failed", e),
      );
    });
    this.client.on(Events.MessageUpdate, (_, m) => {
      void (async () => {
        if (m.partial) m = await m.fetch();
        await this.handleMessage(m, true);
      })().catch((e) => log.warn("Could not index edited message", e));
    });
    this.client.on(Events.MessageDelete, (m) => {
      if (m.guildId === cfg.discordGuildId) index.retire("discord", m.id);
    });
    this.client.on(Events.MessageBulkDelete, (messages) => {
      for (const m of messages.values())
        if (m.guildId === cfg.discordGuildId) index.retire("discord", m.id);
    });
    this.client.on(Events.ChannelDelete, (c) => {
      if (!("guild" in c) || c.guild.id !== cfg.discordGuildId) return;
      for (const row of this.opts.db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM sources WHERE channel_id=? AND deleted_at IS NULL",
        )
        .all(c.id))
        index.retire("discord", row.external_id);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (
        !interaction.isChatInputCommand() ||
        interaction.guildId !== cfg.discordGuildId
      )
        return;
      void this.opts.onInteraction?.(interaction).catch(async (e) => {
        log.error("Command handler failed", e);
        const content =
          "That command failed. Please try again or ask the bot operator to check the logs.";
        try {
          if (interaction.deferred || interaction.replied)
            await interaction.editReply({ content });
          else await interaction.reply({ content, flags: 64 });
        } catch (error) {
          log.warn("Could not report command error", error);
        }
      });
    });
    const ready = new Promise<void>((resolve) =>
      this.client.once(Events.ClientReady, () => resolve()),
    );
    let startupTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([this.client.login(cfg.discordToken), ready]),
        new Promise<never>((_, reject) => {
          startupTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "Discord Gateway startup timed out. Check the token, network, and Message Content Intent.",
                ),
              ),
            60000,
          );
        }),
      ]);
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
    }
    const guild = await this.client.guilds.fetch(cfg.discordGuildId);
    await guild.members.fetchMe();
    await guild.channels.fetch();
    log.info(`Logged in as ${this.client.user?.tag} in ${guild.name}`);
  }
  isProjectChannel(channelId: string, parentId?: string | null): boolean {
    if (
      [channelId, parentId].some(
        (id) => id && this.opts.cfg.discordExcludedChannelIds.includes(id),
      )
    )
      return false;
    return (
      channelConfigured(this.opts.cfg, channelId, parentId) ||
      Boolean(
        this.opts.db
          .prepare(
            "SELECT id FROM tasks WHERE discord_channel_id=? AND project_key=? LIMIT 1",
          )
          .get(channelId, projectKey(this.opts.cfg)),
      )
    );
  }
  private async handleMessage(message: Message, edited = false): Promise<void> {
    const { cfg, index, onMention } = this.opts;
    if (
      message.author.bot ||
      message.guildId !== cfg.discordGuildId ||
      !this.isProjectChannel(
        message.channelId,
        "parentId" in message.channel ? message.channel.parentId : null,
      )
    )
      return;
    const source = toSourceInput(message, cfg.discordGuildId);
    if (source) index.upsert(source);
    else index.retire("discord", message.id);
    if (
      !edited &&
      this.client.user &&
      message.mentions.users.has(this.client.user.id)
    )
      await onMention?.(message);
  }
  sync(full = false): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    if (this.#syncing && full && !this.#fullSync)
      return this.#syncing.then(() => this.sync(true));
    if (!this.#syncing) {
      this.#fullSync = full;
      this.#syncing = runBackfill(
        this.client,
        this.opts.cfg,
        this.opts.db,
        this.opts.index,
        this.opts.queue,
        full,
        () => this.#stopping,
      )
        .then(() => {
          this.saveSyncState("discord-sync-success", Date.now());
          this.opts.db
            .prepare(
              "DELETE FROM service_state WHERE key='discord-sync-failed'",
            )
            .run();
        })
        .catch((error: unknown) => {
          this.saveSyncState("discord-sync-failed", Date.now());
          throw error;
        })
        .finally(() => {
          this.#syncing = undefined;
          this.#fullSync = false;
        });
    }
    return this.#syncing;
  }
  private saveSyncState(key: string, value: number): void {
    this.opts.db
      .prepare(
        "INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, String(value));
  }
  status(scope: AccessScope): unknown {
    const state = (key: string) => {
      const value = this.opts.db
        .prepare<[string], { value: string }>(
          "SELECT value FROM service_state WHERE key=?",
        )
        .get(key)?.value;
      return value ? new Date(Number(value)).toISOString() : null;
    };
    const ids = scope.channelIds;
    const count = ids.length
      ? this.opts.db
          .prepare<string[], { n: number }>(
            `SELECT COUNT(*) n FROM sources WHERE kind='discord' AND deleted_at IS NULL AND channel_id IN (${ids.map(() => "?").join(",")})`,
          )
          .get(...ids)!.n
      : 0;
    return {
      checkedAt: new Date().toISOString(),
      connected: this.client.isReady(),
      syncing: Boolean(this.#syncing),
      syncType: this.#syncing
        ? this.#fullSync
          ? "full reconciliation"
          : "incremental refresh"
        : null,
      initialSyncCompleted: Boolean(state("discord-reconciled")),
      lastFullSyncCompletedAt: state("discord-reconciled"),
      lastRefreshCompletedAt: state("discord-sync-success"),
      lastRefreshFailedAt: state("discord-sync-failed"),
      indexedMessagesInAccessibleChannels: count,
      countScope:
        "Only channels readable by the requester and this conversation's audience; not necessarily the whole server.",
      coverage:
        "Configured channels and threads the bot can read; inaccessible channels are excluded.",
      refreshIntervalSeconds: this.opts.cfg.syncIntervalSeconds,
      fullReconciliationIntervalSeconds: this.opts.cfg.reconcileIntervalSeconds,
      driveSourceConfigured: Boolean(this.opts.cfg.driveSourceFolderId),
    };
  }
  async notify(task: Task, content: string): Promise<void> {
    if (task.kind === "question" && task.output_message_id) {
      const c = await this.client.channels.fetch(task.origin_channel_id);
      if (!c?.isTextBased() || !c.isSendable())
        throw new Error("Destination channel is not sendable");
      await c.messages.edit(task.output_message_id, {
        content,
        allowedMentions: noMentions,
      });
    } else
      await this.send(
        task.discord_channel_id ?? task.origin_channel_id,
        content,
      );
  }
  async scope(
    userId: string,
    destinationId: string,
    originId = destinationId,
  ): Promise<AccessScope> {
    const guild = await this.client.guilds.fetch(this.opts.cfg.discordGuildId);
    const member = await guild.members.fetch({ user: userId, force: true });
    const destination = await guild.channels.fetch(destinationId);
    const origin = await guild.channels.fetch(originId);
    if (
      !destination ||
      !origin ||
      !origin.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ||
      !destination.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)
    )
      throw new Error("The requester can no longer access the task's channels");
    if (
      origin.type === ChannelType.PrivateThread &&
      !member.permissions.has(PermissionFlagsBits.ManageThreads)
    )
      await origin.members.fetch(userId);
    await guild.channels.fetch();
    const ids: string[] = [];
    for (const c of guild.channels.cache.values()) {
      if (!c.isTextBased() || !this.isProjectChannel(c.id, c.parentId))
        continue;
      if (
        !c
          .permissionsFor(member)
          ?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ])
      )
        continue;
      if (audienceCompatible(c, destination, this.client.user!.id))
        ids.push(c.id);
    }
    // A research channel originating in a thread is private to the requester.
    if (
      destinationId !== originId &&
      origin.isThread() &&
      "permissionOverwrites" in destination &&
      destination.permissionOverwrites.cache
        .get(userId)
        ?.allow.has(PermissionFlagsBits.ViewChannel) &&
      destination.permissionOverwrites.cache
        .get(guild.id)
        ?.deny.has(PermissionFlagsBits.ViewChannel)
    )
      ids.push(originId);
    return { channelIds: [...new Set(ids)], destinationId, userId };
  }
  async refreshSource(source: SourceRow): Promise<void> {
    if (source.kind !== "discord" || !source.channel_id) return;
    try {
      const channel = await this.client.channels.fetch(source.channel_id);
      if (!channel?.isTextBased() || !("messages" in channel))
        throw new Error("Source channel unavailable");
      const message = await channel.messages.fetch({
        message: source.external_id,
        force: true,
        cache: false,
      });
      const input = toSourceInput(message, this.opts.cfg.discordGuildId);
      if (input) this.opts.index.upsert(input);
      else this.opts.index.retire("discord", source.external_id);
    } catch (e) {
      if (
        typeof e === "object" &&
        e &&
        "code" in e &&
        [10003, 10008, 50001, 50013].includes(Number(e.code))
      )
        this.opts.index.retire("discord", source.external_id);
      throw e;
    }
  }
  async conversation(source: SourceRow, radius: number): Promise<unknown> {
    await this.refreshSource(source);
    const channel = await this.client.channels.fetch(source.channel_id!);
    if (!channel?.isTextBased() || !("messages" in channel))
      throw new Error("Conversation unavailable");
    const pages = await Promise.all([
      channel.messages.fetch({
        before: source.external_id,
        limit: radius,
        cache: false,
      }),
      channel.messages.fetch({
        after: source.external_id,
        limit: radius,
        cache: false,
      }),
    ]);
    for (const page of pages)
      for (const message of page.values()) {
        if (message.author.bot) continue;
        const input = toSourceInput(message, this.opts.cfg.discordGuildId);
        if (input) this.opts.index.upsert(input);
      }
    return this.opts.index.getConversation(source.external_id, radius);
  }
  async context(message: Message): Promise<unknown> {
    const nearby = await message.channel.messages.fetch({
      before: message.id,
      limit: 15,
      cache: false,
    });
    let reply: Message | undefined;
    if (message.reference?.messageId) {
      try {
        reply = await message.fetchReference();
      } catch {
        /* deleted reference */
      }
    }
    return {
      reply: reply
        ? {
            author: reply.author.username,
            bot: reply.author.bot,
            text: reply.content,
            url: reply.url,
          }
        : null,
      nearby: [...nearby.values()].reverse().map((m) => ({
        author: m.author.username,
        bot: m.author.bot,
        text: m.content,
        url: m.url,
      })),
    };
  }
  createResearchChannel(task: Task): Promise<string> {
    const result = this.#channelCreation.then(() =>
      this.performCreateResearchChannel(task),
    );
    this.#channelCreation = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async performCreateResearchChannel(task: Task): Promise<string> {
    const guild = await this.client.guilds.fetch(this.opts.cfg.discordGuildId);
    const origin = await guild.channels.fetch(task.origin_channel_id);
    if (!origin) throw new Error("Origin channel no longer exists");
    let category = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildCategory &&
        c.name === this.opts.cfg.discordSlopsearchesCategory,
    );
    if (!category)
      category = await guild.channels.create({
        name: this.opts.cfg.discordSlopsearchesCategory,
        type: ChannelType.GuildCategory,
      });
    // Recover a channel created before an interrupted DB write.
    const marker = `slopsearcher:${this.instanceId}:task:${task.id}`;
    const existing = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.topic?.startsWith(marker),
    );
    if (existing) return existing.id;
    const overwrites =
      !origin.isThread() && "permissionOverwrites" in origin
        ? origin.permissionOverwrites.cache.map((o) => ({
            id: o.id,
            type: o.type,
            allow: o.allow.bitfield,
            deny: o.deny.bitfield,
          }))
        : [
            {
              id: guild.id,
              type: 0 as const,
              allow: 0n,
              deny: PermissionFlagsBits.ViewChannel,
            },
            {
              id: task.requested_by,
              type: 1 as const,
              allow:
                PermissionFlagsBits.ViewChannel |
                PermissionFlagsBits.ReadMessageHistory |
                PermissionFlagsBits.SendMessages,
              deny: 0n,
            },
          ];
    const availablePermissions = guild.members.me!.permissions.has(
      PermissionFlagsBits.Administrator,
    )
      ? PermissionsBitField.All
      : guild.members.me!.permissions.bitfield;
    const audienceBits =
      PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
    for (const overwrite of overwrites) {
      if (
        ((overwrite.allow | overwrite.deny) &
          audienceBits &
          ~availablePermissions) !==
        0n
      )
        throw new Error(
          "Grant the bot View Channel and Read Message History on its server role before creating research channels",
        );
      overwrite.allow &= availablePermissions;
      overwrite.deny &= availablePermissions;
    }
    const botPermissions =
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.ReadMessageHistory |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.AttachFiles;
    const botOverwrite = overwrites.find((o) => o.id === this.client.user!.id);
    if (botOverwrite) {
      botOverwrite.allow |= botPermissions;
      botOverwrite.deny &= ~botPermissions;
    } else
      overwrites.push({
        id: this.client.user!.id,
        type: 1,
        allow: botPermissions,
        deny: 0n,
      });
    const slug =
      task.question
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 55) || "research";
    const channel = await guild.channels.create({
      name: `slop-${task.id}-${slug}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${marker} | ${task.question.slice(0, 800)}`,
      permissionOverwrites: overwrites,
    });
    await this.send(
      channel.id,
      `Research #${task.id}\n${task.question}\n\nI’ll post progress and the finished report here. Use /slop cancel to stop this task.`,
    );
    return channel.id;
  }
  async send(channelId: string, text: string): Promise<void> {
    const c = await this.client.channels.fetch(channelId);
    if (!c?.isTextBased() || !c.isSendable())
      throw new Error("Destination channel is not sendable");
    for (const content of chunks(text))
      await c.send({ content, allowedMentions: noMentions });
  }
  async deliver(task: Task): Promise<string> {
    const c = await this.client.channels.fetch(
      task.discord_channel_id ?? task.origin_channel_id,
    );
    if (!c?.isTextBased() || !c.isSendable())
      throw new Error("Destination channel is not sendable");
    const report = task.report_text ?? "No report was returned.";
    const file =
      task.kind === "research" ||
      report.length > 1900 ||
      (task.status === "failed" && Boolean(task.report_text));
    const content =
      task.status === "failed"
        ? `Task #${task.id} failed after retries.${task.report_text ? " The latest partial report is attached." : ""} The operator can check the logs; you can use /slop retry.`
        : file
          ? `Task #${task.id} completed. The full report is attached.${task.report_file_id ? `\nDrive copy: https://drive.google.com/file/d/${task.report_file_id}/view` : ""}\n\n${report.slice(0, 1200)}`
          : report;
    const payload = {
      content: content.slice(0, 1900),
      allowedMentions: noMentions,
      attachments: [],
      ...(file && (task.status !== "failed" || Boolean(task.report_text))
        ? {
            files: [
              new AttachmentBuilder(Buffer.from(report), {
                name: `slopsearch-${task.id}${task.status === "failed" ? "-partial" : ""}.md`,
              }),
            ],
          }
        : {}),
    };
    // Persisted reply IDs survive restarts. Replace attachments on repeated edits.
    if (task.output_message_id) {
      try {
        await c.messages.edit(task.output_message_id, payload);
        return task.output_message_id;
      } catch (error) {
        // Recreate a deleted reply, but retry permission/network errors normally.
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== 10008
        )
          throw error;
      }
    }
    const sent = await c.send({
      ...payload,
      nonce: createHash("sha256")
        .update(`${this.instanceId}:${task.id}:result`)
        .digest("hex")
        .slice(0, 24),
      enforceNonce: true,
      allowedMentions: noMentions,
    });
    return sent.id;
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#syncing?.catch(() => {});
    await this.client.destroy();
  }
}
