# Andromity

> The coding agent that never clocks out.

Andromity is a terminal AI coding agent with a rich TUI. Point it at any codebase, pick a model, and it reads, writes, and runs code — with clear tool approval before any changes.

> **Beta notice:** This is `0.1.0b2` — an early beta. Expect rough edges.

![Andromity Screenshot](screen_shot.png)

---

## Install

```bash
git clone https://github.com/agenticmarket/andromity.git
cd andromity
pip install -e .
```

**Requirements:** Python 3.11+, Git

---

## Usage

### TUI (Interactive)

```bash
andromity tui
```

### CLI / Headless

```bash
andromity run "refactor this module to use async" --profile coder
andromity run "add error handling to tools.py" --yes        # auto-approve all
andromity run "write tests for session.py" --dry-run        # preview only
```

---

## Configuration

Config lives at `~/.andromity/config.toml` (created automatically on first run).

```toml
[default]
provider = "anthropic"
model    = "claude-sonnet-4-5"
profile  = "builder"

[providers.anthropic]
api_key = "sk-ant-..."

[providers.openai]
api_key = "sk-..."

[providers.ollama]
base_url = "http://localhost:11434"
```

API keys can also be set via environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, etc.).

Andromity uses [LiteLLM](https://github.com/BerriAI/litellm) under the hood and is wired to support multiple providers. However, see the **Tested On** section below for what has actually been verified.

---

## Tested On

This beta has only been tested with **Ollama running locally**. The code is wired for other providers via LiteLLM, but the following have **not been tested** by the maintainer:

| Provider | Status |
|----------|--------|
| Ollama (local) | ✅ Tested |
| NVIDIA NIM | ✅ Tested |
| Groq | ✅ Tested |
| OpenRouter | ✅ Tested |
| Google Gemini | ✅ Tested |
| Anthropic (Claude) | ❌ Not tested — no API access |
| OpenAI (GPT) | ❌ Not tested — no API access |
| Grok (xAI) | ❌ Not tested — no API access |

If you test with any of these and find issues, please open an issue.

Note: context window handling has known rough edges at high token counts — see [Known Issues](#known-issues).

---

## Profiles

Switch the agent's role and capabilities with `--profile`:

| Profile | What it does | Tools available |
|---------|-------------|-----------------|
| `builder` (default) | Plans and implements step-by-step | read, write, edit, shell, todos, plans |
| `coder` | Direct implementation without a planning phase | read, write, edit, shell, todos |
| `reviewer` | Read-only audit producing HIGH/MED/LOW findings | read, list |
| `planner` | Produces step-by-step plans without modifying code | read, list, write_plan |

---

## Agent Tools

The agent interacts with the codebase using these built-in tools:

| Tool | What it does |
|------|-------------|
| `read_file` | Reads a file or specific line range (protected against path traversal) |
| `write_file` | Creates or overwrites a file in the workspace |
| `edit_file` | Replaces a specific string inside a file |
| `shell_exec` | Executes a shell command in the project directory |
| `list_dir` | Lists directory contents |
| `write_plan` | Creates a step-by-step plan for approval |
| `create_todo` | Creates a todo item |
| `update_todo` | Updates a todo status (active / done / failed) |
| `list_todos` | Shows active todos and progress |

In `SAFE` mode (default), all write, edit, and shell operations require explicit user approval. UI remains completely responsive during execution thanks to background thread dispatch.

---

## MCP (Model Context Protocol) Support

Andromity supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) to connect to external tools and APIs natively. 

**Smart Lazy-Loading**: Andromity uses a deferred-tool architecture for MCP. It injects a tiny index of available MCP tools into the system prompt and dynamically loads the massive JSON schemas only when the LLM requests them via `tool_search`. This prevents token limit exhaustion and keeps responses lightning fast even with 50+ MCP tools connected.

**Usage:**
- Configure servers in `.andromity/mcp.json` or `.vscode/mcp.json`.
- Type `/mcp` in the chat to view connected servers and available tools.

---

## System Prompts & Customization

System prompts are fully open and defined in:

```
src/andromity/core/profiles.py -> get_system_prompt(profile)
```

The prompt dynamically injects your operating system, shell, Python version, working directory, and Git branch to ensure the agent has accurate local context.

---

## Project Structure

```
src/andromity/
├── cli.py             # CLI commands (run, tui, config)
├── config.py          # Configuration and trust management
├── core/
│   ├── agent.py       # Main agent execution loop and streaming
│   ├── profiles.py    # AI profiles and dynamic system prompt builder
│   ├── tools.py       # Core tool implementations with safety guards
│   ├── provider.py    # LiteLLM client wrapper
│   ├── session.py     # Session persistence and token tracking
│   ├── models.py      # Model catalog and context limits
│   ├── git_ops.py     # Git snapshots and rollback operations
│   └── cron.py        # Project-level background task scheduler
└── tui/
    ├── app.py         # Textual-based interactive UI
    ├── chat.py        # Message history and markdown rendering
    ├── diff_panel.py  # Side-by-side diffs and tool approval dialogs
    ├── plan_panel.py  # Real-time plan tracking and todo list
    └── ...
```

---

## Known Issues

| Issue | Workaround |
|-------|-----------|
| Context window overflow — token counter keeps climbing and model errors when limit is hit | Use `/new` to start a fresh session before hitting the limit |
| Untested on cloud providers (Anthropic, OpenAI, etc.) | Contributions and test reports welcome |
| Session files stored in plaintext at `~/.andromity/sessions/` | Do not use Andromity on shared machines with sensitive codebases |
| Cron jobs in `.andromity/crons.json` are auto-loaded from project directory | Review via `/cron` before trusting a cloned repo |
| **Cohere models (via OpenRouter) may fail with empty tool results** — `all elements in tool_results must have the 'outputs' property specified` | Fixed in 0.1.0b2. Was caused by `list_dir` returning an empty string on empty directories. Update to latest and retry. |

---

## Contributing

This is an early open-source beta. If you test against a provider not listed above, open an issue or PR with your findings. Bug reports and honest feedback are more useful than feature requests at this stage.

---

## License

MIT — see [LICENSE](LICENSE).
