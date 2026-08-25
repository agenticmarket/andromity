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

## Permission modes

| Mode | Plans | File writes | Shell commands |
|------|-------|-------------|----------------|
| **SAFE** (default) | Approve before running | Batch review overlay after turn | Approve before running |
| **TRUST** | Approve before running | Written directly, no review | Written directly, no review |
| **FULL** | Auto-approved | Written directly, no review | Written directly, no review |
| **YOLO** | Auto-approved (shown as FYI) | Silent, no review | Silent, no review |

Permission mode only applies inside a trusted folder. In an untrusted folder, no writes or shell commands happen regardless of mode.

---

## Profiles

Switch with `/profile` or `Ctrl+J`.

| Profile | What it does | Tools available |
|---------|-------------|-----------------|
| `builder` (default) | Plans, then implements step by step | read, search, write, edit, shell, web, tools, plans |
| `coder` | Direct implementation, skips planning | read, search, write, edit, shell, web, tools |
| `reviewer` | Read-only audit, produces HIGH/MED/LOW findings | read, search, list, web, tools |
| `planner` | Produces plans only, touches nothing | read, search, list, tools, write_plan |

---

## Agent tools

| Tool | What it does |
|------|-------------|
| `read_file` | Read a file or specific line range |
| `write_file` | Create or overwrite a file in the workspace |
| `edit_file` | Replace a specific string inside a file |
| `edit_file_multi` | Apply multiple non-contiguous edits to a file in one call |
| `shell_exec` | Run a shell command in the project directory |
| `list_dir` | List directory contents |
| `grep_search` | Ripgrep-style search across the codebase |
| `find_files` | Find files matching a glob pattern |
| `write_plan` | Create a step-by-step plan for approval |
| `list_tools` | Discover connected MCP servers and available tools |
| `web_search` | Search the web |
| `fetch_url` | Fetch a URL and convert it to readable markdown |

All write, edit, and shell tools require explicit approval in SAFE mode.

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
