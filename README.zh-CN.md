<div align="center">
  <img src="andromity.png" alt="Andromity" width="60" height="60" />

  # Andromity

  **终端 AI 编程智能体。自主随心，信任把关。**

  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>

  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Version](https://img.shields.io/badge/version-0.2.3-blueviolet)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | 简体中文 | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

---

Andromity 是一个内置 AI 智能体的终端工作空间。它不是一个聊天窗口，也不是一个插件，而是一个真正的工作空间 —— 会话、差异对比 (diff)、文件查看器、cron 调度器、配置文件 —— 全部都在你的终端中，并配备了一个真正能干活的 AI 智能体。

与众不同之处在于：**除非你声明该文件夹是受信任的，否则什么都不会运行。**

---

## 信任模型的工作原理

当你打开一个文件夹时，Andromity 会询问你是否信任它。这个回答决定了一切 —— 不是你的权限模式，不是你的 API 密钥，也不是你的设置。如果你选择“不”，智能体将无法写入文件、运行命令或触碰任何东西。就是这么绝对。

如果你选择“是”，你可以选择给予智能体多大的权限：

| 模式 | 计划 | 文件写入 | Shell 命令 |
|------|-------|-------------|----------------|
| **SAFE (安全)** | 逐个批准 | 逐个批准 | 逐个批准 |
| **TRUST (信任)** | 自动批准 | 直接执行 — 无需审查 | 直接执行 — 无需审查 |
| **FULL (完全)** | 自动 | 直接执行 | 直接执行 |
| **YOLO (放飞自我)** | 自动 (仅供参考) | 静默执行 | 静默执行 |

建议从 SAFE 模式开始。当你了解智能体在代码库中的行为后，可以切换到 YOLO 模式。你随时可以通过 `/trust` 和 `/untrust` 调整信任状态。

---

## 安装

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# 或者使用 pipx
pipx install andromity
```

需要 Python 3.11+。如果你没有安装 pipx，安装程序会自动处理。

---

## 快速开始

```bash
andromity
```

这将打开工作空间。将其指向一个文件夹，回答信任提示，选择一个模型 —— 就这么简单。开始之前无需任何配置文件。

```bash
# 无头模式 / 脚本执行
andromity run "在 auth.py 中添加错误处理"
andromity run "将其重构为异步" --yes      # 自动批准所有操作
andromity run "审查 session.py" --dry-run       # 演练模式，查看它将做什么
```

---

<!-- 替换为显示信任提示 → diff → 审批流程的 GIF -->
![Andromity 差异对比和审批流程](screen_shot.png)

---

## 功能特性

**调度器 (Scheduler)。** 在你睡觉时定时运行智能体。输入 `/cron` 打开调度器。作业按项目保存在 `.andromity/crons.json` 中。适用于任何权限模式 —— 使用 YOLO 模式实现完全无人值守运行。

**配置文件 (Profiles)。** 切换智能体尝试执行的任务。
- `builder` (构建者) — 先计划，后实施
- `coder` (编码者) — 直接实施，没有计划阶段
- `reviewer` (审查者) — 只读，生成发现报告
- `planner` (计划者) — 仅计划，不修改任何内容

**MCP 支持。** 在你的项目中放置一个 `mcp.json`。工具会被懒加载 —— 模式(schemas)优先索引，完整的有效载荷(payloads)仅在智能体实际需要时才加载。即使连接了 50 多个工具，也能保持合理的 token 消耗。

**会话 (Sessions)。** 所有内容都会被保存。使用 `/sessions` 或 `Ctrl+O` 在会话之间切换。当上下文变得沉重时使用 `/compact`。使用 `/undo` 撤销上一个回合及其所有文件更改。

**声音通知 (Sound notifications)。** 当智能体需要审批或完成回合时，会通过声音提醒你。在 `Ctrl+E → Advanced → Sounds` 中可独立切换。

**模型不可知 (Model-agnostic)。** 底层使用 LiteLLM。支持 Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM。使用 `Ctrl+L` 在会话中途切换。

---

## 对比

> ⚠️ **发布前验证** — 确认竞争对手的列与他们当前的文档是否相符。

| | Andromity | Aider | OpenCode |
|--|-----------|-------|----------|
| 文件夹信任模型 | ✅ | ❌ | ❌ |
| 权限级别 (SAFE → YOLO) | ✅ | ❌ | 部分 |
| 内置 cron 调度器 | ✅ | ❌ | ❌ |
| 内联差异对比 (diff) 视图 | ✅ | ✅ | ✅ |
| 会话管理 | ✅ | ❌ | ✅ |
| 智能体配置文件 (Profiles) | ✅ | ❌ | 部分 |
| 优先本地、自带密钥 (BYOK) | ✅ | ✅ | ✅ |
| MCP 支持 | ✅ | ❌ | ✅ |

---

## 隐私

你的代码只会去到一个地方：你配置的 LLM 提供商。而不是我们这里。

- API 密钥保存在 `~/.andromity/config.toml` 中
- 会话保存在本地的 `~/.andromity/sessions/` 中
- 首次启动时的匿名 Ping —— 不包含代码、路径或密钥。详细信息请参阅 [telemetry-worker/README.md](telemetry-worker/README.md)
- 选择退出：`export DO_NOT_TRACK=1`，或在配置中设置 `telemetry = false`，或通过 `Ctrl+E → Advanced → Telemetry`

---

> ✦ *这里并没有记录每一个命令。探索发现也是体验的一部分。*

---

## 参与贡献

欢迎提交 Issue 或 PR。目前，真实的反馈和 bug 报告比功能请求更有用。

项目结构和开发设置请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

**MIT** 协议 — 详见 [LICENSE](LICENSE)。

---

<div align="center">
  <img src="screen_shot.png" alt="Andromity in action" width="100%" />
</div>
