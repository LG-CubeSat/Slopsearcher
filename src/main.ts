import { loadConfig, requireDiscord } from "./config.ts";
import { openAndMigrate } from "./db/index.ts";
import { DiscordService } from "./discord/client.ts";
import { Commands } from "./discord/commands.ts";
import { SourceIndex } from "./index/index.ts";
import { logger, setLogLevel } from "./log.ts";
import { WorkQueue } from "./queue.ts";
import { CodexRunner } from "./research/codex.ts";
import { DriveService } from "./drive/service.ts";
import { MemoryStore } from "./memory/store.ts";
import { MemoryService } from "./memory/service.ts";
import { TaskStore } from "./tasks/store.ts";
import { TaskWorker } from "./tasks/worker.ts";
import { Scheduler } from "./scheduler.ts";
import { runtimeLock } from "./runtime-lock.ts";
import { createBackup } from "./backup.ts";
import { bindProject } from "./project-scope.ts";
import { existsSync, chmodSync } from "node:fs";
import { BrowserArtifacts } from "./browser/artifacts.ts";
import { BrowserSession } from "./browser/session.ts";
const log = logger("main");
async function main(): Promise<void> {
  process.umask(0o077);
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  requireDiscord(cfg);
  const unlock = runtimeLock(cfg.dbPath);
  const db = openAndMigrate(cfg.dbPath);
  chmodSync(cfg.dbPath, 0o600);
  const index = new SourceIndex(db);
  bindProject(cfg, db, index);
  const queue = new WorkQueue(cfg.backfillConcurrency);
  const runner = new CodexRunner(cfg);
  const memories = new MemoryStore(db);
  const memory = new MemoryService(cfg, memories, runner);
  let drive: DriveService | null = null;
  if (cfg.driveSourceFolderId || cfg.driveReportsFolderId) {
    // Explicitly configured Drive failures should be fixed, not silently ignored.
    drive = new DriveService(cfg, db, index);
  }
  let commands: Commands;
  const discord: DiscordService = new DiscordService({
    cfg,
    db,
    index,
    queue,
    onMention: (m) => commands.mention(m),
    onInteraction: (i) => commands.interaction(i),
    onButton: (i) => commands.button(i),
    onResearchChannelDeleted: (id) => worker.closeResearchChannel(id),
  });
  const store = new TaskStore(db);
  store.recover();
  const worker: TaskWorker = new TaskWorker(
    cfg,
    store,
    runner,
    index,
    memories,
    discord,
    drive,
  );
  const scheduler = new Scheduler();
  const sync = async () => {
    const last = db
      .prepare<[], { value: string }>(
        "SELECT value FROM service_state WHERE key='discord-reconciled'",
      )
      .get();
    const full =
      !last ||
      Date.now() - Number(last.value) >= cfg.reconcileIntervalSeconds * 1000;
    await discord.sync(full);
    if (full)
      db.prepare(
        "INSERT INTO service_state(key,value) VALUES('discord-reconciled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(Date.now()));
  };
  commands = new Commands(cfg, discord, store, worker, index, async () => {
    await Promise.all([sync(), drive?.sync()]);
  });
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal}: shutting down`);
    scheduler.cancel();
    memory.stop();
    const watchdog = setTimeout(() => {
      log.error(
        "Shutdown timed out; the service will recover pending work on restart",
      );
      process.exit(1);
    }, 20000);
    watchdog.unref();
    await Promise.allSettled([worker.stop(), discord.stop()]);
    await scheduler.drain();
    await queue.close();
    db.close();
    unlock();
    clearTimeout(watchdog);
  };
  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });
  try {
    if (cfg.browserEnabled) {
      const browser = new BrowserSession(
        cfg,
        new BrowserArtifacts(cfg, db),
        0,
        AbortSignal.timeout(30000),
      );
      try {
        await browser.prepare();
        log.info(
          "Browser ready: sandboxed Chromium with public-page gateway and screenshot support",
        );
      } catch (error) {
        log.warn(
          "Browser startup failed; browser tools will report errors until the runtime is fixed",
          error,
        );
      } finally {
        await browser.close();
      }
    }
    await discord.start();
    await discord.organizeResearchChannels();
    try {
      await commands.register();
    } catch (e) {
      log.warn(
        "Slash command registration failed; mentions still work. Check the applications.commands install scope.",
        e,
      );
    }
    if (
      !existsSync(`${cfg.codexHome}/auth.json`) &&
      !process.env.OPENAI_API_KEY
    )
      log.warn(
        `Codex is not signed in. Run CODEX_HOME=${cfg.codexHome} codex login --device-auth as the service user.`,
      );
    log.info(
      `Ready: model=${cfg.codexModel || "CLI default"}, reasoning=${cfg.codexEffort}; ${index.stats().total} indexed sources. Research is ${cfg.researchEveryone ? "available to all server members" : "restricted to configured users/roles"}.`,
    );
    scheduler.every(
      "Discord refresh",
      cfg.syncIntervalSeconds * 1000,
      sync,
      true,
    );
    if (drive)
      scheduler.every(
        "Drive refresh",
        cfg.syncIntervalSeconds * 1000,
        () => drive!.sync(),
        true,
      );
    scheduler.every(
      "Heartbeat",
      10000,
      () => {
        if (discord.client.isReady())
          db.prepare(
            "INSERT INTO service_state(key,value) VALUES('runtime-heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(String(Date.now()));
      },
      true,
    );
    scheduler.every("Task dispatcher", 2000, () => worker.tick(), true);
    scheduler.every("Question progress", 15000, () => worker.progress(), true);
    scheduler.every("Report delivery", 15000, () => worker.deliver(), true);
    scheduler.every(
      "Screenshot retention",
      3600000,
      () => new BrowserArtifacts(cfg, db).cleanup(),
      true,
    );
    scheduler.every(
      "Memory extraction",
      cfg.memoryIntervalSeconds * 1000,
      async () => {
        if (worker.idle) await memory.refresh();
      },
    );
    scheduler.every(
      "SQLite backup",
      cfg.backupIntervalHours * 3600000,
      async () => {
        log.info(`Backup saved to ${await createBackup(db, cfg.dbPath)}`);
      },
    );
  } catch (e) {
    await shutdown("Startup failure");
    throw e;
  }
}
main().catch((e) => {
  log.error("Fatal startup error", e);
  process.exitCode = 1;
});
