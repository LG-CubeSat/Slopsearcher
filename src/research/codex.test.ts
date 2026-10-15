import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { CodexRunner } from "./codex.ts";
let dir: string;
let runner: CodexRunner;
const invoke = vi.fn(async () => ({ text: "RFM95, from source 1" }));
const request = {
  prompt: "question",
  instructions: "Test",
  tools: [
    {
      name: "project_lookup",
      description: "Look up a project source",
      inputSchema: { type: "object" },
      invoke,
    },
  ],
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slop-runner-"));
  runner = new CodexRunner({
    ...loadConfig({}),
    codexBin: resolve("src/research/fixtures/app-server.mjs"),
    dbPath: join(dir, "test.db"),
    codexHome: join(dir, "codex"),
  });
  invoke.mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it("drives initialization, tool calls, progress, and final messages over stdio", async () => {
  vi.stubEnv("DISCORD_TOKEN", "sensitive");
  const onThread = vi.fn();
  const onProgress = vi.fn();
  const result = await runner.run({ ...request, onThread, onProgress });
  expect(onThread).toHaveBeenCalledWith("thread-test");
  expect(invoke).toHaveBeenCalledWith({ query: "radio" });
  expect(JSON.parse(result.text).secretInherited).toBe(false);
  expect(JSON.parse(result.text).result.success).toBe(true);
  expect(onProgress).toHaveBeenCalledWith("Checking sources");
});
it("resumes a saved Codex thread", async () => {
  expect(
    (await runner.run({ ...request, threadId: "thread-test" })).threadId,
  ).toBe("thread-test");
});
it("refuses dynamic tools outside the registered allowlist", async () => {
  const result = await runner.run({ ...request, prompt: "forbidden" });
  expect(invoke).not.toHaveBeenCalled();
  expect(JSON.parse(result.text).result.success).toBe(false);
});
it("does not treat failed turns as successful research", async () => {
  await expect(runner.run({ ...request, prompt: "fail" })).rejects.toThrow(
    "provider unavailable",
  );
});
it("rejects if the app-server process exits mid-turn", async () => {
  await expect(runner.run({ ...request, prompt: "crash" })).rejects.toThrow(
    "exited",
  );
});
it("cancels a running turn promptly", async () => {
  const controller = new AbortController();
  const pending = runner.run({
    ...request,
    prompt: "hang",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await expect(pending).rejects.toThrow(/cancelled|closed/);
});
