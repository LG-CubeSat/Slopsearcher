import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.ts";
import { CodexRunner } from "../research/codex.ts";
import type { ToolDefinition } from "../research/types.ts";
async function main(): Promise<void> {
  const cfg = loadConfig();
  const runner = new CodexRunner({
    ...cfg,
    runnerTimeoutSeconds: Math.min(cfg.runnerTimeoutSeconds, 180),
  });
  if (!(await runner.isReady()))
    throw new Error("Sign in the bot's Codex profile first");
  const value = randomUUID();
  let calls = 0;
  const tools: ToolDefinition[] = [
    {
      name: "project_lookup",
      description: "Retrieve the integration check value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      invoke: async () => {
        calls++;
        return { value };
      },
    },
  ];
  let threadId: string | undefined;
  try {
    for (let turn = 0; turn < 2; turn++) {
      const result = await runner.run({
        ...(threadId ? { threadId } : {}),
        instructions:
          "You are verifying the bot integration. Use only project_lookup once. Do not browse or access local files.",
        prompt:
          "Call project_lookup with query integration-check, then return the exact value returned by that tool in the requested JSON.",
        tools,
        webSearch: false,
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      });
      threadId = result.threadId;
      if (JSON.parse(result.text).value !== value)
        throw new Error("Model output did not match the retrieved value");
    }
    if (calls !== 2)
      throw new Error(`Expected two retrieval tool calls, received ${calls}`);
    console.log({
      model: cfg.codexModel,
      reasoning: cfg.codexEffort,
      toolCalls: calls,
      threadResume: true,
      validated: true,
    });
  } finally {
    if (threadId) {
      const client = runner.createClient(false);
      try {
        await runner.initialize(client);
        await client.request("thread/archive", { threadId });
      } finally {
        client.close();
      }
    }
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Runner check failed");
  process.exitCode = 1;
});
