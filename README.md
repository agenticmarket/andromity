<div align="center">
  <img src="andromity.png" alt="Andromity" width="60" height="60" />

  # Andromity

  **A terminal AI coding agent. Autonomous by choice, gated by trust.**

  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>

  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Version](https://img.shields.io/badge/version-0.2.3-blueviolet)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  English | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

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

Then:

```bash
andromity
```

Point it at a folder, answer the trust prompt, pick a model — you're in.

---

Andromity is not a chat window. Not a plugin. It's a proper terminal workspace — sessions, diffs, file viewer, cron scheduler, profiles — with an AI agent wired into all of it.

It works with Claude, Gemini, GPT, Groq, Ollama, and anything LiteLLM supports. Run it entirely local with Ollama and pay nothing. Swap models mid-session with `Ctrl+L`.

The thing that makes it different: **nothing runs until you say the folder is trusted.**

---

## How the trust model works

When you open a folder, Andromity asks if you trust it. That answer controls everything — not your permission mode, not your API key, not your settings. Say no, and the agent cannot write a file, run a command, or touch anything. Full stop.

Say yes, and you pick how much rope the agent gets:

| Mode | Plans | File writes | Shell commands |
|------|-------|-------------|----------------|
| **SAFE** | Approve each one | Approve each one | Approve each one |
| **TRUST** | Approve | Direct — no review | Direct — no review |
| **FULL** | Auto | Direct | Direct |
| **YOLO** | Auto (shown as FYI) | Silent | Silent |

Start in SAFE. Move to YOLO when you know what the agent does in your codebase. `/trust` and `/untrust` any time.

---

## Headless / scripted

```bash
andromity run "add error handling to auth.py"
andromity run "refactor this to async" --yes      # auto-approve everything
andromity run "review session.py" --dry-run       # see what it would do
```

---

## What's inside

**Scheduler.** Run the agent on a timer while you sleep. `/cron` opens the scheduler. Jobs persist per project in `.andromity/crons.json`. Works with any permission mode — use YOLO for fully unattended runs.

**Profiles.** Switch what the agent is trying to do.
- `builder` — plans, then implements
- `coder` — implements directly, no planning phase
- `reviewer` — read-only, produces findings
- `planner` — plans only, touches nothing

**MCP support.** Drop a `mcp.json` in your project. Tool schemas index first, full payloads load only when the agent needs them. Keeps token use sane with 50+ tools connected.

**Sessions.** Everything is saved. Switch between sessions with `/sessions` or `Ctrl+O`. `/compact` when context gets heavy. `/undo` to revert the last turn and all its file changes.

**Sound notifications.** The agent pings you when it needs approval or finishes a turn. Toggle them independently under `Ctrl+E → Advanced → Sounds`.

**Model-agnostic.** LiteLLM under the hood. Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Switch mid-session with `Ctrl+L`.

---

## How it compares

| | Andromity | Aider | Cursor | Claude Code |
|--|-----------|-------|--------|-------------|
| Folder trust model | ✅ | ❌ | ❌ | ❌ |
| Permission levels (SAFE → YOLO) | ✅ | ❌ | Partial | ❌ |
| Built-in cron scheduler | ✅ | ❌ | ❌ | ❌ |
| Inline diff viewer | ✅ | ✅ | ✅ | ✅ |
| Session management + `/undo` | ✅ | ❌ | Partial | ❌ |
| Agent profiles | ✅ | ❌ | ❌ | Partial |
| Local-first / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| MCP support | ✅ | ❌ | Partial | ✅ |
| TUI workspace | ✅ | ❌ | ❌ | ❌ |

---

## Privacy

Your code goes to one place: the LLM provider you configure. Not us.

- API keys live in `~/.andromity/config.toml`
- Sessions stored locally in `~/.andromity/sessions/`
- Anonymous ping on first launch — no code, no paths, no keys. Full details in [telemetry-worker/README.md](telemetry-worker/README.md)
- Opt out: `export DO_NOT_TRACK=1`, or `telemetry = false` in config, or `Ctrl+E → Advanced → Telemetry`

---

> 💡 Run `/help` inside the workspace. Not every feature is documented here — discovery is part of the experience.

---

## Contributing

Open an issue or PR. Honest feedback and bug reports are more useful than feature requests right now.

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout and dev setup.

**MIT** — see [LICENSE](LICENSE).

---

<div align="center">
  <img src="screen_shot.png" alt="Andromity in action" width="100%" />
</div>
