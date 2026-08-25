# Contributing to Andromity

Bug reports and honest feedback first. Feature requests second. If you're not sure whether something is a bug or intended behavior, open an issue and ask.

For large changes, open an issue before writing code. Saves everyone time.

---

## Dev setup

```bash
git clone https://github.com/agenticmarket/andromity
cd andromity
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -e ".[dev]"
andromity
```

Changes to source files take effect immediately — no reinstall needed.

**Ubuntu/Debian:** A venv is required. PEP 668 protects the system Python on these distros. The commands above handle it.

**Run tests:**
```bash
pytest tests
```

---

## Project layout

```text
src/andromity/
├── cli.py                  # Entry points: `andromity` and `andromity run`
├── config.py               # Config loading, trust management, key storage
├── telemetry.py            # Anonymous first-launch & session telemetry
├── assets/
│   └── sounds/             # Bundled .wav notification sounds
│
├── core/                   # Everything the agent actually does
│   ├── agent.py            # Main execution loop, streaming, tool dispatch
│   ├── audio.py            # Cross-platform sound (platform-specific backends)
│   ├── context_menu.py     # OS context menu & file manager integrations
│   ├── cron.py             # Per-project background cron scheduler & run persistence
│   ├── debug_log.py        # Rotating file debug logging
│   ├── events.py           # Stream event dataclasses & delta types
│   ├── export.py           # Session export (Markdown, JSON, HTML)
│   ├── git_ops.py          # Git snapshots before writes, undo/rollback
│   ├── images.py           # Image handling & vision model payloads
│   ├── lore.py             # Developer tips, announcements & lore directives
│   ├── mcp.py              # MCP server manager & lazy tool loading
│   ├── models.py           # Model catalog, context limits, Ollama helpers
│   ├── oauth.py            # OAuth authentication flows for cloud providers
│   ├── planner.py          # Plan generation, step tracking, approval flow
│   ├── pricing.py          # Cost calculations and model price tables
│   ├── profiles.py         # Profile definitions, system prompt assembly
│   ├── provider.py         # LiteLLM wrapper, model switching, key injection
│   ├── search.py           # Fast regex / symbol searching
│   ├── security.py         # Path traversal checks, shell safety guards
│   ├── session.py          # Session persistence, token tracking, compaction
│   ├── skills.py           # Skill discovery, markdown parsing, execution
│   ├── todo.py             # Todo item data model and progress calculation
│   ├── tools.py            # Tool implementations — read, write, edit, shell, search
│   ├── updater.py          # Version checking and auto-update routines
│   ├── usage.py            # Spend analytics and token accounting
│   ├── usage_tracker.py    # Per-turn usage statistics and session metrics
│   └── web.py              # Web search, URL fetch → markdown
│
└── tui/                    # Textual-based interactive UI
    ├── app.py              # Root Textual app, keybindings, event routing
    ├── command_palette.py  # Quick action command palette (`Ctrl+P`)
    ├── footer.py           # Input bar, status bar, mode indicators, badges
    ├── markup_utils.py     # Textual styling and escaping utilities
    ├── patches.py          # Terminal rendering patches & workarounds
    ├── skill_mentions.py   # Inline `@skill` auto-complete popups
    │
    ├── panels/
    │   ├── chat.py         # Message history, markdown rendering, tool call display
    │   ├── diff.py         # Side-by-side diff view, file approval dialogs
    │   ├── filetree.py     # Interactive project file explorer
    │   └── plan.py         # Live plan tracker, step todo list
    │
    └── overlays/
        ├── batch_review.py # Multi-file diff review modal
        ├── cron.py         # Background cron task manager modal (`/cron`)
        ├── help.py         # Keybinding & command help modal (`?`, `/help`)
        ├── model.py        # Model picker overlay (`Ctrl+L`)
        ├── profile.py      # Profile picker overlay (`Ctrl+J`)
        ├── questions.py    # Multi-choice question answering modal
        ├── session.py      # Session browser and switcher overlay
        ├── settings.py     # Settings UI (model, profile, MCP, advanced, telemetry)
        ├── skills.py       # Skills manager and installer modal
        ├── trust.py        # Folder trust prompt overlay on untrusted repos
        └── undo.py         # Revert turn confirmation modal
```

---

## Architecture notes

### Trust before permissions

Trust is enforced at the folder level, resolved before any tool call reaches permission checking. The flow is:

```
tool call requested
  → is folder trusted?
      no  → block, regardless of permission mode
      yes → check permission mode (SAFE / TRUST / FULL / YOLO)
               → prompt user or proceed
```

This is intentional. Permission modes control how much friction exists inside a trusted folder. They do not override the trust boundary.

### Lazy MCP loading

MCP tool schemas are injected into the system prompt as a compact index only. Full schemas load on demand when the LLM requests a specific tool. This matters at 50+ tools — injecting everything upfront burns context fast.

The index looks like: `tool_name: one-line description`. Full schema fetches happen via the internal `list_tools` call.

### Tool safety guards

All file tools go through `security.py` before execution:
- Path traversal: resolved paths must stay within the trusted workspace root
- Shell: no commands that escape the project directory via `cd`, subshell operators, or absolute paths outside workspace

### Sessions and undo

Every turn that writes or edits files first takes a git snapshot via `git_ops.py`. `/undo` reverts to the snapshot from before the last turn. This works even in repos that don't use git — Andromity manages its own internal snapshot branch.

### Cron jobs

Jobs are stored per-project in `.andromity/crons.json`. The scheduler runs as a background thread when the TUI is open. Each job captures the model, permission mode, and prompt at creation time — changing your global settings later doesn't affect scheduled jobs unless you edit them via `/cron`.

---

## Adding a new tool

1. Implement the function in `core/tools.py`
2. Add the tool schema to the tool registry at the bottom of that file
3. If it writes to disk or runs shell commands, route it through `security.py` checks first
4. Add it to the relevant profiles in `core/profiles.py`
5. Write a test in `tests/`

---

## What we're not looking for right now

- New LLM provider integrations (LiteLLM handles this already — just pass the right model string)
- UI theme changes
- Feature requests without a use case description
