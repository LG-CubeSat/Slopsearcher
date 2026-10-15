import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { setCursor } from "../db/cursors.ts";
import type { SourceIndex } from "../index/index.ts";
import { logger } from "../log.ts";
import type { WorkQueue } from "../queue.ts";
import { runBackfill } from "./backfill.ts";
import { toSourceInput } from "./normalize.ts";

const log = logger("discord");

export interface DiscordServiceOptions {
  cfg: Config;
  db: Db;
  index: SourceIndex;
  queue: WorkQueue;
  /** Invoked when the bot is mentioned. Wired to Q&A in phase 2. */
  onMention?: (message: Message) => void | Promise<void>;
  /** Invoked for every newly indexed message. Feeds extraction in phase 5. */
  onIndexed?: (message: Message) => void;
}

export class DiscordService {
  readonly client: Client;
  readonly #opts: DiscordServiceOptions;

  constructor(opts: DiscordServiceOptions) {
    this.#opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        // Privileged. Without it every `message.content` is an empty string and
        // the index fills with blanks, so the failure is loud at startup below.
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start(): Promise<void> {
    const { cfg, db, index, queue } = this.#opts;

    this.client.on(Events.Error, (error) => log.error("gateway error", error));
    this.client.on(Events.MessageCreate, (message) => {
      void this.#handleMessage(message);
    });
    this.client.on(Events.MessageUpdate, (_old, updated) => {
      // The upsert is hash-aware, so re-indexing an edit is cheap and an edit
      // that changed nothing searchable costs one comparison.
      if (updated.partial) return;
      void this.#handleMessage(updated as Message, { skipMention: true });
    });

    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, () => resolve());
    });

    await this.client.login(cfg.discordToken);
    await ready;
    log.info(`logged in as ${this.client.user?.tag}`);

    // Backfill runs in the background at the lowest priority; the bot is
    // responsive to mentions from the moment it is ready.
    void runBackfill(this.client, cfg, db, index, queue).catch((error: unknown) =>
      log.error("backfill aborted", error),
    );
  }

  async #handleMessage(
    message: Message,
    opts: { skipMention?: boolean } = {},
  ): Promise<void> {
    const { cfg, db, index, onMention, onIndexed } = this.#opts;

    if (message.author?.bot) return;
    if (message.guildId !== cfg.discordGuildId) return;
    if (
      cfg.discordChannelIds.length > 0 &&
      !cfg.discordChannelIds.includes(message.channelId)
    ) {
      return;
    }

    const input = toSourceInput(message, cfg.discordGuildId);
    if (input) {
      const result = index.upsertMany([input]);
      // Live messages advance the same cursor backfill uses, so a restart
      // doesn't re-walk history the gateway already delivered.
      setCursor(db, "discord", message.channelId, message.id);
      if (result.inserted > 0) onIndexed?.(message);
    }

    if (
      !opts.skipMention &&
      this.client.user &&
      message.mentions.users.has(this.client.user.id)
    ) {
      await onMention?.(message);
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
