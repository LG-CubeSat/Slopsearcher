import type { Task } from "./store.ts";

/** Fixed activity labels describe tool activity without exposing model reasoning. */
export const questionActivities = new Set([
  "Getting ready…",
  "Checking access to project sources…",
  "Working on your answer…",
  "Searching project history…",
  "Searching project memory…",
  "Reading project sources…",
  "Reading the surrounding discussion…",
  "Checking my indexing status…",
  "Checking web sources…",
  "Writing the answer…",
]);
export const toolActivity = new Map<string, string>([
  ["search_project", "Searching project history…"],
  ["search_memory", "Searching project memory…"],
  ["open_source", "Reading project sources…"],
  ["open_conversation", "Reading the surrounding discussion…"],
  ["get_bot_status", "Checking my indexing status…"],
]);
export function questionProgress(task: Task, activity?: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - task.created_at) / 1000),
  );
  const elapsed =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const prefix = `Question #${task.id}`;
  if (task.status === "cancelled") return `${prefix} cancelled.`;
  if (task.status === "completed")
    return `${prefix} is finished, but I couldn’t deliver the answer yet. I’ll retry shortly.`;
  if (task.status === "failed")
    return `${prefix} couldn’t be completed after retries. Use /slop retry to try again.`;
  if (task.error === "Waiting for Codex sign-in")
    return `${prefix} is waiting for the operator to finish Codex sign-in. I’ll resume automatically. · ${elapsed} elapsed`;
  if (task.status === "pending") {
    if (task.attempts > 0) {
      const retry = Math.max(
        0,
        Math.ceil((task.next_run_at - Date.now()) / 1000),
      );
      return `${prefix} hit a temporary problem. Retrying ${retry ? `in ${retry}s` : "shortly"} (attempt ${task.attempts + 1}/3). · ${elapsed} elapsed`;
    }
    return `${prefix} is queued — waiting for an available slot. · ${elapsed} elapsed`;
  }
  return `${prefix} is in progress. · ${elapsed} elapsed\n${activity ?? "Getting ready…"}`;
}
