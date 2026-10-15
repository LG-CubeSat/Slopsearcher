import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "../config.ts";
import { RpcClient, type RpcMessage } from "./rpc.ts";
import type { ResearchRunner, RunRequest } from "./types.ts";

export class CodexRunner implements ResearchRunner {
  #authCheck: { at: number; ready: boolean } | undefined;
  constructor(private cfg: Config) {}
  async isReady(): Promise<boolean> {
    if (this.#authCheck && Date.now() - this.#authCheck.at < 10000)
      return this.#authCheck.ready;
    const client = this.createClient(false);
    try {
      await this.initialize(client);
      const result = await client.request("account/read", {
        refreshToken: false,
      });
      const ready =
        Boolean(result.account) ||
        result.requiresOpenaiAuth === false ||
        Boolean(process.env.OPENAI_API_KEY);
      this.#authCheck = { at: Date.now(), ready };
      return ready;
    } finally {
      client.close();
    }
  }
  createClient(webSearch: boolean, request?: RunRequest): RpcClient {
    const cwd = join(dirname(this.cfg.dbPath), "research-workspace");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(this.cfg.codexHome, { recursive: true, mode: 0o700 });
    // Do not give the child Discord, Google, or Git credentials from .env.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: this.cfg.codexHome,
    };
    for (const name of [
      "OPENAI_API_KEY",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "SYSTEMROOT",
      "TMPDIR",
    ])
      if (process.env[name]) env[name] = process.env[name];
    return new RpcClient(
      this.cfg.codexBin,
      [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.apply_patch_freeform=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.code_mode=false",
        "-c",
        `web_search=${webSearch ? '"live"' : '"disabled"'}`,
      ],
      { cwd, env },
      async (m: RpcMessage) => {
        if (m.method === "item/tool/call") {
          const tool = request?.tools.find(
            (t) => t.name === m.params?.tool && !m.params?.namespace,
          );
          if (!tool)
            return {
              success: false,
              contentItems: [{ type: "inputText", text: "Tool not permitted" }],
            };
          try {
            const result = await tool.invoke(m.params.arguments);
            return {
              success: true,
              contentItems: [
                { type: "inputText", text: JSON.stringify(result) },
              ],
            };
          } catch (e) {
            return {
              success: false,
              contentItems: [
                {
                  type: "inputText",
                  text: e instanceof Error ? e.message : "Tool failed",
                },
              ],
            };
          }
        }
        if (m.method?.endsWith("/requestApproval"))
          return { decision: "decline" };
        if (
          m.method === "item/tool/requestUserInput" ||
          m.method === "tool/requestUserInput"
        )
          return { answers: {} };
        throw new Error(`Unsupported server request: ${m.method}`);
      },
    );
  }
  async initialize(client: RpcClient): Promise<void> {
    await client.request("initialize", {
      clientInfo: {
        name: "slopsearcher",
        title: "Slopsearcher",
        version: "0.2.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.send({ method: "initialized", params: {} });
  }
  async run(request: RunRequest): Promise<{ threadId: string; text: string }> {
    if (request.signal?.aborted) throw new Error("Task cancelled");
    const client = this.createClient(
      request.webSearch ?? this.cfg.webSearch,
      request,
    );
    const earlyAbort = () => client.close();
    request.signal?.addEventListener("abort", earlyAbort, { once: true });
    if (request.signal?.aborted) client.close();
    let threadId = request.threadId ?? "";
    let turnId = "";
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      await this.initialize(client);
      const params = {
        ...(this.cfg.codexModel ? { model: this.cfg.codexModel } : {}),
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: request.instructions,
        config: {
          "features.shell_tool": false,
          "features.apply_patch_freeform": false,
          "features.multi_agent": false,
          "features.code_mode": false,
        },
      };
      const thread = request.threadId
        ? await client.request("thread/resume", {
            ...params,
            threadId: request.threadId,
          })
        : await client.request("thread/start", {
            ...params,
            dynamicTools: request.tools.map(
              ({ name, description, inputSchema }) => ({
                type: "function",
                name,
                description,
                inputSchema,
              }),
            ),
          });
      threadId = thread.thread.id;
      request.onThread?.(threadId);
      const messages = new Map<string, { text: string; phase?: string }>();
      const completion = new Promise<string>((resolve, reject) => {
        client.once("failure", reject);
        abort = () => {
          void client
            .request("turn/interrupt", { threadId, turnId }, 3000)
            .catch(() => {});
          reject(new Error("Task cancelled"));
        };
        request.signal?.addEventListener("abort", abort, { once: true });
        if (request.signal?.aborted) {
          abort();
          return;
        }
        timer = setTimeout(() => {
          void client
            .request("turn/interrupt", { threadId, turnId }, 3000)
            .catch(() => {});
          client.close();
          reject(
            new Error(
              `Research turn exceeded ${this.cfg.runnerTimeoutSeconds} seconds`,
            ),
          );
        }, this.cfg.runnerTimeoutSeconds * 1000);
        client.on("notification", (m: RpcMessage) => {
          const p = m.params;
          if (p?.threadId !== threadId) return;
          if (
            m.method === "item/completed" &&
            p.item?.type === "agentMessage"
          ) {
            messages.set(p.item.id, p.item);
            if (p.item.phase === "commentary")
              request.onProgress?.(p.item.text);
          }
          if (
            m.method === "item/started" &&
            ["webSearch", "dynamicToolCall"].includes(p.item?.type)
          )
            request.onProgress?.(
              p.item.type === "webSearch"
                ? "Checking web sources…"
                : `Searching project information (${p.item.tool})…`,
            );
          if (m.method !== "turn/completed") return;
          if (p.turn.status !== "completed") {
            reject(
              new Error(p.turn.error?.message ?? `Codex turn ${p.turn.status}`),
            );
            return;
          }
          for (const item of p.turn.items ?? [])
            if (item.type === "agentMessage") messages.set(item.id, item);
          const all = [...messages.values()];
          const finals = all.filter((i) => i.phase === "final_answer");
          const text = (
            finals.length ? finals : all.filter((i) => i.phase !== "commentary")
          )
            .map((i) => i.text)
            .join("\n\n");
          if (!text.trim())
            reject(new Error("Codex finished without a final answer"));
          else resolve(text);
        });
      });
      // Attach rejection handling immediately, even while turn/start is pending.
      void completion.catch(() => {});
      const started = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt }],
        effort: this.cfg.codexEffort,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: {
            type: "restricted",
            includePlatformDefaults: true,
            readableRoots: [
              join(dirname(this.cfg.dbPath), "research-workspace"),
            ],
          },
        },
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      });
      turnId = started.turn.id;
      return { threadId, text: await completion };
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) request.signal?.removeEventListener("abort", abort);
      request.signal?.removeEventListener("abort", earlyAbort);
      client.close();
    }
  }
}
