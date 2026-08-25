<div align="center">
  <img src="andromity.png" alt="Andromity" width="60" height="60" />

  # Andromity

  **Un agent IA de développement dans votre terminal. Autonome par choix, sécurisé par la confiance.**

  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>

  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Version](https://img.shields.io/badge/version-0.2.3-blueviolet)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | Français | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

---

Andromity est un espace de travail dans le terminal avec un agent IA intégré. Pas une fenêtre de chat. Pas un plugin. Un véritable espace de travail — sessions, diffs, visionneuse de fichiers, planificateur cron, profils — le tout dans votre terminal, avec un agent IA qui fait vraiment les choses.

Ce qui fait la différence : **rien ne s'exécute tant que vous n'avez pas déclaré le dossier comme approuvé.**

---

## Comment fonctionne le modèle de confiance

Lorsque vous ouvrez un dossier, Andromity vous demande si vous lui faites confiance. Cette réponse contrôle tout — ni votre mode de permission, ni votre clé API, ni vos paramètres. Si vous dites non, l'agent ne peut pas écrire de fichier, exécuter une commande ou toucher quoi que ce soit. Point final.

Si vous dites oui, vous choisissez la marge de manœuvre de l'agent :

| Mode | Plans | Écriture de fichiers | Commandes Shell |
|------|-------|-------------|----------------|
| **SAFE** | Approuver chacun | Approuver chacun | Approuver chacun |
| **TRUST** | Approuvé | Direct — sans révision | Direct — sans révision |
| **FULL** | Auto | Direct | Direct |
| **YOLO** | Auto (juste pour info) | Silencieux | Silencieux |

Commencez en SAFE. Passez en YOLO lorsque vous savez ce que l'agent fait dans votre code. Utilisez `/trust` et `/untrust` à tout moment.

---

## Installation

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Ou avec pipx
pipx install andromity
```

Nécessite Python 3.11+. L'installateur s'occupe de pipx si vous ne l'avez pas.

---

## Démarrage

```bash
andromity
```

Cela ouvre l'espace de travail. Pointez vers un dossier, répondez à la demande de confiance, choisissez un modèle — et voilà. Aucun fichier de configuration nécessaire pour commencer.

```bash
# Headless / scripts
andromity run "ajouter la gestion des erreurs à auth.py"
andromity run "refactoriser cela en async" --yes      # approuver tout automatiquement
andromity run "revoir session.py" --dry-run       # voir ce qu'il ferait
```

---

<!-- Replace with GIF showing trust prompt → diff → approval flow -->
![Andromity diff and approval flow](screen_shot.png)

---

## Ce qu'il y a à l'intérieur

**Planificateur (Scheduler).** Exécutez l'agent sur une minuterie pendant que vous dormez. `/cron` ouvre le planificateur. Les tâches persistent par projet dans `.andromity/crons.json`. Fonctionne avec n'importe quel mode d'autorisation — utilisez YOLO pour des exécutions totalement sans surveillance.

**Profils.** Modifiez ce que l'agent essaie de faire.
- `builder` — planifie, puis met en œuvre
- `coder` — met en œuvre directement, pas de phase de planification
- `reviewer` — lecture seule, produit des résultats
- `planner` — planifie seulement, ne touche à rien

**Support MCP.** Déposez un `mcp.json` dans votre projet. Les outils se chargent de manière asynchrone — les schémas sont d'abord indexés, les charges utiles complètes ne se chargent que lorsque l'agent en a réellement besoin. Garde l'utilisation des tokens raisonnable avec plus de 50 outils connectés.

**Sessions.** Tout est sauvegardé. Basculez entre les sessions avec `/sessions` ou `Ctrl+O`. `/compact` lorsque le contexte devient lourd. `/undo` pour annuler le dernier tour et toutes ses modifications de fichiers.

**Notifications sonores.** L'agent vous signale lorsqu'il a besoin d'une approbation ou termine un tour. Activez-les indépendamment sous `Ctrl+E → Advanced → Sounds`.

**Indépendant du Modèle.** LiteLLM sous le capot. Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Changez au milieu d'une session avec `Ctrl+L`.

---

## Comparaison

> ⚠️ **Vérifier avant de publier** — confirmez que les colonnes des concurrents sont exactes par rapport à leur documentation actuelle.

| | Andromity | Aider | OpenCode |
|--|-----------|-------|----------|
| Modèle de confiance des dossiers | ✅ | ❌ | ❌ |
| Niveaux de permission (SAFE → YOLO) | ✅ | ❌ | Partiel |
| Planificateur cron intégré | ✅ | ❌ | ❌ |
| Visionneuse de diff en ligne | ✅ | ✅ | ✅ |
| Gestion de session | ✅ | ❌ | ✅ |
| Profils d'agent | ✅ | ❌ | Partiel |
| Local-first, BYOK | ✅ | ✅ | ✅ |
| Support MCP | ✅ | ❌ | ✅ |

---

## Confidentialité

Votre code va à un seul endroit : le fournisseur LLM que vous configurez. Pas chez nous.

- Les clés API se trouvent dans `~/.andromity/config.toml`
- Les sessions sont stockées localement dans `~/.andromity/sessions/`
- Ping anonyme au premier lancement — aucun code, aucun chemin, aucune clé. Détails complets dans [telemetry-worker/README.md](telemetry-worker/README.md)
- Désinscription : `export DO_NOT_TRACK=1`, ou `telemetry = false` dans la configuration, ou `Ctrl+E → Advanced → Telemetry`

---

> ✦ *Toutes les commandes ne sont pas documentées ici. La découverte fait partie de l'expérience.*

---

## Contribuer

Ouvrez une issue ou une PR. Les retours honnêtes et les rapports de bugs sont plus utiles que les demandes de fonctionnalités en ce moment.

Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour la structure du projet et la configuration de développement.

**MIT** — voir [LICENSE](LICENSE).

---

<div align="center">
  <img src="screen_shot.png" alt="Andromity in action" width="100%" />
</div>
