<div align="center">
  <img src="andromity.png" alt="Andromity" width="60" height="60" />

  # Andromity

  **Ein Terminal-KI-Coding-Agent. Autonom nach Wahl, abgesichert durch Vertrauen.**

  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>

  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Version](https://img.shields.io/badge/version-0.2.3-blueviolet)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | Deutsch | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

---

Andromity ist ein Terminal-Arbeitsbereich mit einem integrierten KI-Agenten. Kein Chat-Fenster. Kein Plugin. Ein richtiger Arbeitsbereich – Sitzungen, Diffs, Dateibetrachter, Cron-Scheduler, Profile – alles in deinem Terminal, mit einem KI-Agenten, der wirklich Dinge erledigt.

Der große Unterschied: **Nichts wird ausgeführt, bis du angibst, dass der Ordner vertrauenswürdig ist.**

---

## Wie das Vertrauensmodell funktioniert

Wenn du einen Ordner öffnest, fragt Andromity, ob du ihm vertraust. Diese Antwort steuert alles – nicht dein Berechtigungsmodus, nicht dein API-Schlüssel, nicht deine Einstellungen. Wenn du Nein sagst, kann der Agent keine Datei schreiben, keinen Befehl ausführen und nichts anfassen. Punkt.

Wenn du Ja sagst, wählst du, wie viel Spielraum der Agent bekommt:

| Modus | Pläne | Dateien schreiben | Shell-Befehle |
|------|-------|-------------|----------------|
| **SAFE** | Jeden genehmigen | Jeden genehmigen | Jeden genehmigen |
| **TRUST** | Genehmigen | Direkt – keine Überprüfung | Direkt – keine Überprüfung |
| **FULL** | Auto | Direkt | Direkt |
| **YOLO** | Auto (nur zur Info) | Still | Still |

Beginne mit SAFE. Wechsle zu YOLO, wenn du weißt, was der Agent in deiner Codebasis tut. `/trust` und `/untrust` jederzeit.

---

## Installation

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Oder mit pipx
pipx install andromity
```

Erfordert Python 3.11+. Das Installationsprogramm kümmert sich um pipx, falls du es nicht hast.

---

## Start

```bash
andromity
```

Das öffnet den Arbeitsbereich. Verweise auf einen Ordner, beantworte die Vertrauensfrage, wähle ein Modell – fertig. Keine Konfigurationsdatei für den Start erforderlich.

```bash
# Headless / skriptgesteuert
andromity run "Fehlerbehandlung zu auth.py hinzufügen"
andromity run "das hier zu async refaktorieren" --yes      # alles automatisch genehmigen
andromity run "session.py überprüfen" --dry-run       # sehen, was gemacht werden würde
```

---

<!-- Replace with GIF showing trust prompt → diff → approval flow -->
![Andromity diff and approval flow](screen_shot.png)

---

## Was ist drin

**Scheduler.** Lass den Agenten nach einem Timer laufen, während du schläfst. `/cron` öffnet den Scheduler. Jobs bleiben pro Projekt in `.andromity/crons.json` erhalten. Funktioniert mit jedem Berechtigungsmodus – nutze YOLO für komplett unbeaufsichtigte Durchläufe.

**Profile.** Ändere, was der Agent versuchen soll.
- `builder` – plant, implementiert dann
- `coder` – implementiert direkt, keine Planungsphase
- `reviewer` – nur lesen, liefert Erkenntnisse
- `planner` – nur planen, fasst nichts an

**MCP-Unterstützung.** Lege eine `mcp.json` in dein Projekt. Tools werden verzögert geladen – Schemata werden zuerst indiziert, vollständige Nutzdaten nur geladen, wenn der Agent sie tatsächlich benötigt. Hält die Token-Nutzung bei über 50 verbundenen Tools im Rahmen.

**Sitzungen.** Alles wird gespeichert. Wechsle zwischen Sitzungen mit `/sessions` oder `Ctrl+O`. `/compact`, wenn der Kontext zu schwer wird. `/undo`, um den letzten Zug und alle zugehörigen Dateiänderungen rückgängig zu machen.

**Ton-Benachrichtigungen.** Der Agent pingt dich an, wenn er eine Genehmigung benötigt oder einen Zug beendet. Schalte sie unabhängig voneinander um unter `Ctrl+E → Advanced → Sounds`.

**Modell-agnostisch.** LiteLLM unter der Haube. Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Wechsle mitten in der Sitzung mit `Ctrl+L`.

---

## Vergleich

> ⚠️ **Vor Veröffentlichung überprüfen** – bestätige, dass die Konkurrenzspalten mit ihren aktuellen Dokumentationen übereinstimmen.

| | Andromity | Aider | OpenCode |
|--|-----------|-------|----------|
| Ordner-Vertrauensmodell | ✅ | ❌ | ❌ |
| Berechtigungsstufen (SAFE → YOLO) | ✅ | ❌ | Teilweise |
| Eingebauter Cron-Scheduler | ✅ | ❌ | ❌ |
| Inline-Diff-Viewer | ✅ | ✅ | ✅ |
| Sitzungsmanagement | ✅ | ❌ | ✅ |
| Agenten-Profile | ✅ | ❌ | Teilweise |
| Local-first, BYOK | ✅ | ✅ | ✅ |
| MCP-Unterstützung | ✅ | ❌ | ✅ |

---

## Datenschutz

Dein Code geht an einen einzigen Ort: den von dir konfigurierten LLM-Anbieter. Nicht an uns.

- API-Schlüssel liegen in `~/.andromity/config.toml`
- Sitzungen werden lokal in `~/.andromity/sessions/` gespeichert
- Anonymer Ping beim ersten Start – kein Code, keine Pfade, keine Schlüssel. Vollständige Details in [telemetry-worker/README.md](telemetry-worker/README.md)
- Opt-out: `export DO_NOT_TRACK=1`, oder `telemetry = false` in der Konfiguration, oder `Ctrl+E → Advanced → Telemetry`

---

> ✦ *Nicht jeder Befehl ist hier dokumentiert. Entdecken ist Teil der Erfahrung.*

---

## Mitwirken

Öffne ein Issue oder PR. Ehrliches Feedback und Fehlerberichte sind momentan nützlicher als Funktionsanfragen.

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für Projektlayout und Entwickler-Setup.

**MIT** – siehe [LICENSE](LICENSE).

---

<div align="center">
  <img src="screen_shot.png" alt="Andromity in action" width="100%" />
</div>
