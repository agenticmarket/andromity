<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — VS Code & ターミナル向け AI コーディングエージェント

  **信頼ガバナンス、BYOK、サブエージェント、ライブ計画、ネイティブ差分、ワンクリックロールバックを備えた自律型コーディングエージェント。**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.8-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![Tests](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml/badge.svg)](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | 日本語 | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp?v=0.2.8" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** は、プライベートかつ BYOK（API キー持ち込み）の自律型 AI コーディングエージェントです。VS Code 内で公式拡張機能として利用することも、単体のターミナルワークスペースとして実行することも可能です。複雑なタスクの計画、並列サブエージェントの管理、ステップごとの実行ブループリントの表示、適用前の差分（diff）レビュー、ワンクリックでの即時ロールバックを提供します。

お好みの AI モデル（**Claude 3.7 Sonnet、GPT-4o、Gemini 2.5 Pro、DeepSeek R1 & V3、Groq、OpenRouter**）に接続することも、**Ollama を使って 100% ローカルかつ完全無料** で実行することも可能です。

---

## ⚡ クイックインストールと開始方法

### 🚀 オプション A: VS Code 拡張機能 (推奨)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code にインストール" />
  </a>
</div>

👉 **推奨:** マーケットプレイスから直接インストール:  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

またはターミナルからワンクリックでインストール:

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 オプション B: ターミナル CLI

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# または pipx でインストール
pipx install andromity
```

---

## ✨ 主な機能

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="ライブタスクプランナーと実行ブループリント" width="100%" />
</div>

### 📝 ライブタスクプランナーと実行ブループリント
Andromity はコードベースを分析し、インタラクティブなステップごとの実装計画を作成し、コードを書く前に承認を待ちます。各ステップを個別に確認、承認、スキップできます。

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp?v=0.2.8" alt="無料のローカル Ollama を含む 396+ モデル対応" width="100%" />
</div>

### 🤖 396+ モデル対応 — 無料のローカル Ollama を含む
Claude 3.7、GPT-4o、Gemini 2.5 Pro、DeepSeek R1、Groq に接続、または Ollama で完全オフライン実行可能。セッション中に `Ctrl+L` でモデルを切り替えられます。

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="信頼ガバナンス" width="100%" />
</div>

### 🔐 信頼ガバナンス — 常にあなたがコントロール

| モード | プラン | ファイル書き込み | ターミナルコマンド |
|------|-------|-------------|-------------------|
| **SAFE** *(デフォルト)* | 毎回承認 | 毎回承認 | 毎回承認 |
| **TRUST** | 承認 | 直接実行（確認なし） | 直接実行（確認なし） |
| **FULL** | 自動 | 直接実行 | 直接実行 |
| **YOLO** | 自動 | サイレント実行 | サイレント実行 |

フォルダを信頼済みとして宣言するまで、エージェントは一切ファイルやコマンドを実行しません。SAFE モードから始めて、動作を把握したら YOLO モードに移行できます。

---

## 他ツールとの比較

| 機能 | Andromity | Aider | Cursor | Claude Code |
|------|-----------|-------|--------|-------------|
| フォルダ信頼ガバナンスモデル | ✅ | ❌ | ❌ | ❌ |
| 権限レベル (SAFE → YOLO) | ✅ | ❌ | 一部対応 | ❌ |
| **リアルタイム実行ウォーターフォールプロファイラ** | ✅ | ❌ | ❌ | ❌ |
| **内蔵 Cron スケジューラ** | ✅ | ❌ | ❌ | ❌ |
| **並列セッションとサブエージェント** | ✅ | ❌ | ❌ | 一部対応 |
| インラインネイティブ差分ビューア | ✅ | ✅ | ✅ | ✅ |
| セッション管理と `/undo` ロールバック | ✅ | ❌ | 一部対応 | ❌ |
| エージェントプロファイル (Profiles) | ✅ | ❌ | ❌ | 一部対応 |
| ローカル優先 / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| MCP プロトコル対応 | ✅ | ❌ | 一部対応 | ✅ |
| VS Code 公式拡張機能 | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Cron スケジューラ — 寝ている間に動く AI

他の AI コーディングエージェントにはない機能です。Andromity 内で `/cron` を開き、タスクを書いてスケジュールを設定するだけで、不在の間もタイマーで自律実行されます。

```bash
# 例: 毎晩深夜 2 時にテストを実行し、失敗した箇所を自動修正してコミット
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

ジョブはプロジェクトごとに `.andromity/crons.json` に保存されます。FULL または YOLO モードを使用すれば、完全な夜間無人実行が可能です。

---

## 🤖 並列セッションとサブエージェント

メインセッションを中断することなく、並行して作業を進めるバックグラウンドサブエージェントを生成できます。例：1つのサブエージェントが新しいライブラリを調査している間に、別のサブエージェントが機能を実装し、あなた自身はメインセッションで全体計画をレビューする — すべて同時に進行できます。

```
メインセッション    → 機能 A の計画と実装
サブエージェント 1  → 最適な認証ライブラリの調査
サブエージェント 2  → 機能 B の単体テスト作成
```

すべてのセッションは `Ctrl+O` で簡単に切り替えられます。各セッションは独自のコンテキスト、履歴、変更ログを持ちます。`/undo` は現在のセッションの変更のみを元に戻します。

---

## ターミナルワークスペースの機能

> VS Code 拡張機能とターミナルは同じエージェントコアを共有しています。ターミナルワークスペースは圧倒的なスピードと柔軟性を提供します。

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**プロファイル (Profiles)。** セッションの途中でエージェントの目的を切り替えます：
- `builder` — 最初に計画を立て、その後実装
- `coder` — 計画フェーズをスキップして直接実装
- `reviewer` — 読み取り専用で、コードレビューやセキュリティ監査レポートを作成
- `planner` — コードを変更せず、仕様と計画のみを作成

**MCP 対応。** プロジェクトに `mcp.json` を配置します。ツールのスキーマはオンデマンドで遅延ロードされ、50以上のツールを接続してもトークン消費を最小限に抑えます。

**セッション。** すべて自動保存されます。`/sessions` または `Ctrl+O` で切り替え。コンテキストが大きくなった場合は `/compact` を実行。直前のターンの変更をすべて戻すには `/undo` を使用します。

**ヘッドレス / スクリプト実行：**
```bash
andromity run "auth.py にエラーハンドリングを追加"
andromity run "これを async にリファクタリング" --yes      # 全アクションを自動承認
andromity run "session.py をレビュー" --dry-run       # 実行内容をシミュレーション
```

**モデル非依存。** 内部で LiteLLM を採用。Anthropic、OpenAI、Gemini、Groq、OpenRouter、Ollama、NVIDIA NIM に対応。`Ctrl+L` でいつでも切り替え可能。

---

## プライバシーとセキュリティ

あなたのコードは、設定した LLM プロバイダーとの間でのみ送受信されます。私たちがコードやプロンプトを収集することはありません。

- API キーはローカルの `~/.andromity/config.toml` に暗号化して保存
- セッションはローカルの `~/.andromity/sessions/` に保存
- テレメトリの無効化: `export DO_NOT_TRACK=1`

---

## スター履歴 (Star History)

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## 更新履歴

詳細は [CHANGELOG.md](CHANGELOG.md) をご覧ください。

---

## コントリビューション

Issue や Pull Request を歓迎します！

プロジェクト構成や開発環境については [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

**MIT** — 詳細は [LICENSE](LICENSE) を参照してください。
