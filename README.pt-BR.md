<div align="center">
  <img src="andromity.png" alt="Andromity" width="60" height="60" />

  # Andromity

  **Um agente de IA para codificação no terminal. Autônomo por escolha, delimitado por confiança.**

  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>

  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Version](https://img.shields.io/badge/version-0.2.3-blueviolet)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | Português (Brasil) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

---

Andromity é um espaço de trabalho no terminal com um agente de IA integrado. Não é uma janela de chat. Não é um plugin. Um espaço de trabalho adequado — sessões, diffs, visualizador de arquivos, agendador cron, perfis — tudo no seu terminal, com um agente de IA que realmente faz as coisas.

A coisa que o torna diferente: **nada é executado até que você diga que a pasta é confiável.**

---

## Como funciona o modelo de confiança

Quando você abre uma pasta, o Andromity pergunta se você confia nela. Essa resposta controla tudo — não o seu modo de permissão, não a sua chave de API, não as suas configurações. Se você disser não, o agente não pode gravar um arquivo, executar um comando ou tocar em nada. Ponto final.

Se você disser sim, você escolhe o quanto de liberdade o agente tem:

| Modo | Planos | Gravação de arquivos | Comandos de shell |
|------|-------|-------------|----------------|
| **SAFE** | Aprovar cada um | Aprovar cada um | Aprovar cada um |
| **TRUST** | Aprovar | Direto — sem revisão | Direto — sem revisão |
| **FULL** | Automático | Direto | Direto |
| **YOLO** | Automático (exibido apenas para informação) | Silencioso | Silencioso |

Comece no SAFE. Mude para o YOLO quando souber o que o agente faz na sua base de código. `/trust` e `/untrust` a qualquer momento.

---

## Instalação

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Ou com pipx
pipx install andromity
```

Requer Python 3.11+. O instalador lida com o pipx se você não tiver.

---

## Início

```bash
andromity
```

Isso abre o espaço de trabalho. Aponte-o para uma pasta, responda ao prompt de confiança, escolha um modelo — pronto. Nenhum arquivo de configuração é necessário para começar.

```bash
# Headless / via script
andromity run "adicionar tratamento de erro no auth.py"
andromity run "refatorar isso para async" --yes      # aprovar tudo automaticamente
andromity run "revisar session.py" --dry-run       # ver o que ele faria
```

---

<!-- Replace with GIF showing trust prompt → diff → approval flow -->
![Andromity diff and approval flow](screen_shot.png)

---

## O que tem dentro

**Agendador (Scheduler).** Execute o agente em um cronômetro enquanto você dorme. `/cron` abre o agendador. Os jobs persistem por projeto em `.andromity/crons.json`. Funciona com qualquer modo de permissão — use YOLO para execuções totalmente autônomas.

**Perfis.** Alterne o que o agente está tentando fazer.
- `builder` — planeja e depois implementa
- `coder` — implementa diretamente, sem fase de planejamento
- `reviewer` — somente leitura, produz descobertas
- `planner` — apenas planeja, não toca em nada

**Suporte MCP.** Coloque um `mcp.json` no seu projeto. As ferramentas carregam lentamente — os esquemas são indexados primeiro, as cargas úteis completas são carregadas apenas quando o agente realmente precisa delas. Mantém o uso de tokens são com mais de 50 ferramentas conectadas.

**Sessões.** Tudo é salvo. Alterne entre sessões com `/sessions` ou `Ctrl+O`. `/compact` quando o contexto ficar pesado. `/undo` para reverter a última rodada e todas as suas alterações de arquivo.

**Notificações sonoras.** O agente avisa quando precisa de aprovação ou termina uma rodada. Alterne-os de forma independente em `Ctrl+E → Advanced → Sounds`.

**Agnóstico de Modelo.** LiteLLM nos bastidores. Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Alterne no meio da sessão com `Ctrl+L`.

---

## Como se compara

> ⚠️ **Verifique antes de publicar** — confirme se as colunas da concorrência são precisas com base em suas documentações atuais.

| | Andromity | Aider | OpenCode |
|--|-----------|-------|----------|
| Modelo de confiança de pasta | ✅ | ❌ | ❌ |
| Níveis de permissão (SAFE → YOLO) | ✅ | ❌ | Parcial |
| Agendador cron integrado | ✅ | ❌ | ❌ |
| Visualizador de diff inline | ✅ | ✅ | ✅ |
| Gerenciamento de sessão | ✅ | ❌ | ✅ |
| Perfis de agentes | ✅ | ❌ | Parcial |
| Local-first, BYOK | ✅ | ✅ | ✅ |
| Suporte MCP | ✅ | ❌ | ✅ |

---

## Privacidade

Seu código vai para um único lugar: o provedor LLM que você configurar. Não para nós.

- Chaves de API ficam em `~/.andromity/config.toml`
- Sessões armazenadas localmente em `~/.andromity/sessions/`
- Ping anônimo no primeiro lançamento — sem código, sem caminhos, sem chaves. Detalhes completos em [telemetry-worker/README.md](telemetry-worker/README.md)
- Opt-out: `export DO_NOT_TRACK=1`, ou `telemetry = false` na configuração, ou `Ctrl+E → Advanced → Telemetry`

---

> ✦ *Nem todos os comandos estão documentados aqui. A descoberta faz parte da experiência.*

---

## Contribuindo

Abra uma issue ou PR. Feedback honesto e relatórios de bugs são mais úteis do que solicitações de recursos no momento.

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para layout do projeto e configuração de desenvolvimento.

**MIT** — veja [LICENSE](LICENSE).

---

<div align="center">
  <img src="screen_shot.png" alt="Andromity in action" width="100%" />
</div>
