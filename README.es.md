<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — Agente de IA para VS Code y Terminal

  **Agente de codificación autónomo con gobernanza de confianza, BYOK, subagentes, planes en vivo, diffs nativos y reversión en un clic.**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.8-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![Tests](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml/badge.svg)](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | Español | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp?v=0.2.8" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** es un agente de codificación con IA autónomo, privado y BYOK (Bring Your Own Key). Úsalo dentro de VS Code con la extensión oficial o ejecútalo como un espacio de trabajo independiente en la terminal. Planifica tareas complejas, gestiona subagentes en paralelo, muestra planes paso a paso en vivo, te permite revisar diffs antes de aplicarlos y ofrece reversión instantánea en un clic.

Conecta tu modelo de IA favorito (**Claude 3.7 Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek R1 & V3, Groq, OpenRouter**) o ejecútalo **100% en local y gratis con Ollama**.

---

## ⚡ Instalación Rápida y Primeros Pasos

### 🚀 Opción A: Extensión para VS Code (Recomendado)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Instalar en VS Code" />
  </a>
</div>

👉 **Recomendado:** Instala la extensión directamente desde el marketplace:  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

O instálala al instante desde la terminal:

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 Opción B: CLI de Terminal

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# O mediante pipx
pipx install andromity
```

---

## ✨ Características Principales

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="Planificador de Tareas y Planos en Vivo" width="100%" />
</div>

### 📝 Planificador de Tareas y Planos en Vivo
Andromity analiza tu base de código, crea un plan de implementación interactivo paso a paso y espera tu confirmación antes de escribir una sola línea de código. Revisa, aprueba o salta cualquier paso.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp?v=0.2.8" alt="Soporte para 396+ Modelos incluyendo Ollama local gratuito" width="100%" />
</div>

### 🤖 Soporte para 396+ Modelos — Incluyendo Ollama Local Gratuito
Conecta Claude 3.7, GPT-4o, Gemini 2.5 Pro, DeepSeek R1, Groq o ejecuta 100% offline con Ollama. Cambia de modelo en plena sesión con `Ctrl+L`.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="Gobernanza de Confianza" width="100%" />
</div>

### 🔐 Gobernanza de Confianza — Tú Siempre Tienes el Control

| Modo | Planes | Escritura de Archivos | Comandos de Terminal |
|------|-------|-------------|-------------------|
| **SAFE** *(por defecto)* | Aprobar cada uno | Aprobar cada uno | Aprobar cada uno |
| **TRUST** | Aprobar | Directo | Directo |
| **FULL** | Automático | Directo | Directo |
| **YOLO** | Automático | Silencioso | Silencioso |

Nada se ejecuta hasta que confirmes que la carpeta es de confianza. Comienza en modo SAFE y cambia a YOLO cuando conozcas cómo trabaja el agente.

---

## Comparativa con Otras Herramientas

| Característica | Andromity | Aider | Cursor | Claude Code |
|------|-----------|-------|--------|-------------|
| Modelo de confianza de carpetas | ✅ | ❌ | ❌ | ❌ |
| Niveles de permisos (SAFE → YOLO) | ✅ | ❌ | Parcial | ❌ |
| **Perfilador visual de ejecución en cascada (Waterfall)** | ✅ | ❌ | ❌ | ❌ |
| **Programador Cron Integrado** | ✅ | ❌ | ❌ | ❌ |
| **Sesiones paralelas y subagentes** | ✅ | ❌ | ❌ | Parcial |
| Visor de diffs nativo | ✅ | ✅ | ✅ | ✅ |
| Gestión de sesiones y `/undo` | ✅ | ❌ | Parcial | ❌ |
| Perfiles de agente (Profiles) | ✅ | ❌ | ❌ | Parcial |
| Enfoque local / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| Soporte para protocolo MCP | ✅ | ❌ | Parcial | ✅ |
| Extensión oficial para VS Code | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Programador Cron — La IA que Trabaja Mientras Duermes

Ningún otro agente de IA para codificar cuenta con esto. Abre `/cron` dentro de Andromity, escribe tu tarea y define un horario: el agente ejecutará todo de forma autónoma con temporizador en tu ausencia.

```bash
# Ejemplo: ejecutar suite de tests y solucionar fallos cada noche a las 2:00
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

Las tareas se guardan en `.andromity/crons.json` por proyecto. Usa el modo FULL o YOLO para ejecuciones nocturnas totalmente desatendidas.

---

## 🤖 Sesiones Paralelas y Subagentes

Genera subagentes en segundo plano para flujos de trabajo simultáneos sin interrumpir tu sesión principal. Ejemplo: mientras un subagente investiga una biblioteca nueva, otro implementa una función y tú revisas el plan en la sesión principal, todo al mismo tiempo.

```
Sesión principal  → Planificar e implementar la Función A
Subagente 1       → Investigar la mejor librería de autenticación
Subagente 2       → Escribir pruebas unitarias para la Función B
```

Cambia entre sesiones con `Ctrl+O`. Cada sesión tiene su propio contexto, historial y registro de modificaciones de archivos. `/undo` revierte solo los cambios de la sesión actual.

---

## Características del Espacio de Trabajo en Terminal

> La extensión de VS Code y la terminal comparten el mismo núcleo de agente. El terminal te brinda la máxima velocidad y control directo.

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**Perfiles (Profiles).** Cambia el objetivo del agente en plena sesión:
- `builder` — planifica primero, luego implementa
- `coder` — implementa directamente sin fase previa de planificación
- `reviewer` — modo solo lectura, genera informes de auditoría y análisis
- `planner` — solo diseña la arquitectura, sin tocar ningún archivo

**Soporte MCP.** Agrega un archivo `mcp.json` en tu proyecto. Los esquemas de herramientas se cargan bajo demanda, manteniendo un uso mínimo de tokens incluso con más de 50 herramientas conectadas.

**Sesiones.** Todo se guarda automáticamente. Usa `/sessions` o `Ctrl+O` para alternar. Usa `/compact` si el contexto crece mucho. Usa `/undo` para revertir el último turno y todas sus modificaciones de archivos.

**Modo Headless / Scripts:**
```bash
andromity run "añadir manejo de errores en auth.py"
andromity run "refactorizar a async" --yes      # autoaprueba todas las acciones
andromity run "revisar session.py" --dry-run       # simula lo que haría
```

**Independencia de Modelos.** Basado en LiteLLM. Compatible con Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Cambia de modelo al vuelo con `Ctrl+L`.

---

## Privacidad y Seguridad

Tu código se envía exclusivamente al proveedor de LLM que configures. Nosotros nunca recopilamos tu código ni tus prompts.

- Las claves de API se guardan en `~/.andromity/config.toml` (cifradas localmente)
- Las sesiones se almacenan localmente en `~/.andromity/sessions/`
- Desactivar telemetría: `export DO_NOT_TRACK=1`

---

## Historial de Estrellas

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## Registro de Cambios

Consulta [CHANGELOG.md](CHANGELOG.md) para más detalles.

---

## Contribuir

¡Agradecemos sugerencias y Pull Requests!

Revisa [CONTRIBUTING.md](CONTRIBUTING.md) para conocer la estructura del proyecto y configuración de desarrollo.

**Licencia MIT** — consulta [LICENSE](LICENSE).
