import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
export function runtimeLock(dbPath: string): () => void {
  const path = `${dbPath}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const pid = Number(readFileSync(path, "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive)
        throw new Error(
          `Another Slopsearcher process (${pid}) is using ${dbPath}`,
        );
    }
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}
