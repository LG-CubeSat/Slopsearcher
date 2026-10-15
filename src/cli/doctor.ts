import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { REST, Routes } from "discord.js";
import { loadConfig } from "../config.ts";
import { openAndMigrate } from "../db/index.ts";
import { SourceIndex } from "../index/index.ts";
import { CodexRunner } from "../research/codex.ts";
import { DriveService } from "../drive/service.ts";
async function main(): Promise<void> {
  const cfg = loadConfig();
  let failed = false;
  const check = (okay: boolean, text: string, optional = false) => {
    console.log(`${okay ? "OK" : optional ? "OPTIONAL" : "MISSING"} ${text}`);
    if (!okay && !optional) failed = true;
  };
  check(
    Number(process.versions.node.split(".")[0]) >= 24,
    `Node ${process.version} (requires 24+)`,
  );
  console.log(
    `MODEL ${cfg.codexModel || "CLI default"}; reasoning=${cfg.codexEffort}`,
  );
  check(Boolean(cfg.discordToken), "DISCORD_TOKEN");
  check(/^\d{17,20}$/.test(cfg.discordGuildId), "DISCORD_GUILD_ID");
  check(existsSync(".env"), ".env configuration file", true);
  if (existsSync(".env"))
    check(
      (statSync(".env").mode & 0o077) === 0,
      ".env is readable only by its owner",
    );
  try {
    const version = execFileSync(cfg.codexBin, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    check(true, version);
  } catch {
    check(false, `Codex CLI executable (${cfg.codexBin})`);
  }
  check(
    existsSync(`${cfg.codexHome}/auth.json`) ||
      Boolean(process.env.OPENAI_API_KEY),
    `Codex sign-in in ${cfg.codexHome} (or OPENAI_API_KEY)`,
  );
  const db = openAndMigrate(cfg.dbPath);
  const index = new SourceIndex(db);
  try {
    const result = db.prepare("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    check(
      result.quick_check === "ok",
      `SQLite integrity; ${index.stats().total} active sources`,
    );
    check(
      Boolean(cfg.driveSourceFolderId),
      "DRIVE_SOURCE_FOLDER_ID (Drive indexing)",
      true,
    );
    check(
      Boolean(cfg.driveReportsFolderId),
      "DRIVE_REPORTS_FOLDER_ID (report uploads)",
      true,
    );
    if (cfg.driveSourceFolderId || cfg.driveReportsFolderId) {
      check(
        Boolean(cfg.googleClientId && cfg.googleClientSecret),
        "Google OAuth client ID and secret",
      );
      check(
        existsSync(cfg.googleTokenPath),
        "Google refresh credentials; run npm run drive:auth",
      );
    }
    if (process.argv.includes("--runner")) {
      const runner = new CodexRunner(cfg);
      const client = runner.createClient(false);
      try {
        await runner.initialize(client);
        const account = await client.request("account/read", {
          refreshToken: false,
        });
        check(
          Boolean(account.account) ||
            account.requiresOpenaiAuth === false ||
            Boolean(process.env.OPENAI_API_KEY),
          "Codex app-server account access",
        );
        const started = await client.request("thread/start", {
          approvalPolicy: "never",
          sandbox: "read-only",
          dynamicTools: [
            {
              type: "function",
              name: "slopsearcher_check",
              description: "Configuration check",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        });
        check(
          Boolean(started.thread?.id),
          "Codex app-server initialization and dynamic-tool protocol (no model inference requested)",
        );
        await client.request("thread/archive", { threadId: started.thread.id });
      } finally {
        client.close();
      }
    }
    if (process.argv.includes("--connect")) {
      if (cfg.discordToken && cfg.discordGuildId) {
        const rest = new REST({ version: "10" }).setToken(cfg.discordToken);
        await rest.get(Routes.guild(cfg.discordGuildId));
        check(true, "Discord token can access configured server");
      }
      if (cfg.driveSourceFolderId || cfg.driveReportsFolderId) {
        const drive = new DriveService(cfg, db, index);
        for (const id of [
          cfg.driveSourceFolderId,
          cfg.driveReportsFolderId,
        ].filter(Boolean)) {
          const file = await drive.api.files.get(
            {
              fileId: id,
              fields: "id,mimeType,trashed",
              supportsAllDrives: true,
            },
            { timeout: 30000 },
          );
          check(
            file.data.mimeType === "application/vnd.google-apps.folder" &&
              !file.data.trashed,
            `Drive folder access (${id})`,
          );
        }
      }
    }
  } finally {
    db.close();
  }
  console.log(
    "The bot uses outbound Discord/Google/OpenAI connections; it opens no public listening ports.",
  );
  if (failed) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Configuration check failed");
  process.exitCode = 1;
});
