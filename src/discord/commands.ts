import {
  PermissionFlagsBits,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { projectKey } from "../project-scope.ts";
import { channelConfigured, type Config } from "../config.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { TaskWorker } from "../tasks/worker.ts";
import type { SourceIndex } from "../index/index.ts";
import type { DiscordService } from "./client.ts";
import { noMentions, withTimeout } from "../util.ts";
import { logger } from "../log.ts";
const log = logger("commands");
export const command = new SlashCommandBuilder()
  .setName("slop")
  .setDescription("Ask questions and investigate the CubeSat project")
  .addSubcommand((c) =>
    c
      .setName("ask")
      .setDescription("Ask a question using project history")
      .addStringOption((o) =>
        o
          .setName("question")
          .setDescription("What would you like to know?")
          .setRequired(true)
          .setMaxLength(4000),
      ),
  )
  .addSubcommand((c) =>
    c
      .setName("research")
      .setDescription("Start an ongoing investigation in a dedicated channel")
      .addStringOption((o) =>
        o
          .setName("question")
          .setDescription("Research goal")
          .setRequired(true)
          .setMaxLength(4000),
      ),
  )
  .addSubcommand((c) =>
    c
      .setName("search")
      .setDescription("Find original project messages and documents")
      .addStringOption((o) =>
        o
          .setName("query")
          .setDescription("Keywords or part numbers")
          .setRequired(true)
          .setMaxLength(500),
      ),
  )
  .addSubcommand((c) =>
    c
      .setName("status")
      .setDescription("Show your recent tasks or one task")
      .addIntegerOption((o) =>
        o.setName("id").setDescription("Task number").setMinValue(1),
      ),
  )
  .addSubcommand((c) =>
    c
      .setName("cancel")
      .setDescription("Stop one of your tasks")
      .addIntegerOption((o) =>
        o
          .setName("id")
          .setDescription("Task number")
          .setRequired(true)
          .setMinValue(1),
      ),
  )
  .addSubcommand((c) =>
    c
      .setName("retry")
      .setDescription("Retry a failed or cancelled task")
      .addIntegerOption((o) =>
        o
          .setName("id")
          .setDescription("Task number")
          .setRequired(true)
          .setMinValue(1),
      ),
  )
  .addSubcommand((c) =>
    c
      .setName("sync")
      .setDescription("Refresh project sources now (server managers)"),
  )
  .addSubcommand((c) =>
    c.setName("help").setDescription("Show what Slopsearcher can do"),
  );
export const help =
  "Mention me or use /slop ask to ask about the project. Reply to a message and mention me to include that conversation. Ask me to make a question long-running, or use /slop research, to start a dedicated investigation.\n\n/slop search finds original sources. /slop status shows your tasks. /slop cancel stops a task, and /slop retry retries a failed or cancelled one. Research reports include source links and are attached in the task’s channel.";
export function isResearchRequest(text: string): boolean {
  return /\blong[\s-]*running\b|\b(?:ongoing|deep)\s+(?:research|investigation)\b|\bstart\s+(?:a\s+)?(?:research|investigation)\b|\bresearch\s+(?:this|that)\b/i.test(
    text,
  );
}
export class Commands {
  constructor(
    private cfg: Config,
    private discord: DiscordService,
    private store: TaskStore,
    private worker: TaskWorker,
    private index: SourceIndex,
    private sync: () => Promise<void>,
  ) {}
  async register(): Promise<void> {
    const guild = await this.discord.client.guilds.fetch(
      this.cfg.discordGuildId,
    );
    const existing = (await guild.commands.fetch()).find(
      (c) => c.name === "slop",
    );
    if (existing)
      await this.discord.client.rest.patch(
        Routes.applicationGuildCommand(
          this.discord.client.user!.id,
          guild.id,
          existing.id,
        ),
        { body: command.toJSON() },
      );
    else await guild.commands.create(command.toJSON());
  }
  private async canResearch(userId: string): Promise<boolean> {
    if (
      this.cfg.researchEveryone ||
      this.cfg.researchAllowedUserIds.includes(userId)
    )
      return true;
    const guild = await this.discord.client.guilds.fetch(
      this.cfg.discordGuildId,
    );
    const member = await guild.members.fetch(userId);
    return this.cfg.researchAllowedRoleIds.some((id) =>
      member.roles.cache.has(id),
    );
  }
  async mention(message: Message): Promise<void> {
    const botRole = message.guild?.members.me?.roles.botRole?.id;
    const question = message.content
      .replace(new RegExp(`<@!?${this.discord.client.user!.id}>`, "g"), "")
      .replace(botRole ? new RegExp(`<@&${botRole}>`, "g") : /$^/, "")
      .trim();
    if (!question) {
      await message.reply({ content: help, allowedMentions: noMentions });
      return;
    }
    const kind = isResearchRequest(question) ? "research" : "question";
    if (kind === "research" && !(await this.canResearch(message.author.id))) {
      await message.reply({
        content:
          "Research is restricted to the configured project roles or users.",
        allowedMentions: noMentions,
      });
      return;
    }
    let placeholder: Message | undefined;
    try {
      if (question.length > 4000)
        throw new Error("Please keep the question under 4,000 characters.");
      if (kind === "question")
        placeholder = await message.reply({
          content:
            "Question received — getting ready… I’ll keep this message updated.",
          allowedMentions: noMentions,
        });
      const context = await withTimeout(
        this.discord.context(message),
        8000,
      ).catch((error) => {
        log.warn(
          "Could not load nearby discussion; continuing with the question",
          error,
        );
        return { unavailable: true };
      });
      const task = this.store.create(
        {
          kind,
          question,
          userId: message.author.id,
          channelId: message.channelId,
          messageId: message.id,
          ...(placeholder ? { outputMessageId: placeholder.id } : {}),
          context,
        },
        this.cfg,
      );
      if (kind === "research")
        await message.reply({
          content: `Research #${task.id} is queued. I’ll post its channel link here when it starts.`,
          allowedMentions: noMentions,
        });
      this.worker.tick();
    } catch (e) {
      const options = {
        content:
          e instanceof Error
            ? e.message.slice(0, 1000)
            : "Could not queue that request.",
        allowedMentions: noMentions,
      };
      if (placeholder) await placeholder.edit(options);
      else await message.reply(options);
    }
  }
  async interaction(i: ChatInputCommandInteraction): Promise<void> {
    if (i.commandName !== "slop") return;
    const sub = i.options.getSubcommand();
    await i.deferReply(sub === "ask" ? {} : { flags: 64 });
    const reply = async (content: string) => {
      return await i.editReply({
        content: content.slice(0, 1950),
        allowedMentions: noMentions,
      });
    };
    if (sub === "help") {
      await reply(help);
      return;
    }
    if (sub === "sync") {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await reply("Only server managers can request a manual refresh.");
        return;
      }
      await reply(
        "Refreshing Discord and Drive sources. This can take a while for a large project.",
      );
      void this.sync().catch(() => {});
      return;
    }
    if (["status", "cancel", "retry"].includes(sub)) {
      const id = i.options.getInteger("id");
      const tasks = id
        ? [this.store.get(id)].filter((t) => t !== null)
        : this.store.list(i.user.id, 10, projectKey(this.cfg));
      const visible = tasks.filter(
        (t) =>
          t.project_key === projectKey(this.cfg) &&
          (t.requested_by === i.user.id ||
            i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
      );
      if (!visible.length) {
        await reply("No matching tasks found.");
        return;
      }
      if (sub === "status") {
        await reply(
          visible
            .map(
              (t) =>
                `#${t.id} · ${t.status} · ${t.kind} · ${t.question.slice(0, 100)}${t.discord_channel_id ? `\n<#${t.discord_channel_id}>` : ""}${t.error === "Waiting for Codex sign-in" ? "\nWaiting for Codex sign-in" : ""}`,
            )
            .join("\n\n"),
        );
        return;
      }
      const task = visible[0]!;
      if (sub === "cancel") {
        if (!["pending", "running", "paused"].includes(task.status)) {
          await reply(`Task #${task.id} is already ${task.status}.`);
          return;
        }
        this.worker.cancel(task.id);
        await reply(`Task #${task.id} cancelled.`);
        return;
      }
      if (task.error?.startsWith("Project configuration changed")) {
        await reply(
          "That task belongs to a previous project configuration. Please start a new task.",
        );
        return;
      }
      if (!["failed", "cancelled", "paused"].includes(task.status)) {
        await reply("Only failed, cancelled, or paused tasks can be retried.");
        return;
      }
      if (task.kind === "research" && !(await this.canResearch(i.user.id))) {
        await reply("You are not allowed to start research.");
        return;
      }
      await this.discord.scope(
        task.requested_by,
        task.discord_channel_id ?? task.origin_channel_id,
        task.origin_channel_id,
      );
      const count = this.store.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) n FROM tasks WHERE status IN ('pending','running')",
        )
        .get()!.n;
      if (count >= this.cfg.maxPendingTasks) {
        await reply("The task queue is full. Try again later.");
        return;
      }
      this.store.update(task.id, {
        status: "pending",
        attempts: 0,
        turn_count: 0,
        error: null,
        next_run_at: 0,
        delivery_pending: 0,
      });
      this.store.event(task.id, "retried");
      await reply(`Task #${task.id} queued again.`);
      this.worker.tick();
      return;
    }
    const channel = await i.guild!.channels.fetch(i.channelId);
    if (
      !channel ||
      !this.discord.isProjectChannel(channel.id, channel.parentId)
    ) {
      await reply(
        "This channel is outside the bot's configured project channels.",
      );
      return;
    }
    if (sub === "search") {
      const scope = await this.discord.scope(i.user.id, i.channelId);
      const hits = this.index.search(i.options.getString("query", true), {
        allowedChannelIds: scope.channelIds,
        limit: 8,
      });
      await reply(
        hits.length
          ? hits
              .map(
                (s) =>
                  `[${s.title ?? s.channel_name ?? s.kind}](${s.url})\n${s.snippet.slice(0, 150)}`,
              )
              .join("\n\n")
          : "No indexed sources matched. Try different keywords or wait for the initial sync.",
      );
      return;
    }
    const kind = sub === "research" ? "research" : "question";
    if (kind === "research" && !(await this.canResearch(i.user.id))) {
      await reply(
        "Research is restricted to the configured project roles or users.",
      );
      return;
    }
    try {
      const placeholder =
        kind === "question"
          ? await reply(
              "Question received — getting ready… I’ll keep this message updated.",
            )
          : null;
      const task = this.store.create(
        {
          kind,
          question: i.options.getString("question", true),
          userId: i.user.id,
          channelId: i.channelId,
          messageId: i.id,
          ...(placeholder ? { outputMessageId: placeholder.id } : {}),
        },
        this.cfg,
      );
      if (kind === "research")
        await reply(
          `Research #${task.id} is queued. I’ll post its research channel link here when it starts.`,
        );
      this.worker.tick();
    } catch (e) {
      await reply(
        e instanceof Error ? e.message : "Could not queue that task.",
      );
    }
  }
}
