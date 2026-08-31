<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="80" height="80" />

  # Meet Andromity

  **Autonomous AI coding agent right inside VS Code.**
  Trust-gated. Multi-model. Built for developers who ship.

  [![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/agenticmarket.andromity?label=VS%20Marketplace&logo=visualstudiocode&color=blueviolet)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity)
  [![Installs](https://img.shields.io/visual-studio-marketplace/i/agenticmarket.andromity?color=brightgreen)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/agenticmarket/andromity/blob/main/LICENSE)
  [![GitHub](https://img.shields.io/badge/GitHub-agenticmarket%2Fandromity-181717?logo=github)](https://github.com/agenticmarket/andromity)

  [Website](https://andromity.dev) • [GitHub](https://github.com/agenticmarket/andromity) • [Documentation](https://andromity.dev) • [Report Issue](https://github.com/agenticmarket/andromity/issues)

</div>

---

**Andromity** is an AI coding assistant designed to give you superpowers in VS Code. It doesn't just autocomplete or guess code — it plans out complex architectural tasks, shows you live step-by-step blueprints, lets you review diffs before applying, and gives you instant one-click rollback if you change your mind.

Connect your preferred AI model (**Claude, GPT-4o, Gemini, DeepSeek, Groq**) or run **100% locally and free with Ollama**.

---

## ⚡ Quick Start — Up and Running in Seconds

### 1. Install Extension
Click **Install** on this Marketplace page. That's it!

### 2. Add Your API Key (or Use Local Ollama)
1. Open the **Andromity** tab in your Activity Bar (left sidebar).
2. Click the ⚙️ **Settings** icon in the header.
3. Paste the API key for your favorite provider:
   - **Anthropic** (Claude 3.7 / 3.5 Sonnet)
   - **OpenAI** (GPT-4o, o3-mini)
   - **Google Gemini** (Gemini 2.5 Pro / Flash)
   - **Groq** (Llama 3.3 70B, DeepSeek)
   - **DeepSeek / OpenRouter**
   - **Ollama (Free / Local)**: No API key required! Just have Ollama running locally on your machine.

### 3. Start Coding!
Press `Ctrl+Alt+C` (`Cmd+Alt+C` on macOS) or open the sidebar. Ask a question, select a file, or describe a feature you want to build.

---

## 🚀 How to Use Andromity in Your Workflow

### 💬 1. Interactive Sidebar Chat
- Chat directly with the AI about your workspace.
- Reference files with `@` mentions.
- The agent reads files, diagnoses bugs, implements features, and writes tests.

### 📝 2. Live Step-by-Step Plans
When tackling complex tasks, Andromity creates an interactive implementation plan first.
- Review steps before changes happen.
- Approve, skip, or edit steps individually.
- Watch real-time execution status for each task.

### 🔍 3. Side-by-Side Diff Review
Every change proposed by the agent is presented as a native VS Code diff.
- See exact additions and deletions.
- Accept changes file-by-file or accept all at once.

### ⏪ 4. One-Click Rollback (`/undo`)
Made a turn you don't like? Simply trigger **Undo Last Turn** from the header menu or command palette. Andromity rolls back all file changes from that turn instantly without touching your git history.

### 🖱️ 5. Right-Click Context Menu Superpowers
Highlight any snippet in your code editor, right-click, and choose:
- **Ask About Selection** (`Ctrl+Alt+A`): Inquire about logic or behavior.
- **Explain Code** (`Ctrl+Alt+E`): Get a breakdown of what the code does.
- **Fix Diagnostics & Errors**: Auto-resolve type errors, linter warnings, or crashes.
- **Generate Unit Tests** (`Ctrl+Alt+T`): Auto-generate complete test suites for your functions or classes.

### ✍️ 6. AI Git Commit Messages
Click the **Andromity icon** directly in the Source Control panel title bar to generate a clean, descriptive commit message based on your staged changes.

---

## 🔐 Trust Governance (Permission Modes)

You are always in control of what the agent does in your workspace:

| Mode | Plans | File Writes | Terminal Commands |
|------|-------|-------------|-------------------|
| **SAFE** *(default)* | You approve each one | You approve each one | You approve each one |
| **TRUST** | You approve | Direct (No review needed) | Direct (No review needed) |
| **FULL** | Auto-runs with live log | Direct | Direct |
| **YOLO** | Auto-runs silently | Silent | Silent |

Switch modes anytime by clicking the permission badge in the top bar or via `Andromity: Switch Permission Mode`.

---

## 🤖 4 Specialized Agent Profiles

Switch profiles depending on what you're working on:

- **🏗️ Builder** *(default)*: Plans out tasks first, then implements them.
- **⚡ Coder**: Fast direct implementation without an upfront planning stage.
- **🧐 Reviewer**: Read-only mode for code audits, security checks, and PR reviews.
- **📐 Planner**: Generates architectural specs and technical plans without modifying code.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | macOS | Action |
|----------|-------|--------|
| `Ctrl+Alt+C` | `Cmd+Alt+C` | Open Andromity Chat |
| `Ctrl+Alt+A` | `Cmd+Alt+A` | Ask About Selected Code |
| `Ctrl+Alt+E` | `Cmd+Alt+E` | Explain Selected Code |
| `Ctrl+Alt+T` | `Cmd+Alt+T` | Generate Unit Tests for Selection |

---

## ⚙️ Extension Settings

Customize Andromity in **Settings** (`Ctrl+,` → search `Andromity`):

- `andromity.defaultProvider`: Default AI provider (`anthropic`, `openai`, `google`, `groq`, `openrouter`, `ollama`, `nvidia`).
- `andromity.defaultModel`: Default model (e.g., `claude-sonnet-4-6`, `gpt-4o`, `gemini-2.5-pro`).
- `andromity.defaultProfile`: Default agent profile (`builder`, `coder`, `reviewer`, `planner`).
- `andromity.permissionMode`: Default trust mode (`safe`, `trust`, `full`, `yolo`).
- `andromity.reasoningEffort`: Thinking level for reasoning models (`off`, `low`, `medium`, `high`).
- `andromity.soundNotifications`: Enable or disable turn completion sound cues.

---

## 🔒 Privacy & Security First

- **Zero Data Collection:** Your code and prompts go strictly between your machine and your chosen AI provider.
- **Local Secret Storage:** API keys are encrypted locally using VS Code's native Secret Storage API.
- **100% Offline Capability:** Use Ollama to keep all code and conversations strictly local on your machine.

---

## 🌐 Links & Community

- 🏠 **Website:** [andromity.dev](https://andromity.dev)
- 🐙 **GitHub:** [agenticmarket/andromity](https://github.com/agenticmarket/andromity)
- 💬 **Discussions & Feedback:** [GitHub Discussions](https://github.com/agenticmarket/andromity/discussions)
- 🐛 **Bug Reports & Requests:** [GitHub Issues](https://github.com/agenticmarket/andromity/issues)

---

<div align="center">

**Built with ❤️ for developers by [Agentic Market](https://github.com/agenticmarket)**

[MIT License](https://github.com/agenticmarket/andromity/blob/main/LICENSE)

</div>
