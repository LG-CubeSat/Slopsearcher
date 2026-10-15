import type { Db } from "../db/index.ts";
import type { Config } from "../config.ts";
export type TaskStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
export interface Task {
  id: number; question: string; requested_by: string; origin_channel_id: string; origin_message_id: string | null;
  discord_channel_id: string | null; runner_thread_id: string | null; status: TaskStatus; kind: "question" | "research";
  context_json: string; progress_json: string; report_text: string | null; report_file_id: string | null;
  error: string | null; turn_count: number; next_run_at: number; attempts: number; delivery_pending: number;
  output_message_id: string | null; created_at: number; updated_at: number;
}
export class TaskStore {
  constructor(readonly db: Db) {}
  get(id: number): Task | null { return this.db.prepare<[number], Task>("SELECT * FROM tasks WHERE id=?").get(id) ?? null; }
  create(input: { kind: Task["kind"]; question: string; userId: string; channelId: string; messageId?: string; context?: unknown }, cfg: Config): Task {
    return this.db.transaction(() => {
      if (input.messageId) {
        const duplicate = this.db.prepare<[string], Task>("SELECT * FROM tasks WHERE origin_message_id=?").get(input.messageId);
        if (duplicate) return duplicate;
      }
      const count = this.db.prepare<[], { n: number }>("SELECT COUNT(*) n FROM tasks WHERE status IN ('pending','running')").get()!.n;
      if (count >= cfg.maxPendingTasks) throw new Error("The research queue is full. Please try again later.");
      const recent = this.db.prepare<[string], { created_at: number }>("SELECT created_at FROM tasks WHERE requested_by=? ORDER BY id DESC LIMIT 1").get(input.userId);
      if (recent && Date.now() - recent.created_at < cfg.userCooldownSeconds * 1000) throw new Error(`Please wait ${cfg.userCooldownSeconds} seconds between requests.`);
      const id = this.db.prepare("INSERT INTO tasks(question,requested_by,origin_channel_id,origin_message_id,status,kind,context_json,created_at,updated_at) VALUES(?,?,?,?, 'pending',?,?,?,?)").run(input.question, input.userId, input.channelId, input.messageId ?? null, input.kind, JSON.stringify(input.context ?? {}), Date.now(), Date.now()).lastInsertRowid;
      this.event(Number(id), "created", { kind: input.kind }); return this.get(Number(id))!;
    })();
  }
  update(id: number, fields: Partial<Pick<Task, "status" | "discord_channel_id" | "runner_thread_id" | "progress_json" | "report_text" | "report_file_id" | "error" | "turn_count" | "next_run_at" | "attempts" | "delivery_pending" | "output_message_id">>): void {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    const permitted = new Set(["status","discord_channel_id","runner_thread_id","progress_json","report_text","report_file_id","error","turn_count","next_run_at","attempts","delivery_pending","output_message_id"]);
    if (entries.some(([k]) => !permitted.has(k))) throw new Error("Invalid task update");
    this.db.prepare(`UPDATE tasks SET ${entries.map(([k]) => `${k}=?`).join(",")}, updated_at=? WHERE id=?`).run(...entries.map(([, v]) => v), Date.now(), id);
  }
  recover(): void {
    this.db.prepare("UPDATE tasks SET status='pending', updated_at=? WHERE status='running'").run(Date.now());
  }
  next(): Task | null {
    return this.db.transaction(() => {
      const task = this.db.prepare<[number], Task>("SELECT * FROM tasks WHERE status='pending' AND next_run_at <= ? ORDER BY CASE kind WHEN 'question' THEN 0 ELSE 1 END,id LIMIT 1").get(Date.now());
      if (!task) return null;
      this.update(task.id, { status: "running" }); return this.get(task.id);
    })();
  }
  list(userId: string, limit = 10): Task[] { return this.db.prepare<[string, number], Task>("SELECT * FROM tasks WHERE requested_by=? ORDER BY id DESC LIMIT ?").all(userId, limit); }
  deliveries(): Task[] { return this.db.prepare<[], Task>("SELECT * FROM tasks WHERE delivery_pending=1 AND status IN ('completed','failed') ORDER BY id LIMIT 20").all(); }
  event(id: number, type: string, data: unknown = {}): void { this.db.prepare("INSERT INTO task_events(task_id,at,type,data_json) VALUES(?,?,?,?)").run(id, Date.now(), type, JSON.stringify(data)); }
}
