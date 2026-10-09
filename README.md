<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — AI Coding Agent for VS Code & Terminal

  **Trust-governed, BYOK, autonomous coding agent with subagents, live plans, native diffs & one-click rollback.**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.18-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/taPJSNy4)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  [![GitHub Stars](https://img.shields.io/github/stars/agenticmarket/andromity?style=social)](https://github.com/agenticmarket/andromity)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  English | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp?v=0.2.8" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** is a private, BYOK (Bring Your Own Key) autonomous AI coding agent. Use it inside VS Code with the extension, or run it as a standalone terminal workspace. It plans complex tasks, manages parallel subagents, shows live step-by-step blueprints, lets you review diffs before applying, and gives you instant one-click rollback.

Connect your preferred AI model (**Claude 3.7 Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek R1 & V3, Groq, OpenRouter**) or run **100% locally and free with Ollama**.

---

## ⚡ Quick Install & Get Started

### 🚀 Option A: VS Code Extension (Recommended)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install in VS Code" />
  </a>
</div>

👉 **Recommended:** Install directly from the marketplace:  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

Or install instantly via terminal:

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 Option B: Terminal CLI

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Or with pipx
pipx install andromity
```

---

## ✨ Key Features

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="Live Task Planner & Blueprints" width="100%" />
</div>

### 📝 Live Task Planner & Blueprints
Andromity analyzes your codebase, creates an interactive step-by-step implementation plan, and waits for your approval before writing a single line of code. Review, approve, or skip any step.

### 🌊 Live Execution Waterfall Profiler
Inspect agent reasoning turns, tool execution latencies (bash commands, file operations, web queries), and parallel subagents in real time on an interactive chronological timeline grid directly inside VS Code (`/waterfall`).

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp?v=0.2.8" alt="396+ Model Support including local Ollama" width="100%" />
</div>

### 🤖 396+ Models — Including Free Local Ollama
Connect Claude 3.7, GPT-4o, Gemini 2.5 Pro, DeepSeek R1, Groq, or run 100% offline with Ollama. Swap models mid-session with `Ctrl+L`.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="Trust and Workspace Governance" width="100%" />
</div>

### 🔐 Trust Governance — You Are Always in Control

| Mode | Plans | File Writes | Terminal Commands |
|------|-------|-------------|-------------------|
| **SAFE** *(default)* | Approve each | Approve each | Approve each |
| **TRUST** | Approve | Direct | Direct |
| **FULL** | Auto | Direct | Direct |
| **YOLO** | Auto | Silent | Silent |

Nothing runs until you say a folder is trusted. Start in SAFE, move to YOLO when you know what the agent does.

---

## How it compares

| | Andromity | Aider | Cursor | Claude Code |
|--|-----------|-------|--------|-------------|
| Folder trust model | ✅ | ❌ | ❌ | ❌ |
| Permission levels (SAFE → YOLO) | ✅ | ❌ | Partial | ❌ |
| **Live execution waterfall profiler** | ✅ | ❌ | ❌ | ❌ |
| **Built-in cron scheduler** | ✅ | ❌ | ❌ | ❌ |
| **Parallel sessions & subagents** | ✅ | ❌ | ❌ | Partial |
| Inline diff viewer | ✅ | ✅ | ✅ | ✅ |
| Session management + `/undo` | ✅ | ❌ | Partial | ❌ |
| Agent profiles | ✅ | ❌ | ❌ | Partial |
| Local-first / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| MCP support | ✅ | ❌ | Partial | ✅ |
| VS Code Extension | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Cron Scheduler — AI That Works While You Sleep

No other AI coding agent has this. Open `/cron` inside Andromity, write your task, set a schedule — and the agent executes it autonomously on a timer while you're away.

```bash
# Example: auto-run test suite and fix failures every night at 2 AM
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

Jobs persist in `.andromity/crons.json` per project. Use FULL or YOLO mode for fully unattended overnight runs. Wake up to commits already made.

---

## 🤖 Parallel Sessions & Subagents

Spawn background subagents for parallel workstreams without interrupting your main session. Example: while one subagent researches an unfamiliar library, another implements a feature, and you review the plan in the main session — all simultaneously.

```
Main session      → Plan & implement Feature A
Subagent 1        → Research the best auth library
Subagent 2        → Write unit tests for Feature B
```

Switch between all sessions with `Ctrl+O`. Every session has its own context, history, and file change log. `/undo` reverts only the current session's changes.

---

## What's inside the terminal workspace

> The VS Code extension and the terminal share the same agent core. The terminal workspace gives you the raw power.

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**Profiles.** Switch what the agent is trying to do mid-session.
- `builder` — plans first, then implements
- `coder` — implements directly, no planning phase
- `reviewer` — read-only, produces findings
- `planner` — plans only, touches nothing

**MCP support.** Drop a `mcp.json` in your project. Tool schemas load on demand — keeps token use sane with 50+ tools connected.

**Sessions.** Everything is saved. `/sessions` or `Ctrl+O` to switch. `/compact` when context gets heavy. `/undo` to revert the last turn and all its file changes.

**Headless / scripted runs.**
```bash
andromity run "add error handling to auth.py"
andromity run "refactor this to async" --yes      # auto-approve everything
andromity run "review session.py" --dry-run       # see what it would do
```

**Model-agnostic.** LiteLLM under the hood. Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Swap mid-session with `Ctrl+L`.

---

## Privacy

Your code goes to one place: the LLM provider you configure. Not us.

- API keys live in `~/.andromity/config.toml` — encrypted locally
- Sessions stored locally in `~/.andromity/sessions/`
- Opt out of telemetry: `export DO_NOT_TRACK=1`

---

## SWE-bench Lite: local evaluation

Andromity resolved **150 of 300 SWE-bench Lite tasks (50.0%)** in our local evaluation dated October 4, 2026. The evaluation produced 296 task reports; the remaining four tasks count as unresolved in the full-dataset score. This is a self-reported result, not an official leaderboard ranking or a guarantee of contamination-free model training.

The agent workspace was initialized from each task's base commit. Tool execution used command restrictions, proxy settings, and Python socket guards; these are not an OS-enforced air gap. Model inference used a remote provider.

See [benchmark methodology and limitations](BENCHMARK.md) and the [evaluation evidence](evaluation/swe-bench-lite-2026-10-04/) for deduplicated predictions, per-task outcomes, and hashes. The model alias was recorded as Space Bunny Alpha; the archived predictions identify the system as `andromity/auto`, so the underlying model identity is not independently established.

---

## 🚀 #BuiltWithAndromity Showcase & Hackathons

Are you building an open-source project, university coursework, or commercial application using Andromity?

- **Showcase Your Work:** Tag your project or PR with **`#BuiltWithAndromity`** on X (Twitter) or drop it in the `#showcase` channel on [Discord](https://discord.gg/taPJSNy4).
- **Get Featured:** Top community projects and contributions are spotlighted on [agenticmarket.dev](https://agenticmarket.dev) and receive official ecosystem contributor recognition and goodies.
- **Community Hackathons:** Stay tuned in Discord for global community hackathons benefiting open-source developers worldwide.

---

## 💬 Community & Discord

Join our growing community of autonomous AI developers, students, and engineers:

- **Discord:** [Join the Andromity Community Discord](https://discord.gg/taPJSNy4) for live discussions, local Ollama setups, prompt engineering, and MCP skill sharing.
- **Skills & MCP Hub:** Discover and publish community agent skills, custom prompts, and MCP tool servers on [AgenticMarket](https://agenticmarket.dev).

⭐ **Loved the Live Waterfall profiler or saved hours debugging?** Consider giving Andromity a star on GitHub — it helps more developers discover 100% free, private, open-source AI tooling!

---

## Star History

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed release history and version notes.

---

## Maintainer & Authors

Andromity is created and actively maintained by:

- **Shekhar Pachlore** ([@shekharP1536](https://github.com/shekharP1536)) — Creator & Lead Maintainer (Core Architecture & Autonomous Runtimes)

---

## Contributing

Open an issue or PR. Honest feedback and bug reports are more useful than feature requests right now.

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout and dev setup.

**MIT** — see [LICENSE](LICENSE).

