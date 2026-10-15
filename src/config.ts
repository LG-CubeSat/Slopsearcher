import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/**
 * Comma-separated env lists arrive as "" when unset, which `split` would turn
 * into [""] rather than []. Normalize that here so callers can treat an empty
 * list as "no filter".
 */
const csv = z
  .string()
  .default("")
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

const intIn = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const schema = z.object({
  dbPath: z.string().min(1),

  discordToken: z.string().default(""),
  discordGuildId: z.string().default(""),
  discordChannelIds: csv,
  discordSlopsearchesCategory: z.string().default("slopsearches"),

  googleClientId: z.string().default(""),
  googleClientSecret: z.string().default(""),
  googleRedirectUri: z.string().default(""),
  googleTokenPath: z.string().default("./data/google-token.json"),
  driveSourceFolderId: z.string().default(""),
  driveReportsFolderId: z.string().default(""),

  codexBin: z.string().default("codex"),

  // Discord's history endpoint hard-caps a page at 100.
  backfillPageSize: intIn(1, 100).default(100),
  backfillConcurrency: intIn(1, 16).default(3),
  extractWindowIdleSeconds: intIn(30, 86_400).default(900),
  extractWindowMaxMessages: intIn(1, 1000).default(80),

  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse({
    dbPath: env.DB_PATH ?? "./data/slopsearcher.db",

    discordToken: env.DISCORD_TOKEN,
    discordGuildId: env.DISCORD_GUILD_ID,
    discordChannelIds: env.DISCORD_CHANNEL_IDS,
    discordSlopsearchesCategory: env.DISCORD_SLOPSEARCHES_CATEGORY,

    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: env.GOOGLE_REDIRECT_URI,
    googleTokenPath: env.GOOGLE_TOKEN_PATH,
    driveSourceFolderId: env.DRIVE_SOURCE_FOLDER_ID,
    driveReportsFolderId: env.DRIVE_REPORTS_FOLDER_ID,

    codexBin: env.CODEX_BIN,

    backfillPageSize: env.BACKFILL_PAGE_SIZE,
    backfillConcurrency: env.BACKFILL_CONCURRENCY,
    extractWindowIdleSeconds: env.EXTRACT_WINDOW_IDLE_SECONDS,
    extractWindowMaxMessages: env.EXTRACT_WINDOW_MAX_MESSAGES,

    logLevel: env.LOG_LEVEL,
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  return parsed.data;
}

/**
 * Phases come online one at a time, so config is validated lazily per feature
 * rather than demanding every credential at boot. A service that only indexes
 * Discord should not refuse to start because Drive is unconfigured.
 */
export function requireDiscord(cfg: Config): void {
  const missing = [
    ["DISCORD_TOKEN", cfg.discordToken],
    ["DISCORD_GUILD_ID", cfg.discordGuildId],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    throw new Error(
      `Discord is not configured. Set: ${missing.map(([name]) => name).join(", ")}`,
    );
  }
}

export function requireDrive(cfg: Config): void {
  const missing = [
    ["GOOGLE_CLIENT_ID", cfg.googleClientId],
    ["GOOGLE_CLIENT_SECRET", cfg.googleClientSecret],
    ["DRIVE_SOURCE_FOLDER_ID", cfg.driveSourceFolderId],
    ["DRIVE_REPORTS_FOLDER_ID", cfg.driveReportsFolderId],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    throw new Error(
      `Drive is not configured. Set: ${missing.map(([name]) => name).join(", ")}`,
    );
  }
}
