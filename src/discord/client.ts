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
  type ButtonInteraction,
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
import { resolveDiscordMember, recentMemberMessages } from "./members.ts";
import { audienceCompatible } from "./access.ts";
import { loadMessageImages, messageImages } from "./images.ts";
import type { Task } from "../tasks/store.ts";
import { chunks, noMentions } from "../util.ts";
const log = logger("discord");
export interface AccessScope {
  channelIds: string[];
  destinationId: string;
  userId: string;
  originId?: string;
}
export interface DiscordServiceOptions {
  cfg: Config;
  db: Db;
  index: SourceIndex;
  queue: WorkQueue;
  onMention?: (message: Message) => Promise<void>;
  onInteraction?: (interaction: ChatInputCommandInteraction) => Promise<void>;
  onButton?: (interaction: ButtonInteraction) => Promise<void>;
  onResearchChannelDeleted?: (channelId: string) => Promise<void>;
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
      if (
        this.opts.db
          .prepare(
            "SELECT id FROM tasks WHERE kind='research' AND discord_channel_id=? AND project_key=? LIMIT 1",
          )
          .get(c.id, projectKey(cfg))
      )
        void this.opts
          .onResearchChannelDeleted?.(c.id)
          .catch((error) =>
            log.warn(
              "Could not stop tasks for a deleted research channel",
              error,
            ),
          );
      for (const row of this.opts.db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM sources WHERE channel_id=? AND deleted_at IS NULL",
        )
        .all(c.id))
        index.retire("discord", row.external_id);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (
        interaction.isButton() &&
        interaction.guildId === cfg.discordGuildId &&
        interaction.customId.startsWith("slop-delete:")
      ) {
        void this.opts.onButton?.(interaction).catch(async (error) => {
          log.error("Research deletion confirmation failed", error);
          const content =
            "Could not delete the research channel. Ask the bot operator to check the logs.";
          try {
            if (interaction.deferred || interaction.replied)
              await interaction.editReply({ content, components: [] });
            else await interaction.reply({ content, flags: 64 });
          } catch (replyError) {
            log.warn("Could not report deletion error", replyError);
          }
        });
        return;
      }
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
      (message.mentions.users.has(this.client.user.id) ||
        Boolean(
          message.guild?.members.me?.roles.botRole &&
          message.mentions.roles.has(message.guild.members.me.roles.botRole.id),
        ))
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
    return { channelIds: [...new Set(ids)], destinationId, userId, originId };
  }
  async resolveMember(query: string) {
    return resolveDiscordMember(
      this.client,
      this.opts.cfg.discordGuildId,
      query,
    );
  }
  async memberMessages(
    scope: AccessScope,
    userId: string,
    limit: number,
    channelId?: string,
  ) {
    const current = await this.scope(
      scope.userId,
      scope.destinationId,
      scope.originId ?? scope.destinationId,
    );
    const allowed = scope.channelIds.filter((id) =>
      current.channelIds.includes(id),
    );
    if (channelId && !allowed.includes(channelId))
      throw new Error("Channel not allowed");
    return recentMemberMessages(
      this.client,
      this.opts.cfg.discordGuildId,
      channelId ? [channelId] : allowed,
      userId,
      limit,
      this.opts.index,
      () => this.#stopping,
    );
  }
  messageIdentity(message: Message) {
    return {
      originMessageId: message.id,
      originChannelId: message.channelId,
      images: messageImages(message),
      requester: {
        id: message.author.id,
        username: message.author.username,
        displayName:
          message.member?.displayName ??
          message.author.globalName ??
          message.author.username,
      },
      mentionedUsers: [...message.mentions.users.values()].map((user) => ({
        id: user.id,
        username: user.username,
        globalName: user.globalName,
        displayName:
          message.mentions.members?.get(user.id)?.displayName ??
          user.globalName ??
          user.username,
        bot: user.bot,
      })),
      mentionedChannels: [...message.mentions.channels.values()].map(
        (channel) => ({
          id: channel.id,
          name: "name" in channel ? channel.name : null,
        }),
      ),
    };
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
      ...this.messageIdentity(message),
      reply: reply
        ? {
            id: reply.id,
            channelId: reply.channelId,
            authorId: reply.author.id,
            author: reply.author.username,
            bot: reply.author.bot,
            text: reply.content,
            url: reply.url,
            images: messageImages(reply),
          }
        : null,
      nearby: [...nearby.values()].reverse().map((m) => ({
        authorId: m.author.id,
        author: m.author.username,
        bot: m.author.bot,
        text: m.content,
        url: m.url,
      })),
    };
  }
  async imageContext(task: Task, scope: AccessScope, signal: AbortSignal) {
    const empty = {
      images: [],
      notes: [] as string[],
      sourceChannels: [] as string[],
    };
    if (!task.origin_message_id) return empty;
    if (!scope.channelIds.includes(task.origin_channel_id))
      throw new Error("Image source channel is outside the authorized scope");
    const channel = await this.client.channels.fetch(task.origin_channel_id);
    if (!channel?.isTextBased() || !("messages" in channel)) return empty;
    let origin: Message;
    try {
      origin = await channel.messages.fetch({
        message: task.origin_message_id,
        force: true,
        cache: false,
      });
    } catch (error) {
      // Slash-command interaction IDs are not Discord message IDs.
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        Number(error.code) === 10008
      )
        return empty;
      throw error;
    }
    if (origin.guildId !== this.opts.cfg.discordGuildId)
      throw new Error("Image source belongs to another server");
    const messages = [origin];
    const notes: string[] = [];
    const reference = origin.reference;
    if (reference?.messageId) {
      const referenceChannel = reference.channelId ?? origin.channelId;
      if (!scope.channelIds.includes(referenceChannel)) {
        notes.push(
          "The replied-to message is outside the authorized source scope; its images were not loaded.",
        );
      } else {
        try {
          const target = await this.client.channels.fetch(referenceChannel);
          if (!target?.isTextBased() || !("messages" in target))
            throw new Error("Reply channel unavailable");
          const reply = await target.messages.fetch({
            message: reference.messageId,
            force: true,
            cache: false,
          });
          if (reply.guildId === this.opts.cfg.discordGuildId)
            messages.push(reply);
        } catch {
          notes.push(
            "The replied-to message could not be refreshed; its images were not loaded.",
          );
        }
      }
    }
    signal.throwIfAborted();
    const result = await loadMessageImages(messages, signal);
    return {
      ...result,
      notes: [...notes, ...result.notes],
      sourceChannels: [
        ...new Set(
          messages
            .filter((m) => messageImages(m).length)
            .map((m) => m.channelId),
        ),
      ],
    };
  }
  private researchMarker(taskId: number): string {
    return `slopsearcher:${this.instanceId}:task:${taskId}`;
  }
  private markerMatches(topic: string | null, taskId: number): boolean {
    const marker = this.researchMarker(taskId);
    return topic === marker || Boolean(topic?.startsWith(`${marker} | `));
  }
  private async researchCategory() {
    const guild = await this.client.guilds.fetch(this.opts.cfg.discordGuildId);
    await guild.channels.fetch();
    const key = `research-category:${guild.id}`;
    const saved = this.opts.db
      .prepare<[string], { value: string }>(
        "SELECT value FROM service_state WHERE key=?",
      )
      .get(key)?.value;
    let category =
      guild.channels.cache.find(
        (c) =>
          c.id === saved &&
          c.type === ChannelType.GuildCategory &&
          c.name === this.opts.cfg.discordSlopsearchesCategory,
      ) ??
      guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildCategory &&
          c.name === this.opts.cfg.discordSlopsearchesCategory,
      );
    if (!category)
      category = await guild.channels.create({
        name: this.opts.cfg.discordSlopsearchesCategory,
        type: ChannelType.GuildCategory,
      });
    this.opts.db
      .prepare(
        "INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, category.id);
    return category;
  }
  async organizeResearchChannels(): Promise<void> {
    const category = await this.researchCategory();
    const guild = await this.client.guilds.fetch(this.opts.cfg.discordGuildId);
    const tasks = this.opts.db
      .prepare<[string], Task>(
        "SELECT * FROM tasks WHERE kind='research' AND discord_channel_id IS NOT NULL AND channel_closed_at IS NULL AND project_key=?",
      )
      .all(projectKey(this.opts.cfg));
    for (const task of tasks) {
      const channel = guild.channels.cache.get(task.discord_channel_id!);
      if (
        channel?.type !== ChannelType.GuildText ||
        !this.markerMatches(channel.topic, task.id)
      )
        continue;
      if (channel.parentId !== category.id)
        await channel.setParent(category.id, {
          lockPermissions: false,
          reason: "Organize Slopsearcher long-running research",
        });
    }
  }
  async researchChannelForDeletion(channelId: string, userId: string) {
    const task = this.opts.db
      .prepare<[string, string], Task>(
        "SELECT * FROM tasks WHERE kind='research' AND discord_channel_id=? AND project_key=? LIMIT 1",
      )
      .get(channelId, projectKey(this.opts.cfg));
    if (!task)
      throw new Error(
        `I can only delete research channels I created under ${this.opts.cfg.discordSlopsearchesCategory}.`,
      );
    const guild = await this.client.guilds.fetch(this.opts.cfg.discordGuildId);
    const channel = await guild.channels.fetch(channelId, { force: true });
    const categoryId = this.opts.db
      .prepare<[string], { value: string }>(
        "SELECT value FROM service_state WHERE key=?",
      )
      .get(`research-category:${guild.id}`)?.value;
    if (
      channel?.type !== ChannelType.GuildText ||
      channel.guildId !== guild.id ||
      !this.markerMatches(channel.topic, task.id) ||
      !categoryId ||
      channel.parentId !== categoryId
    )
      throw new Error(
        "This channel is not a verified Slopsearcher long-running research channel.",
      );
    const category = await guild.channels.fetch(categoryId, { force: true });
    if (
      category?.type !== ChannelType.GuildCategory ||
      category.name !== this.opts.cfg.discordSlopsearchesCategory
    )
      throw new Error(
        "The research category has changed. Ask the bot operator to check it.",
      );
    const member = await guild.members.fetch({ user: userId, force: true });
    if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel))
      throw new Error("You cannot access this research channel.");
    if (
      task.requested_by !== userId &&
      !member.permissions.has(PermissionFlagsBits.ManageGuild)
    )
      throw new Error(
        "Only the research creator or a server manager can delete this channel.",
      );
    return { task, channel };
  }
  async deleteResearchChannel(
    channelId: string,
    userId: string,
    taskId: number,
  ): Promise<void> {
    // Repeat all ownership and authorization checks immediately before deletion.
    const current = await this.researchChannelForDeletion(channelId, userId);
    if (current.task.id !== taskId || !current.task.channel_closed_at)
      throw new Error("Research deletion has not been prepared");
    await current.channel.delete(
      `Research #${taskId} deletion confirmed by ${userId}`,
    );
    for (const source of this.opts.db
      .prepare<[string], { external_id: string }>(
        "SELECT external_id FROM sources WHERE kind='discord' AND channel_id=? AND deleted_at IS NULL",
      )
      .all(channelId))
      this.opts.index.retire("discord", source.external_id);
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
    if (task.channel_closed_at)
      throw new Error("This research channel was closed");
    const guild = await this.client.guilds.fetch(this.opts.cfg.discordGuildId);
    const origin = await guild.channels.fetch(task.origin_channel_id);
    if (!origin) throw new Error("Origin channel no longer exists");
    const category = await this.researchCategory();
    // Recover a channel created before an interrupted DB write.
    const marker = this.researchMarker(task.id);
    const existing = guild.channels.cache.find(
      (c): c is TextChannel =>
        c.type === ChannelType.GuildText &&
        this.markerMatches(c.topic, task.id),
    );
    if (existing) {
      if (existing.parentId !== category.id)
        await existing.setParent(category.id, { lockPermissions: false });
      return existing.id;
    }
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
      PermissionFlagsBits.AttachFiles |
      PermissionFlagsBits.ManageChannels;
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
      `Research #${task.id}\n${task.question}\n\nI’ll post progress and the finished report here. Use /slop cancel to stop this task. To delete this research channel, use /slop delete or mention me with “delete this channel”.`,
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
