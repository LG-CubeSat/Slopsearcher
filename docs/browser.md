# Browser operation

## Using the bot

Mention the bot or use `/slop ask`, for example:

- “Open https://github.com/LG-CubeSat/Slopsearcher and summarize what you see.”
- “Open this page, send a screenshot, and explain the diagram.”
- “Follow the documentation link and look farther down the page.”

`browser_open`, `browser_follow`, and `browser_scroll` return rendered text, numbered links and an actual screenshot to the model. `browser_screenshot` saves an image for the final Discord reply when `share=true` (the default). `share=false` is for analysis only. Saved screenshots accompany the existing question reply or research report; the model cannot choose another channel or a server file path. Question progress includes browser activity labels.

Each research turn gets a fresh browser, so the model must reopen the relevant page when an investigation resumes. Existing investigations created before browser tools were available start a new runner thread using their saved findings, because the deployed Codex CLI saves dynamic tools at thread creation.

## Installation

Use Node 24 and install the repository dependencies. Then install Playwright’s matching Chromium:

```sh
npx playwright install --with-deps chromium --only-shell
```

On this server the browser is under `~/.local/share/slopsearcher-runtime/browsers`, selected by `PLAYWRIGHT_BROWSERS_PATH` in the user service. Missing Debian 13 shared libraries are extracted into the dedicated runtime’s `browser-libs` directory; `.env` sets `BROWSER_LIBRARY_PATH` to its `usr/lib/x86_64-linux-gnu` directory. These libraries are loaded only by Chromium, whose environment excludes Discord, Google and Git credentials. System fonts are used.

The service enables Chromium’s renderer sandbox. Its namespace allowlist permits nested user, PID and network namespaces; mount and cgroup namespaces remain blocked. The syscall filter permits `chroot` so Chromium can place renderers in an empty root inside their own user namespace. No host capabilities are granted. All other service restrictions remain in place. Startup opens and closes a blank browser page to report runtime readiness without contacting a website. A browser startup failure is logged while Discord and indexing remain available.

The Dockerfile installs Chromium and shared libraries. Chromium sandboxing must work in the container runtime too; runtimes that deny unprivileged user namespace creation need an appropriately reviewed seccomp configuration. The bot does not fall back to `--no-sandbox`. The Docker image has not been exercised on this server.

## Configuration and limits

| Setting                             | Default                            |
| ----------------------------------- | ---------------------------------- |
| `BROWSER_ENABLED`                   | `true`                             |
| `BROWSER_EXECUTABLE_PATH`           | Playwright’s installed Chromium    |
| `BROWSER_LIBRARY_PATH`              | Empty; use system shared libraries |
| `BROWSER_MAX_ACTIONS`               | 15 per turn                        |
| `BROWSER_SCREENSHOT_RETENTION_DAYS` | 7                                  |

Browser sessions last at most three minutes. Navigation has a 25-second timeout. Each session allows up to 200 requests, six in flight, with a 5 MiB response limit and a 50 MiB delivered-body budget. Resource requests time out after 12 seconds. Screenshot viewports are 1280 × 900; `fullPage=true` captures up to 3600 pixels in height. Scroll for other regions. At most five screenshots of up to 2 MiB each can be shared per task.

Screenshots are stored under the database directory in `browser-screenshots`, with metadata in SQLite. Hourly cleanup removes expired screenshots from terminal tasks after delivery; files awaiting delivery are retained. Restarting does not lose selected screenshots or resend a separate question message.

## Access boundaries

Chromium uses a dead proxy and disabled hostname resolution. The application fulfills page requests through an HTTP/HTTPS gateway that resolves each hostname, rejects nonpublic addresses, and pins the actual connection to a validated address. Redirects and subresources go through the same checks. Only standard web ports and GET/HEAD are allowed. Cookies, if needed, belong only to that fresh anonymous browser session; no account tokens are provided.

There are no form-filling, login, upload, arbitrary click/evaluate, shell, filesystem, or general browser-control tools. Downloads, WebSockets and service workers are disabled. Website JavaScript may run inside Chromium’s renderer sandbox to render pages. The tools remain limited to reading public pages, following links, scrolling and screenshots. Hosted web search remains separately configurable.

Login walls, anti-bot challenges, blocked resources, PDFs, unusually large pages and sites that require POST requests may not render fully. The model must report these limitations instead of claiming to have read unavailable content. Page text and screenshots remain untrusted evidence, not instructions.
