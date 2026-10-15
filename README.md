<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — AI Coding Agent for VS Code & Terminal

  **Trust-governed, BYOK, autonomous coding agent with subagents, live plans, native diffs & one-click rollback.**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.19-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white)](https://discord.gg/taPJSNy4)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  [![GitHub Stars](https://img.shields.io/github/stars/agenticmarket/andromity?style=social)](https://github.com/agenticmarket/andromity)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  **[Website](https://andromity.agenticmarket.dev)** · **[Documentation](https://andromity.agenticmarket.dev/docs)** · **[Quickstart](https://andromity.agenticmarket.dev/docs/quickstart)** · **[Blog](https://andromity.agenticmarket.dev/blog)**

  English | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp?v=0.2.8" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** is an open-source (MIT), BYOK (Bring Your Own Key) autonomous AI coding agent for VS Code and the terminal. Use it inside VS Code with the extension, or run it as a standalone terminal workspace. It plans complex tasks, manages parallel subagents, shows live step-by-step blueprints, lets you review diffs before applying, and gives you instant one-click rollback.

Connect your preferred AI provider (**Anthropic Claude, OpenAI, Google Gemini, DeepSeek, Groq, OpenRouter, NVIDIA NIM**, or any OpenAI-compatible endpoint) or run models **locally and free with Ollama**.

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
Andromity analyzes your codebase and writes a step-by-step implementation plan. In SAFE and TRUST modes it waits for your approval before editing; review the plan, approve it, or send feedback. FULL and YOLO modes approve plans automatically.

### 🌊 Live Execution Waterfall Profiler
Inspect agent reasoning turns, tool execution latencies (bash commands, file operations, web queries), and parallel subagents in real time on an interactive timeline inside VS Code. Open it from the waterfall button in the chat toolbar or with the **Andromity: Waterfall Trace** command.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp?v=0.2.8" alt="Andromity model picker with cloud providers and local Ollama models" width="100%" />
</div>

### 🤖 Any Model — Cloud Providers or Free Local Ollama
Connect Anthropic Claude, OpenAI, Google Gemini, DeepSeek, Groq, or OpenRouter with your own API key, or run local models with Ollama. Andromity uses LiteLLM, so models LiteLLM supports work too. Swap models mid-session with `Ctrl+L`.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="Trust and Workspace Governance" width="100%" />
</div>

### 🔐 Trust Governance — You Are Always in Control

| Mode | Plans | File edits | Terminal commands |
|------|-------|-------------|-------------------|
| **SAFE** *(default)* | You approve | You approve (VS Code asks per edit; the terminal app reviews the turn's edits as a batch) | You approve each |
| **TRUST** | You approve | Applied directly, except sensitive or execution-control files (`.git`, `.vscode`, `.andromity`, `package.json`, …), which ask | Allowlisted commands run directly; others ask |
| **FULL** | Auto-approved | Applied directly | Run directly |
| **YOLO** | Auto-approved | Applied directly | Run directly. In the terminal app YOLO lasts for the current session only and resets to SAFE on restart |

Folder trust comes first: in an untrusted folder the agent cannot read files, edit them, or run commands, whatever the mode. Planner and reviewer profiles are read-only in every mode. Start in SAFE, and move up when you know what the agent does.

---

## How it compares

Checked against each tool's official documentation on October 14, 2026. These tools change quickly; if something here is out of date, please open an issue.

| | Andromity | Claude Code | Cursor | Cline | Aider |
|--|-----------|-------------|--------|-------|-------|
| License | MIT | Proprietary | Proprietary | Apache-2.0 | Apache-2.0 |
| Where it runs | VS Code extension, terminal app, headless CLI | Terminal, VS Code extension, desktop app, web | Its own editor (a VS Code fork) | VS Code extension, CLI, SDK | Terminal; works alongside any editor via `--watch-files` |
| Models | Any provider via LiteLLM with your own key, or local Ollama | Claude models only | Cursor's models, or your own OpenAI, Anthropic, Google, Azure or Bedrock key for chat (requests still go through Cursor) | Your own key for many providers, or local Ollama / LM Studio | Your own key for many providers, or local Ollama |
| Local models | Yes (Ollama) | No | Not in official docs | Yes | Yes |
| Folder / workspace trust | Required before any file read, edit, or command (`andromity run --yes` grants it to the current folder) | Trust prompt in interactive sessions (not shown with `-p`) | Not in official docs | Not in official docs | Not in official docs |
| Approval modes | SAFE, TRUST, FULL, YOLO | 6 modes, from `default` to `bypassPermissions` | Not in official docs | Per-category auto-approve, plus YOLO | Not in official docs |
| Undo / checkpoints | `/undo` reverts the last turn's file changes | `/rewind` restores code and/or conversation | Checkpoints restore files | Checkpoints restore files, task, or both | `/undo` reverts Aider's last git commit |
| Subagents | Yes, parallel and in the background | Yes, parallel and in the background | Not in official docs | CLI and desktop app only | Not in official docs |
| MCP | Yes; tool schemas load on demand | Yes; tool search loads tools on demand | Yes | Yes | Not built in ([open request](https://github.com/Aider-AI/aider/issues/4506)) |
| Scheduled tasks | `/cron`, saved per project | `/loop` and cron within a session (expire after 7 days), desktop scheduled tasks, cloud routines | Not in official docs | Cron scheduler in the CLI and SDK | Not in official docs |
| Live execution waterfall | Yes, in VS Code | Not in official docs | Not in official docs | Not in official docs | Not in official docs |

"Not in official docs" means we could not find the feature in the tool's documentation; it does not prove the feature is absent.

Sources: Claude Code [permissions](https://code.claude.com/docs/en/permissions), [security](https://code.claude.com/docs/en/security), [checkpointing](https://code.claude.com/docs/en/checkpointing), [subagents](https://code.claude.com/docs/en/sub-agents), [MCP](https://code.claude.com/docs/en/mcp), [VS Code](https://code.claude.com/docs/en/vs-code), [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks), [LLM gateways](https://code.claude.com/docs/en/llm-gateway) · Cursor [API keys](https://cursor.com/docs/settings/api-keys), [MCP](https://cursor.com/docs/context/mcp), [checkpoints](https://cursor.com/docs/agent/chat/checkpoints) · Cline [local models](https://docs.cline.bot/running-models-locally/overview), [MCP](https://docs.cline.bot/mcp/mcp-overview), [checkpoints](https://docs.cline.bot/features/checkpoints), [auto-approve](https://docs.cline.bot/features/auto-approve), [subagents](https://docs.cline.bot/features/subagents), [scheduling](https://docs.cline.bot/cli/scheduling) · Aider [commands](https://aider.chat/docs/usage/commands.html), [watch mode](https://aider.chat/docs/usage/watch.html), [Ollama](https://aider.chat/docs/llms/ollama.html)

---

## ⏰ Cron Scheduler — AI That Works While You Sleep

Open `/cron` inside Andromity, write your task, set a schedule, and the agent runs it on a timer while you're away.

```bash
# Example: auto-run test suite and fix failures every night at 2 AM
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

Jobs persist in `.andromity/crons.json` per project, and in an untrusted folder they cannot edit files or run commands. Each job has its own permission mode: in SAFE, TRUST, and FULL, a scheduled job runs only terminal commands on your allowlist (for the example above, allow `pytest` and `git commit`); a YOLO job runs any command.

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

**App connectors.** Connect Notion, Linear, Jira & Confluence, Gmail, Google Calendar, Google Drive, Stripe, Sentry, Supabase, Neon and 41 more apps in one click. Each connector is the app's own official remote MCP server: you sign in once in your browser, and the app is available in every trusted project. GitHub, Airtable, Render and PagerDuty connect with an access token instead; Andromity checks the token before saving it and keeps it in the encrypted token store. Open `/settings` → **MCP** → **Connect an app** in the terminal, or **MCP Servers** → **Discover** in VS Code. Gmail, Calendar and Drive are in Google's Workspace Developer Preview and need your own Google OAuth client, because Google doesn't let apps register themselves.

**MCP support.** Add any other server in `.andromity/mcp.json` or `.vscode/mcp.json` in your project, or `~/.andromity/mcp.json` for all projects. Tool schemas load on demand, which keeps token use down when many tools are connected.

**Sessions.** Everything is saved. `/sessions` or `Ctrl+O` to switch. `/compact` when context gets heavy. `/undo` to revert the last turn and all its file changes.

**Headless / scripted runs.**
```bash
andromity run "add error handling to auth.py"
andromity run "refactor this to async" --yes      # auto-approve everything (also marks the current folder as trusted)
andromity run "review session.py" --dry-run       # see what it would do
```

**Model-agnostic.** LiteLLM under the hood. Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Swap mid-session with `Ctrl+L`.

---

## Privacy

Your code goes to the model provider you configure. With a local Ollama model, inference stays on your machine. The built-in `andromity` provider routes requests through the Andromity edge gateway, which forwards them without storing prompts, source code, or completions.

- API keys stay on your machine in `~/.andromity/config.toml` (`%APPDATA%\andromity\config.toml` on Windows); keep that file private
- Sessions stored locally in `~/.andromity/sessions/`
- Opt out of anonymous usage telemetry: `export DO_NOT_TRACK=1` or `ANDROMITY_NO_TELEMETRY=1`

---

## FAQ

**What is Andromity?**
Andromity is an open-source AI coding agent for VS Code and the terminal. It reads your repository, proposes a plan, edits files, and runs commands such as your tests. Folder trust and permission modes control what it may do, and you choose the model: a cloud provider with your own API key or a local Ollama model.

**Is Andromity free?**
Yes. Andromity is open source under the MIT license. With your own API key, your model provider bills its own usage. Local Ollama models have no API charge; performance depends on your hardware and model.

**Can Andromity run locally with Ollama?**
Yes. Select Ollama in the model picker (or `/model` in the terminal) and choose an installed model that supports tool calling. Inference then runs on your machine. See the [local Ollama guide](https://andromity.agenticmarket.dev/docs/guides/local-ollama).

**Can the agent run commands without asking?**
Not in an untrusted folder: file writes and commands are blocked there whatever the permission mode. In a trusted folder, SAFE mode asks before each plan, edit, and command; YOLO runs without prompts. See [workspace trust and permission modes](https://andromity.agenticmarket.dev/docs/security).

**Does Andromity support MCP?**
Yes. Connect apps such as Notion, Linear, Gmail or Stripe in one click from Settings, or add any MCP server in a project `mcp.json`. Tool schemas load on demand instead of filling the prompt up front, so many connected tools don't exhaust the context window.

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

⭐ **Loved the Live Waterfall profiler or saved hours debugging?** Consider giving Andromity a star on GitHub — it helps more developers discover free, open-source AI tooling!

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

