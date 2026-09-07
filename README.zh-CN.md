<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — VS Code 与终端的 AI 编程智能体

  **信任把关、BYOK、具备子智能体、实时计划、原生差异对比与一键回滚的自主编程智能体。**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.8-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![Tests](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml/badge.svg)](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | 简体中文 | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** 是一个私密、BYOK（自带 API 密钥）的自主 AI 编程智能体。您可以在 VS Code 中搭配扩展使用，也可以作为独立的终端工作空间运行。它可以规划复杂任务、管理并行子智能体、展示实时分步蓝图、允许在应用前审查差异对比 (diff)，并提供即时的一键回滚。

连接您喜爱的 AI 模型（**Claude 3.7 Sonnet、GPT-4o、Gemini 2.5 Pro、DeepSeek R1 & V3、Groq、OpenRouter**），或者通过 **Ollama 100% 本地免费运行**。

---

## ⚡ 快速安装与开始

### 🚀 方案 A: VS Code 插件 (推荐)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="在 VS Code 中安装" />
  </a>
</div>

👉 **推荐操作：** 直接在官方插件市场中安装：  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

或在终端中一键安装：

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 方案 B: 终端命令行 (CLI)

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# 或者使用 pipx
pipx install andromity
```

---

## ✨ 核心特性

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="实时任务规划器与执行蓝图" width="100%" />
</div>

### 📝 实时任务规划器与执行蓝图
Andromity 深入分析代码库，制定可交互的分步实施计划，并在编写任何代码前等待您的确认。您可以独立审查、批准或跳过任何步骤。

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp" alt="支持 396+ 款模型，包括本地免费 Ollama" width="100%" />
</div>

### 🤖 396+ 款模型支持 — 包括完全免费的本地 Ollama
连接 Claude 3.7、GPT-4o、Gemini 2.5 Pro、DeepSeek R1、Groq，或通过 Ollama 100% 离线运行。随时使用 `Ctrl+L` 在会话中切换模型。

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="信任与工作区治理" width="100%" />
</div>

### 🔐 信任治理 — 一切尽在您的掌控之中

| 模式 | 计划 | 文件写入 | 终端命令 |
|------|-------|-------------|-------------------|
| **SAFE** *(默认)* | 逐项批准 | 逐项批准 | 逐项批准 |
| **TRUST** | 自动批准 | 直接写入 | 直接执行 |
| **FULL** | 自动 | 直接写入 | 直接执行 |
| **YOLO** | 自动 | 静默执行 | 静默执行 |

在您明确将文件夹声明为受信任之前，智能体不会运行任何操作。从 SAFE 模式开始，熟悉后再进入 YOLO 模式。

---

## 竞品对比

| 功能 | Andromity | Aider | Cursor | Claude Code |
|------|-----------|-------|--------|-------------|
| 文件夹信任治理模型 | ✅ | ❌ | ❌ | ❌ |
| 权限级别 (SAFE → YOLO) | ✅ | ❌ | 部分支持 | ❌ |
| **实时执行瀑布追踪分析器 (Waterfall)** | ✅ | ❌ | ❌ | ❌ |
| **内置 Cron 定时调度器** | ✅ | ❌ | ❌ | ❌ |
| **并行会话与子智能体** | ✅ | ❌ | ❌ | 部分支持 |
| 内联原生差异对比 (Diff) | ✅ | ✅ | ✅ | ✅ |
| 会话管理与一键撤销 `/undo` | ✅ | ❌ | 部分支持 | ❌ |
| 智能体角色配置 (Profiles) | ✅ | ❌ | ❌ | 部分支持 |
| 本地优先 / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| MCP 协议支持 | ✅ | ❌ | 部分支持 | ✅ |
| VS Code 官方插件 | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Cron 定时调度器 — 在您入睡时自动工作的 AI

其他任何 AI 编程工具都不具备此功能。在 Andromity 中输入 `/cron`，编写任务并设定定时计划 —— 智能体将在后台按时自动执行。

```bash
# 示例：每天凌晨 2 点自动运行测试套件并修复失败项
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

任务保存在每个项目的 `.andromity/crons.json` 中。使用 FULL 或 YOLO 模式实现完全无人值守的通宵运行。醒来时，提交已经就绪。

---

## 🤖 并行会话与子智能体

在不中断主会话的前提下生成后台子智能体以开展并行工作流。例如：当一个子智能体调研新库时，另一个子智能体编写功能代码，而您在主会话中审查规划 —— 全部同时进行。

```
主会话        → 规划并实现功能 A
子智能体 1    → 调研最适合的认证库
子智能体 2    → 为功能 B 编写单元测试
```

使用 `Ctrl+O` 在所有会话之间随时切换。每个会话都有自己独立的上下文、历史记录和文件修改日志。`/undo` 仅撤销当前会话的更改。

---

## 终端工作区特性

> VS Code 插件与终端工作区共享相同的智能体核心引擎。终端工作区为您带来极致的极客掌控感。

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**角色配置 (Profiles)。** 在会话中切换智能体的工作目标：
- `builder` — 先制定计划，再动手实现
- `coder` — 直接编写代码，跳过规划阶段
- `reviewer` — 只读模式，输出审查建议与安全审计报告
- `planner` — 仅做架构设计与规划，不修改任何文件

**MCP 支持。** 在项目中放置 `mcp.json`。工具模式 (schemas) 按需惰性加载 —— 即使连接 50+ 个工具也能保持极低 Token 消耗。

**会话管理。** 一切皆自动保存。使用 `/sessions` 或 `Ctrl+O` 切换。上下文较长时使用 `/compact` 压缩。使用 `/undo` 撤销上一个回合及其所有的文件修改。

**无头模式 / 脚本执行：**
```bash
andromity run "在 auth.py 中添加错误处理"
andromity run "将其重构为异步" --yes      # 自动批准所有操作
andromity run "审查 session.py" --dry-run       # 演练模式，查看它将做什么
```

**模型中立。** 底层由 LiteLLM 驱动。支持 Anthropic、OpenAI、Gemini、Groq、OpenRouter、Ollama、NVIDIA NIM。使用 `Ctrl+L` 即可在会话中随时切换。

---

## 隐私安全

您的代码只会发送给您配置的 LLM 服务商。我们绝不收集任何代码或提示词。

- API 密钥存储在本地 `~/.andromity/config.toml` 中 — 本地加密存储
- 会话保存在本地 `~/.andromity/sessions/`
- 退出遥测：`export DO_NOT_TRACK=1`

---

## 历史标星

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## 更新日志

详情参见 [CHANGELOG.md](CHANGELOG.md)。

---

## 参与贡献

欢迎提交 Issue 或 Pull Request！

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解项目结构与开发环境配置。

**MIT** — 详见 [LICENSE](LICENSE)。
