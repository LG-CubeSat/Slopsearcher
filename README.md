# Slopsearcher

An experimental LG-CubeSat research assistant. Slopsearcher keeps project knowledge from Discord and Google Drive searchable, answers questions in context, and runs longer investigations while the team is busy elsewhere. It periodically checks its sources and updates its memory as the project changes.

## What works

- Mention the bot or use `/slop ask` for questions grounded in project history, with source links. Replies include the referenced message and nearby conversation.
- Use `/slop research`, or ask to make a question “long-running,” to create an investigation channel under `slopsearches`. Everyone in the configured Discord server can start research by default.
- Research runs through Codex App Server, posts progress, saves checkpoints, and resumes persisted threads after a restart. The default is **GPT-6 Luna with max reasoning**.
- SQLite FTS5 indexes Discord messages, threads, and supported Drive documents. The agent can search, open a source, and fetch the discussion surrounding a message.
- Discord events update edited/deleted messages immediately. Periodic history scans catch new messages, and full reconciliation catches older edits and deletions. Drive folder scans check for additions, changes, removals, and moves.
- Periodic extraction distills cited facts, requirements, decisions, rationale, and unresolved questions. Source edits invalidate old notes; clear replacement decisions can supersede earlier notes while retaining their history.
- Completed reports are attached in Discord and optionally uploaded as Markdown to a configured Drive folder. Delivery retries use saved results rather than repeating the investigation.
- The bot uses outbound API connections and the Discord Gateway. **No port forwarding, public HTTP endpoint, or open inbound port is required.**

The project design is in [slopsearcher.md](slopsearcher.md).

## Quick start

Requires **Node.js 24+** and **Codex CLI 0.159.2 or later**. The App Server dynamic-tool API is experimental; this implementation has been checked against 0.159.2. Use a model available to the account you sign in with.

```bash
# If you use nvm:
nvm install
nvm use

npm ci
cp -n .env.example .env
chmod 600 .env
```

Edit `.env` to select the bot token, Discord server, project channels, and optional Drive folders. No IDs or credentials are hardcoded. At minimum, set:

```dotenv
DISCORD_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_server_id
CODEX_MODEL=gpt-6-luna
CODEX_EFFORT=max
```

On the current server, Node 24 is also installed at `~/.local/share/slopsearcher-runtime/node_modules/.bin/node`. If your shell still selects Node 20, use:

```bash
export PATH="$HOME/.local/share/slopsearcher-runtime/node_modules/.bin:$PATH"
```

Sign in a dedicated Codex profile as the same user that will run the bot:

```bash
CODEX_HOME="$PWD/data/codex" codex login --device-auth
npm run doctor -- --runner --connect
npm run build
npm start
```

`SLOP_CODEX_HOME` in `.env` must point to that profile. If you use a different profile path, use it in the sign-in command too. An API key can alternatively be supplied as `OPENAI_API_KEY` in the service environment. No development profile, plugins, or credentials are automatically copied into the bot's profile.

The bot can connect and index Discord before Codex sign-in is complete. Research requests wait in the queue and are picked up automatically after sign-in. `doctor --runner` checks the actual App Server protocol without making a model inference request; a completed live answer is the check that model inference is available.

## Discord setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable **Message Content Intent** in the Bot settings. The bot requests Guilds, Guild Messages, and Message Content gateway intents.
3. Install it in your server with the `bot` and `applications.commands` scopes.
4. Grant **View Channel**, **Read Message History**, **Send Messages**, **Send Messages in Threads**, **Attach Files**, and **Manage Channels** where the bot should work. Manage Channels is used to create investigation channels and the `slopsearches` category. Administrator permission is unnecessary.
5. Enable Developer Mode in Discord and copy the server ID into `DISCORD_GUILD_ID`.

`DISCORD_CHANNEL_IDS` optionally limits indexing to a comma-separated list of channels; a parent ID also includes its threads. An empty list indexes readable channels across the selected server. `DISCORD_EXCLUDED_CHANNEL_IDS` takes precedence over inclusions. The bot ignores DMs and other servers.

Commands are registered in the configured server on startup without deleting unrelated application commands:

| Command                    | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `/slop ask question:`      | Ask about the project; the answer is posted in the channel |
| `/slop research question:` | Start an investigation with a dedicated channel            |
| `/slop search query:`      | Find original source messages/documents                    |
| `/slop status [id:]`       | Show your recent tasks or one task                         |
| `/slop cancel id:`         | Stop your queued or running task                           |
| `/slop retry id:`          | Retry a failed or cancelled task                           |
| `/slop sync`               | Refresh sources now; requires Manage Server                |
| `/slop help`               | Show usage                                                 |

A server manager can inspect and cancel tasks in the current project. To restrict who may start research, set `RESEARCH_EVERYONE=false` and configure `RESEARCH_ALLOWED_ROLE_IDS` and/or `RESEARCH_ALLOWED_USER_IDS`. Questions remain available to server members.

Research channels copy the originating channel's permission overwrites. A task started inside a thread gets a channel private to the requester and bot (server administrators retain their usual access). Cross-channel retrieval checks the requester’s access and the destination audience; private channels with different access overwrites are deliberately excluded. Source access is checked again before delivering a report. Drive source-folder contents are treated as shared project knowledge for this server, so choose the source and report folders accordingly.

## Optional Google Drive integration

Set either or both folder IDs in `.env`:

```dotenv
DRIVE_SOURCE_FOLDER_ID=folder_to_read
DRIVE_REPORTS_FOLDER_ID=folder_for_finished_reports
GOOGLE_CLIENT_ID=your_desktop_oauth_client_id
GOOGLE_CLIENT_SECRET=your_desktop_oauth_client_secret
```

The folder ID is the final part of a Drive folder URL, such as `https://drive.google.com/drive/folders/FOLDER_ID`.

Enable the Drive API in a Google Cloud project, configure OAuth consent for your account, and create a **Desktop app** OAuth client. Then authorize:

```bash
npm run drive:auth -- --manual
```

Open the printed consent URL on your computer. After approving, the browser may show a loopback connection error. Copy its complete address-bar URL into the terminal; the command verifies its state, exchanges the code, and stores refresh credentials with owner-only permissions. This mode opens no listener.

Alternatively, `npm run drive:auth` temporarily listens on `127.0.0.1:53682` during setup. On a remote server, use the SSH forward printed by the command. The running bot never needs that listener.

The OAuth grant uses the full Drive scope to support arbitrary existing folders selected in configuration. Application operations read only the configured source tree and create/update reports only in the configured reports folder. Tokens refresh automatically. Google OAuth apps with External audience and **Testing** status normally receive refresh tokens that expire after seven days; use an appropriate production/internal configuration for unattended operation. See [Google's token expiration documentation](https://developers.google.com/identity/protocols/oauth2#expiration).

Supported content:

- Google Docs and Slides exported as text.
- Google Sheets exported as XLSX, including all sheets.
- Text, Markdown, CSV, JSON, XML, PDF text, DOCX, and XLSX files.
- Nested source folders and shared-drive files visible to the OAuth account.

The reports subtree and reports created by this bot are excluded from ingestion to avoid feeding generated answers back into memory. Drive shortcuts are not followed. Scanned PDFs, images, diagrams, videos, and legacy `.doc`/`.xls` files are not interpreted. Discord attachments are indexed by their filename and link; their binary content is not downloaded. The default download limit is 20 MiB and the extracted-text limit is 200,000 characters; truncated text is explicitly marked.

## Scheduling and task limits

All settings are documented in [.env.example](.env.example). Defaults:

| Setting                                  | Default                                          |
| ---------------------------------------- | ------------------------------------------------ |
| Discord catch-up and Drive source checks | Every 5 minutes                                  |
| Full Discord history reconciliation      | Daily; also on the first startup                 |
| Memory extraction                        | Every 15 minutes, when research workers are idle |
| Research concurrency                     | 2 tasks                                          |
| Research turn budget                     | 6 turns per investigation                        |
| Per-turn timeout                         | 30 minutes                                       |
| Maximum queued/running tasks             | 50                                               |
| Per-user request cooldown                | 20 seconds                                       |
| SQLite backup                            | Daily; retain the latest 7                       |

Research uses additional turns when the agent identifies useful remaining work. The last allowed turn must produce a report that lists unfinished work. A transient failure is retried three times with backoff. Cancellation interrupts the active runner. Tasks waiting for sign-in do not spend their retry budget.

Background memory extraction also uses the configured model, so it consumes model usage. Disable it with `MEMORY_ENABLED=false` if you only want source indexing and on-demand research. Raw source search remains available without distilled notes.

## Run as a service on this server

A user service is provided at [deploy/slopsearcher.service](deploy/slopsearcher.service). Its paths match this server’s checkout and isolated Node 24 runtime. Adjust them for another machine.

```bash
npm run build
mkdir -p ~/.config/systemd/user
cp deploy/slopsearcher.service ~/.config/systemd/user/slopsearcher.service
systemctl --user daemon-reload
systemctl --user enable --now slopsearcher
journalctl --user -u slopsearcher -f
```

The service reads `.env` from the checkout. Restart after configuration changes or a new build:

```bash
systemctl --user restart slopsearcher
npm run health
```

For a user service to remain active after logout, the machine must have lingering enabled for that user (`loginctl enable-linger USER`, subject to the machine’s administration policy). The service restarts on failure, handles termination signals, and resumes queued research from SQLite.

A Docker alternative is provided in [compose.yaml](compose.yaml):

```bash
mkdir -p data
# The image runs as UID 1000; the mounted directory must be writable by it.
docker compose build
docker compose run --rm slopsearcher codex login --device-auth
docker compose up -d
```

The container uses `/data` for its database, Google tokens, and Codex profile. For Drive, authorize on the host using the same `data/google-token.json` path before starting the container. Compose publishes no ports. The image includes a heartbeat health check; Docker’s health status is diagnostic, while its restart policy handles process exits.

## Development and operations

```bash
npm run typecheck
npm test
npm run build
npm run dev                  # TypeScript entry point
npm run doctor               # Local configuration and database checks
npm run doctor -- --runner   # App Server handshake/account checks; no inference
npm run doctor -- --connect  # Read-only Discord and Drive connectivity checks
npm run search -- "radio"    # Search local indexed sources
npm run backup               # Online SQLite backup
npm run memory:refresh       # Distill one batch now (uses the configured model)
npm run runner:check         # Two live model turns to verify tool calls and resumption
npm run health               # Check the running bot's recent heartbeat
npm run format:check
```

`data/`, `.env`, credentials, SQLite databases, reports, and backups are ignored by Git and excluded from Docker build context. The bot launches Codex with a filtered environment, shell execution disabled, a read-only sandbox, and host-controlled retrieval tools. It does not give Codex the Discord or Google credentials.

The database contains source text, derived notes, research threads/tasks, reports, and progress events. Removed sources are tombstoned and excluded from search; their previous local contents remain for audit/history. Backups contain the same project information. Keep the database and the Codex profile when moving the service, because thread resumption requires both. Changing the configured Discord server or Drive source folder retires the old source scope and cancels unfinished work; start new tasks for the new project.

If a task fails, inspect the service logs and retry it with `/slop retry`. If the Gateway reports disallowed intents, enable Message Content Intent in the Developer Portal. If slash commands do not appear, check the install scopes; mentions still work. If Drive reports `invalid_grant`, authorize again. A very large initial history reconciliation can take time; live mentions remain responsive while it runs.

## Current limits

Semantic/vector search, OCR, automatic interpretation of Discord attachments, and a Claude Code backend are not implemented. Private archived Discord threads are limited to the threads the bot can discover and access. Research is bounded by the configured turn/time limits, rather than running indefinitely. Retrieved material and generated research still need engineering review before being used for CubeSat design decisions.
