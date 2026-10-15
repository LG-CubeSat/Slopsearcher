import { AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, type ChatInputCommandInteraction, type GuildBasedChannel, type Message, type TextChannel } from "discord.js";
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
export interface AccessScope { channelIds: string[]; destinationId: string; userId: string }
export interface DiscordServiceOptions {
  cfg: Config; db: Db; index: SourceIndex; queue: WorkQueue;
  onMention?: (message: Message) => Promise<void>;
  onInteraction?: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
export class DiscordService {
  readonly client: Client;
  #syncing: Promise<void> | undefined;
  #stopping = false;
  constructor(private opts: DiscordServiceOptions) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel, Partials.Message], allowedMentions: noMentions });
  }
  async start(): Promise<void> {
    const { cfg, index } = this.opts;
    this.client.on(Events.Error, e => log.error("Gateway error", e));
    this.client.on(Events.MessageCreate, m => { void this.handleMessage(m).catch(e => log.error("Message handler failed", e)); });
    this.client.on(Events.MessageUpdate, (_, m) => { void (async () => { if (m.partial) m = await m.fetch(); await this.handleMessage(m, true); })().catch(e => log.warn("Could not index edited message", e)); });
    this.client.on(Events.MessageDelete, m => { if (m.guildId === cfg.discordGuildId) index.retire("discord", m.id); });
    this.client.on(Events.MessageBulkDelete, messages => { for (const m of messages.values()) if (m.guildId === cfg.discordGuildId) index.retire("discord", m.id); });
    this.client.on(Events.ChannelDelete, c => {
      if (!("guild" in c) || c.guild.id !== cfg.discordGuildId) return;
      for (const row of this.opts.db.prepare<[string], { external_id: string }>("SELECT external_id FROM sources WHERE channel_id=? AND deleted_at IS NULL").all(c.id)) index.retire("discord", row.external_id);
    });
    this.client.on(Events.InteractionCreate, interaction => {
      if (!interaction.isChatInputCommand() || interaction.guildId !== cfg.discordGuildId) return;
      void this.opts.onInteraction?.(interaction).catch(async e => {
        log.error("Command handler failed", e);
        const content = "That command failed. Please try again or ask the bot operator to check the logs.";
        try { if (interaction.deferred || interaction.replied) await interaction.editReply({ content }); else await interaction.reply({ content, flags: 64 }); } catch (error) { log.warn("Could not report command error", error); }
      });
    });
    const ready = new Promise<void>(resolve => this.client.once(Events.ClientReady, () => resolve()));
    await this.client.login(cfg.discordToken); await ready;
    const guild = await this.client.guilds.fetch(cfg.discordGuildId);
    await guild.members.fetchMe(); await guild.channels.fetch();
    log.info(`Logged in as ${this.client.user?.tag} in ${guild.name}`);
  }
  private async handleMessage(message: Message, edited = false): Promise<void> {
    const { cfg, index, onMention } = this.opts;
    if (message.author.bot || message.guildId !== cfg.discordGuildId || !channelConfigured(cfg, message.channelId, "parentId" in message.channel ? message.channel.parentId : null)) return;
    const source = toSourceInput(message, cfg.discordGuildId);
    if (source) index.upsert(source); else index.retire("discord", message.id);
    if (!edited && this.client.user && message.mentions.users.has(this.client.user.id)) await onMention?.(message);
  }
  sync(full = false): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    if (!this.#syncing) this.#syncing = runBackfill(this.client, this.opts.cfg, this.opts.db, this.opts.index, this.opts.queue, full, () => this.#stopping).finally(() => { this.#syncing = undefined; });
    return this.#syncing;
  }
  async scope(userId: string, destinationId: string, originId = destinationId): Promise<AccessScope> {
    const guild = await this.client.guilds.fetch(this.opts.cfg.discordGuildId);
    const member = await guild.members.fetch({ user: userId, force: true });
    const destination = await guild.channels.fetch(destinationId);
    const origin = await guild.channels.fetch(originId);
    if (!destination || !origin || !origin.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) || !destination.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) throw new Error("The requester can no longer access the task's channels");
    if (origin.type === ChannelType.PrivateThread && !member.permissions.has(PermissionFlagsBits.ManageThreads)) await origin.members.fetch(userId);
    await guild.channels.fetch();
    const ids: string[] = [];
    for (const c of guild.channels.cache.values()) {
      if (!c.isTextBased() || !channelConfigured(this.opts.cfg, c.id, c.parentId)) continue;
      if (!c.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) continue;
      if (audienceCompatible(c, destination, this.client.user!.id)) ids.push(c.id);
    }
    // A research channel originating in a thread is private to the requester.
    if (destinationId !== originId && origin.isThread() && "permissionOverwrites" in destination && destination.permissionOverwrites.cache.get(userId)?.allow.has(PermissionFlagsBits.ViewChannel) && destination.permissionOverwrites.cache.get(guild.id)?.deny.has(PermissionFlagsBits.ViewChannel)) ids.push(originId);
    return { channelIds: [...new Set(ids)], destinationId, userId };
  }
  async refreshSource(source: SourceRow): Promise<void> {
    if (source.kind !== "discord" || !source.channel_id) return;
    try {
      const channel = await this.client.channels.fetch(source.channel_id);
      if (!channel?.isTextBased() || !("messages" in channel)) throw new Error("Source channel unavailable");
      const message = await channel.messages.fetch({ message: source.external_id, force: true, cache: false });
      const input = toSourceInput(message, this.opts.cfg.discordGuildId);
      if (input) this.opts.index.upsert(input); else this.opts.index.retire("discord", source.external_id);
    } catch (e) {
      if (typeof e === "object" && e && "code" in e && [10003,10008,50001,50013].includes(Number(e.code))) this.opts.index.retire("discord", source.external_id);
      throw e;
    }
  }
  async conversation(source: SourceRow, radius: number): Promise<unknown> {
    await this.refreshSource(source);
    const channel = await this.client.channels.fetch(source.channel_id!);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error("Conversation unavailable");
    const pages = await Promise.all([channel.messages.fetch({ before: source.external_id, limit: radius, cache: false }), channel.messages.fetch({ after: source.external_id, limit: radius, cache: false })]);
    for (const page of pages) for (const message of page.values()) {
      if (message.author.bot) continue;
      const input = toSourceInput(message, this.opts.cfg.discordGuildId); if (input) this.opts.index.upsert(input);
    }
    return this.opts.index.getConversation(source.external_id, radius);
  }
  async context(message: Message): Promise<unknown> {
    const nearby = await message.channel.messages.fetch({ before: message.id, limit: 15, cache: false });
    let reply: Message | undefined;
    if (message.reference?.messageId) { try { reply = await message.fetchReference(); } catch { /* deleted reference */ } }
    return { reply: reply ? { author: reply.author.username, text: reply.content, url: reply.url } : null, nearby: [...nearby.values()].reverse().map(m => ({ author: m.author.username, bot: m.author.bot, text: m.content, url: m.url })) };
  }
  async createResearchChannel(task: Task): Promise<string> {
    const guild = await this.client.guilds.fetch(this.opts.cfg.discordGuildId);
    const origin = await guild.channels.fetch(task.origin_channel_id);
    if (!origin) throw new Error("Origin channel no longer exists");
    let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === this.opts.cfg.discordSlopsearchesCategory);
    if (!category) category = await guild.channels.create({ name: this.opts.cfg.discordSlopsearchesCategory, type: ChannelType.GuildCategory });
    // Recover a channel created before an interrupted DB write.
    const marker = `slopsearcher-task:${task.id}`;
    const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.topic?.startsWith(marker));
    if (existing) return existing.id;
    const overwrites = !origin.isThread() && "permissionOverwrites" in origin
      ? origin.permissionOverwrites.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }))
      : [{ id: guild.id, type: 0 as const, allow: 0n, deny: PermissionFlagsBits.ViewChannel }, { id: task.requested_by, type: 1 as const, allow: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.SendMessages, deny: 0n }];
    const botPermissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.SendMessages | PermissionFlagsBits.AttachFiles;
    const botOverwrite = overwrites.find(o => o.id === this.client.user!.id);
    if (botOverwrite) { botOverwrite.allow |= botPermissions; botOverwrite.deny &= ~botPermissions; }
    else overwrites.push({ id: this.client.user!.id, type: 1, allow: botPermissions, deny: 0n });
    const slug = task.question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "research";
    const channel = await guild.channels.create({ name: `slop-${task.id}-${slug}`, type: ChannelType.GuildText, parent: category.id, topic: `${marker} | ${task.question.slice(0, 800)}`, permissionOverwrites: overwrites });
    await this.send(channel.id, `Research #${task.id}\n${task.question}\n\nI’ll post progress and the finished report here. Use /slop cancel to stop this task.`);
    return channel.id;
  }
  async send(channelId: string, text: string): Promise<void> {
    const c = await this.client.channels.fetch(channelId);
    if (!c?.isTextBased() || !c.isSendable()) throw new Error("Destination channel is not sendable");
    for (const content of chunks(text)) await c.send({ content, allowedMentions: noMentions });
  }
  async deliver(task: Task): Promise<string> {
    const c = await this.client.channels.fetch(task.discord_channel_id ?? task.origin_channel_id);
    if (!c?.isTextBased() || !c.isSendable()) throw new Error("Destination channel is not sendable");
    const report = task.report_text ?? "No report was returned.";
    const file = task.kind === "research" || report.length > 1900;
    const content = task.status === "failed" ? `Task #${task.id} failed after retries. The operator can check the logs; you can use /slop retry.` : file ? `Task #${task.id} completed. The full report is attached.${task.report_file_id ? `\nDrive copy: https://drive.google.com/file/d/${task.report_file_id}/view` : ""}\n\n${report.slice(0, 1200)}` : report;
    // A persisted message ID plus enforced nonce makes retrying delivery safe.
    if (task.output_message_id) { await c.messages.edit(task.output_message_id, { content: content.slice(0, 1900), allowedMentions: noMentions }); return task.output_message_id; }
    const sent = await c.send({ content: content.slice(0, 1900), ...(file && task.status !== "failed" ? { files: [new AttachmentBuilder(Buffer.from(report), { name: `slopsearch-${task.id}.md` })] } : {}), nonce: `slop-${task.id}-result`, enforceNonce: true, allowedMentions: noMentions });
    if (!file && report.length > 1900 && task.status !== "failed") for (const part of chunks(report.slice(1900))) await c.send({ content: part, allowedMentions: noMentions });
    return sent.id;
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#syncing?.catch(() => {});
    await this.client.destroy();
  }
}
