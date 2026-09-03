# Change Log

All notable changes to the "andromity" extension will be documented in this file.

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
