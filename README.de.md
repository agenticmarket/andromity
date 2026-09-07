<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — KI-Coding-Agent für VS Code & Terminal

  **Vertrauensgesteuerter, autonomer BYOK-Coding-Agent mit Subagenten, Live-Plänen, nativen Diffs & One-Click-Rollback.**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.8-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![Tests](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml/badge.svg)](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | Deutsch | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** ist ein privater, autonomer BYOK-Coding-Agent (Bring Your Own Key) mit KI. Nutzen Sie ihn in VS Code über die offizielle Erweiterung oder als eigenständigen Terminal-Workspace. Er plant komplexe Aufgaben, steuert parallele Subagenten, visualisiert Schritt-für-Schritt-Pläne live, ermöglicht die Überprüfung nativer Diffs vor der Anwendung und bietet sofortiges One-Click-Rollback.

Verbinden Sie Ihr bevorzugtes KI-Modell (**Claude 3.7 Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek R1 & V3, Groq, OpenRouter**) oder betreiben Sie ihn **100% lokal und kostenlos mit Ollama**.

---

## ⚡ Schnelle Installation & Erste Schritte

### 🚀 Option A: VS Code Erweiterung (Empfohlen)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="In VS Code installieren" />
  </a>
</div>

👉 **Empfohlen:** Installieren Sie die Erweiterung direkt aus dem Marketplace:  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

Oder installieren Sie sie direkt über das Terminal:

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 Option B: Terminal-CLI

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Oder über pipx
pipx install andromity
```

---

## ✨ Hauptfunktionen

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="Live-Aufgabenplaner und Ausführungs-Blueprints" width="100%" />
</div>

### 📝 Live-Aufgabenplaner und Ausführungs-Blueprints
Andromity analysiert Ihre Codebasis, erstellt einen interaktiven Schritt-für-Schritt-Plan und wartet auf Ihre Genehmigung, bevor eine einzige Zeile Code geändert wird. Überprüfen, bestätigen oder überspringen Sie jeden Schritt einzeln.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp" alt="Unterstützung für 396+ Modelle inklusive lokalem Ollama" width="100%" />
</div>

### 🤖 Unterstützung für 396+ Modelle — Inklusive lokalem, kostenlosem Ollama
Verbinden Sie Claude 3.7, GPT-4o, Gemini 2.5 Pro, DeepSeek R1, Groq oder arbeiten Sie zu 100% offline mit Ollama. Wechseln Sie Modelle mitten in der Sitzung mit `Ctrl+L`.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="Vertrauens-Governance" width="100%" />
</div>

### 🔐 Vertrauens-Governance — Sie behalten stets die Kontrolle

| Modus | Pläne | Datei-Schreibvorgänge | Terminal-Befehle |
|------|-------|-------------|-------------------|
| **SAFE** *(Standard)* | Einzeln genehmigen | Einzeln genehmigen | Einzeln genehmigen |
| **TRUST** | Genehmigen | Direkt | Direkt |
| **FULL** | Automatisch | Direkt | Direkt |
| **YOLO** | Automatisch | Lautlos | Lautlos |

Nichts wird ausgeführt, bevor Sie einen Ordner nicht ausdrücklich als vertrauenswürdig eingestuft haben. Starten Sie im SAFE-Modus und wechseln Sie zu YOLO, sobald Sie mit den Aktionen vertraut sind.

---

## Vergleich mit Alternativen

| Funktion | Andromity | Aider | Cursor | Claude Code |
|------|-----------|-------|--------|-------------|
| Ordner-Vertrauensmodell | ✅ | ❌ | ❌ | ❌ |
| Berechtigungsstufen (SAFE → YOLO) | ✅ | ❌ | Teilweise | ❌ |
| **Visueller Wasserfall-Ausführungs-Profiler (Waterfall)** | ✅ | ❌ | ❌ | ❌ |
| **Integrierter Cron-Scheduler** | ✅ | ❌ | ❌ | ❌ |
| **Parallele Sitzungen & Subagenten** | ✅ | ❌ | ❌ | Teilweise |
| Nativer Inline-Diff-Viewer | ✅ | ✅ | ✅ | ✅ |
| Sitzungsverwaltung & `/undo` Rollback | ✅ | ❌ | Teilweise | ❌ |
| Agenten-Profile (Profiles) | ✅ | ❌ | ❌ | Teilweise |
| Local-First / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| MCP-Protokollunterstützung | ✅ | ❌ | Teilweise | ✅ |
| Offizielle VS Code Erweiterung | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Cron-Scheduler — KI, die arbeitet, während Sie schlafen

Kein anderer Coding-Agent bietet diese Möglichkeit. Öffnen Sie `/cron` in Andromity, beschreiben Sie Ihre Aufgabe und legen Sie den Zeitplan fest — der Agent erledigt dies autonom per Timer während Ihrer Abwesenheit.

```bash
# Beispiel: Jede Nacht um 2 Uhr Test-Suite ausführen und Fehler automatisch beheben
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

Aufgaben bleiben pro Projekt in `.andromity/crons.json` gespeichert. Nutzen Sie FULL oder YOLO für komplett unbeaufsichtigte Nachtläufe.

---

## 🤖 Parallele Sitzungen & Subagenten

Starten Sie Hintergrund-Subagenten für parallele Aufgabenströme, ohne Ihre Hauptsitzung zu unterbrechen. Beispiel: Während ein Subagent eine neue Bibliothek recherchiert, implementiert ein anderer ein Feature und Sie prüfen den Gesamtplan in der Hauptsitzung — alles gleichzeitig.

```
Hauptsitzung   → Feature A planen & implementieren
Subagent 1     → Beste Authentifizierungs-Bibliothek recherchieren
Subagent 2     → Unit-Tests für Feature B schreiben
```

Wechseln Sie blitzschnell zwischen allen Sitzungen mit `Ctrl+O`. Jede Sitzung verfügt über eigenen Kontext, Verlauf und Änderungshistorie. `/undo` macht ausschließlich die Änderungen der aktuellen Sitzung rückgängig.

---

## Funktionen im Terminal-Workspace

> Die VS Code-Erweiterung und das Terminal teilen sich denselben Agentenkern. Das Terminal bietet maximale Geschwindigkeit und vollständige Kontrolle.

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**Profile (Profiles).** Passen Sie den Fokus des Agenten während der Sitzung an:
- `builder` — plant zuerst, implementiert danach
- `coder` — implementiert direkt ohne vorherige Planungsphase
- `reviewer` — nur lesend, erstellt Code-Audits und Prüfberichte
- `planner` — plant ausschließlich die Architektur, verändert keine Dateien

**MCP-Unterstützung.** Fügen Sie eine `mcp.json` in Ihr Projekt ein. Werkzeug-Schemas werden bei Bedarf nachgeladen — dadurch bleibt der Token-Verbrauch auch bei 50+ angebundenen Tools minimal.

**Sitzungen.** Alles wird automatisch gespeichert. Nutzen Sie `/sessions` oder `Ctrl+O` zum Wechseln. `/compact`, wenn der Kontext groß wird. `/undo`, um den letzten Schritt inklusive aller Dateiänderungen zurückzunehmen.

**Headless- / Skriptmodus:**
```bash
andromity run "Fehlerbehandlung zu auth.py hinzufügen"
andromity run "in async umwandeln" --yes      # alle Aktionen automatisch bestätigen
andromity run "session.py prüfen" --dry-run       # Testlauf ohne Änderungen
```

**Modell-Unabhängigkeit.** Basiert auf LiteLLM. Unterstützt Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Jederzeit wechselbar mit `Ctrl+L`.

---

## Datenschutz & Privatsphäre

Ihr Code wird ausschließlich an den von Ihnen gewählten LLM-Provider übertragen. Wir sammeln weder Ihren Code noch Ihre Prompts.

- API-Schlüssel werden lokal in `~/.andromity/config.toml` gespeichert (lokal verschlüsselt)
- Sitzungen liegen lokal in `~/.andromity/sessions/`
- Telemetrie deaktivieren: `export DO_NOT_TRACK=1`

---

## GitHub Stars-Verlauf

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## Änderungsprotokoll

Details finden Sie im [CHANGELOG.md](CHANGELOG.md).

---

## Mitwirken

Issues und Pull Requests sind herzlich willkommen!

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für Projektarchitektur und Entwicklungssetup.

**MIT-Lizenz** — siehe [LICENSE](LICENSE).
