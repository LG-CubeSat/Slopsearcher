import { loadConfig, requireDiscord } from "./config.ts";
import { openAndMigrate } from "./db/index.ts";
import { DiscordService } from "./discord/client.ts";
import { SourceIndex } from "./index/index.ts";
import { logger, setLogLevel } from "./log.ts";
import { WorkQueue } from "./queue.ts";

const log = logger("main");

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  requireDiscord(cfg);

  const db = openAndMigrate(cfg.dbPath);
  const index = new SourceIndex(db);
  const queue = new WorkQueue(cfg.backfillConcurrency + 2);

  log.info(`index holds ${index.stats().total} sources`);

  const discord = new DiscordService({ cfg, db, index, queue });
  await discord.start();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received, shutting down`);
    await discord.stop();
    await queue.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("fatal", error);
  process.exit(1);
});
