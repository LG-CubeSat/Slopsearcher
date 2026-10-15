import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { DRIVE_SCOPES, googleAuth, writeTokens } from "../drive/auth.ts";
import type { Credentials } from "google-auth-library";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const auth = googleAuth(cfg, false);
  const redirect = new URL(cfg.googleRedirectUri);
  if (
    redirect.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
    !redirect.port
  )
    throw new Error(
      "GOOGLE_REDIRECT_URI must be a loopback HTTP URL with an explicit port, such as http://127.0.0.1:53682/oauth2callback",
    );
  const state = randomBytes(24).toString("hex");
  const { codeVerifier, codeChallenge } =
    await auth.generateCodeVerifierAsync();
  const url = auth.generateAuthUrl({
    access_type: "offline",
    scope: DRIVE_SCOPES,
    prompt: "consent",
    state,
    code_challenge: codeChallenge!,
    code_challenge_method: "S256" as any,
  });
  const validate = (input: string): string => {
    const received = new URL(input);
    if (
      received.origin !== redirect.origin ||
      received.pathname !== redirect.pathname ||
      received.searchParams.get("state") !== state
    )
      throw new Error(
        "The OAuth callback does not match this authorization request",
      );
    if (received.searchParams.has("error"))
      throw new Error(
        `Google authorization failed: ${received.searchParams.get("error")}`,
      );
    const code = received.searchParams.get("code");
    if (!code) throw new Error("The callback URL has no authorization code");
    return code;
  };
  let code: string;
  if (process.argv.includes("--manual")) {
    console.log(
      `Open this URL on your own computer:\n\n${url}\n\nAfter consent, your browser may show a connection error. Copy the complete URL from its address bar and paste it here. This mode opens no listening socket.`,
    );
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      code = validate((await input.question("Full redirect URL: ")).trim());
    } finally {
      input.close();
    }
  } else {
    code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const received = new URL(req.url ?? "/", redirect.origin);
        if (received.pathname !== redirect.pathname) {
          res.writeHead(404).end();
          return;
        }
        try {
          const result = validate(received.href);
          res
            .writeHead(200, {
              "Content-Type": "text/plain",
              "Cache-Control": "no-store",
            })
            .end("Authorization received. Return to the terminal.");
          clearTimeout(timer);
          server.close();
          resolve(result);
        } catch (e) {
          res
            .writeHead(400, { "Content-Type": "text/plain" })
            .end(
              "Invalid authorization callback. Please return to the terminal and try again.",
            );
        }
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("Authorization timed out"));
      }, 600000);
      server.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.listen(Number(redirect.port), "127.0.0.1", () =>
        console.log(
          `Open this URL in your browser:\n\n${url}\n\nFor a remote server, forward the loopback callback first:\nssh -L ${redirect.port}:127.0.0.1:${redirect.port} user@your-server\n\nOr rerun with: npm run drive:auth -- --manual`,
        ),
      );
    });
  }
  const { tokens } = await auth.getToken({ code, codeVerifier });
  let previous: Credentials = {};
  try {
    previous = JSON.parse(readFileSync(cfg.googleTokenPath, "utf8"));
  } catch {}
  if (!tokens.refresh_token && !previous.refresh_token)
    throw new Error(
      "Google did not return a refresh token. Revoke the old app grant, then authorize again with offline access.",
    );
  writeTokens(cfg.googleTokenPath, { ...previous, ...tokens });
  console.log(
    `Drive authorized. Credentials saved with owner-only permissions to ${cfg.googleTokenPath}.`,
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Drive authorization failed");
  process.exitCode = 1;
});
