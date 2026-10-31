<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="80" height="80" />

  # Andromity — AI Coding Agent for VS Code

  **Your AI agent just changed 30 files. Andromity shows you exactly what it did.**

  **The open-source coding agent with built-in agent observability: Waterfall, Fingerprint and Blast radius trace every model call, file read, edit and command. A free alternative to Cline, Claude Code and Cursor. Bring your own API key or run local models with Ollama.**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.25-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![VS Code](https://img.shields.io/badge/VS_Code-%5E1.85.0-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-informational)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)

  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/agenticmarket/andromity/blob/main/LICENSE)

  [Website](https://andromity.agenticmarket.dev) • [Docs](https://andromity.agenticmarket.dev/docs) • [Integrations](https://andromity.agenticmarket.dev/integrations) • [Quickstart](https://andromity.agenticmarket.dev/docs/quickstart) • [GitHub](https://github.com/agenticmarket/andromity) • [Report Issue](https://github.com/agenticmarket/andromity/issues)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp?v=0.2.8" alt="Andromity AI coding agent with agent observability: live Waterfall trace of every model call, file edit and command in VS Code" width="100%" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);" />
</div>

---

**Andromity** is an open-source (MIT), BYOK (Bring Your Own Key) AI coding agent for VS Code. It plans multi-file tasks, edits code, runs commands and tests, and manages parallel subagents, while you review its plans, inspect native diffs, and roll back a turn with one click. Use it as an open-source alternative to Cline, Kilo Code, Claude Code, or the agent modes in Copilot and Cursor.

Connect your preferred AI provider (**Anthropic Claude, OpenAI, Google Gemini, DeepSeek, Groq, OpenRouter, NVIDIA NIM**) or run models **locally and free with Ollama**.

---

## 🔎 See Exactly What the Agent Did

Agents edit dozens of files and run commands faster than you can follow. Andromity records the whole run and gives you three views of it:

- **🌊 Waterfall.** A live timeline of reasoning turns, model calls, terminal commands, file edits, web searches and parallel subagents. Inspect each span's timing and details. Click the 🌊 **Waterfall** button in the chat header, or run **Andromity: Waterfall Trace**.
- **🧬 Fingerprint.** What the agent read, changed, ran and delegated, turn by turn: agent time, files changed, files read, commands run, and sensitive files accessed or blocked. Filter by changed, read, shell, subagents or sensitive; open any file at the line the agent touched; drill into a subagent's run; export the session as JSON.
- **💥 Blast radius.** Each turn drawn as a hub with everything it touched around it, so you can see at a glance how far a change reached. Paths matching the agent's sensitive-path rules (`.env` files, SSH keys, cloud credentials, files named like secrets or tokens) are flagged.

Open Fingerprint and Blast radius from the Waterfall panel, or run **Andromity: Fingerprint Trace & Blast Radius**.

---

## ✨ Interactive Welcome Walkthrough

New to Andromity? The built-in walkthrough gets you oriented in about a minute:
1. Press `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS) to open the Command Palette.
2. Select **`Andromity: Welcome / Getting Started`** (or use the welcome icon in the Andromity panel header).
3. Follow **Get started with Andromity** to tour the agent, planning, and workspace governance.

---

## ⚡ Quick Start

### 1. Install Extension
Click **Install** on this Marketplace page, or run `code --install-extension agenticmarket.andromity-agent`.

### 2. Add Your API Key (or Use Local Ollama)
1. Open the **Andromity** panel in the Secondary Side Bar (press `Ctrl+Alt+C` / `Cmd+Alt+C`).
2. Click the ⚙️ **Settings** icon in the panel header.
3. Add the API key for your provider:
   - **Anthropic** (Claude)
   - **OpenAI**
   - **Google Gemini**
   - **DeepSeek**
   - **Groq**
   - **OpenRouter**
   - **NVIDIA NIM**
   - **Ollama (free, local)**: no API key required; just have Ollama running on your machine. Pick a model that supports tool calling.

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp?v=0.2.8" alt="Andromity model picker with cloud providers and local Ollama models" width="100%" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);" />
</div>

### 3. Trust Your Workspace and Start
Click **Trust Folder** in the chat panel (or type `/trust`) once you've reviewed the repository; the agent cannot read, edit, or run anything in an untrusted folder. Then ask a question or describe a feature you want to build.

---

## 🚀 How to Use Andromity in Your Workflow

### 💬 1. Interactive Sidebar Chat
- Chat with the agent about your workspace.
- Attach files or selected lines with **Add to Andromity** from the editor's right-click menu.
- Type `@` to call a skill.
- The agent reads files, diagnoses bugs, implements features, and writes tests.

### 📝 2. Live Task Planner & Blueprints
For larger tasks, the Builder profile writes an implementation plan before editing.
- In SAFE and TRUST modes, review the plan, then approve it or send feedback. FULL and YOLO modes approve plans automatically.
- Watch each step's status update as the agent works.

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="Live Task Planner and Step Blueprints" width="100%" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);" />
</div>

### 🔍 3. Native Diff Review
- In SAFE mode, you approve each file edit before it is written.
- The **Changes Review** panel lists every file the agent changed, opens each one in a native VS Code diff, and lets you revert files individually.

### ⏪ 4. One-Click Rollback
Took a wrong turn? Run **Undo Last Turn & Rollback Diff** from the panel header or the Command Palette. Andromity restores the files changed in that turn without rewriting your Git history.

### 🤖 5. Multi-Agent & Parallel Subagents
Spawn background subagents for research, file scanning, or isolated implementation work while you keep chatting in the main session.

### 🔌 6. App Connectors & MCP
Open **Andromity Hub → MCP Servers → Discover** ([see every app and its setup guide](https://andromity.agenticmarket.dev/integrations)) and connect Notion, Linear, Jira & Confluence, Gmail, Google Calendar, Google Drive, Stripe, Sentry, Supabase, Neon and more in one click. Each is the app's official remote MCP server; you sign in once in your browser and it works in every trusted workspace. Gmail, Calendar and Drive need your own Google OAuth client. GitHub, Airtable, Render and PagerDuty connect with an access token, which Andromity checks before saving.

**Yours** lists everything you've connected, with status, tools, re-authenticate and remove. You can still add any other MCP server through `.andromity/mcp.json` or `.vscode/mcp.json`. Tool schemas load on demand to keep token use down.

### ✏️ 7. Inline Edit
Select code and press `Ctrl+I` (`Cmd+I`), describe the change, then accept with `Ctrl+Enter` (`Cmd+Enter`) or reject with `Escape`.

### 🖱️ 8. Right-Click Context Menu
Highlight code, right-click, and open the **Andromity** menu:
- **Inline Edit** (`Ctrl+I`)
- **Ask About Selection** (`Ctrl+Alt+A`)
- **Explain Code** (`Ctrl+Alt+E`)
- **Fix Diagnostics & Errors**
- **Generate Unit Tests** (`Ctrl+Alt+T`)

### 🧩 9. Works with Copilot Chat
Mention **@andromity** in VS Code's Chat view to ask the Andromity agent to explain, fix, or build something.

### ✍️ 10. AI Git Commit Messages
Click the **Andromity icon** in the Source Control panel title bar to generate a commit message from your changes.

### 🌊 11. Waterfall, Fingerprint & Blast Radius
Trace every model call, file read, edit and command the agent made. See [See Exactly What the Agent Did](#-see-exactly-what-the-agent-did).

---

## 🔐 Trust Governance (Permission Modes)

Folder trust comes first: in an untrusted folder the agent cannot read files, edit them, or run commands, whatever the mode. Within a trusted folder, the permission mode decides what needs your approval:

| Mode | Plans | File edits | Terminal commands |
|------|-------|-------------|-------------------|
| **SAFE** *(default)* | You approve | You approve each edit | You approve each command |
| **TRUST** | You approve | Applied directly, except sensitive or execution-control files (`.git`, `.vscode`, `.andromity`, `package.json`, …), which ask | Allowlisted commands run directly; others ask |
| **FULL** | Auto-approved | Applied directly | Run directly |
| **YOLO** | Auto-approved | Applied directly | Run directly |

Profile restrictions still apply in every mode: Planner and Reviewer never edit files or run commands. Switch modes anytime from the mode menu in the chat panel.

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="Trust and Workspace Governance" width="100%" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);" />
</div>

---

## 🤖 4 Specialized Agent Profiles

Switch profiles depending on what you're working on:

- **🏗️ Builder** *(default)*: Plans complex changes first, then implements them.
- **⚡ Coder**: Implements directly, without a structured planning step.
- **🧐 Reviewer**: Inspects code and reports findings without edits or commands.
- **📐 Planner**: Creates plans without editing project code or running commands.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | macOS | Action |
|----------|-------|--------|
| `Ctrl+Alt+C` | `Cmd+Alt+C` | Open Andromity Chat |
| `Ctrl+I` | `Cmd+I` | Inline Edit |
| `Ctrl+Enter` | `Cmd+Enter` | Accept Inline Edit |
| `Escape` | `Escape` | Reject Inline Edit |
| `Ctrl+Alt+A` | `Cmd+Alt+A` | Ask About Selected Code |
| `Ctrl+Alt+E` | `Cmd+Alt+E` | Explain Selected Code |
| `Ctrl+Alt+T` | `Cmd+Alt+T` | Generate Unit Tests for Selection |

---

## ⚙️ Extension Settings

Customize Andromity in **Settings** (`Ctrl+,` → search `Andromity`):

- `andromity.defaultProvider`: Default AI provider (`anthropic`, `openai`, `google`, `groq`, `openrouter`, `ollama`, `nvidia`).
- `andromity.defaultModel`: Default model (default `claude-sonnet-4-6`).
- `andromity.defaultProfile`: Default agent profile (`builder`, `coder`, `reviewer`, `planner`).
- `andromity.permissionMode`: Default permission mode (`safe`, `trust`, `full`, `yolo`).
- `andromity.reasoningEffort`: Thinking effort for reasoning models (default `auto`; pick supported levels in the chat model picker, or `budget:<tokens>` for models with a thinking-token budget).
- `andromity.soundNotifications`: Turn completion sound cues on or off.
- `andromity.telemetry`: Usage and performance telemetry linked to a random installation ID; never prompts, code or file paths ([full list](https://github.com/agenticmarket/andromity/blob/main/TELEMETRY.md)). On by default; also follows VS Code's telemetry setting.

---

## 🔒 Privacy & Security

- **Where your code goes:** to the model provider you choose. The built-in Andromity provider routes requests through the Andromity edge gateway, which forwards them without storing prompts, code, or completions. For quotas and abuse prevention it keeps request metadata (account or install ID, a keyed IP fingerprint, country, model and token counts) for 14 days.
- **API keys:** stored on your machine in the Andromity config file (`~/.andromity/config.toml`, or `%APPDATA%\andromity\config.toml` on Windows); keep that file private. Sign-in tokens use VS Code Secret Storage.
- **Telemetry:** usage and performance data linked to a random installation ID: client, OS, version, country, provider and model name, session length and turn counts, task outcomes, error categories, and which features are used (feature names such as `fingerprint`). Never prompts, code, file paths, or model output. Full list: [TELEMETRY.md](https://github.com/agenticmarket/andromity/blob/main/TELEMETRY.md). Turn it off with `andromity.telemetry`, VS Code's telemetry setting, or `DO_NOT_TRACK=1`.
- **Local models:** with Ollama, model inference runs on your machine. Web tools, remote MCP servers, and package installs can still use the network.

---

## ❓ FAQ

**What is Andromity?**
An open-source AI coding agent for VS Code and the terminal. It reads your repository, proposes a plan, edits files, and runs commands such as your tests. Folder trust and permission modes control what it may do, and you choose the model.

**Is it free?**
Yes. Andromity is open source under the MIT license. With your own API key, your provider bills its own usage; local Ollama models have no API charge.

**Can it run locally with Ollama?**
Yes. Choose Ollama in the model picker and an installed model that supports tool calling. See the [local Ollama guide](https://andromity.agenticmarket.dev/docs/guides/local-ollama).

**Can the agent run commands without asking?**
Not in an untrusted folder. In a trusted folder, SAFE mode asks before each edit and command; FULL and YOLO run without prompts. See [workspace trust and permission modes](https://andromity.agenticmarket.dev/docs/security).

**How does it compare with Claude Code, Cursor, Cline, or Aider?**
See the [comparison table](https://github.com/agenticmarket/andromity#how-it-compares), checked against each tool's official documentation.

---

## 🌐 Links & Community

- 🏠 **Website:** [andromity.agenticmarket.dev](https://andromity.agenticmarket.dev)
- 📚 **Documentation:** [andromity.agenticmarket.dev/docs](https://andromity.agenticmarket.dev/docs)
- 🔌 **Integrations:** [andromity.agenticmarket.dev/integrations](https://andromity.agenticmarket.dev/integrations)
- 🐙 **GitHub:** [agenticmarket/andromity](https://github.com/agenticmarket/andromity)
- 📋 **Changelog:** [CHANGELOG.md](CHANGELOG.md)
- 💬 **Discussions & Feedback:** [GitHub Discussions](https://github.com/agenticmarket/andromity/discussions)
- 🐛 **Bug Reports & Requests:** [GitHub Issues](https://github.com/agenticmarket/andromity/issues)

---

<div align="center">

**Built with ❤️ for developers by [AgenticMarket](https://github.com/agenticmarket)**

[MIT License](https://github.com/agenticmarket/andromity/blob/main/LICENSE)

</div>
