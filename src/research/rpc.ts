import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { errorMessage } from "../util.ts";
export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string; code?: number };
}
/** App-server uses newline-delimited JSON, without JSON-RPC's version header. */
export class RpcClient extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  #nextId = 0;
  #pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #closed = false;
  #stderr = "";
  constructor(
    bin: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    private handleRequest: (message: RpcMessage) => Promise<unknown>,
  ) {
    super();
    this.child = spawn(bin, args, { ...options, stdio: "pipe" });
    this.child.stderr.on("data", (data: Buffer) => {
      this.#stderr = (this.#stderr + data.toString()).slice(-2000);
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on(
      "line",
      (line) => {
        let m: RpcMessage;
        try {
          m = JSON.parse(line);
        } catch {
          this.fail(new Error("Codex app-server emitted invalid JSON"));
          return;
        }
        if (m.method && m.id !== undefined) {
          const id = m.id;
          void this.handleRequest(m)
            .then(
              (result) => this.send({ id, result }),
              (e) =>
                this.send({
                  id,
                  error: { code: -32601, message: errorMessage(e) },
                }),
            )
            .catch(() => {});
        } else if (m.method) this.emit("notification", m);
        else if (typeof m.id === "number") {
          const pending = this.#pending.get(m.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(m.id);
          if (m.error) pending.reject(new Error(m.error.message));
          else pending.resolve(m.result);
        }
      },
    );
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", (code, signal) => {
      if (!this.#closed)
        this.fail(
          new Error(
            `Codex app-server exited (${signal ?? code}). ${this.#stderr}`,
          ),
        );
    });
    this.child.stdin.on("error", (e) => this.fail(e));
  }
  send(message: RpcMessage): void {
    if (this.#closed || !this.child.stdin.writable)
      throw new Error("Codex app-server is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown, timeout = 60000): Promise<any> {
    if (this.#closed)
      return Promise.reject(new Error("Codex app-server is closed"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(e);
      }
    });
  }
  private fail(error: Error): void {
    if (this.#closed) return;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.#pending.clear();
    this.emit("failure", error);
    this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Codex app-server closed"));
    }
    this.#pending.clear();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }, 3000);
    timer.unref();
  }
}
