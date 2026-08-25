<div align="center">
  <img src="andromity.png" alt="Andromity" width="60" height="60" />

  # Andromity

  **ターミナルAIコーディングエージェント。選べる自律性、信頼による制御。**

  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>

  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Version](https://img.shields.io/badge/version-0.2.3-blueviolet)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | 日本語 | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

---

Andromityは、AIエージェントを内蔵したターミナルワークスペースです。チャットウィンドウではありません。プラグインでもありません。セッション、差分（diff）、ファイルビューア、cronスケジューラ、プロファイルなど、すべてがターミナル内にある適切なワークスペースであり、AIエージェントが実際に作業を行います。

他のツールとの違い：**あなたがフォルダを信頼すると言うまで、何も実行されません。**

---

## 信頼モデルの仕組み

フォルダを開くと、Andromityはそのフォルダを信頼するかどうかを尋ねます。この回答がすべてを制御します。パーミッションモードでも、APIキーでも、設定でもありません。「いいえ」と答えた場合、エージェントはファイルを書き込んだり、コマンドを実行したり、何かに触れたりすることはできません。それでおしまいです。

「はい」と答えた場合、エージェントにどの程度の自由を与えるかを選択します。

| モード | 計画 | ファイル書き込み | Shell コマンド |
|------|-------|-------------|----------------|
| **SAFE** | 毎回承認 | 毎回承認 | 毎回承認 |
| **TRUST** | 承認済み | 直接 — レビューなし | 直接 — レビューなし |
| **FULL** | 自動 | 直接 | 直接 |
| **YOLO** | 自動 (参考として表示) | サイレント | サイレント |

まずはSAFEから始めましょう。エージェントがコードベースで何をするかが分かったら、YOLOに移行してください。いつでも `/trust` と `/untrust` を使用できます。

---

## インストール

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# または pipx を使用
pipx install andromity
```

Python 3.11+が必要です。pipxがない場合はインストーラーが処理します。

---

## 使い方

```bash
andromity
```

これでワークスペースが開きます。フォルダを指定し、信頼のプロンプトに答え、モデルを選択します。それで完了です。開始するために設定ファイルは必要ありません。

```bash
# ヘッドレス / スクリプトでの実行
andromity run "auth.py にエラー処理を追加して"
andromity run "これを非同期 (async) にリファクタリングして" --yes      # すべて自動承認
andromity run "session.py をレビューして" --dry-run       # 何をするかを確認
```

---

<!-- Replace with GIF showing trust prompt → diff → approval flow -->
![Andromity diff and approval flow](screen_shot.png)

---

## 主な機能

**スケジューラー (Scheduler)。** 寝ている間にタイマーでエージェントを実行します。`/cron` でスケジューラーを開きます。ジョブはプロジェクトごとに `.andromity/crons.json` に保存されます。どのパーミッションモードでも機能します — 完全に無人で実行する場合は YOLO を使用してください。

**プロファイル (Profiles)。** エージェントが実行しようとする内容を切り替えます。
- `builder` — 計画してから実装する
- `coder` — 計画フェーズなしで直接実装する
- `reviewer` — 読み取り専用で、調査結果を生成する
- `planner` — 計画のみで、何も変更しない

**MCPサポート。** プロジェクトに `mcp.json` を配置します。ツールは遅延ロードされます — スキーマが最初にインデックス付けされ、エージェントが実際に必要としたときにのみフルペイロードがロードされます。50以上のツールを接続しても、トークン使用量を妥当なレベルに保ちます。

**セッション。** すべてが保存されます。`/sessions` または `Ctrl+O` でセッションを切り替えます。コンテキストが重くなった場合は `/compact` を使用します。`/undo` で最後のアクションとすべてのファイル変更を元に戻します。

**サウンド通知。** エージェントが承認を必要とする場合や、ターンを完了した場合に通知音が鳴ります。`Ctrl+E → Advanced → Sounds` で独立して切り替えることができます。

**モデルに依存しない。** 内部でLiteLLMを使用しています。Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIMに対応。セッションの途中で `Ctrl+L` を使用して切り替えることができます。

---

## 比較

> ⚠️ **公開前に確認** — 競合他社の列が現在のドキュメントと一致しているか確認してください。

| | Andromity | Aider | OpenCode |
|--|-----------|-------|----------|
| フォルダ信頼モデル | ✅ | ❌ | ❌ |
| パーミッションレベル (SAFE → YOLO) | ✅ | ❌ | 部分的 |
| 内蔵cronスケジューラー | ✅ | ❌ | ❌ |
| インラインdiffビューア | ✅ | ✅ | ✅ |
| セッション管理 | ✅ | ❌ | ✅ |
| エージェントプロファイル | ✅ | ❌ | 部分的 |
| ローカルファースト, BYOK | ✅ | ✅ | ✅ |
| MCPサポート | ✅ | ❌ | ✅ |

---

## プライバシー

あなたのコードは、あなたが設定したLLMプロバイダーの1か所のみに送信されます。私たちには送信されません。

- APIキーは `~/.andromity/config.toml` に保存されます
- セッションはローカルの `~/.andromity/sessions/` に保存されます
- 初回起動時の匿名Ping — コード、パス、キーは含まれません。詳細は [telemetry-worker/README.md](telemetry-worker/README.md) にあります
- オプトアウト: `export DO_NOT_TRACK=1` 、設定で `telemetry = false` 、または `Ctrl+E → Advanced → Telemetry`

---

> ✦ *すべてのコマンドがここにドキュメント化されているわけではありません。発見することも体験の一部です。*

---

## コントリビューション

IssueまたはPRを作成してください。現時点では、機能の要望よりも、率直なフィードバックやバグ報告の方が役立ちます。

プロジェクトのレイアウトや開発のセットアップについては [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

**MIT** — [LICENSE](LICENSE) を参照してください。

---

<div align="center">
  <img src="screen_shot.png" alt="Andromity in action" width="100%" />
</div>
