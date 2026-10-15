# slopsearcher

`slopsearcher` is a persistent research server and Discord bot for a CubeSat project. It keeps a compact local memory of important project information from Discord and Google Drive, answers questions using the surrounding discussion and broader project history, and carries out longer investigations in dedicated Discord channels.

## Service and project memory

The server stays running to scan messages across the project's Discord channels and maintain a small, searchable local database of important CubeSat information. The memory should preserve useful facts and context such as technical details, requirements, decisions, rationale, and unresolved questions, with links to the original messages or documents. It is a research index; the Discord and Drive sources remain available for verification.

The bot should periodically recheck its configured Discord channels and Google Drive folder, incrementally adding new or changed material and updating or retiring stale memory so its information stays current. Keep source links and timestamps so updates can be traced back to their origins.

The bot can also read a configured Google Drive project folder. It can use those documents alongside Discord history and write finished research reports to a configured Drive reports folder.

## Questions and investigations

When a user pings the bot with a question, it should account for the message being replied to and the nearby conversation before answering. It can then search across its local memory, Discord messages, and available Drive material as needed, rather than being limited to a short preselected summary. Responses should identify the source material behind important findings.

If a user asks whether a question can be made “long-running,” the bot can start an ongoing investigation by creating a dedicated channel in the Discord group named `slopsearches`. The research can continue exploring project conversations and documents, collect and organize findings, and post progress and results in that channel. Completed reports can be saved to the configured Drive reports folder.

Research tasks run through Codex App Server. The design may support Claude Code as an additional research backend later.

## Recommended technical approach

- **Language and runtime:** Use TypeScript on Node.js. It supports a single persistent, event-driven service, with [discord.js](https://discord.js.org/docs) for Discord and Google's [Node.js Drive client](https://developers.google.com/workspace/drive/api/quickstart/nodejs). Keep Discord, indexing, Drive, and research code in separate modules within one service to start.
- **Local memory and search:** Use SQLite on the server's persistent disk, with [FTS5](https://www.sqlite.org/fts5.html) for full-text search. Store searchable message and document text alongside source IDs, links, timestamps, and project-memory notes. Give the research runner tools to search the index, open source messages or documents, and fetch the surrounding Discord conversation. Add semantic/vector search later only if keyword search proves insufficient.
- **Durable research:** Track each long-running task in SQLite with its Discord channel, runner thread ID, status, and progress so work can continue after a restart. Put Codex behind a research-runner interface; its app-server communicates over newline-delimited JSON on stdio and provides a [generated TypeScript protocol schema](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md). A separate adapter can support Claude Code later.
- **External access and operations:** Use Google OAuth with configured source and report folder IDs and the required read/write scopes. Run the service on an always-on machine with persistent storage and backups. Discord indexing requires permission to view channel history and access to the privileged [Message Content Intent](https://docs.discord.com/developers/events/gateway#message-content-intent), subject to Discord's current access rules.
