#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let current;
const config = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== "-c") continue;
  const setting = process.argv[++i];
  const equals = setting.indexOf("=");
  const key = setting.slice(0, equals);
  const raw = setting.slice(equals + 1);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    continue;
  }
  if (key.startsWith("features."))
    (config.features ??= {})[key.slice(9)] = value;
  else config[key] = value;
}
const complete = (text, status = "completed") => {
  send({
    method: "item/completed",
    params: {
      threadId: "thread-test",
      item: {
        type: "agentMessage",
        id: "progress",
        phase: "commentary",
        text: "Checking sources",
      },
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-test",
      item: { type: "agentMessage", id: "final", phase: "final_answer", text },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: "thread-test",
      turn: {
        id: "turn-test",
        status,
        items: [],
        error:
          status === "completed" ? null : { message: "provider unavailable" },
      },
    },
  });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    if (!m.params.capabilities.experimentalApi)
      throw Error("experimental API required");
    send({ id: m.id, result: {} });
  } else if (m.method === "config/read") {
    send({ id: m.id, result: { config } });
  } else if (m.method === "thread/start" || m.method === "thread/resume") {
    if (m.params.model !== "gpt-6-luna") throw Error("wrong model");
    if (m.params.approvalPolicy !== "never" || m.params.sandbox !== "read-only")
      throw Error("bad sandbox");
    send({ id: m.id, result: { thread: { id: "thread-test" } } });
  } else if (m.method === "turn/start") {
    if (m.params.model && m.params.model !== "gpt-6-luna")
      throw Error("wrong model");
    if (
      m.params.sandboxPolicy.type !== "readOnly" ||
      m.params.sandboxPolicy.networkAccess !== false ||
      m.params.sandboxPolicy.access
    )
      throw Error("invalid turn sandbox policy");
    if (m.params.effort !== "max") throw Error("wrong effort");
    current = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: "turn-test" } } });
    if (current === "hang") return;
    if (current === "crash") {
      process.exit(23);
      return;
    }
    if (current === "fail") {
      complete("", "failed");
      return;
    }
    send({
      id: 900,
      method: "item/tool/call",
      params: {
        threadId: "thread-test",
        tool: current === "forbidden" ? "unauthorized" : "project_lookup",
        arguments: { query: "radio" },
        namespace: null,
      },
    });
  } else if (m.method === "turn/interrupt") {
    send({ id: m.id, result: {} });
    complete("", "interrupted");
  } else if (m.id === 900)
    complete(
      JSON.stringify({
        result: m.result,
        secretInherited: Boolean(
          process.env.DISCORD_TOKEN || process.env.GOOGLE_CLIENT_SECRET,
        ),
      }),
    );
});
