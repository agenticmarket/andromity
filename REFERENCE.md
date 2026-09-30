# Andromity Reference

Full reference for commands, config, modes, profiles, tools, and data locations.

---

## Chat commands

Type these in the chat bar.

| Command | What it does |
|---------|-------------|
| `/model` | Switch provider and model (also `Ctrl+L`) |
| `/profile [name]` | Switch profile: `builder` / `coder` / `reviewer` / `planner` (also `Ctrl+J`) |
| `/mode [safe\|trust\|full\|yolo]` | Set permission mode for the current session |
| `/trust` | Trust the current folder |
| `/untrust` | Remove trust from the current folder |
| `/sessions` | Browse and switch sessions (also `Ctrl+O`) |
| `/new` | Start a new session |
| `/rename <name>` | Rename the current session |
| `/compact` | Summarize and compress old context to free token space |
| `/undo` | Undo the last turn and revert all its file changes |
| `/dry-run` | Toggle dry-run mode — simulates tools without writing or running anything |
| `/debug` | Toggle debug mode — shows tool calls inline as they happen |
| `/mcp` | Show MCP server status and available tools |
| `/cron` | Open the background task scheduler |
| `/plan clear` | Clear the active session plan |
| `/settings` | Open the settings panel (also `Ctrl+E`) |
| `/keys` | Show API key status for all configured providers |
| `/keys set <provider> <key>` | Save an API key to your config |
| `/tips` | Get a random developer tip |
| `/news` | Show latest Andromity release notes |
| `/logs` | Show log file location |
| `/clear` | Clear chat history |

> ✦ Not every command is listed here.

---

## Security Architecture & 3-Gate Enforcement Model

Andromity operates on a strict, defense-in-depth 3-tier security gate hierarchy. Every tool invocation must successfully pass all three gates sequentially before execution is permitted.

```
       [ Tool Call Initiated ]
                  │
                  ▼
┌───────────────────────────────────────────┐
│ GATE 1: Folder Trust Boundary (Hard Fence)│
│  - Untrusted: Reads allowed               │
│  - Writes / Shell / Mutating tools BLOCKED│
│  - CANNOT be bypassed by FULL or YOLO     │
└─────────────────────┬─────────────────────┘
                      │ Passed
                      ▼
┌───────────────────────────────────────────┐
│ GATE 2: Profile Confinement & Subagents   │
│  - planner / reviewer: Read-only          │
│  - Mutating tools stripped & blocked      │
│  - Subagents strictly inherit confinement │
│  - Anti-forking: nested subagents blocked │
└─────────────────────┬─────────────────────┘
                      │ Passed
                      ▼
┌───────────────────────────────────────────┐
│ GATE 3: Permission Mode Execution Gate    │
│  - SAFE: Interactive approval required    │
│  - TRUST: Direct writes & allowlisted cmd │
│  - FULL / YOLO: Autonomous execution      │
└─────────────────────┬─────────────────────┘
                      │ Approved
                      ▼
            [ Execute Tool ]
```

### Gate 1: Folder Trust Boundary (Hard Fence)
- Folders are untrusted by default until explicitly trusted via `/trust` or the Hub UI.
- In an untrusted folder:
  - Non-mutating read and search operations (`read_file`, `list_dir`, `grep_search`, `find_files`) are allowed so users can audit unfamiliar codebases safely.
  - All mutating tools (`write_file`, `edit_file`, `edit_file_multi`), shell commands (`shell_exec`, `shell_bg`, `shell_kill`), and subagents with mutating capabilities are **unconditionally blocked**.
  - Folder trust is an absolute boundary: neither `FULL` mode nor `YOLO` mode can bypass an untrusted folder.

### Gate 2: Agent Profile Confinement (Least Privilege)
- Profile capabilities define the strict boundary of what an agent may execute:
  - `builder` (default): Full lifecycle (plan, read, search, write, edit, shell, web, tools).
  - `coder`: Implementation focused (read, search, write, edit, shell, web, tools; skips plan writing).
  - `reviewer`: Read-only audit (read, search, list, web; mutating tools and shell commands are stripped and blocked).
  - `planner`: Planning only (read, search, list, write_plan; mutating tools and shell commands are stripped and blocked).
- **Subagent Confinement Inheritance**: When a parent agent spawns a subagent via `spawn_subagent`, the child strictly inherits the parent's profile confinement. Subagents spawned under `planner` or `reviewer` have all mutating tools stripped upfront from their schemas and blocked at execution time.
- **Anti-Forking Protection**: Subagents are strictly forbidden from spawning nested subagents (`spawn_subagent` is stripped from their toolsets).

### Gate 3: Permission Mode Workflow (User In The Loop)
- Permission modes govern interactive human approval inside trusted workspaces:

| Mode | Plans | File writes | Shell commands | External URLs & MCP |
|------|-------|-------------|----------------|----------------------|
| **SAFE** (default) | Approve before running | Batch review overlay after turn | Approve before running | Approve before running |
| **TRUST** | Approve before running | Written directly, no review | Allowlisted run directly; unlisted prompt | Allowlisted domains run directly; unlisted prompt |
| **FULL** | Auto-approved | Written directly, no review | Written directly, no review | Auto-approved |
| **YOLO** | Auto-approved (shown as FYI) | Silent, no review | Silent, no review | Silent, no review |

---

## Profiles

Switch with `/profile` or `Ctrl+J`.

| Profile | What it does | Allowed Tools |
|---------|-------------|---------------|
| `builder` (default) | Plans, then implements step by step | read, search, write, edit, shell, web, tools, plans |
| `coder` | Direct implementation, skips planning | read, search, write, edit, shell, web, tools |
| `reviewer` | Read-only audit, produces findings | read, search, list, web, tools (no writes/shell) |
| `planner` | Produces plans only, touches nothing | read, search, list, tools, write_plan (no writes/shell) |

---

## Agent tools

| Tool | Category | What it does |
|------|----------|-------------|
| `read_file` | Filesystem | Read a file or specific line range (with optional AST symbols outline) |
| `write_file` | Filesystem | Create or overwrite a file in the workspace |
| `edit_file` | Filesystem | Replace a specific string inside a file with multi-tier matching |
| `edit_file_multi` | Filesystem | Apply multiple non-contiguous edits to a file in one call |
| `list_dir` | Filesystem | List directory contents |
| `grep_search` | Search | Ripgrep-style search across the codebase respecting `.gitignore` |
| `find_files` | Search | Find files matching a glob pattern |
| `shell_exec` | Execution | Run a shell command synchronously in the project directory |
| `shell_bg` | Execution | Start a long-running background command (returns `process_id`) |
| `shell_read` | Execution | Read buffered output of a running or completed background process |
| `shell_kill` | Execution | Terminate a running background process and its process tree |
| `shell_list` | Execution | List all active and recent background processes for the project |
| `spawn_subagent` | Multi-Agent | Spawn a specialized subagent scoped to a specific task |
| `write_plan` | Planning | Create a step-by-step plan for approval |
| `update_plan_step` | Planning | Update the status of an existing plan step |
| `ask_questions` | Interaction | Ask the user one or more interactive clarifying questions |
| `list_tools` | MCP / Catalog | Discover connected MCP servers and available deferred tools |
| `web_search` | Web | Search the web |
| `fetch_url` | Web | Fetch a URL and convert it to readable markdown |

---

## Background Process System (`shell_bg`)

Andromity provides resilient background process management for dev servers (`npm run dev`, `docker compose up`), test runners, and long-running compilers:

1. **Non-Blocking Launch**: `shell_bg` starts the process detached with a unique, project-scoped ID and returns immediately. The tool call tag displays `RUNNING (BG)` rather than falsely marking the task complete.
2. **Interactive UI Controls**: In the VS Code extension and TUI, running background processes display an active badge with a direct **[⏹ Stop]** button to terminate the process at any time without asking the AI.
3. **Waterfall Timeline Integration**: Background processes remain active spans on the Waterfall timeline throughout their entire lifetime, tracking exact execution duration until exit.
4. **Reactive Auto-Wake**: When a background command exits (either successfully or with an error), the agent automatically wakes up to process the exit code, duration, and output logs, continuing the workflow seamlessly.
5. **Clean Teardown**: `shell_kill` terminates the entire process group tree across Windows (`taskkill /F /T`) and POSIX (`SIGTERM` -> `SIGKILL`), preventing leaked background or zombie processes.

---

## Config file

Lives at `~/.andromity/config.toml`. Created automatically on first run.

```toml
[default]
provider = "anthropic"
model    = "claude-sonnet-4-5"
profile  = "builder"
telemetry = true   # set to false to opt out

[[providers]]
name = "anthropic"
type = "anthropic"
api_key = "sk-ant-..."

[[providers]]
name = "openai"
type = "openai"
api_key = "sk-..."

[[providers]]
name = "gemini"
type = "google"
api_key = "AI..."

[[providers]]
name = "openrouter"
type = "openrouter"
api_key = "sk-or-..."

[[providers]]
name = "ollama"
type = "ollama"
base_url = "http://localhost:11434"
```

API keys can also be passed as environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`.

Andromity uses LiteLLM under the hood. Any LiteLLM-supported provider works — pass the correct model string and it routes correctly.

---

## MCP configuration

Create `.andromity/mcp.json` or `.vscode/mcp.json` in your project root.

```json
{
  "servers": {
    "your-server-name": {
      "command": "npx",
      "args": ["-y", "@your/mcp-package"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}
```

Run `/mcp` in the chat to see connected servers and available tools.

Tool schemas are lazy-loaded — only the index goes into the system prompt. Full schemas fetch on demand when the agent uses a tool.

---

## Cron jobs

Open with `/cron`. Jobs are stored per-project at `.andromity/crons.json`.

Each job captures:
- The prompt
- The model at creation time
- The permission mode at creation time
- The schedule (plain English: "every 30m", "every 1d", "every 2h")

Jobs run asynchronously. Logs and run details go to `.andromity/cron_runs/`.

Use YOLO mode for fully unattended jobs. The TUI must be running in the background — no headless daemon yet.

---

## Data and log locations

**macOS / Linux:**
```
~/.andromity/
  config.toml       ← your config and API keys
  sessions/         ← session history (plaintext — don't run on shared machines)
  logs/             ← agent logs
```

**Windows:**
```
%APPDATA%\andromity\
```

**Windows Store Python users:** Python installed via the Microsoft Store virtualizes app data. Your files will be at:
```
%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\LocalCache\Roaming\andromity\
```
The path changes slightly by Python version (3.11, 3.12, 3.13). Check `%LOCALAPPDATA%\Packages\` and look for the Python folder matching your version.

---

## Security notes

- Session files are stored in plaintext. Don't run Andromity on a shared machine with a sensitive codebase.
- Cron jobs in `.andromity/crons.json` auto-load from the project directory. Review via `/cron` before trusting a repo you cloned.
- The trust boundary is enforced before permission checks. Untrusted folder = nothing runs, regardless of mode.
