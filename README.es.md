<div align="center">
  <img src="andromity.png" alt="Andromity" width="60" height="60" />

  # Andromity

  **Un agente de IA para programar en la terminal. Autónomo por elección, protegido por confianza.**

  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>

  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Version](https://img.shields.io/badge/version-0.2.3-blueviolet)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | Español | [हिन्दी](README.hi.md)

</div>

---

Andromity es un espacio de trabajo en la terminal con un agente de IA integrado. No es una ventana de chat. No es un plugin. Un espacio de trabajo adecuado — sesiones, diffs, visor de archivos, programador cron, perfiles — todo en tu terminal, con un agente de IA que realmente hace cosas.

Lo que lo hace diferente: **nada se ejecuta hasta que digas que la carpeta es de confianza.**

---

## Cómo funciona el modelo de confianza

Cuando abres una carpeta, Andromity te pregunta si confías en ella. Esa respuesta controla todo — no tu modo de permisos, no tu clave API, no tu configuración. Si dices que no, el agente no puede escribir un archivo, ejecutar un comando ni tocar nada. Punto.

Si dices que sí, tú eliges cuánta libertad tiene el agente:

| Modo | Planes | Escritura de archivos | Comandos de shell |
|------|-------|-------------|----------------|
| **SAFE** | Aprobar cada uno | Aprobar cada uno | Aprobar cada uno |
| **TRUST** | Aprobar | Directo — sin revisión | Directo — sin revisión |
| **FULL** | Automático | Directo | Directo |
| **YOLO** | Automático (solo para info) | Silencioso | Silencioso |

Comienza en SAFE. Cambia a YOLO cuando sepas qué hace el agente en tu código base. Usa `/trust` y `/untrust` en cualquier momento.

---

## Instalación

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# O con pipx
pipx install andromity
```

Requiere Python 3.11+. El instalador se encarga de pipx si no lo tienes.

---

## Inicio

```bash
andromity
```

Esto abre el espacio de trabajo. Apúntalo a una carpeta, responde al aviso de confianza, elige un modelo — listo. No se necesita archivo de configuración para comenzar.

```bash
# Headless / por scripts
andromity run "agregar manejo de errores en auth.py"
andromity run "refactorizar esto a async" --yes      # aprobar todo automáticamente
andromity run "revisar session.py" --dry-run       # ver qué haría
```

---

<!-- Replace with GIF showing trust prompt → diff → approval flow -->
![Andromity diff and approval flow](screen_shot.png)

---

## Qué hay dentro

**Programador (Scheduler).** Ejecuta el agente con un temporizador mientras duermes. `/cron` abre el programador. Los trabajos persisten por proyecto en `.andromity/crons.json`. Funciona con cualquier modo de permisos — usa YOLO para ejecuciones totalmente desatendidas.

**Perfiles (Profiles).** Cambia lo que el agente intenta hacer.
- `builder` — planifica, luego implementa
- `coder` — implementa directamente, sin fase de planificación
- `reviewer` — solo lectura, produce hallazgos
- `planner` — solo planifica, no toca nada

**Soporte MCP.** Coloca un `mcp.json` en tu proyecto. Las herramientas se cargan de forma perezosa — los esquemas se indexan primero, las cargas útiles completas se cargan solo cuando el agente realmente las necesita. Mantiene el uso de tokens razonable con más de 50 herramientas conectadas.

**Sesiones.** Todo se guarda. Cambia entre sesiones con `/sessions` o `Ctrl+O`. Usa `/compact` cuando el contexto se vuelva pesado. Usa `/undo` para deshacer el último turno y todos sus cambios de archivo.

**Notificaciones de sonido.** El agente te avisa cuando necesita aprobación o termina un turno. Actívalas de forma independiente en `Ctrl+E → Advanced → Sounds`.

**Independiente del modelo.** LiteLLM bajo el capó. Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Cambia a mitad de sesión con `Ctrl+L`.

---

## Cómo se compara

> ⚠️ **Verificar antes de publicar** — confirma que las columnas de la competencia sean exactas según sus documentos actuales.

| | Andromity | Aider | OpenCode |
|--|-----------|-------|----------|
| Modelo de confianza de carpeta | ✅ | ❌ | ❌ |
| Niveles de permisos (SAFE → YOLO) | ✅ | ❌ | Parcial |
| Programador cron integrado | ✅ | ❌ | ❌ |
| Visor de diff en línea | ✅ | ✅ | ✅ |
| Gestión de sesiones | ✅ | ❌ | ✅ |
| Perfiles de agentes | ✅ | ❌ | Parcial |
| Local-first, BYOK | ✅ | ✅ | ✅ |
| Soporte MCP | ✅ | ❌ | ✅ |

---

## Privacidad

Tu código va a un solo lugar: el proveedor LLM que configures. No a nosotros.

- Las claves API viven en `~/.andromity/config.toml`
- Las sesiones se almacenan localmente en `~/.andromity/sessions/`
- Ping anónimo en el primer lanzamiento — sin código, sin rutas, sin claves. Detalles completos en [telemetry-worker/README.md](telemetry-worker/README.md)
- Exclusión voluntaria: `export DO_NOT_TRACK=1`, o `telemetry = false` en la configuración, o `Ctrl+E → Advanced → Telemetry`

---

> ✦ *No todos los comandos están documentados aquí. Descubrirlos es parte de la experiencia.*

---

## Contribuir

Abre un issue o un PR. Los comentarios honestos y los informes de errores son más útiles que las solicitudes de funciones en este momento.

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para ver el diseño del proyecto y la configuración de desarrollo.

**MIT** — consulta [LICENSE](LICENSE).

---

<div align="center">
  <img src="screen_shot.png" alt="Andromity in action" width="100%" />
</div>
