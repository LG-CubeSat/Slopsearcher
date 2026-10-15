import { expect, it } from "vitest";
import { channelConfigured, loadConfig } from "./config.ts";
it("defaults every bot model call to Luna at max reasoning", () => {
  const c = loadConfig({});
  expect(c.codexModel).toBe("gpt-6-luna");
  expect(c.codexEffort).toBe("max");
  expect(c.researchEveryone).toBe(true);
});
it("rejects invalid booleans and unbounded concurrency", () => {
  expect(() => loadConfig({ WEB_SEARCH: "maybe" })).toThrow("WEB_SEARCH");
  expect(() => loadConfig({ RESEARCH_CONCURRENCY: "1000" })).toThrow(
    "RESEARCH_CONCURRENCY",
  );
});
it("includes configured threads through their parent but respects exclusions", () => {
  const c = loadConfig({
    DISCORD_CHANNEL_IDS: "parent",
    DISCORD_EXCLUDED_CHANNEL_IDS: "hidden",
  });
  expect(channelConfigured(c, "thread", "parent")).toBe(true);
  expect(channelConfigured(c, "hidden", "parent")).toBe(false);
  expect(channelConfigured(c, "other")).toBe(false);
});
