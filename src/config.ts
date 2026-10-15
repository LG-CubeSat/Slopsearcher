import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

loadDotenv({ quiet: true });
const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(String(fallback) as "true" | "false")
    .transform((v) => v === "true");
const schema = z.object({
  dbPath: z.string().default("./data/slopsearcher.db"),
  discordToken: z.string().default(""),
  discordGuildId: z.string().default(""),
  discordChannelIds: csv,
  discordExcludedChannelIds: csv,
  discordSlopsearchesCategory: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default("Slopsearcher Long-Running"),
  researchAllowedRoleIds: csv,
  researchAllowedUserIds: csv,
  researchEveryone: bool(true),
  googleClientId: z.string().default(""),
  googleClientSecret: z.string().default(""),
  googleRedirectUri: z
    .string()
    .url()
    .default("http://127.0.0.1:53682/oauth2callback"),
  googleTokenPath: z.string().default("./data/google-token.json"),
  driveSourceFolderId: z.string().default(""),
  driveReportsFolderId: z.string().default(""),
  driveMaxFileMb: int(1, 100, 20),
  codexBin: z.string().default("codex"),
  codexHome: z.string().default("./data/codex"),
  codexModel: z.string().default("gpt-6-luna"),
  codexEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("max"),
  webSearch: bool(true),
  browserEnabled: bool(true),
  browserExecutablePath: z.string().default(""),
  browserLibraryPath: z.string().default(""),
  browserMaxActions: int(1, 50, 15),
  browserScreenshotRetentionDays: int(1, 90, 7),
  runnerTimeoutSeconds: int(30, 86400, 1800),
  researchMaxTurns: int(1, 50, 6),
  researchConcurrency: int(1, 8, 2),
  maxPendingTasks: int(1, 1000, 50),
  userCooldownSeconds: int(0, 3600, 0),
  backfillPageSize: int(1, 100, 100),
  backfillConcurrency: int(1, 16, 2),
  syncIntervalSeconds: int(30, 86400, 300),
  reconcileIntervalSeconds: int(300, 604800, 86400),
  memoryIntervalSeconds: int(60, 86400, 900),
  memoryBatchSize: int(1, 100, 30),
  memoryEnabled: bool(true),
  maxSourceCharacters: int(1000, 1000000, 200000),
  backupIntervalHours: int(1, 168, 24),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const names: Record<keyof Config, string> = {
    dbPath: "DB_PATH",
    discordToken: "DISCORD_TOKEN",
    discordGuildId: "DISCORD_GUILD_ID",
    discordChannelIds: "DISCORD_CHANNEL_IDS",
    discordExcludedChannelIds: "DISCORD_EXCLUDED_CHANNEL_IDS",
    discordSlopsearchesCategory: "DISCORD_SLOPSEARCHES_CATEGORY",
    researchAllowedRoleIds: "RESEARCH_ALLOWED_ROLE_IDS",
    researchAllowedUserIds: "RESEARCH_ALLOWED_USER_IDS",
    researchEveryone: "RESEARCH_EVERYONE",
    googleClientId: "GOOGLE_CLIENT_ID",
    googleClientSecret: "GOOGLE_CLIENT_SECRET",
    googleRedirectUri: "GOOGLE_REDIRECT_URI",
    googleTokenPath: "GOOGLE_TOKEN_PATH",
    driveSourceFolderId: "DRIVE_SOURCE_FOLDER_ID",
    driveReportsFolderId: "DRIVE_REPORTS_FOLDER_ID",
    driveMaxFileMb: "DRIVE_MAX_FILE_MB",
    codexBin: "CODEX_BIN",
    codexHome: "SLOP_CODEX_HOME",
    codexModel: "CODEX_MODEL",
    codexEffort: "CODEX_EFFORT",
    webSearch: "WEB_SEARCH",
    browserEnabled: "BROWSER_ENABLED",
    browserExecutablePath: "BROWSER_EXECUTABLE_PATH",
    browserLibraryPath: "BROWSER_LIBRARY_PATH",
    browserMaxActions: "BROWSER_MAX_ACTIONS",
    browserScreenshotRetentionDays: "BROWSER_SCREENSHOT_RETENTION_DAYS",
    runnerTimeoutSeconds: "RUNNER_TIMEOUT_SECONDS",
    researchMaxTurns: "RESEARCH_MAX_TURNS",
    researchConcurrency: "RESEARCH_CONCURRENCY",
    maxPendingTasks: "MAX_PENDING_TASKS",
    userCooldownSeconds: "USER_COOLDOWN_SECONDS",
    backfillPageSize: "BACKFILL_PAGE_SIZE",
    backfillConcurrency: "BACKFILL_CONCURRENCY",
    syncIntervalSeconds: "SYNC_INTERVAL_SECONDS",
    reconcileIntervalSeconds: "RECONCILE_INTERVAL_SECONDS",
    memoryIntervalSeconds: "MEMORY_INTERVAL_SECONDS",
    memoryBatchSize: "MEMORY_BATCH_SIZE",
    memoryEnabled: "MEMORY_ENABLED",
    maxSourceCharacters: "MAX_SOURCE_CHARACTERS",
    backupIntervalHours: "BACKUP_INTERVAL_HOURS",
    logLevel: "LOG_LEVEL",
  };
  const result = schema.safeParse(
    Object.fromEntries(Object.entries(names).map(([k, v]) => [k, env[v]])),
  );
  if (!result.success)
    throw new Error(
      `Invalid configuration:\n${result.error.issues.map((i) => `  ${names[i.path[0] as keyof Config]}: ${i.message}`).join("\n")}`,
    );
  const cfg = result.data;
  for (const k of ["dbPath", "googleTokenPath", "codexHome"] as const)
    cfg[k] = resolve(cfg[k]);
  return cfg;
}
export function requireDiscord(cfg: Config): void {
  if (!cfg.discordToken || !/^\d{17,20}$/.test(cfg.discordGuildId))
    throw new Error(
      "Set DISCORD_TOKEN and a valid DISCORD_GUILD_ID in .env. Run npm run doctor for setup checks.",
    );
}
export function requireDrive(cfg: Config): void {
  if (!cfg.googleClientId || !cfg.googleClientSecret)
    throw new Error(
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then run npm run drive:auth.",
    );
}
export function channelConfigured(
  cfg: Config,
  channelId: string,
  parentId?: string | null,
): boolean {
  const ids = [channelId, parentId].filter((v): v is string => Boolean(v));
  if (ids.some((id) => cfg.discordExcludedChannelIds.includes(id)))
    return false;
  return (
    cfg.discordChannelIds.length === 0 ||
    ids.some((id) => cfg.discordChannelIds.includes(id))
  );
}
