<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — Agent IA de développement pour VS Code et Terminal

  **Agent de codage autonome avec gouvernance de confiance, BYOK, sous-agents, plans en direct, diffs natifs et retour arrière en un clic.**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.8-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![Tests](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml/badge.svg)](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | Français | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp?v=0.2.8" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** est un agent IA autonome de codage, privé et BYOK (Bring Your Own Key). Utilisez-le dans VS Code grâce à l'extension officielle ou lancez-le comme un espace de travail autonome dans votre terminal. Il planifie les tâches complexes, gère des sous-agents en parallèle, affiche des plans d'exécution pas à pas en direct, vous permet d'examiner les diffs avant application et offre une annulation instantanée en un clic.

Connectez votre modèle IA préféré (**Claude 3.7 Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek R1 & V3, Groq, OpenRouter**) ou exécutez-le **100% localement et gratuitement avec Ollama**.

---

## ⚡ Installation rapide et démarrage

### 🚀 Option A : Extension VS Code (Recommandé)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Installer dans VS Code" />
  </a>
</div>

👉 **Recommandé :** Installez l'extension directement depuis le marketplace :  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

Ou installez-la instantanément via le terminal :

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 Option B : CLI Terminal

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Ou avec pipx
pipx install andromity
```

---

## ✨ Fonctionnalités clés

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="Planificateur de tâches en direct et plans d'exécution" width="100%" />
</div>

### 📝 Planificateur de tâches en direct et plans d'exécution
Andromity analyse votre base de code, génère un plan de mise en œuvre interactif étape par étape et attend votre confirmation avant d'écrire la moindre ligne de code. Examinez, approuvez ou ignorez chaque étape.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp?v=0.2.8" alt="Prise en charge de 396+ modèles avec Ollama local gratuit" width="100%" />
</div>

### 🤖 Prise en charge de 396+ modèles — y compris Ollama local gratuit
Connectez Claude 3.7, GPT-4o, Gemini 2.5 Pro, DeepSeek R1, Groq ou travaillez à 100% hors ligne avec Ollama. Changez de modèle en cours de session avec `Ctrl+L`.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="Gouvernance de confiance" width="100%" />
</div>

### 🔐 Gouvernance de confiance — Vous gardez toujours le contrôle

| Mode | Plans | Écriture de fichiers | Commandes de terminal |
|------|-------|-------------|-------------------|
| **SAFE** *(par défaut)* | Approuver chaque action | Approuver chaque action | Approuver chaque action |
| **TRUST** | Approuver | Direct | Direct |
| **FULL** | Automatique | Direct | Direct |
| **YOLO** | Automatique | Silencieux | Silencieux |

Rien n'est exécuté tant que vous n'avez pas confirmé que le dossier est de confiance. Démarrez en mode SAFE, puis passez en mode YOLO lorsque vous êtes familiarisé.

---

## Comparatif

| Fonctionnalité | Andromity | Aider | Cursor | Claude Code |
|------|-----------|-------|--------|-------------|
| Modèle de confiance de dossier | ✅ | ❌ | ❌ | ❌ |
| Niveaux d'autorisation (SAFE → YOLO) | ✅ | ❌ | Partiel | ❌ |
| **Analyseur visuel d'exécution en cascade (Waterfall)** | ✅ | ❌ | ❌ | ❌ |
| **Planificateur Cron intégré** | ✅ | ❌ | ❌ | ❌ |
| **Sessions parallèles et sous-agents** | ✅ | ❌ | ❌ | Partiel |
| Visualiseur de diffs natif | ✅ | ✅ | ✅ | ✅ |
| Gestion des sessions et `/undo` | ✅ | ❌ | Partiel | ❌ |
| Profils d'agent (Profiles) | ✅ | ❌ | ❌ | Partiel |
| Local d'abord / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| Prise en charge du protocole MCP | ✅ | ❌ | Partiel | ✅ |
| Extension officielle pour VS Code | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Planificateur Cron — L'IA qui travaille pendant votre sommeil

Aucun autre agent d'IA pour le code ne propose cela. Ouvrez `/cron` dans Andromity, décrivez votre tâche et définissez un calendrier — l'agent s'exécute de façon autonome selon le minuteur pendant votre absence.

```bash
# Exemple : lancer la suite de tests et corriger les erreurs chaque nuit à 2h00
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

Les tâches sont conservées par projet dans `.andromity/crons.json`. Utilisez le mode FULL ou YOLO pour des exécutions de nuit totalement autonomes.

---

## 🤖 Sessions parallèles et sous-agents

Générez des sous-agents en arrière-plan pour des flux de travail parallèles sans interrompre votre session principale. Exemple : pendant qu'un sous-agent explore une nouvelle bibliothèque, un autre implémente une fonctionnalité et vous examinez le plan dans la session principale — le tout simultanément.

```
Session principale  → Planifier et implémenter la Fonctionnalité A
Sous-agent 1        → Rechercher la meilleure bibliothèque d'authentification
Sous-agent 2        → Rédiger les tests unitaires pour la Fonctionnalité B
```

Basculez entre vos sessions avec `Ctrl+O`. Chaque session conserve son propre contexte, son historique et son journal de modifications de fichiers. `/undo` n'annule que les modifications de la session active.

---

## Fonctionnalités de l'espace de travail en terminal

> L'extension VS Code et le terminal partagent le même moteur d'agent. L'espace de travail en terminal offre un contrôle et une vitesse bruts.

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**Profils (Profiles).** Modifiez l'objectif de l'agent en direct :
- `builder` — planifie d'abord, puis implémente
- `coder` — implémente directement sans étape préalable de planification
- `reviewer` — en lecture seule, fournit des audits de code et des rapports
- `planner` — planifie uniquement l'architecture, ne touche à aucun fichier

**Support MCP.** Déposez un fichier `mcp.json` dans votre projet. Les schémas d'outils se chargent à la demande, maintenant une consommation de tokens minimale même avec plus de 50 outils connectés.

**Sessions.** Tout est sauvegardé automatiquement. Utilisez `/sessions` ou `Ctrl+O` pour basculer. Utilisez `/compact` quand le contexte devient volumineux. Utilisez `/undo` pour annuler le dernier tour et toutes ses modifications de fichiers.

**Mode scripté / Headless :**
```bash
andromity run "ajouter la gestion d'erreurs dans auth.py"
andromity run "refactoriser en async" --yes      # approuver automatiquement
andromity run "analyser session.py" --dry-run       # simuler les actions
```

**Indépendance des modèles.** Propulsé par LiteLLM. Compatible avec Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Changez à tout moment avec `Ctrl+L`.

---

## Confidentialité et sécurité

Votre code n'est transmis qu'au fournisseur LLM que vous configurez. Nous ne collectons jamais vos données ni votre code.

- Les clés API restent dans `~/.andromity/config.toml` (chiffrement local)
- Les sessions sont stockées localement dans `~/.andromity/sessions/`
- Désactivation de la télémétrie : `export DO_NOT_TRACK=1`

---

## Historique des étoiles (Star History)

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## Journal des modifications

Consultez [CHANGELOG.md](CHANGELOG.md) pour les détails des versions.

---

## Contribution

Vos retours et Pull Requests sont les bienvenus !

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour la structure du projet et l'environnement de développement.

**Licence MIT** — voir [LICENSE](LICENSE).
