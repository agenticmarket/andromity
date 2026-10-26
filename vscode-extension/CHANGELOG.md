# Change Log

All notable changes to the "andromity" extension will be documented in this file.

## [0.2.24] — 2026-10-26

### Added
- **A quick check-in in the chat.** Now and then, after a reply that went well, the chat asks how Andromity is working for you. **Love it** offers a link to leave a review. **It's OK** and **Not great** ask what gets in the way most, with one-click choices and an optional note. Every step offers the review link. It replaces the rating notification, never appears after an error or during a scheduled run, is off in air-gap mode, and **Don't ask again** stops it. Your answer reaches the team without your telemetry ID.
- **Risk notes on command approvals.** The approval card lists in plain words what deserves a second look, such as deleting files recursively, downloading and running a script, force-pushing, running with elevated privileges, or reading secrets and sending data off the machine. Enter no longer approves a command flagged as destructive; click **Allow once** or press Ctrl+Y. Web fetches are flagged when the address carries a credential or a long block of data, or goes to a raw IP address.
- **A warning before a secret leaves your machine.** If a message looks like it contains an API key, token, private key or database password, Andromity holds it and offers **Redact and send**, **Send anyway** or **Edit message**. Messages to local Ollama models are not checked.
- **When a rate limit lifts.** Rate limit errors say when the limit resets, if the provider reports it, and lead with **Switch Model** when the wait is long.
- **High demand card.** When Andromity's shared models are at capacity, the card shows a plain explanation and the time they are expected back, with **Switch Model**, **Retry Turn** and **Use Your Own Key**, instead of the upstream provider's error. Expected-back times on error cards show as their own badge instead of running into the message.
- Suggested next steps have **See the exact request**, which shows the prompt **Do it** sends.
- **Remembered approvals in Settings.** **Trust & Security** lists the commands and web domains you chose to always allow, each with **Remove**. Before, they could only be removed by editing the config file.
- **Send feedback without leaving the editor.** The new **Andromity: Send Feedback** command opens a small box where you type a note. It goes straight to the Andromity team with your client, OS family and extension version, and is stored with the country Cloudflare reports for the connection. It is not linked to your telemetry ID, and your IP address isn't stored. If it can't be sent, you can copy it into a GitHub issue instead. It is turned off in air-gap mode.
- **Tips for features you haven't tried.** After a reply, a short "Did you know" card can introduce one feature that fits what the turn did, such as Fingerprint, commit messages, inline edit, cron jobs, test generation, fixing terminal errors, air-gap mode or MCP servers.
  - At most one tip a day, none during your first two sessions or on scheduled runs, and each tip shows at most twice.
  - A tip retires once you click it, hide it or use the feature. Which features you've used is kept on your machine, so this works with telemetry off.
  - Turn tips off from the card's menu or with the new `andromity.featureTips` setting.
- **Chapter rail in the plan tab.** A rail of section marks with previews runs beside the plan. Click a mark to jump to that section, or step through sections with Alt+Up and Alt+Down.

### Changed
- A call waiting for your approval shows **Needs approval** instead of **Running**, its timer stops, and it is no longer marked as stuck after 45 seconds.
- The approval card offers to remember a command only when the command can be remembered. Commands that use shell operators such as `&&` or `|`, and commands flagged as destructive, are approved one run at a time.
- **Run** on a chat code block first shows the whole command and asks, when the command hides text off screen, contains invisible characters, or would do lasting damage. It does nothing in a workspace VS Code doesn't trust.
- Approvals in `@andromity` chat show the full arguments and the same risk notes. Handing a task from Copilot to Andromity shows the whole task and the permission mode it will run in.
- Trusting a folder lists the MCP servers that folder's own config will start, with any passwords or keys in their arguments redacted, so you know which programs you are allowing.
- Short tables fit narrow side bars instead of scrolling sideways.
- The model badge says **Choose a model** when no model is selected, instead of naming one.
- **Statuses as text.** The session list, MCP servers and background runs show their status as a word instead of a dot, and running, starting and watching states shimmer. The open session is marked by its background only.
- Suggestions with several options show the question above the buttons.
- The side panel's MCP button opens the MCP tab in Settings.
- **Safer agent defaults.** The agent keeps secrets out of code, refuses system-wiping commands, doesn't work around blocked tools, and doesn't let instruction files widen its permissions. The builder and coder profiles work on `andromity/<topic>` branches, never commit to the default branch, and push or open pull requests only when you ask.
- Anonymous use of the Andromity provider is counted per install, with a random ID kept separate from your telemetry ID, instead of a shared default.

### Fixed
- Signing in or out updates the welcome screen's **Sign In** button and account state again. Since 0.2.12 the update stopped partway.
- A plan step with an unexpected status can no longer add markup to the Plan view, and links in the Plan view open only http and https addresses.
- Paths that start with a mix of forward and back slashes are treated as network shares and are not opened.
- Error cards match status codes as whole numbers. A rate limit whose reset time or request ID happened to contain "404" or "500" was shown as **Model Not Available** or a service outage.
- **Recent Sessions** no longer lists sessions that were opened in the terminal app and never used, and session lists count only the conversation, not the system prompt.
- The Waterfall's **Duration** total no longer drops to 0 when a turn finishes, is cancelled or fails.
- The Waterfall's inactive **Stream Log** and **Stats & Profiling** tabs no longer show as bright button blocks.
- Loading placeholders no longer clip the session title once it loads.

## [0.2.23] — 2026-10-24

### Changed
- **The model picker shows the model you're using.** Your current model is listed first under **Current** with an **Active** label, even when it is far down the list or no longer offered, and it comes first in search results. Only the model on your session's provider is marked, not every provider with the same model ID.
- **Every Andromity model is listed.** The Model Hub and the chat model picker show every model the Andromity provider offers, with its name, description, pricing and context window, instead of Auto alone. Picking a model that isn't available to you right now shows a clear message with **Sign In** or **Switch Model** instead of retrying.
- **Session panel on more screens.** The session panel appears from 1100px wide, docked beside a slightly narrower chat, instead of needing 1500px. That covers most laptop screens and a chat open next to your files. Narrower views show the chat only.
- The profile picker is called **Profile** everywhere: the session panel row, the prompt-bar button and the picker menu.
- The reasoning button is hidden when the selected model doesn't support reasoning, instead of showing a disabled control.
- No feature events are sent if the extension can't read your telemetry setting.

### Fixed
- Prompt-bar buttons stay clickable when other elements overlap them.
- The session title no longer cuts off the bottoms of letters like g, j and y.

## [0.2.22] — 2026-10-20

### Added
- **Session panel in wide windows.** When the chat is wide enough (a full editor tab), the empty space on the right shows **Context window** usage with **Compact now**, uncommitted **Changes** with line counts and **Review changes**, **MCP servers** with their status, and the **Environment** (folder, branch, model, mode, air-gap). Click a card header to collapse it to a one-line summary. Right-click the panel, or use its ⋯ button, to choose which cards show, or to expand or collapse them all. Hide the panel with the × and bring it back from the chat bar.
  - Drag a section's six-dot handle to change its position. With the handle focused, Up/Down moves it one place and Home/End moves it to the top/bottom. **Reset section order** restores the original order.
  - All sections start expanded. Their order, collapsed state, visibility and the panel's hide preference persist across chat tabs and VS Code reloads.
  - **Context** matches the Context window pop-up, with its Breakdown behind a toggle so the card stays short.
  - **Changes** shows file icons, folders, line counts and a small diff bar. A five-file preview links to the rest, and full paths remain available in tooltips and accessible labels.
  - **MCP servers** shows explicit running, sign-in, trust, starting, off and error states, plus the number of tools available from running servers.
  - **Environment** rows open their control: model, permission mode, working style and reasoning pickers, the branch switcher, the Explorer, and air-gap mode. They update as soon as you change any of them.
  - Only the panel scrolls, with soft edges instead of a scrollbar, and its header stays in place.
  - Works in pop-out session tabs too.
- **MCP icon in the bottom bar.** One click opens MCP settings; hover it to see how many servers are running.
- **Badge on the Andromity icon.** While the chat is hidden, finished replies and requests for your approval or an answer show as a count on the Andromity icon, wherever the view is placed. It clears when you open the chat.
- **Smart starter buttons.** On an empty chat, **Fix a problem** becomes **Fix 3 errors in auth.ts** when the open file (or your workspace) has errors, and **Add tests** becomes **Review my changes** when you have uncommitted files.
- **Copy chat as Markdown.** A button in the chat bar, and **Andromity: Copy Chat as Markdown**, copy your prompts and the replies, without tool output or attached editor context.
- **Air-gap mode.** Turning it on first shows what will stop for you, such as a cloud model or a reply in progress. Settings → Andromity → **Air-gap Mode**, or **Andromity: Air-gap Mode: Turn On or Off**. Andromity can then reach only this machine and private hosts you list, for example a shared model server.
  - Cloud models, web search, remote MCP servers, sign-in and telemetry turn off.
  - Commands the agent runs, and the code-block **Run** terminal, are blocked from the internet where possible.
  - A project can turn it on but only your user settings can turn it off, and `ANDROMITY_AIRGAP=1` locks it on.
  - A shield in the status bar and an **Air-gap** badge show it is on.
  - **Run self-test** checks each kind of outbound access without making a real connection.
  - For complete isolation, also use your firewall.
- **Edit and Duplicate on the Cron Jobs page.** Editing keeps the job's run history. Duplicating makes a paused copy.
- **Live schedule preview.** As you type, the form shows the schedule in words with the next five run times, and flags invalid schedules before you save.
- **Fuller job form.**
  - Permission mode (defaults to SAFE for new jobs), time limit, what happens when a run fails, when to notify you, and whether to catch up on missed runs.
  - Presets for weekdays and weekly schedules.
  - **Save and run now.**
  - Save errors stay in the form instead of clearing it.
- **More detail on job cards.**
  - The schedule in words.
  - The next run as a date and time.
  - The job's folder, time limit, failure and notify settings.
  - A count of jobs that need attention.
- **Fix buttons.** When a run fails or a job pauses itself, the card says why and offers a fix: **Open API keys**, **Trust this workspace** or **Edit job**.
- **Run history** shows **Needs attention**, **Skipped** and **Missed** runs, labels catch-up, manual and retry runs, and lists blocked tools.
- **Fix with Andromity.** When a command started from a code block's **Run** button fails, the button shows the exit code and a **Fix** button sends the command and its last output lines to the chat. Needs VS Code 1.93+ and a shell with shell integration; otherwise **Run** works as before.
- **Edit and resend.** Every message has an **Edit** button. Resending undoes that turn and everything after it, including file changes (you confirm first), then sends the edited message.
- **Background sessions in the status bar.** A session you are not looking at shows as a quiet count, `Andromity · 1`. Hover for what it is doing; click to open it. The session in view no longer changes the status bar.
- **"Needs you" notifications.** When a background session, or the current one while the chat is hidden or VS Code is in the background, needs approval or asks a question, a notification with **Open** appears.
- **Queue and steer hints.** While the agent works, the prompt box says Enter queues a follow-up and Ctrl+Enter steers. The send button stays next to Stop once you type.
- **More commands in the Command Palette.** Switch Model, Switch Permission Mode, Switch Agent Profile, Open Model Hub, Open Cron Jobs, Sign In, Sign Out, Undo Last Turn, Show Sessions History and Compact Session Context.
- **Permission mode descriptions** in Settings, with a warning on YOLO.
- **Run button on shell code blocks.** Bash, sh, zsh, PowerShell and CMD blocks in chat have a **Run** button. It opens a new terminal in your workspace and runs the command. PowerShell blocks open in PowerShell and CMD blocks in `cmd.exe` when your default terminal is a different shell. Leading `$ ` and `PS>` prompts are removed.

### Changed
- **Notifications.** Scheduled runs notify you only when a run fails, times out, is skipped or needs attention. Choose **After every run** or **Never** per job.
- **Notification buttons.** Each notification offers **Open Session** and **Open Cron Jobs**.

### Fixed
- A run that hit a provider error, or ended with the agent asking a question, no longer shows as **Succeeded**.
- A job no longer runs twice at once, or in the VS Code install folder when no folder is open.
- **Open session** on a run shows the whole run, not just the prompt.
- **Live progress.** A scheduled run opened while it is running now updates live and leaves the Working state when it ends, whatever the outcome. **Stop** cancels it.
- **Scheduled run notice.** A note above the message box names the job and the permission mode it ran in. While the run is going, the note says you can continue the chat when it finishes, and a message sent meanwhile gets that explanation instead of a generic failure.
- **Quiet background runs.** Scheduled runs no longer open the Waterfall panel, play the done sound or show a "Parallel task completed" message. Their cron notification covers that.
- Chats that stopped mid-reply because VS Code was closed or the engine restarted no longer spin forever in the sessions list. They show an **Interrupted** badge; hover it for what happened, and send a message to continue.
- **Approval keyboard.** Enter or Space on a focused option (such as **Deny**) now picks that option instead of approving. Esc closes an open menu or palette without denying the pending tool.
- **Saving an empty API key** no longer deletes the stored key.
- **Deleting a session** from the trash icon and **removing a custom provider** now ask first.
- **Prompt history.** ArrowDown inside a recalled multi-line prompt moves the cursor instead of replacing your edits.
- **Failed sends** show the error once in the chat, without a raw error toast.
- **Fingerprint** says when it couldn't load a session and offers **Retry**, instead of showing "No activity yet".
- **Changes Review refreshes itself.** Edits you save, the agent's edits during a turn, commits, checkouts and other tools now update the panel within about half a second. It waits while hidden and catches up when shown, keeps the open diff and scroll position, and says when the file you were reading no longer has changes.
- **Light themes.** Borders, dividers and hover backgrounds in the chat, Settings, Waterfall, Plan, Changes Review and background task views no longer disappear on light themes, and status colors are readable on white. High-contrast rules now apply.
- **Keyboard.** Tool, thinking and tool-group cards, session rows, Settings chips, skill cards and tags, and Waterfall rows can be reached with Tab and opened with Enter or Space. Copy, Insert and session buttons appear when focused, not only on hover.
- **Screen readers.** A streaming reply is read once when it finishes, and the `/` and `@` menus announce the highlighted option.

## [0.2.21] — 2026-10-18

### Added
- **15 more apps in Discover**, for 65 in total: Context7, Tavily, Firecrawl, CircleCI, Heroku, Pulumi, PlanetScale, ClickHouse, Clerk, WorkOS, LaunchDarkly, Better Stack, Ahrefs, Make and Calendly. CircleCI, PlanetScale, ClickHouse, Pulumi, Clerk, Make, Calendly and Better Stack show their brand icons.
- **AI disclosure on posts.** Text the agent posts for you through app connectors or `gh` (comments, descriptions, messages, wiki pages) ends with "Written by Andromity, an AI agent, on behalf of the user who posted this."
- **`andromity.includeAssistedBy`** (off by default) adds `Assisted-by: Andromity/<version> (<provider>/<model>)` to commits the agent makes.
- **Rate and share.** **Andromity: Rate & Review Andromity** opens the review page (VS Code Marketplace, or Open VSX in Cursor, Windsurf and VSCodium). **Andromity: Share Andromity with Developers** copies a link or opens a post on X or LinkedIn. Regular users see one notification asking for a rating after a few days of use, and a later one about sharing. Each has **Don't Ask Again**, comes at most once a day and stops after a few dismissals.

### Changed
- The extension is now listed as "Andromity: Free AI Coding Agent for VS Code", with a description and search keywords that say it is free and open source and an alternative to Cline, Kilo Code, Claude Code and Cursor. It also names the models you can use with it: DeepSeek V4, GLM 5.3, Kimi K3, Qwen, Claude Opus 5.5, GPT-6, Gemini 4 and Grok.
- The "Enjoying Andromity?" notification that appeared after your third finished turn is gone.

## [0.2.20] — 2026-10-15

### Added
- **App connectors.** The MCP Servers page has two views. **Discover** lists 50 official app servers (Notion, Linear, Gmail, Stripe, Sentry and more) with their brand icons, grouped by category and searchable; **Connect** opens a browser sign-in. **Yours** lists the servers you've added. Icons come from Simple Icons (CC0) and are bundled, so nothing is fetched from the internet. Gmail, Calendar and Drive ask for your Google OAuth client ID and secret in VS Code input boxes, not in the webview.
- **Token connectors.** GitHub, Airtable, Render and PagerDuty connect with an access token entered in a VS Code input box. Andromity checks the token with the app before saving it and keeps it in the encrypted token store.
- **Google connectors.** Gmail, Google Calendar and Google Drive ask for your own Google OAuth client ID and secret, with the setup steps and a link to Google's guide.
- **Setup guides.** Each app with a guide on andromity.agenticmarket.dev/integrations has a **Setup guide** link on its Discover tile.

## [0.2.19] — 2026-10-15

### Added
- **Turn rail.** When the chat panel is wide enough, a tick for each prompt appears in the left gutter. Hover shows a preview of the turn (prompt, start of the reply, time, duration, tools and files). Click jumps to it, and Alt+Up/Down steps through turns. It hides itself in narrow panels such as the sidebar.
- **Context window breakdown.** The context popover expands to show what fills the window: system prompt, tool definitions, MCP and deferred tools, skills, compacted summary, your messages, replies, tool calls and tool results. It also shows free space, the auto-compact buffer and how many tokens remain until auto-compaction, with a **Compact now** button. The popover follows the VS Code theme.
- **Cron Jobs page redesign.**
  - Each job shows its next run, last run with date and outcome, model and provider, permission mode, allowed commands and last error.
  - A live **Running** state appears while a job runs, and a summary line shows how many jobs are active and which runs next.
  - Run history shows the success count and average duration, with expandable output and links to each run's session.
- **Fingerprint redesign.**
  - Turns read top to bottom, with actions in order, and the view fits on screen when it opens.
  - Repeated reads and a turn's searches collapse into one card, and paths are shown relative to the workspace.
  - The turn list shows each prompt with its time, duration and status.
  - The inspector lists every call, collapses long output and labels it as tool output.
  - Cards you drag stay where you put them across refreshes, and the panel works in light themes.
- Every Settings tab now links to its documentation page: Model Hub, API keys and custom providers, skills, MCP servers, folder trust, preferences and personalisation.
- Anonymous feature-usage events for commands, chat actions, Hub sections, `@andromity`, inline edit and session tabs. Each event is a feature name only; turn telemetry off with `andromity.telemetry` or VS Code's telemetry setting.

### Fixed
- Provider error cards (for example "credit balance is too low") showed as raw HTML. They render as cards again, rebuilt from their text with only the existing safe actions, so model output still cannot inject markup.
- The Waterfall **TOKENS** total stayed at 0 for live sessions.
- The context indicator showed 0 used tokens for new sessions, after compaction, and with providers that report no usage. It now shows an estimate marked `~`, and switching model updates the window size immediately.
- After compaction, by hand or automatic, the token count kept its old value until the next reply. It now updates as soon as compaction finishes, to an estimate marked `~`, until the next reply reports the real size. Updates that don't include a cost no longer reset the cost to $0.0000.
- After reopening VS Code or reloading a session, background processes that had finished showed **RUNNING (BG)** forever. A card now shows RUNNING only while the engine still runs the process. Otherwise it shows ENDED, DONE or FAILED. An exit event for one process no longer marks other processes as stopped, and a command that fails at once shows FAILED.
- Cron Jobs:
  - **Show Session** no longer opens the session twice.
  - A job created with a model from another provider no longer saves the wrong provider.
  - Run counts on the card and in the history now agree.
  - **Last run** includes the date.
  - The page updates live when a run starts and finishes.
- Fingerprint:
  - **Agent time:** shows time spent on turns, not how long ago the session was created.
  - **Files changed / read:** count unique files.
  - **Searches and commands:** searches and plan updates are no longer counted as file reads, and reading a process's output no longer counts as a command.
  - **Turns:** messages sent while a turn runs no longer count as separate turns, and IDE context is removed from turn titles. Turns from before a context compaction are kept.
  - **Subagents:** subagents sharing a role are no longer mixed up.
  - **Sensitive files:** "AirGap Sentinel / 0 Leaks" is replaced by a sensitive-files count that uses Andromity's own sensitive-path rules and says whether access was blocked.
  - **Refresh:** the panel refreshes at most every 0.75 s and never while hidden.
  - **Export:** saves to the workspace folder.
- If `config.toml` can't be read, VS Code now says so once, with the error, where Andromity kept a copy of the file (with your API keys), and **Open Saved Copy** / **Open config.toml** buttons. Before, settings and keys silently reset to defaults.
- `andromity.ollamaHost` only changed where the extension checked for Ollama; the engine kept using `config.toml`. Setting it now updates the engine's Ollama address too, and the status check uses the engine's address when the setting is unset. It can only be set in user settings, so a repository can't redirect Ollama traffic.
- Typing `@` with no skills installed listed four made-up skills (browser, terminal, editor, git) that did nothing. It now says no skills are installed and offers **Browse skills**. The **Browse Hub** button on the `/skills` card also works in session tabs now.
- The model picker, Model Hub and OpenRouter card no longer claim a fixed "396+" model count.
- Settings:
  - **Restart Engine** in About & Diagnostics did nothing. It now restarts the engine.
  - **Max Parallel Subagents** saved a value the engine never read. It now sets the limit subagents actually use, and shows the real default, 5.
  - **Startup Session Restoration** labelled Last Session as the default; the default is Fresh Session.
- Telemetry accuracy:
  - Hub tab visits counted tabs opened by commands.
  - **Hub opened** was counted again on every reconnect.
  - **Turn undone** was recorded even when the undo failed.
  - An unused wallpaper event was removed.

### Changed
- `andromity.defaultProvider`, `andromity.defaultModel`, `andromity.defaultProfile` and `andromity.reasoningEffort` are marked deprecated. They never had an effect; VS Code now strikes them through and points to the Model Hub and Preferences, where these are set.
- The `andromity.telemetry` description and the README describe the feature-usage events.
- The permission-mode and profile menus, Waterfall, Fingerprint and the Cron Jobs page link to new documentation on the website.
- The Hub's permission-mode table now describes what each mode actually does: TRUST runs allowlisted commands without asking, and YOLO behaves like FULL in VS Code. The Waterfall Guide shows the correct colours (tools blue, subagents green), and its Duration tooltip no longer calls the sum of turn times "wall-clock".

## [0.2.18] — 2026-10-13

### Security
- Opening a folder no longer runs Python from it: workspace virtualenvs, the Python extension's interpreter and `src/` packages are used only in trusted workspaces, interpreter probes run outside the workspace, and the daemon starts with `-P` so the workspace is never on its import path.
- `andromity.pythonPath`, `serverPort`, `ollamaHost`, `permissionMode`, `includeCoAuthor` and the wallpaper ripple setting are ignored when set by an untrusted workspace. Python paths on network shares are refused.
- TCP daemon mode authenticates with the daemon token.
- Enabling Andromity's file and shell access for a folder requires VS Code workspace trust and a confirmation, and only applies to the open folder. Switching to FULL or YOLO always asks first, including from Settings and session tabs, and a single prompt can no longer raise the permission mode.
- Settings and chat can only change a fixed set of configuration keys, with validated values. Starting MCP servers requires workspace trust.
- The background task tab has a strict Content Security Policy and escapes the command it shows. Waterfall and plan views render model output with the same rules as chat: HTML as text, safe links only, remote images as links.
- Values embedded in webview scripts are escaped so they cannot close the script element. Webview nonces come from a secure random source, and Google Fonts are no longer loaded.
- Links in chat to network paths are refused, and files outside the workspace open only after confirmation.

### Performance
- The chat panel appears about 3 s sooner on Windows. Model listing no longer waits on Ollama's connection timeout (the daemon pins `localhost` to the address that answers), and Ollama detection runs after the chat is shown.
- Startup loads chat state once instead of up to four times. Settings data is prefetched after startup settles, and the daemon defers its provider-library import until the first requests are answered.
- Streaming replies render at most once per frame and re-parse only the unfinished part of the message, so long answers no longer slow down as they grow. Tool arguments and thinking text append without re-processing.
- The workspace file index used for clickable paths is built asynchronously and cached.
- The status bar and context keys update when a turn starts or stops, not on every token. Editor-context updates skip hidden views and other files' diagnostics.
- A daemon that crashes on startup now backs off and stops after five attempts instead of restarting every 2 seconds. Process shutdown no longer blocks the editor.
- The packaged extension is minified, and background task tabs poll only while visible.

### Added
- `@andromity` in VS Code's native chat (VS Code 1.95+). Replies stream into the chat, tool approvals and clarifying questions appear as buttons, `/explain`, `/fix` and `/tests` shortcuts are available, and follow-ups in the same chat thread continue the same Andromity session.
- An **Andromity Agent** tool (`#andromity`) that Copilot agent mode can use to hand a task to Andromity. You confirm each delegation, and Andromity's own permission mode still applies.
- **Edit with AI** (Ctrl+I / Cmd+I, or the editor context menu): describe a change to the selection or current line. Andromity applies it in place and highlights it, with Accept (Ctrl+Enter), Reject (Esc) and Compare above the edit. Ctrl+I stays with another inline-chat extension (such as Copilot) when one is installed.
- Ollama setup states in the Hub: show when the server is unavailable, offer Start Ollama for an installed but stopped server, and provide installation and official setup documentation links.
- Running Ollama servers with no installed models show a download action and a Check again button.
- Connecting and reasoning activity animations, with a steady assistant header while response text streams.
- File and folder targets beside existing tool names in live activity, restored sessions, and history. Technical tool identifiers remain unchanged.

### Changed
- Improve Markdown readability with clearer heading and paragraph spacing, quieter inline code and file links, and better table padding and alignment. Wide tables remain horizontally scrollable.
- Simplify permission and working-style menus, improve keyboard navigation, and keep the permissions popup above chat content with a more compact layout.
- Explain when permission changes apply from the next turn, including when eligible pending approvals may proceed immediately. Menu descriptions reflect workspace trust, profile restrictions, and the shared Full/YOLO approval rules.

### Fixed
- Ollama model selection shows only installed models verified against the running server, blocks stale catalog selections, and no longer marks an offline provider as active.
- Ollama onboarding cannot activate a model before one is installed. Installation and documentation links remain available when the agent service is disconnected.

## [0.2.17] — 2026-10-09

### Security
- File write and edit approvals show the lines being removed and added in a compact, scrollable box. `write_file` and multi-edit calls are recognised as file changes instead of showing "Execute" with raw parameters.
- The sign-in token is only sent to AgenticMarket hosts configured in user settings; workspace settings can no longer redirect it.
- Sign-in links must be started from this editor, and callback tokens are no longer written to the output log.
- Chat renders model-supplied HTML as text and shows remote images as links.
- Session collaboration and edits to execution-control files (`.git/`, `.vscode/`, `package.json`, …) follow stricter trust and approval rules.

### Fixed
- Collaborator badges, per-session renames, and inbox items for sessions that are not on screen.
- Clicking an edit row in chat no longer opens the review twice.
- Edits that fail show "Edit failed" instead of "Edited" and are left out of the turn's changed files; multi-edits that only partly apply show "Partly edited".
- Opening review from an older edit row uses that turn's files instead of the latest turn's.
- Generated commit messages still credit Andromity when they already credit another co-author.

### Changed
- `andromity.includeCoAuthor` also applies to commits the agent creates.

## [0.2.16] — 2026-10-07

### Fixed
- Preserve LiteLLM proxy runtime dependencies in bundled daemon binaries to fix missing-module errors on Linux.
- Prune bundled proxy web chunks and test certificates to resolve VS Code Marketplace validation errors.
- Exclude duplicate binary variants and stray certificate keys from the extension package.
- Verify AgenticMarket account sessions before reporting successful sign-in and clear rejected credentials.

### Added
- Automated provider runtime verification (`--check-runtime`) during binary builds and CI release workflows.
- Permanent packaging and binary bundle cleanliness test suites.

## [0.2.15] - 2026-10-06

### Added
- Show a three-dot activity wave in the composer and latest-message button while the agent is working.
- Refresh the chat welcome screen with task cards, clearer conversation spacing, a compact theme-aware composer, and visible keyboard focus.
- Put API key and Ollama setup first, with one cloud trial action and one sign-in button below as alternatives.
- Clarify the cloud account panel with an allowance bar, local reset times, blocked and unavailable states, and a clear separation from BYOK usage.
- Add, remove, enable, disable, restart, and authenticate MCP servers from the Hub.
- Remove installed skills from the Hub, targeting the selected installation.
- Inspect connected MCP tools in a collapsible list of names and descriptions.

### Fixed
- Exclude temporary session-cache copies from packaged extensions.
- Preserve small manual scrolls and timeline navigation in idle sessions, and use full turn heights so opening sessions and jumping to latest reach the entire conversation.
- Keep chat pinned to the latest message through permission-card layout changes, and stop delayed session scrolling from overriding manual scrolling or a newer session.
- Pause auto-follow during manual scroll gestures and resume at the actual bottom, avoiding jumps when browsing between turns near the latest message.
- Distinguish manual and automatic Waterfall usage, record cancellation requests separately from completion, and avoid duplicate error telemetry.
- Hide automatically attached IDE context from queue previews, session titles, and live/restored Waterfall labels and tooltips while retaining it for the agent.
- Automatically start enabled MCP servers on daemon connection and reconnection, refresh their live status, and notify users when authentication, trust, or retry is needed.
- Show Re-authenticate after connecting and wrap long MCP URLs within responsive cards.
- Allow enough time for remote MCP startup rather than caching an empty list after a short timeout.

Versions 0.2.13 and 0.2.14 were urgent releases and do not have separate changelog entries.

## [0.2.12] - 2026-09-30

### Added & Improved
- **🔄 Unified Cross-View Authentication & Quotas:**
  - **Editor Tab Secrets Sync:** Synchronized AgenticMarket credentials and live usage quotas across both sidebar and editor-tab views.
  - **Multi-Panel Event Broadcast:** Login, logout, and quota updates instantly broadcast across all active session webviews.
- **📐 Responsive Interactive Card Bounds:**
  - **Prompt-Aligned Modals:** Constrained `#interactive-slot`, permission approval cards, and clarifying question carousels to match the exact bounds of the prompt composer across wide editor layouts.
- **🌿 Multi-Root Git Commit Generation:**
  - **Context-Aware SCM Commit:** Directly targets active workspace repositories and isolates staged vs. unstaged diffs cleanly.
- **🛡️ Error Recovery & Quota Clarity:**
  - **UTC Daily Reset Badges:** Live countdown indicators for daily token quotas.
  - **Sanitized Error Reporting:** Eliminated raw provider rate-limit traces in favor of actionable UI cards.

## [0.2.11] - 2026-09-25

### Added & Improved
- **🌊 Live Waterfall Execution Profiler:**
  - **Auto-Open Waterfall:** New `andromity.waterfall.autoOpen` setting that automatically opens and docks the Live Execution Waterfall panel when multi-step reasoning or subagents start executing.
  - **Smooth Span Synchronization:** Eliminated timeline jitter during concurrent tool calls, ensuring live durations and status codes stream smoothly without dropped spans.
- **🤝 Multi-Agent & Session Collaboration:**
  - **Collaborative Session Inbox:** Added dedicated Session Inbox in the webview to read, inspect, and answer incoming messages and mailbox events across concurrent agent sessions.
  - **Session Watch & Auto-Awake:** Background sessions can enter `watching` mode and automatically awaken when another agent posts an answer or file handoff.
  - **Inline Permission Cards:** Clarifying questions render inline using the `permission-card` aesthetic with custom radio options for fluid pair-programming.
- **🎨 Session UI & Chat Experience:**
  - **Stepped Reasoning Popover:** Minimal, stepped slider popover (`Off`, `Low`, `Medium`, `High`) for reasoning effort without distracting header clutter.
  - **Cursor-Parity File Pills:** Automatic stripping of raw ambient context blocks with clean, interactive file pills and diagnostics badges.
  - **Intelligent Auto-Scroll:** Preserves user scroll position when reviewing message history while maintaining automatic scroll-to-bottom for live incoming tokens.
  - **Post-Response Meta Footer:** Sleek turn duration badge (`3.2s`), humanized relative timestamps (`now`, `2m ago`), and one-click copy actions.
  - **Enhanced Activity Rows:** Activity rows now feature dedicated diff preview buttons, addition/deletion line statistics, and expandable output previews.
- **🤖 Git Co-Authoring:**
  - **Automatic Co-Author Attribution:** Automatically attaches `Co-authored-by: andromity-bot <bot@agenticmarket.dev>` in Git commit trailers generated by the agent for complete transparency in team repositories.
- **🛡️ Telemetry & System Resilience:**
  - **Session UUID Joining Fix:** Fixed regex false positive in key scrubber that incorrectly masked UUID session IDs, restoring event-to-session database linkages.
  - **Real Tool Call Tracking:** Repaired telemetry counters for `shell_exec`, `shell_bg`, `find_files`, and `edit_file_multi`, ensuring terminal runs and multi-file edits reflect accurately in developer analytics.
  - **Cumulative Multi-Turn Metrics:** Bound tool counters directly to session state so multi-turn sessions accumulate real tool operations instead of resetting to 0.

## [0.2.10] - 2026-09-20

### Added & Improved
- **🎨 UI & Chat Redesign:**
  - **Clean Minimal Theme:** Complete overhaul of errors, onboarding, commands, and skills views for a sleek, distraction-free experience.
  - **Neutral Markdown Typography:** High-contrast markdown rendering with clean list and blockquote spacing.
  - **Borderless Inline Prompt Controls:** Replaced bordered inputs with borderless inline controls matching Cursor/Codex style; drag-drop removed from prompt bar.
- **🛡️ Error Recovery & Resilience:**
  - **Resilient Error Cards:** Polished error cards with one-click retry to re-execute the previous agent turn without losing context.
  - **Vision Model Guarding:** Automatic content-type guards preventing vision payloads from reaching text-only models.
  - **Transient 5xx Auto-Retry:** Transparent exponential-backoff retries on transient server-side errors.
- **🌐 Web Search & Security:**
  - **Zero-API Resilient Web Search:** Web search cascades across multiple providers with no single-point-of-failure API dependency.
  - **Safe Skill Read Roots:** Skill file reads restricted to declared safe root directories, preventing unauthorized traversal.
- **📎 File Context & Attachments:**
  - **Cursor-Parity File Pills:** File context attachments display as compact clickable pills, openable directly in the editor.
  - **Drag-and-Drop Context:** Drag files from the VS Code explorer into the chat to attach them as context.
  - **Ollama Auto-Connect:** Detected local Ollama models are automatically registered in the model catalog on startup.
- **⏰ Cron & Scheduling:**
  - **Exact Date, Time & Cron Syntax:** Full scheduling support for exact dates, exact times, and raw cron expressions from the cron overlay.
  - **Running Status Sync:** Fixed cron job status desync across split editor panels.
  - **Cron Preset Deletion:** Allow deleting saved cron presets directly from the scheduling overlay.
- **🧩 IDE Improvements:**
  - **Secondary Sidebar Support:** Extension panel can be pinned to the secondary sidebar for a wider layout.
  - **Terminal Error Quickfix:** Inline quickfix action surfaces for detected terminal errors to let the agent auto-fix in one click.
  - **Ambient IDE Context Injection:** Workspace context (open files, cursor positions, diagnostics) automatically included in agent prompts.
  - **Tool & Plan Approval Routing:** Correctly routes tool execution and plan approval prompts from editor-tab session panels.
  - **Diff Line Stats:** Changed file cards display accurate `+additions / -deletions` line statistics.

## [0.2.9] - 2026-09-13

### Added & Improved
- **🐾 Pixel Mascot Companion & Interactive Pet:**
  - **Playful Pixel Pet (`ChatViewProvider`):** Added idle roaming across the webview, edge peeking animations, and priority interrupts when active tasks begin.
  - **Sticky Tool-Flank Docking:** Mascot docks dynamically alongside running tools with real-time checklist status indicators.
- **🎨 UI Improvements & Webview Polishing:**
  - **Enhanced Activity Rows:** High-contrast, theme-adaptive cards with live execution badges and fluid state animations.
  - **Settings Diagnostics Fast-Path:** Instant pre-warmed diagnostics rendering (<1ms) in Andromity Hub, avoiding loading flashes.
  - **Refined Theme Styling:** WCAG-compliant focus rings, polished scrollbars, and seamless integration with light and dark themes.
- **🌊 Waterfall Live Trace Sync & Profiler Stability:**
  - **Live Mid-Turn Sync:** Prevented split turns by holding live trace events in queue until the baseline history payload is fully established.
  - **Race Condition Resolution:** Eliminated duplicate spans and timeline jitter during concurrent subagent tool invocations.
  - **Ripgrep Cascading:** Sub-millisecond workspace search performance across multi-project workspaces.

## [0.2.8] - 2026-09-07

### Added & Improved
- **🌊 Waterfall Live Execution Trace & Profiler:**
  - **Visual Timeline Profiler (`WaterfallPanel`):** Real-time execution waterfall mapping reasoning phases, tool invocations (terminal commands, file edits/reads, web search, MCP calls), and subagent lifecycles across a chronological timeline grid.
  - **Trace Buffer & Latency Inspection:** Inspect exact duration, execution timing, status codes, and input/output parameters per span directly inside a dedicated editor panel.
  - **Quick Header Access & Slash Command:** Launch the waterfall view anytime using the 🌊 Waterfall icon in the chat header, the `/waterfall` slash command, or the `Andromity: Open Live Execution Waterfall` command.
  - **First-Session Onboarding Callout:** Introduces new developers to live visual execution tracing with an interactive, dismissible callout popover.
- **Personalisation & Ambient Wallpaper Engine:** Added dedicated personalisation controls in Settings with on/off toggles, `/personalisation` and `/wallpaper` slash commands, custom aura intensity, and live particle background modes.
- **Accessible & Aesthetic Focus Rings:** Replaced heavy focus outlines with sleek, accessible focus-visible styles that harmoniously integrate with VS Code workbench themes.
- **CJK IME Composition Protection:** Fixed enter-key submission issues during East Asian IME input composition (Japanese, Chinese, Korean), preventing accidental message firing.
- **WCAG 2.1 Contrast & Accessibility:** Elevated link contrast ratios, keyboard navigation rings, and ARIA role labeling across all webview elements.
- **Real-Time Telemetry Sync & Strict Opt-Out:** Synced VS Code's global telemetry settings directly to the daemon in real time, automatically injecting `DO_NOT_TRACK=1` and `ANDROMITY_NO_TELEMETRY=1` on opt-out.
- **Global CDN Asset Migration:** Replaced local walkthrough image paths with ultra-fast CDN URLs (`https://cdn.agenticmarket.dev/andromity/git/`), ensuring reliable rendering on the VS Code Marketplace and Open VSX.
- **Untrusted Workspace Support:** Declared limited untrusted workspace support for secure, sandboxed editing.

## [0.2.7] - 2026-09-05

### Added & Improved
- **Native VS Code Diff Integration (`git.openChange`):** Clicking files in the changed files list now delegates directly to VS Code's native Git diff viewer (`<file> (Working Tree)`), matching VS Code Source Control panel behavior.
- **Staged File Diff Support:** Resolved issue where newly staged files without a `HEAD` commit showed an empty left pane; now seamlessly retrieves the staged baseline from the Git Index.
- **Refined File Badges & Card Depth:** Removed bulky pill backgrounds and borders around file extensions in changed file cards in favor of clean, syntax-colored monospace labels and subtle modern elevation.
- **Daemon Git Performance:** Optimized git status queries to avoid disk saturation when working inside large repositories.

## [0.2.6] - 2026-09-04

### Added & Improved
- **Platform-Specific Binaries & Slim VSIX:** Included standalone binaries for `win32-x64`, `linux-x64`, and `darwin-arm64` (Apple Silicon) built and packaged independently for each platform, eliminating Python/pip installation requirements on Linux and macOS.
- **CI Automated Packaging:** Integrated multi-platform GitHub Actions build matrix with automated package generation.

## [0.2.5] - 2026-09-03

### Added & Improved
- **Minimalist Running Arc Indicator:** Replaced bulky `RUNNING` text pills and jittery zoom-scale animations with a smooth, minimalist circular arc SVG spinner next to session and subagent titles.
- **Hierarchical Sessions & Subsessions Tree:** Organized the sessions flyout and sidebar tree into an intuitive tree view with expandable/collapsible toggles (`[ ▾ {count} subtasks ]`), child indentation, and branch connectors (`└─`, `├─`).
- **Active Session Indicator:** Replaced raw unicode star with a sleek glowing active indicator dot.
- **Smart Expansion & Search:** Searching sessions filters across both parent sessions and child subagent tasks, automatically expanding matching parent nodes.
- **VS Code Activity Bar Tree Parity:** Enhanced `SessionTreeProvider` to mirror the hierarchical session/subsession tree directly in the VS Code sidebar.
- **Multi-Session Parallel Tabs:** Enabled simultaneous sessions across independent VS Code editor tabs without event crosstalk or reconnection collisions.
- **Timeline Polish:** Aligned conversation timeline styling with clean card design standards, eliminating excessive glow and gradients.
- **Optimized Extension Package:** Cut VSIX package size by ~42 MB by removing duplicate binaries and redundant root assets.

## [0.2.4] - 2026-08-30

### Improved
- **Telemetry Ingestion:** Integrated lightweight, zero-PII telemetry tracking with Cloudflare D1.
- **Platform Detection:** Added OS and client version breakdown telemetry.

## [0.2.3] - 2026-08-31

### Added
- **Interactive Live Plans:** Step-by-step agent task execution plan preview and inline step approval.
- **Side-by-Side Diff Review:** Inspect and accept/reject diffs directly in VS Code.
- **Rollback & Undo Turn:** One-click rollback for file changes made in previous agent turns.
- **Model Hub (396+ Models):** Support for Claude 3.7 / 3.5 Sonnet, GPT-4o, Gemini 2.5, DeepSeek-V3 / R1, Groq, and local Ollama models.
- **Trust Governance:** Granular permission modes (`SAFE`, `TRUST`, `FULL`, `YOLO`).
- **Agent Profiles:** Switch seamlessly between `Builder`, `Coder`, `Reviewer`, and `Planner`.
- **Background Cron Scheduler:** Schedule recurrent autonomous tasks directly from VS Code.
- **AI Git Commit Messages:** Auto-generate commit messages from staged changes in Source Control.
- **MCP (Model Context Protocol):** Native integration for MCP tool servers configured via `mcp.json`.
- **Right-Click Context Menu Actions:** Ask about selection, explain code, fix diagnostics, and generate unit tests.
- **Audio Feedback:** Optional sound cues on turn completion and approval requests.
