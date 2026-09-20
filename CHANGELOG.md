# Changelog

All notable changes to Andromity are tracked here. We follow semantic versioning.

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
- **Edge Worker Production Deployment**: Live Cloudflare D1 worker endpoints (`/ping`, `/event`) with zero-PII guarantees, strict rate limiting, and automated health checks.
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
