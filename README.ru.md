<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — ИИ-агент для разработки в VS Code и терминале

  **Автономный агент с управлением доверием, BYOK, субагентами, живыми планами, нативными диффами и откатом в один клик.**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.8-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![Tests](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml/badge.svg)](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | Русский | [Português (Brasil)](README.pt-BR.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** — это приватный автономный ИИ-агент для разработки по модели BYOK (Bring Your Own Key). Используйте его в VS Code с помощью официального расширения или запускайте как отдельное терминальное рабочее пространство. Он планирует сложные задачи, управляет параллельными субагентами, отображает пошаговые интерактивные планы, позволяет просматривать диффы до их применения и обеспечивает мгновенный откат изменений в один клик.

Подключайте любую языковую модель (**Claude 3.7 Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek R1 & V3, Groq, OpenRouter**) или работайте **на 100% локально и бесплатно с Ollama**.

---

## ⚡ Быстрая установка и начало работы

### 🚀 Вариант A: Расширение для VS Code (Рекомендуется)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Установить в VS Code" />
  </a>
</div>

👉 **Рекомендуется:** Установите расширение прямо из маркетплейса:  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

Или мгновенно установите через терминал:

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 Вариант B: Терминальный CLI

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Или через pipx
pipx install andromity
```

---

## ✨ Ключевые возможности

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="Интерактивный планировщик задач и пошаговые чертежи" width="100%" />
</div>

### 📝 Интерактивный планировщик задач и пошаговые чертежи
Andromity анализирует вашу кодовую базу, создает интерактивный пошаговый план реализации и ждет вашего подтверждения перед написанием хотя бы одной строчки кода. Вы можете просматривать, утверждать или пропускать любые шаги.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp" alt="Поддержка 396+ моделей, включая локальную Ollama" width="100%" />
</div>

### 🤖 Поддержка 396+ моделей — включая локальную бесплатную Ollama
Подключайте Claude 3.7, GPT-4o, Gemini 2.5 Pro, DeepSeek R1, Groq или работайте на 100% оффлайн с Ollama. Переключайте модели прямо посреди сессии комбинацией `Ctrl+L`.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="Управление доверием и безопасность" width="100%" />
</div>

### 🔐 Управление доверием — вы всегда сохраняете контроль

| Режим | Планы | Запись файлов | Команды терминала |
|------|-------|-------------|-------------------|
| **SAFE** *(по умолчанию)* | Подтверждать каждый | Подтверждать каждый | Подтверждать каждый |
| **TRUST** | Автоматически | Напрямую | Напрямую |
| **FULL** | Автоматически | Напрямую | Напрямую |
| **YOLO** | Автоматически | Без вывода в консоль | Без вывода в консоль |

Никакие действия не выполняются, пока вы явно не подтвердите доверие к папке проекта. Начните в режиме SAFE и переходите в YOLO, когда полностью освоитесь.

---

## Сравнение с аналогами

| Функция | Andromity | Aider | Cursor | Claude Code |
|------|-----------|-------|--------|-------------|
| Модель доверия к каталогам | ✅ | ❌ | ❌ | ❌ |
| Уровни разрешений (SAFE → YOLO) | ✅ | ❌ | Частично | ❌ |
| **Визуальный трейс водопада выполнения (Waterfall)** | ✅ | ❌ | ❌ | ❌ |
| **Встроенный Cron-планировщик** | ✅ | ❌ | ❌ | ❌ |
| **Параллельные сессии и субагенты** | ✅ | ❌ | ❌ | Частично |
| Встроенный просмотр диффов | ✅ | ✅ | ✅ | ✅ |
| Управление сессиями и откат `/undo` | ✅ | ❌ | Частично | ❌ |
| Профили агентов (Profiles) | ✅ | ❌ | ❌ | Частично |
| Локальный режим / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| Поддержка протокола MCP | ✅ | ❌ | Частично | ✅ |
| Официальное расширение VS Code | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Cron-планировщик — ИИ работает, пока вы спите

Ни у одного другого ИИ-агента для кодинга нет такой функции. Введите команду `/cron` внутри Andromity, задайте задачу и настройте расписание — агент выполнит её автономно по таймеру.

```bash
# Пример: автоматический запуск тестов и исправление ошибок каждую ночь в 2:00
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

Задачи сохраняются для каждого проекта в файле `.andromity/crons.json`. Используйте режимы FULL или YOLO для полностью автономной ночной работы.

---

## 🤖 Параллельные сессии и субагенты

Создавайте фоновых субагентов для параллельных рабочих потоков без прерывания основной сессии. Например: пока один субагент исследует новую библиотеку, второй пишет код функционала, а вы проверяете общий план в главной сессии — и всё это одновременно.

```
Главная сессия     → Планирование и реализация компонента A
Субагент 1         → Исследование подходящей библиотеки авторизации
Субагент 2         → Написание модульных тестов для компонента B
```

Переключайтесь между сессиями с помощью `Ctrl+O`. У каждой сессии свой собственный контекст, история и журнал изменений. Команда `/undo` откатывает правки только текущей сессии.

---

## Возможности терминального рабочего пространства

> Расширение VS Code и терминал используют одинаковое ядро агента. Терминальное пространство предоставляет максимальный уровень контроля.

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**Профили (Profiles).** Переключайте цели работы агента посреди сессии:
- `builder` — сначала планирует, затем реализует
- `coder` — сразу пишет код без этапа планирования
- `reviewer` — только для чтения, формирует отчеты и аудит кода
- `planner` — только проектирует архитектуру, не трогая файлы

**Поддержка MCP.** Добавьте файл `mcp.json` в свой проект. Схемы инструментов загружаются по требованию — это сохраняет минимальный расход токенов даже при 50+ подключенных инструментах.

**Сессии.** Все данные сохраняются. Переключайтесь между сессиями через `/sessions` или `Ctrl+O`. Используйте `/compact` для сжатия контекста и `/undo` для отката изменений последнего шага.

**Автономный режим / Скрипты:**
```bash
andromity run "добавить обработку ошибок в auth.py"
andromity run "переписать на async" --yes      # автоматическое подтверждение всех действий
andromity run "проверить session.py" --dry-run       # тестовый запуск без изменений
```

**Независимость от моделей.** В основе лежит LiteLLM. Поддерживаются Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Переключайтесь между ними на лету нажатием `Ctrl+L`.

---

## Конфиденциальность

Ваш код отправляется исключительно выбранному вами провайдеру LLM. Мы не сохраняем и не передаем ваши данные.

- Ключи API хранятся в `~/.andromity/config.toml` — локальное шифрование
- Сессии хранятся локально в `~/.andromity/sessions/`
- Отключение телеметрии: `export DO_NOT_TRACK=1`

---

## История популярности (Stars)

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## История версий

Подробности смотрите в файле [CHANGELOG.md](CHANGELOG.md).

---

## Участие в разработке

Будем рады вашим замечаниям и Pull Request!

Смотрите [CONTRIBUTING.md](CONTRIBUTING.md) для получения информации о структуре проекта и настройке окружения.

**Лицензия:** [MIT](LICENSE).
