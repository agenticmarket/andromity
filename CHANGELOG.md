# Changelog

All notable changes to Andromity are tracked here. We follow semantic versioning.

## [Unreleased]

### Fixed
- **Undo after a long conversation.** Once a conversation had been compacted, undoing one turn could revert the files of many earlier turns, not just that one. Undo now finds each turn by where it starts in the conversation as it is now, undoes exactly the turns asked for, and says plainly when a turn was summarized and can no longer be undone. A message sent while a turn was running no longer counts as a turn of its own. The turn during which a conversation compacts itself can be undone too; before, its files were left as they were. This applies to VS Code and the terminal app. In the terminal app, a turn that stopped before it started (for example, an image sent to a model that can't read images) no longer gets in the way of undoing earlier turns.
- **Pasted images when a conversation compacts.** If a long conversation compacted itself on the turn you sent an image, the model got your message without the image. It now gets the image too, in VS Code and the terminal app.
- **Error cards for your own API keys.** A limit or error from your own provider key no longer shows the Andromity daily-limit card. Cards name the provider properly (for example OpenRouter, Google Gemini or Groq), say in plain words whether it was a rate or daily limit, a rejected key, a missing model, an account out of credits, an outage at the provider or a network problem, show the provider's own message in the details with keys removed, and suggest the next step.
- **"Provider unavailable" only for real outages.** It now needs a server error from the provider. A connection that never got through (refused, reset, DNS, TLS) shows **Couldn't reach** the provider, and a local server that isn't running (Ollama, LM Studio, llama.cpp or any localhost address) shows the local server card. Request IDs and timestamps that contain 500 or 503 no longer count. A provider's answer that will not change on a second try (a 4xx other than 408 and 429, such as out of credits or a blocked request) is shown at once instead of after half a minute of retries.
- **Andromity Cloud errors follow the gateway's error type.** The card comes from the type and action the gateway sends, in headers or in the error body, and falls back to the wording only when neither is there. A sign-in the gateway no longer accepts shows **Your Andromity sign-in isn't valid anymore**, with **Sign in again** and, in VS Code, **Use without signing in**, which signs out and retries the turn. Gateway-side failures, such as a timeout reaching upstream models, maintenance or an unreachable session store, show **Andromity Cloud is having trouble right now** with **Retry Turn**.
- Error telemetry also records where each error came from (`gateway`, `provider`, `local` or `network`) and its kind (`4xx`, `429`, `5xx`, `timeout`, `conn` or `other`) as one `error_src_<source>_<kind>` feature event, never the message text. The telemetry worker keeps these out of the error counts and reports them as `error_stats.sources`.

## [0.2.24] — 2026-10-26

### Added
- **In-chat check-in (VS Code).** After a reply that went well, at most a few times, the chat asks "How's Andromity working for you?". Love it leads to a review link; It's OK and Not great ask what gets in the way most. The feedback endpoint accepts the answer as optional `sentiment` and `annoyances` fields on the same anonymous note, and the admin panel's **User Feedback** page shows the sentiment split and the most common annoyances for the last 30 days. Run `telemetry-worker/feedback-checkin.sql` once on an existing database.
- The admin panel names the newer error codes (shared capacity busy, daily limit, session already running and others) instead of listing them as unclassified.
- **Send Feedback in VS Code.** A small box sends a note to the Andromity team with the client, OS family and version. It is stored with the country Cloudflare reports for the connection, but not with your telemetry ID or IP address. It is off in air-gap mode. [TELEMETRY.md](TELEMETRY.md) explains what is stored and how to have a note deleted.
- **VS Code tips for features you haven't tried.** After a reply, at most one "Did you know" card a day introduces a feature that fits what the turn did. Turn tips off with the `andromity.featureTips` setting.
- **Chapter rail in the VS Code plan tab.** Click a section mark to jump to it, or step through sections with Alt+Up and Alt+Down.

### Changed
- **Clear messages when shared capacity runs out.** When every upstream provider behind the Andromity gateway is throttled or failing, the gateway answers with one Andromity message, "very high demand right now", with how long capacity should take to return, instead of passing on the provider's own error. Provider wording about account credits, keys and per-account limits, provider account IDs and provider headers no longer reach users. Failures that come from the request itself, such as a prompt that is too long, keep their explanation without the provider's details.
- Gateway errors carry `x-andromity-error-type` and `x-andromity-error-action` headers, plus `Retry-After` when the wait is known, because OpenAI-compatible client libraries keep only an error's message and headers.
- The agent shows a **High demand** card with the gateway's message, the local time capacity is expected back, **Switch Model** first when the wait is long, and **Use Your Own Key**. It no longer spends half a minute retrying when the gateway says capacity returns much later. Gateway errors marked "model unavailable" are now recognised through the same headers; before, they were missed in real use.
- **Safer agent defaults.** The system prompt now covers secrets (never hardcoded, no placeholder keys), refusing system-wiping commands, not working around blocked tools, instruction files that cannot widen permissions, data leaks through URLs and images, and secure coding defaults for profiles that edit code. Subagents get the same rules, and the context passed to them is marked as data.
- **Branches and pull requests.** The builder and coder profiles never commit to the default branch, use `andromity/<topic>` branches, push and open pull requests only when you ask, open drafts for unfinished work, and never merge without you.
- Replies use plainer language, and questions about Andromity point to the docs site.
- Anonymous use of the Andromity provider is counted per install, with a random ID kept separate from the telemetry ID, instead of a shared default.
- VS Code: session, MCP server and background run statuses show as text, and running states shimmer.

### Security
- Write approvals judge a path by where it really lands. Names that Windows rewrites (`.git./config`, trailing spaces, `::$DATA` streams), symlinks and junctions no longer get past the checks that guard `.git`, `.vscode`, `package.json` and the other files that control what runs later.
- In TRUST mode, an allowlisted command needs approval when an argument reaches outside the project (`..`, absolute or network paths, `~`, wildcards) or uses a git option that writes files or runs programs, such as `--output`, `--ext-diff`, `-O` or `-c`.
- Subagents in TRUST mode can't write sensitive or execution-control files, and fetch only allowed domains.
- Scheduled runs in SAFE and TRUST mode don't change execution-control files, fetch only allowed domains, and don't run MCP tools that may change data.
- `grep_search` skips files that `read_file` refuses, such as credential files and `.env`.
- `fetch_url` checks the address it actually connects to, so a name that re-resolves to a private address (DNS rebinding) is refused.
- A project `skills` folder that links outside the project is ignored.
- OAuth sign-in opens only https pages, or http on localhost.
- `write_plan` stores only known step statuses.
- VS Code: **Settings → Trust & Security** lists the commands and domains you chose to always allow, each with **Remove**.
- VS Code: trusting a folder lists the MCP servers its own config will start. Command approvals list risks in plain words, a message that looks like it contains a secret is held until you choose to redact or send it, and **Run** on a chat code block shows the whole command before running one that hides text or would do lasting damage.

### Fixed
- Provider errors are classified by whole HTTP status codes. An error whose request ID or reset time contained "401", "404" or "500" could be shown as a sign-in problem, a missing model or an outage, and could skip the rate-limit retry.
- `andromity run` no longer crashes with a `UnicodeEncodeError` when it prints an error card on a Windows console or into a redirected log that cannot encode symbols such as the timer icon.
- `grep_search` results on Windows show the relative path and line number, instead of the absolute path with the line number inside the text.
- TUI: Ctrl+E (Settings), Ctrl+U (Profile) and Ctrl+D (Viewer) work while you type in the message box.
- TUI: the notice for an untrusted folder says that reading files is blocked too.
- TUI: the status bar says "cost unknown" for a model with no price data, instead of `?$0.0000`.
- TUI: the session browser no longer fills up with the empty session each launch leaves behind, and its **Messages** column counts only the conversation, not the system prompt.
- TUI: `/trust` describes what it unlocks accurately, and the model picker says "1 live model".
- VS Code: signing in or out updates the welcome screen again, a call waiting for approval shows **Needs approval** instead of **Running**, and rate limit errors say when the limit resets.
- VS Code: the Waterfall's **Duration** total no longer drops to 0 when a turn ends, and its inactive tabs no longer show as bright blocks.
- VS Code: loading placeholders no longer clip the session title.

## [0.2.23] — 2026-10-24

### Added
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability privately and what response to expect.
- [TELEMETRY.md](TELEMETRY.md) lists every telemetry event and field, how to turn telemetry off, and how to have your data deleted.

### Changed
- The Andromity provider's model list shows each model's name, description, pricing and context window. Picking a model that is not available to you right now shows a clear message with a **Sign In** or **Switch Model** action instead of retrying.
- Messages between sessions: a plain message now waits in the receiving session's inbox until its next turn, while a question or a handoff wakes it right away. The sender is told which happened.
- The OpenCode connection now needs your own OpenCode API key. It no longer reads OpenCode's credential file and identifies itself as Andromity.
- Tips, news and command content are no longer fetched when telemetry is off or air-gap mode is on.
- The VS Code extension sends no feature events if it cannot read your telemetry setting.
- **A calmer terminal UI.**
  - Colours follow your theme, emoji icons are gone, and the header bar is removed, leaving more room for the chat.
  - The status bar and footer blend into the background. The permission mode shows as a coloured word (`safe`, `trust`, `full`, `yolo`), and long model names are no longer cut short when there is room.
  - Your messages start with `›`, tool and thinking rows are shorter (`✓ read_file 3s`), and messages from other sessions use a simple coloured edge.
  - The message box has a rounded border that lights up when focused.
- **Dialogs share one look.** Every dialog (model, connection, profile, trust, undo, sessions, skills, scheduled jobs, batch review, settings and help) uses the same title bar, spacing and buttons, and longer dialogs scroll on small terminals.
- **Model picker.** Enter or Space picks a provider or model, your current model stays selected when the list refreshes, a custom model ID takes priority over the list, and the lists fit small terminals.
- **VS Code model picker.** Your current model is listed first under **Current** with an **Active** label, and the picker and Model Hub show every model the Andromity provider offers, not just Auto.
- **VS Code session panel on more screens.** It appears from 1100px wide, docked beside the chat, instead of needing 1500px.

### Fixed
- VS Code: prompt-bar buttons stay clickable when other elements overlap them, and the session title no longer cuts off the bottoms of letters like g, j and y.

## [0.2.22] — 2026-10-20

### Added
- **Customizable VS Code session panel.** Wide chat windows show context usage, uncommitted changes, MCP server status and environment controls. Drag a section's handle to reorder it, or use Up/Down, Home and End while the handle is focused. Sections start expanded; their order, collapsed state, visibility and the panel's hide preference are saved across chat tabs and reloads.
- **Air-gap mode.** Turn it on with `[default] airgap = true` in `config.toml` or `ANDROMITY_AIRGAP=1`. Andromity then makes no network connections except to this machine and private hosts in `airgap_allowed_hosts` / `ANDROMITY_AIRGAP_ALLOW`.
  - A guard installed at startup refuses connections, UDP sends and DNS lookups, including on the Windows asyncio path the old guard missed.
  - Cloud providers, web tools, remote and unapproved local MCP servers, connectors, telemetry and background lookups turn off with clear messages.
  - Commands the agent runs get stricter network blocking that an MCP server's `env` can no longer loosen.
  - New `airgap.status` and `airgap.self_test` RPC methods, and an `airgap/blocked` notification.
  - See [docs/air-gap.md](docs/air-gap.md), including what the guard does not cover.
- **Edit scheduled jobs in place.** New `cron.update` and `cron.duplicate` RPC methods keep a job's id and run history; changes apply from the next run.
- **Schedule preview.** `cron.preview` validates a schedule and returns a readable description plus the next run times.
- **More schedule formats:** `weekdays at 09:00`, `mondays and fridays at 5pm`, `every 1h30m`, `every 2 hours`, cron day and month names (`MON-FRI`, `JAN`), and `@hourly`/`@daily`/`@weekly`/`@monthly`.
- **New job settings**, all optional:
  - `catch_up`: run once after downtime (the default) or skip.
  - `max_retries`: default 2.
  - `notify`: `failures` (default), `always` or `never`.
- **Missed runs.** A daily or cron-schedule job that Andromity was closed for runs once when it starts again, if the miss was within 24 hours. Otherwise the history records it as **Missed**.
- **New run statuses:**
  - **Needs attention:** a tool was blocked, or the agent ended with a question nobody could answer.
  - **Skipped:** for example, the workspace is untrusted.
  - **Missed:** Andromity was not running at the scheduled time.
  - Runs also record their trigger (schedule, manual, catch-up or retry) and the tools that were blocked.
- **Run history** keeps the last 100 runs per job.

### Fixed
- **A job's run history was wiped** from the database every time any job was saved. It survived only through the `.andromity/cron_runs` JSON copies.
- **Duplicate runs.**
  - The VS Code engine started a new copy of a running job every 10 seconds.
  - A terminal and a VS Code window open on the same folder each ran the same jobs.
  - Jobs are now claimed in the database before they start, so each scheduled run happens once. Run now on a running job says it is already running.
- **Provider failures were recorded as successes.** Missing key, rate limit and quota failures now fail the run with a plain-language reason. Only temporary errors (rate limits, provider outages) are retried, with growing waits.
- **Auto-pause.** A job pauses itself after 5 failed runs in a row and shows why.
- **Unattended runs.**
  - The agent is told it is unattended and which commands it may run.
  - A blocked command now says "Blocked by this scheduled job's allowed commands" and lists them, instead of "rejected by user".
- **Wrong folder.** Scheduled jobs no longer run in the editor's install folder when VS Code has no folder open. Cron requests without a real project folder are refused, and jobs whose folder disappeared are paused.
- **Stale session view.** Opening a scheduled run's session while it ran could leave a stale copy showing only the prompt. It now shows the live run, and missing run sessions are never recreated empty.
- **Live updates for open scheduled runs.**
  - An open scheduled run streams like a normal chat: `agent/started`, text, thinking and tool events, then exactly one finish signal. That is `agent/done` for success or needs-attention, `agent/error` for a failure or timeout, or `agent/cancelled` when stopped.
  - Chat turns and scheduled runs now share one event-forwarding helper.
  - **Stop** in the chat cancels the run.
  - These notifications carry `scheduled: true`.
- **Wrong permission mode.** A scheduled run's session records the job's permission mode and profile instead of your default. `session.get` adds a `scheduled_run` field with the job, its mode and whether the run is still going.
- **Messages during a run.** Sending a message into a scheduled run that is still going is refused with "This scheduled run is still in progress. You can continue the chat when it finishes." Before, it started a second agent on the same session. Once the run ends, the chat continues normally.
- **Untrusted workspace.** A job no longer records a failed run every 10 seconds. It records one skipped run and pauses until you trust the workspace and resume it.
- **Cron expressions** fired only if a check happened to land inside the matching minute. They now run on time, and their next-run time is correct.
- **Schedule parsing.**
  - Out-of-range fields such as `99 * * * *` were accepted and never ran.
  - Day-of-month and day-of-week now follow standard cron (either can match).
  - `every 1h30m` was read as one hour.
- **Daily jobs** (`daily at HH:MM`) created after that time no longer run immediately.
- A chat no longer shows as running forever when Andromity stopped mid-reply (VS Code closed, the engine crashed or was restarted). Each engine now records itself as the owner of a running chat, and any window can tell when that engine is gone; such chats show as `interrupted`. Chats left running by earlier versions count as interrupted after 30 minutes without activity. A run in another open window is never marked interrupted.

### Changed
- A new interval job waits one interval before its first run. Use **Run now** to start it right away.
- A run stopped by shutdown is recorded as interrupted and does not count as a failure.

## [0.2.21] — 2026-10-18

### Added
- **15 more app connectors**, for 65 in total: Context7, Tavily, Firecrawl, CircleCI, Heroku, Pulumi, PlanetScale, ClickHouse, Clerk, WorkOS, LaunchDarkly, Better Stack, Ahrefs, Make and Calendly. Each is the vendor's official remote MCP server and connects with one browser sign-in.
- **AI disclosure on posts.** When the agent posts text other people read on your behalf (issue and pull request comments, descriptions, messages, emails, wiki pages) through an app connector or a CLI such as `gh`, it ends the text with "Written by Andromity, an AI agent, on behalf of the user who posted this." Drafts it hands back to you are not marked.
- **Assisted-by trailer** (off by default). `[default] include_assisted_by = true`, or **Assisted-by Trailer** in the terminal settings, adds `Assisted-by: Andromity/<version> (<provider>/<model>)` to commits the agent makes. A model switch mid-session updates the trailer.
- Each saved answer records the provider and model that produced it. Session exports name the model on every answer and say they were generated by Andromity, with a `generator` field in JSON and `<meta name="generator">` in HTML.

### Changed
- The GitHub Action's PR review footer says the review is AI-generated and names the model.

## [0.2.20] — 2026-10-15

### Added
- **App connectors.** A catalog of 50 official remote MCP servers (Notion, Linear, Jira & Confluence, Gmail, Google Calendar, Google Drive, Stripe, Sentry, Supabase, Neon and more) that connect with one browser sign-in. In the TUI: `/settings` → MCP → **Connect an app**. Connectors are saved to `~/.andromity/mcp.json`; nothing is saved if sign-in fails or is cancelled. Gmail, Calendar and Drive take your own Google OAuth client ID and secret. GitHub, Airtable, Render and PagerDuty connect with an access token: Andromity checks it with the service, then stores it in the encrypted token store, not in `mcp.json`.
- MCP server entries accept an optional `token_prefix` (default `Bearer `) for servers that expect another `Authorization` scheme, such as PagerDuty's `Token token=`.
- New RPC methods `connectors.list` and `connectors.connect`.
- The terminal's **Connect an app** note links the setup guides at https://andromity.agenticmarket.dev/integrations.

### Fixed
- MCP OAuth discovery rejected servers whose metadata differed only by a trailing slash in the resource or issuer URL, such as Vercel and Google. Google sign-ins now ask for offline access, so their tokens refresh instead of expiring after an hour.
- OpenRouter listed Andromity under two different app names. All Andromity requests now identify as "Andromity" from `https://andromity.agenticmarket.dev`, so OpenRouter counts them as one app.

## [0.2.19] — 2026-10-15

### Fixed
- A background command (`shell_bg`) that exits within its first two seconds is no longer reported to the agent as running. The tool result now includes the exit code and output, with a reminder of the active shell's syntax. On Windows that shell is PowerShell, so a bash loop such as `for i in $(seq 1 180); do …; done` exits at once with a parse error. Previously the agent was told the process had started and kept saying it was running. The agent is no longer woken a second time for an exit it already saw.
- Background processes are registered before their output reader starts, so a process that ends instantly is no longer missed.
- Background process notices are no longer lost:
  - **During a turn:** if a process ends or you stop it while the agent is working, the notice is added to the running turn. Before, it was dropped.
  - **Several at once:** when several processes end within a moment (for example, you stop them all), the agent gets one message listing every one. Before, only the first reached it.
  - **Settings:** these turns use the session's own mode capped at TRUST, plus its profile and model, as before.
- Compacting by hand no longer stores a rough estimate as if the provider had reported it. As with automatic compaction, the size is unknown until the next request. Both kinds of compaction now send an estimate of the compacted context, flagged with `context_estimated`; it covers the system prompt, tool definitions and messages.
- A `config.toml` with a syntax error could lose your API keys. Andromity started with defaults, and the next setting it saved overwrote the file. It now keeps a copy as `config.toml.unreadable-<time>` before anything can be saved, says where in its warning, and reports it through the new `config.status` RPC. The warning goes to stderr instead of stdout.
- MCP:
  - **TRUST mode** checked the whole tool name, server included, for words like `post` or `exec`, so every tool of a server named `postgres` asked for approval. Only the tool's own name counts now.
  - **TUI "Use PAT"** rewrote the server into an `npx mcp-remote … --header` command whose header was never sent, so the token didn't work. The token is now stored like an OAuth or VS Code token and sent on connect.
  - **`mcp-remote` configs** keep their `--header "Name:Value"` arguments when Andromity connects to the URL directly.
- The **Max Parallel Subagents** setting wrote `[subagents] max_parallel`, which nothing read. `config.get` now reports `[subagents] max_concurrent`, the limit the subagent orchestrator uses (default 5).
- TUI text that didn't match the app:
  - **Trust prompt:** it said reading files is always allowed in an untrusted folder; reading is blocked until you trust it. Its dismiss button now reads **Not now** instead of **Read-only**.
  - **Error hints:** they pointed to `Ctrl+M`, `Ctrl+P -> Settings` and an `andromity auth login` command that doesn't exist. They now say `Ctrl+L` to switch model, `Ctrl+E` for Settings, and signing in from the VS Code extension.
  - **Help and command palette:** they listed `Ctrl+J` for switching profile; the key is `Ctrl+U`.

### Security
- Skills that come with a project (`.agents/skills/`, `.andromity/skills/`, `skills/`) are left out of the system prompt until the folder is trusted. Before, an untrusted repository's skill names and descriptions reached the model even though the agent could not open them. Settings still lists them.

### Added
- `session.context` RPC: an estimate of what fills a session's context window, by category. The categories are the system prompt, tool definitions, MCP and deferred tools, skills, the compacted summary, your messages, replies, tool calls and tool results. It also returns the provider-reported size of the last request, the model's window and the auto-compact threshold. The VS Code context popover uses it.
- Anonymous feature-usage events for automatic compaction (`compact_auto`) and TUI slash commands (`tui_<command>`).
- `config.status` RPC: the path of `config.toml`, and the parse error and kept copy if it couldn't be read.
- `config.set_ollama_host` RPC: sets the Ollama address, with the same URL checks as custom providers. The TUI's Ollama Base URL field uses the same checks and now reports an invalid URL instead of ignoring it.

### Changed
- The `shell_exec` tool description now points long-running commands to `shell_bg` instead of suggesting `&` or `Start-Process`.
- The auto-compaction threshold (80% of the context window) is a named constant shared with the context breakdown.
- The telemetry notice in `telemetry.py` lists feature-usage events: feature names only, with the anonymous install ID and session ID.

### Telemetry Dashboard
- A new **Feature Usage** page lists every tracked feature grouped by area, including ones nobody has used. Each feature shows users, uses and adoption, with search and used/unused filters. The overview's feature list is no longer cut at 25 entries, and its stale labels are fixed. These dashboard changes deploy independently of the core release.

## [0.2.18] — 2026-10-09

### Fixed
- Ollama model discovery now returns only models installed on the running server. Offline servers and empty installations no longer fall back to catalog entries or stale cached models.
- Plan approval uses the active session's permission mode instead of the global default. Builder instructions now match automatic plan approval in Full and YOLO.
- Switching permission modes rechecks pending approvals against workspace trust and profile restrictions. Switching to Trust preserves checks for sensitive paths, execution-control files, commands, and external actions.

### Changed
- VS Code chat has clearer permission and working-style menus, model activity indicators, tool targets, and Markdown formatting. See the extension changelog for details.

### Telemetry Dashboard
- Session timelines show recorded error categories, such as “Model not found” and “Provider unavailable”, instead of a generic error badge. Older records without a category show “Error type not recorded”.
- A later successful turn no longer hides an earlier recorded session error. These dashboard changes are deployed independently of the core release and use existing anonymous telemetry without collecting error message text.

## [0.2.17] — 2026-10-09

### Added
- Commits the agent creates end with `Co-authored-by: Andromity <333054755+andromity-bot@users.noreply.github.com>`. Turn this off with `include_co_author = false` under `[default]` in `config.toml` or the Co-author Commits switch in TUI settings.

### Security
- VS Code: SAFE-mode approvals for `write_file`, `edit_file` and `edit_file_multi` show the lines being removed and added, instead of only the file path or raw parameters.
- Auto-woken sessions now run with their own permission mode and profile, capped at TRUST, and never in an untrusted folder.
- Session tools that can wake or steer another session (send, ask, broadcast, watch, shared state writes, handoffs) require workspace trust again and need approval in SAFE mode. Sessions only reach peers in the same project, and only the addressed session (or the user) can answer a question.
- Writes to `.git/`, `.andromity/`, `.vscode/`, `.husky/`, `package.json`, `.envrc` and `.mcp.json` need approval in SAFE and TRUST, since they can trigger later command execution.
- Cron jobs that arrive in a repository's `.andromity/crons.json` are imported disabled, and FULL/YOLO jobs are lowered to SAFE.
- VS Code: the sign-in token only goes to AgenticMarket hosts set in user settings, sign-in links must come from this editor, and model output can no longer render raw HTML or load remote images in chat.

### Fixed
- Inter-session messages, questions and answers now appear in the TUI, and VS Code keeps them for sessions that are not on screen.
- Collaborator badges and per-session renames in VS Code, plus shared-state and handoff notifications.
- Sessions whose last turn was cancelled or failed can be woken again.

### Changed
- Error telemetry records the error category (for example `error_auth`, `error_rate_limit`, `error_ollama_offline`), never the message text.

## [0.2.16] — 2026-10-07

### Fixed
- Preserve LiteLLM proxy runtime modules (`spend_tracking`) in bundled daemon binaries to resolve Linux runtime crashes (`ModuleNotFoundError: No module named 'litellm.proxy'`).
- Prune Next.js frontend chunks and stray test certificates from `litellm/proxy` to resolve VS Code Marketplace automated validation and security scanner rejections.
- Eliminate duplicate binary outputs (`serverb`) and enforce strict packaging exclusions for certificates and keys.
- Validate AgenticMarket account sessions before saving sign-in credentials and clear rejected sessions from the extension and daemon.

### Added
- Automated provider runtime checks (`--check-runtime`) integrated into both the build script and GitHub Actions CI matrix across Windows, Linux, and macOS runners.
- Dedicated regression test suites in Python and TypeScript (`packagingGuards.test.ts`) guarding `.vscodeignore` rules and bundled binary integrity.

## [0.2.15] — 2026-10-06

### Fixed
- Close Git review repository handles after RPC requests so Windows can release workspace directories.
- Refresh the VS Code chat, keep BYOK setup visible, clarify cloud trial status, and preserve manual scrolling while reliably jumping to the latest turn.
- Harden Docker defaults and release workflows with locked dependencies, restricted credentials, pinned Actions, and release validation.
- Reduce telemetry dashboard D1 reads with normalized shared snapshots, compact historical activity, grouped feature/session statistics, and session/day error checks. Ordinary ingestion no longer invalidates statistics snapshots.
- Count telemetry activity across complete windows, apply database cohort filters, and avoid multiplying session totals when multiple turn endings exist.
- Separate gateway first-token timing from full response duration and record failures within streams.
- Generate initial session titles from the user message before appending IDE context, preventing active-document metadata from appearing in titles.
- Reconnect enabled MCP servers when the IDE daemon starts, even when a manager already exists. Failed startup can retry, and changing projects closes previous sessions.
- Support remote MCP HTTP transport, protected resource discovery, and OAuth token endpoint client authentication required by providers such as Supabase.
- Refresh the TUI file sidebar after file creation, deletion, and moves. Reconcile affected visible directories without cascading into unrelated expanded folders; refresh collapsed folders when reopened.

### Added
- Anonymous task outcomes and active turn timing, durable telemetry retries with idempotent ingestion, and MCP startup/cancellation signals. Dashboard statistics and administrative actions require separate server-side credentials and authenticated access.
- IDE RPC support for MCP configuration management and removal of selected installed skills, with workspace trust checks.
- MCP tool names and descriptions for collapsible IDE inspection while keeping schemas lazy.

## [0.2.12] — 2026-09-30

### 🌿 Git & Multi-Repository Targeting
- **Multi-Root Git Commit Generation**: Resolved target repository directly from SCM button context, preventing cross-repo diff contamination in multi-root workspaces.
- **Dedicated Staged vs. Unstaged Diffs**: Prioritizes staged changes cleanly without polluting with unstaged modifications when generating commit messages.
- **Commit Input Error Guard**: Blocked AI error strings and backend exceptions from ever being injected into the Git commit input box.

### 💻 Terminal TUI & Clean CLI Formatting
- **Core Error Decoupling**: Decoupled error classification from HTML presentation in `core/provider.py`.
- **Zero-HTML Terminal Rendering**: Terminal TUI and standalone CLI output clean Markdown blockquotes and native Textual `.session-error-card` with zero raw HTML, `<svg>`, or `<button>` tags.
- **Webview HTML Isolation**: Preserves rich interactive HTML error cards exclusively for webviews.

### 🛡️ UX Hardening & Gateway Quota Transparency
- **UTC Quota Countdown Timer**: Dynamic live countdown badge (`Quota resets in Xh Ym (00:00 UTC)`) indicating exact daily reset times.
- **Raw Exception Suppression**: Omitted raw `litellm.RateLimitError` and internal stack traces on quota limits to maintain a clean, trustworthy developer experience.
- **Zero Hardcoded Numbers**: Removed artificial turn counts (`30`, `5`) across all UI cards; limits and status derive directly from gateway allocations.

### 🔑 Authentication & VS Code Forks
- **Universal IDE Fork Support**: Deep-link login automatically detects editor URI schemes (`cursor://`, `vscodium://`, `windsurf://`, `trae://`, `vscode://`, `code-oss://`).
- **Open-Redirect Hardening**: Validated callback URLs via strict pattern matching to eliminate open-redirect risks while ensuring tokens route safely to the originating editor.
- **Cross-View Auth & Limit Sync**: Unified authentication status and live usage quotas across both sidebar and editor-tab views with bi-directional broadcast.
- **Interactive Action Target Fix**: Wired up `[Sign In]` and `[Open Settings]` click handlers in the webview error card.

### 📐 UI Dimensions & Modal Bounds
- **Prompt-Aligned Interactive Cards**: Constrained `#interactive-slot`, permission approval cards, and clarifying question carousels to match the prompt composer bounds across wide editor layouts.
- **Typo Fix**: Corrected CSS background property in markdown file pills.

---

## [0.2.11] — 2026-09-25

### 🌊 Live Waterfall Execution Profiler
- **Auto-Open Waterfall Option**: Configurable `andromity.waterfall.autoOpen` setting that automatically opens and docks the Live Execution Waterfall panel during multi-step reasoning and subagent runs.
- **Span Synchronization & Real-Time Tracking**: Fixed timeline jitter during concurrent tool calls, ensuring live durations and status codes stream smoothly without dropped spans.
- **Trace Metrics & Habit Telemetry**: Added developer trace habit analysis to measure execution depth and repeat adoption.

### 🤝 Multi-Agent & Session Collaboration
- **Collaborative Session Inbox**: Added dedicated Session Inbox in the webview to read, inspect, and answer incoming messages and mailbox events across concurrent agent sessions.
- **Session Watch & Auto-Awake**: Background sessions can enter `watching` mode and automatically awaken when another agent posts an answer or file handoff.
- **Permission-Card Clarifying Questions**: Replaced blocking modals with sleek inline `permission-card` UI featuring custom radio options for fluid pair-programming.

### 🎨 Session UI & Chat Experience
- **Stepped Reasoning Popover**: Minimal, stepped slider popover (`Off`, `Low`, `Medium`, `High`) for reasoning effort without distracting header clutter.
- **Cursor-Parity File Pills**: Automatic stripping of raw ambient context blocks with clean, interactive file pills and diagnostics badges.
- **Intelligent Auto-Scroll**: Preserves user scroll position when reviewing message history while maintaining automatic scroll-to-bottom for live incoming tokens.
- **Post-Response Meta Footer**: Sleek turn duration badge (`3.2s`), humanized relative timestamps (`now`, `2m ago`), and one-click copy actions.
- **Enhanced Activity Rows**: Activity rows now feature dedicated diff preview buttons, addition/deletion line statistics, and expandable output previews.

### 🤖 Git Co-Authoring
- **Automatic Co-Author Attribution**: Automatically attaches `Co-authored-by: andromity-bot <bot@agenticmarket.dev>` in Git commit trailers generated by the agent for complete transparency in team repositories.

### 🛡️ Telemetry & System Resilience
- **Session UUID Joining Fix**: Fixed regex false positive in key scrubber that incorrectly masked UUID session IDs, restoring event-to-session database linkages.
- **Real Tool Call Tracking**: Repaired telemetry counters for `shell_exec`, `shell_bg`, `find_files`, and `edit_file_multi`, ensuring terminal runs and multi-file edits reflect accurately in developer analytics.
- **Cumulative Multi-Turn Metrics**: Bound tool counters directly to session state so multi-turn sessions accumulate real tool operations instead of resetting to 0.

---

## [0.2.10] — 2026-09-20

### 🎨 UI & Chat Redesign
- **Clean Minimal Theme**: Complete UI overhaul for errors, onboarding, commands, and skills views — sleek, distraction-free layouts with consistent neutral aesthetics.
- **Sleek Markdown Typography**: Neutral high-contrast markdown rendering with clean list and blockquote spacing matching modern IDE standards.
- **Borderless Inline Prompt Controls**: Replaced bordered prompt inputs with clean, borderless inline controls matching Cursor/Codex style; removed drag-drop from the prompt bar.

### 🛡️ Error Recovery & Resilience
- **Resilient Error Cards**: Introduced polished error cards with one-click retry to re-execute the previous agent turn without losing context.
- **Vision Model Guarding**: Added automatic content-type guards to prevent vision-incompatible payloads from reaching text-only models.
- **Transient 5xx Auto-Retry**: Automatic transparent retries on transient server-side errors (5xx) with exponential backoff.

### 🌐 Web Search & Security Hardening
- **Zero-API Resilient Web Search**: Web search now cascades across multiple providers with no single-point-of-failure API dependency.
- **Safe Skill Read Roots**: Restricted skill file reads to declared safe root directories, preventing unauthorized filesystem traversal.
- **Security Hardening**: Additional sandboxing and input validation across web search and skill execution paths.

### 📎 File Context & Attachments
- **Cursor-Parity File Pills**: File context attachments now display as compact clickable pills (matching Cursor/Codex UX), openable directly in the editor.
- **Drag-and-Drop Context Attachments**: Drag files from the VS Code explorer directly into the chat to attach them as context.
- **Robust Window Drag-Drop**: Replaced ambient open-file behavior with explicit, robust drag-and-drop and manual file attachment; removed duplicate Andromity icon and mascot header clutter.
- **Raw Context Stripping**: Automatically strips unnecessary raw context wrappers from attached file content before sending to the model.
- **Ollama Auto-Connect & Model Registration**: Detected local Ollama models are now automatically registered in the model catalog on startup.

### ⏰ Cron & Scheduling
- **Exact Date, Time & Cron Syntax**: Full scheduling support for exact dates, exact times, and raw cron expressions (`0 2 * * *`) from the cron overlay.
- **Daily Time Sync**: Cron overlay syncs current date and time dynamically, eliminating stale schedule previews.
- **Running Status Sync Across Split Views**: Fixed cron job running status desync when Andromity is open in multiple split editor panels.
- **Cron Preset Management**: Allow deleting saved cron presets directly from the scheduling overlay.

### 🧩 IDE & Extension Improvements
- **Secondary Sidebar Placement**: Extension panel can now be pinned to VS Code's secondary sidebar for a wider, more spacious layout.
- **Terminal Error Quickfix**: Detected terminal errors surface an inline quickfix action to let the agent auto-fix in one click.
- **Ambient IDE Context Injection**: Ambient workspace context (open files, cursor positions, diagnostics) is automatically included in agent prompts.
- **Title Logo Button Restored**: Restored the Andromity logo button in the chat title bar with correct routing.
- **Dual Waterfall State**: Waterfall panel correctly handles dual open/closed states across split views without desync.
- **Terminal Capture**: Agent can capture terminal output for use as inline context during task planning.
- **Diff Line Stats**: Changed file cards now display accurate `+additions / -deletions` line statistics.
- **Tool & Plan Approval Routing**: Correctly routes tool execution and plan approval prompts from editor-tab session panels.

---

## [0.2.9] — 2026-09-13

### 🐾 Pixel Mascot Companion & Interactive Pet
- **Smart Adaptive Pixel Pet (`ChatViewProvider`)**: Introduced a playful pixel mascot companion that roams idly across the webview, performs adorable edge peeking animations, and reacts in real-time to agent actions.
- **Task Priority Interrupt & Tool Docking**: Companion dynamically responds to live activity, docking alongside executing tools and updating state during complex reasoning phases.
- **Checklist Styling & Step Visualizer**: Added dynamic checklist styling and tool-flank indicators for clear visual tracking of multi-step agent plans.

### 🎨 UI Improvements & Webview Polishing
- **Modern Activity Rows & Live Status**: Streamlined chat activity displays with high-contrast, theme-adaptive cards, smooth state transitions, and clean typography.
- **Settings & Diagnostic Fast-Path**: Instant pre-warmed diagnostics rendering (<1ms) in Andromity Hub, eliminating layout shifts and loading flashes.
- **Aesthetic Token & Contrast Harmony**: Full WCAG compliance with refined focus rings, polished scrollbars, and seamless dark/light VS Code theme integration.

### 🌊 Waterfall Profiler Synchronization & Stability
- **Real-Time Mid-Turn Trace Sync**: Live event queueing ensures trace events are preserved during initial connection, preventing split turns and dropped spans.
- **Sequence Race Condition Resolution**: Completely resolved mid-turn span duplication and timeline jitter during rapid multi-tool execution.
- **Multi-Tier Search Integration**: Optimized file pattern matching and ripgrep cascading for sub-millisecond workspace exploration.

### 🛠️ Core Agent & CI Reliability
- **Message Content Sanitization**: Enhanced API message formatting and role sequencing to guarantee robust turn boundaries across all supported LLMs.
- **Asset Optimization**: Streamlined documentation and extension WebP assets under 5MB for marketplace compliance.
- **Cross-Platform Test Reliability**: Hardened CI test suites and session teardown across Windows, macOS, and Linux runners.

---

## [0.2.8] — 2026-09-07

### 🌊 Waterfall Live Execution Trace & Profiler
- **Live Visual Waterfall (`WaterfallPanel`)**: Real-time visual waterfall profiling that maps agent reasoning steps, tool call latencies (terminal commands, file operations, web lookups), and subagent lifecycles across a chronological timeline grid.
- **Trace Buffer & Latency Inspection**: Inspect exact duration, status, execution timing, and input/output parameters per span directly inside a dedicated editor panel.
- **Header Action & First-Session Tour**: Direct access via the 🌊 Waterfall icon in the chat header, `/waterfall` slash command, and a non-intrusive onboarding callout.

### VS Code Extension Polish & UX
- **Personalisation & Ambient Wallpaper Engine**: Added comprehensive personalisation controls in Settings with on/off toggles, `/personalisation` and `/wallpaper` slash commands, custom aura intensity, and live particle background modes.
- **Accessible & Aesthetic Focus States**: Refined keyboard focus styling across all custom dropdowns, pill selectors, and input controls to match native VS Code `:focus-visible` aesthetics without intrusive outlines.
- **CJK IME Composition Guard**: Fixed enter-key submission issues during East Asian IME composition (Japanese, Chinese, Korean), preventing premature message sends.
- **WCAG 2.1 Accessibility**: Elevated link contrast ratios, keyboard navigation rings, and ARIA role labeling across all webview elements.
- **Untrusted Workspace Support**: Declared limited untrusted workspace support for secure, sandboxed editing.

### Telemetry & Privacy Hardening
- **Real-Time Privacy Synchronization**: Added real-time event listeners in VS Code (`onDidChangeTelemetryEnabled`, `onDidChangeConfiguration`) to dynamically synchronize telemetry opt-out state to the daemon without restarting.
- **Zero-Bypass Privacy Enforcement**: Strict bypass when `DO_NOT_TRACK=1`, `ANDROMITY_NO_TELEMETRY=1`, `CI=1`, or when telemetry is disabled in VS Code settings. Automatically injects opt-out flags into child daemon environments.
- **Edge Worker Production Deployment**: Live Cloudflare D1 worker endpoints (`/ping`, `/event`) that never collect code, prompts or file paths, with strict rate limiting, and automated health checks.
- **Automated Telemetry Test Suite**: Added dedicated automated unit tests (`tests/test_telemetry.py`) covering all 9 opt-out and toggle conditions.

### Documentation & Global Marketplace Assets
- **Global CDN Asset Migration**: Replaced local walkthrough images in all READMEs with ultra-fast CDN URLs (`https://cdn.agenticmarket.dev/andromity/git/`), ensuring flawless rendering across VS Code Marketplace, Open VSX, GitHub, and PyPI.
- **Multilingual Alignment**: Synchronized all 8 international translations (`zh-CN`, `ru`, `pt-BR`, `ja`, `hi`, `es`, `fr`, `de`) with the updated VS Code & Terminal feature showcase and comparison matrix.
- **High-Converting Quick Install Action**: Standardized clickable Marketplace install badges, direct links, and terminal install commands across all documentation.

---

## [0.2.7] — 2026-09-05

### Git Diff & Staging Integration
- **Index-Aware Staged Diff Viewer**: Clicking a modified file in the review card now properly diffs Working Tree vs. Git Index (`:rel`), matching native VS Code Source Control behavior (`(Working Tree)`) rather than falling back to an empty `HEAD` baseline for newly staged files.
- **Accurate Diff Numstat**: Combines unstaged working tree diffs and staged index changes so newly staged and modified files reflect accurate additions and deletions (`+` / `-`).
- **Disk I/O & Performance Optimization**: Replaced recursive `repo.untracked_files` with `git status --porcelain -unormal` across `git_ops.py` and `rpc_handler.py`, eliminating 100% disk usage and performance freezes during git status checks.
- **Rollback Safety**: Preserves user-created untracked files during snapshot rollbacks while cleanly pruning AI-created turn files.

---

## [0.2.6] — 2026-09-04

### Platform Binaries & CI
- **Native Platform Binaries**: Standalone daemon binaries bundled per-platform (`win32-x64`, `linux-x64`, `darwin-arm64`), removing Python/pip requirements for Linux & macOS.
- **Automated Matrix CI**: GitHub Actions workflow builds and packages slim platform-specific `.vsix` packages automatically upon release.
- **Environment Compatibility**: Switched build pipeline to use `uv` with PEP 668 bypass for clean builds in externally-managed Python environments.

---

## [0.2.5] — 2026-09-03

### Sessions & Subagents
- **Minimalist Running Arc Indicator**: Replaced bulky `RUNNING` text pills and jerky zoom scaling animations with a smooth, minimalist circular arc SVG spinner (`0.85s` linear infinite rotation) next to session and subagent titles.
- **Hierarchical Sessions Tree**: Reorganized the session flyout into an intuitive tree view where subsessions (subagents) are nested directly beneath their parent sessions with expandable/collapsible toggles (`[ ▾ {count} subtasks ]`) and branch connectors (`└─`, `├─`).
- **Active Session Dot**: Replaced raw unicode star (`★`) with an elegant glowing active indicator dot.
- **Smart Expansion & Search**: Searching sessions searches across both parent sessions and child subagent tasks, automatically expanding matching parent nodes.
- **VS Code Activity Bar Tree Parity**: Updated `SessionTreeProvider` to mirror the hierarchical parent/subsession tree structure directly in the VS Code sidebar.

### Multi-Session & Webview Stability
- **Parallel Editor Tabs**: Enabled seamless parallel sessions across multiple VS Code editor tabs without event crosstalk or session collision.
- **Session Lifecycle & Deduplication**: Fixed title rename storms, pruned empty ghost sessions cleanly, and isolated plan updates per session.
- **Conversation Timeline**: Aligned timeline styling with clean card design standards, eliminating excessive glow and gradients.

---

## [0.2.4] — 2026-08-30

### Telemetry & Infrastructure
- **Cloudflare D1 & Worker Redesign**: Modernized telemetry ingestion architecture with Cloudflare D1 SQL storage, and automated rate limiting.
- **Platform Detection**: Added clean OS and client provider breakdown telemetry without sensitive workspace data.

---

## [0.2.3] — 2026-08-25

### Internationalization & Documentation
- **Multi-language Localized READMEs**: Full coverage and cross-navigation for 8 major developer languages (Simplified Chinese, Russian, Brazilian Portuguese, Japanese, German, French, Spanish, and Hindi).
- **Dynamic Media Showcase**: Integrated high-definition video walkthroughs on CDN for immediate preview without repo bloat.

### UI & Styling
- **Thought Bubble Contrast Fix**: Tuned collapsible reasoning header styling to ensure clear contrast when highlighted across all terminal themes.

## [0.2.2] — 2026-08-24

### Terminal UI & Visual Hierarchy
- **Dropped the emoji clutter**: The footer, status bar, and message headers used to have a bunch of random emojis that messed with terminal fonts and character widths. We swapped them out for clean Unicode glyphs (`▪`, `◆`, `✦`, `⠋`, `✓`, `✗`) so everything lines up nicely across different terminal emulators.
- **Better spacing & breathing room**: Fixed tight padding across the chat stream, diff pane, and file tree. Long diffs and dense code blocks are way easier on the eyes now.


### Edge Intelligence & Community Lore
- **Edge-powered hidden commands**: Added dynamic dispatch for 15 unlisted experimental commands (`/ghost`, `/void`, `/roast`, `/council`, `/trial`, `/matrix`, `/tao`, etc.). Directives live on our edge worker rather than hardcoded in the package, keeping the binary light and discovery fresh.
- **`/tips` & `/news`**: Added a quick tip feed tagged by topic (`#perf`, `#debug`, `#git`, `#arch`) and an in-app release bulletin so you can check updates without opening a browser.
- **Calendar-aware easter eggs**: The edge worker can inject temporary seasonal flavor (Halloween, New Year, April Fools, midnight dev shifts) without needing a client package update.

### Cron & Background Tasks
- **Dedicated run logs**: Every scheduled run now dumps its history and logs inside your project under `.andromity/cron_runs/` so you can actually inspect what the agent did while you were away.
- **Status bar countdown**: Added a live footer badge showing how many cron jobs are active and when the next one will trigger.
- **Strict per-job isolation**: Each scheduled task keeps its own permission level, model choice, and context window separate from your main interactive session.

### Telemetry & Privacy
- **Usage metrics**: The optional telemetry ping only sends OS name, version, and model provider distribution. No file names, no code contents, no prompt data.

---

## [0.2.1] — 2026-08-20

### Startup Speed
- **Killed the startup blank screen**: Removed a stray `litellm` import sitting in the settings module that was forcing Python to load the whole dependency graph before rendering anything. Startup dropped from ~5–10s down to sub-second.
- **Lazy settings screen**: The 87KB settings UI only loads into memory when you actually open it (`Ctrl+,` or `/settings`).

### Long-Session Stability
- **Debounced disk writes**: Stopped saving session state on every single streamed token. It now saves on a 1.5s background debounce with an immediate flush on exit or session switch.
- **Sub-widget timer cleanup**: Added proper `on_unmount()` cancellation on dynamic message widgets so leftover timers don't run in the background.
- **DOM pruning**: Chat messages scrolled way past the viewport get serialized into light Python dicts in memory, then rebuilt only when you scroll back up.
- **File watcher thread pool**: Stopped spawning a new thread for every filesystem event; uses a single background worker thread instead.
- **Bounded undo memory**: Capped prompt previews in undo history at 20k characters so pasting giant files doesn't balloon memory.
- **Accurate token counts**: Uses real `context_tokens` from provider APIs for compaction thresholds instead of guessing by character length.

---ro

## [0.2.0] — 2026-08-15

### Initial Release
- Full-screen terminal IDE with split chat, file explorer, diff view, and plan tracker.
- Multi-provider support: Anthropic, OpenAI, Gemini, Ollama (local), DeepSeek, Groq, OpenRouter, NVIDIA NIM.
- Built-in tools for file search/replace, bash execution, directory traversal, and web scraping.
- MCP (Model Context Protocol) integration for external tool servers.
- Three execution permission modes: `SAFE`, `AUTO-EDIT`, and `YOLO`.
- Checkpoints with Git-backed undo for rolling back bad agent changes.
