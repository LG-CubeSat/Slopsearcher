import { OAuth2Client, type Credentials } from "google-auth-library";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { requireDrive, type Config } from "../config.ts";
// Arbitrary configured folders require Drive access; all app operations are
// restricted to source-folder reads and report-folder creates/updates.
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];
export function writeTokens(path: string, tokens: Credentials): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(tokens, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
export function googleAuth(cfg: Config, loadTokens = true): OAuth2Client {
  requireDrive(cfg);
  const auth = new OAuth2Client(
    cfg.googleClientId,
    cfg.googleClientSecret,
    cfg.googleRedirectUri,
  );
  if (loadTokens) {
    let saved: Credentials;
    try {
      saved = JSON.parse(readFileSync(cfg.googleTokenPath, "utf8"));
    } catch {
      throw new Error(
        "Google credentials are missing or invalid. Run npm run drive:auth.",
      );
    }
    auth.setCredentials(saved);
    auth.on("tokens", (next) => {
      saved = { ...saved, ...next };
      writeTokens(cfg.googleTokenPath, saved);
    });
  }
  return auth;
}
