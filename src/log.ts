type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
}

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(line);
  else {
    let detail = extra instanceof Error ? `${extra.name}: ${extra.message}` : typeof extra === "string" ? extra : JSON.stringify(extra);
    detail = detail.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]");
    for (const [key, value] of Object.entries(process.env)) if (value && value.length > 8 && /TOKEN|SECRET|API_KEY/i.test(key)) detail = detail.replaceAll(value, "[redacted]");
    stream(line, detail);
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
