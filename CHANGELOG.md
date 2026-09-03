# Changelog

All notable changes to Andromity are tracked here. We follow semantic versioning.

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
- **Cloudflare D1 & Worker Redesign**: Modernized telemetry ingestion architecture with Cloudflare D1 SQL storage, automated rate limiting, and zero-PII security guarantees.
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
- **Zero-PII anonymous metrics**: The optional telemetry ping only sends OS name, version, and model provider distribution. No file names, no code contents, no prompt data.

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
