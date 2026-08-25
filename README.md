<div align="center">
  <img src="andromity.png" alt="Andromity" width="60" height="60" />

  # Andromity

  **Your terminal. Your rules. AI does the work.**

  <img src="screen_shot.png" alt="Andromity in action" width="100%" />

  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Version](https://img.shields.io/badge/version-0.2.2-blueviolet)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

---

Andromity is a terminal workspace with an AI agent built in. Not a chat window. Not a plugin. A proper workspace — sessions, diffs, file viewer, cron scheduler, profiles — all in your terminal, with an AI agent that actually does things.

The thing that makes it different: **nothing runs until you say the folder is trusted.**

---

## How the trust model works

When you open a folder, Andromity asks if you trust it. That answer controls everything — not your permission mode, not your API key, not your settings. If you say no, the agent cannot write a file, run a command, or touch anything. Full stop.

If you say yes, you pick how much rope the agent gets:

| Mode | Plans | File writes | Shell commands |
|------|-------|-------------|----------------|
| **SAFE** | Approve each one | Approve each one | Approve each one |
| **TRUST** | Approve | Direct — no review | Direct — no review |
| **FULL** | Auto | Direct | Direct |
| **YOLO** | Auto (shown as FYI) | Silent | Silent |

Start in SAFE. Move to YOLO when you know what the agent does in your codebase. `/trust` and `/untrust` any time.

---

## Install

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Or with pipx
pipx install andromity
```

Needs Python 3.11+. The installer handles pipx if you don't have it.

---

## Start

```bash
andromity
```

That opens the workspace. Point it at a folder, answer the trust prompt, pick a model — done. No config file needed to get started.

```bash
# Headless / scripted
andromity run "add error handling to auth.py"
andromity run "refactor this to async" --yes      # auto-approve everything
andromity run "review session.py" --dry-run       # see what it would do
```

---

<!-- Replace with GIF showing trust prompt → diff → approval flow -->
![Andromity diff and approval flow](screen_shot.png)

---

## What's inside

**Scheduler.** Run the agent on a timer while you sleep. `/cron` opens the scheduler. Jobs persist per project in `.andromity/crons.json`. Works with any permission mode — use YOLO for fully unattended runs.

**Profiles.** Switch what the agent is trying to do.
- `builder` — plans, then implements
- `coder` — implements directly, no planning phase
- `reviewer` — read-only, produces findings
- `planner` — plans only, touches nothing

**MCP support.** Drop a `mcp.json` in your project. Tools load lazily — schemas index first, full payloads load only when the agent actually needs them. Keeps token use sane with 50+ tools connected.

**Sessions.** Everything is saved. Switch between sessions with `/sessions` or `Ctrl+O`. `/compact` when context gets heavy. `/undo` to revert the last turn and all its file changes.

**Sound notifications.** The agent pings you when it needs approval or finishes a turn. Toggle them independently under `Ctrl+E → Advanced → Sounds`.

**Model-agnostic.** LiteLLM under the hood. Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Switch mid-session with `Ctrl+L`.

---

## How it compares

> ⚠️ **Verify before publishing** — confirm competitor columns are accurate against their current docs.

| | Andromity | Aider | OpenCode |
|--|-----------|-------|----------|
| Folder trust model | ✅ | ❌ | ❌ |
| Permission levels (SAFE → YOLO) | ✅ | ❌ | Partial |
| Built-in cron scheduler | ✅ | ❌ | ❌ |
| Inline diff viewer | ✅ | ✅ | ✅ |
| Session management | ✅ | ❌ | ✅ |
| Agent profiles | ✅ | ❌ | Partial |
| Local-first, BYOK | ✅ | ✅ | ✅ |
| MCP support | ✅ | ❌ | ✅ |

---

## Privacy

Your code goes to one place: the LLM provider you configure. Not us.

- API keys live in `~/.andromity/config.toml`
- Sessions stored locally in `~/.andromity/sessions/`
- Anonymous ping on first launch — no code, no paths, no keys. Full details in [telemetry-worker/README.md](telemetry-worker/README.md)
- Opt out: `export DO_NOT_TRACK=1`, or `telemetry = false` in config, or `Ctrl+E → Advanced → Telemetry`

---

> ✦ *Not every command is documented here. Discovery is part of the experience.*

---

## Contributing

Open an issue or PR. Honest feedback and bug reports are more useful than feature requests right now.

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout and dev setup.

**MIT** — see [LICENSE](LICENSE).