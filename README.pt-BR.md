<div align="center">
  <img src="https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.png" alt="Andromity" width="70" height="70" />

  # Andromity — Agente de IA para VS Code e Terminal

  **Agente de codificação autônomo com governança de confiança, BYOK, subagentes, planos ao vivo, diffs nativos e reversão em um clique.**

  [![VS Code Marketplace](https://img.shields.io/badge/VS_Marketplace-v0.2.8-blueviolet?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)
  [![PyPI](https://img.shields.io/pypi/v/andromity)](https://pypi.org/project/andromity/)
  ![Python](https://img.shields.io/badge/python-3.11+-blue)
  [![Tests](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml/badge.svg)](https://github.com/agenticmarket/andromity/actions/workflows/tests.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

  [English](README.md) | [简体中文](README.zh-CN.md) | [Русский](README.ru.md) | Português (Brasil) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [हिन्दी](README.hi.md)

</div>

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/with_waterfall.webp?v=0.2.8" alt="Andromity AI Coding Agent with Live Waterfall Trace in VS Code" width="100%" />
</div>

---

**Andromity** é um agente autônomo de codificação com IA privativo e BYOK (Bring Your Own Key). Use-o dentro do VS Code com a extensão oficial ou execute-o como um ambiente de trabalho autônomo no terminal. Ele planeja tarefas complexas, gerencia subagentes em paralelo, exibe etapas e projetos ao vivo, permite revisar diffs antes de aplicar e oferece reversão instantânea em um clique.

Conecte seu modelo de IA favorito (**Claude 3.7 Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek R1 & V3, Groq, OpenRouter**) ou execute **100% localmente e de graça com o Ollama**.

---

## ⚡ Instalação Rápida e Primeiros Passos

### 🚀 Opção A: Extensão para VS Code (Recomendado)

<div align="left">
  <a href="https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent">
    <img src="https://img.shields.io/badge/Install%20in%20VS%20Code-Marketplace-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Instalar no VS Code" />
  </a>
</div>

👉 **Recomendado:** Instale a extensão diretamente pelo marketplace:  
🔗 **[Andromity AI Coding Agent for VS Code - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=agenticmarket.andromity-agent)**

Ou instale instantaneamente via terminal:

```bash
code --install-extension agenticmarket.andromity-agent
```

### 💻 Opção B: Terminal CLI

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex

# Ou com pipx
pipx install andromity
```

---

## ✨ Principais Recursos

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/planning.webp" alt="Planejador de Tarefas ao Vivo e Projetos" width="100%" />
</div>

### 📝 Planejador de Tarefas ao Vivo e Projetos
O Andromity analisa sua base de código, cria um plano de implementação interativo passo a passo e aguarda sua aprovação antes de escrever uma única linha de código. Revise, aprove ou pule qualquer etapa.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/models.webp?v=0.2.8" alt="Suporte a 396+ Modelos incluindo Ollama local gratuito" width="100%" />
</div>

### 🤖 Suporte a 396+ Modelos — Incluindo Ollama Local Gratuito
Conecte Claude 3.7, GPT-4o, Gemini 2.5 Pro, DeepSeek R1, Groq ou execute 100% offline com Ollama. Troque de modelo no meio da sessão com `Ctrl+L`.

---

<div align="center">
  <img src="https://cdn.agenticmarket.dev/andromity/git/trusted.webp" alt="Governança de Confiança" width="100%" />
</div>

### 🔐 Governança de Confiança — Você Sempre no Controle

| Modo | Planos | Gravação de Arquivos | Comandos de Terminal |
|------|-------|-------------|-------------------|
| **SAFE** *(padrão)* | Aprovar cada um | Aprovar cada um | Aprovar cada um |
| **TRUST** | Aprovar | Direto | Direto |
| **FULL** | Automático | Direto | Direto |
| **YOLO** | Automático | Silencioso | Silencioso |

Nada é executado até que você confirme que a pasta é confiável. Comece no modo SAFE e mude para YOLO quando já souber como o agente trabalha.

---

## Comparativo com Alternativas

| Recurso | Andromity | Aider | Cursor | Claude Code |
|------|-----------|-------|--------|-------------|
| Modelo de confiança de pasta | ✅ | ❌ | ❌ | ❌ |
| Níveis de permissão (SAFE → YOLO) | ✅ | ❌ | Parcial | ❌ |
| **Profiler visual de execução em cascata (Waterfall)** | ✅ | ❌ | ❌ | ❌ |
| **Agendador Cron Integrado** | ✅ | ❌ | ❌ | ❌ |
| **Sessões paralelas e subagentes** | ✅ | ❌ | ❌ | Parcial |
| Visualizador de diffs nativo | ✅ | ✅ | ✅ | ✅ |
| Gerenciamento de sessões e `/undo` | ✅ | ❌ | Parcial | ❌ |
| Perfis de agente (Profiles) | ✅ | ❌ | ❌ | Parcial |
| Modo local / Ollama / BYOK | ✅ | ✅ | ❌ | ❌ |
| Suporte ao protocolo MCP | ✅ | ❌ | Parcial | ✅ |
| Extensão oficial para VS Code | ✅ | ❌ | ✅ | ✅ |

---

## ⏰ Agendador Cron — A IA que Trabalha Enquanto Você Dorme

Nenhum outro agente de codificação possui isso. Abra `/cron` no Andromity, escreva sua tarefa e defina um agendamento — o agente executará tudo com autonomia por temporizador enquanto você estiver ausente.

```bash
# Exemplo: rodar suite de testes e corrigir falhas todas as noites às 2h
/cron  →  "run pytest, fix any failing tests, commit the fix"  →  0 2 * * *
```

As tarefas persistem em `.andromity/crons.json` por projeto. Use o modo FULL ou YOLO para execuções totalmente autônomas durante a noite.

---

## 🤖 Sessões Paralelas e Subagentes

Gere subagentes em segundo plano para fluxos de trabalho simultâneos sem interromper sua sessão principal. Exemplo: enquanto um subagente pesquisa uma biblioteca nova, outro implementa uma funcionalidade e você revisa o plano na sessão principal — tudo ao mesmo tempo.

```
Sessão principal  → Planejar e implementar a Funcionalidade A
Subagente 1       → Pesquisar a melhor biblioteca de autenticação
Subagente 2       → Escrever testes unitários para a Funcionalidade B
```

Alterne entre todas as sessões com `Ctrl+O`. Cada sessão possui contexto, histórico e registro de alterações de arquivos próprios. O `/undo` reverte apenas as alterações da sessão atual.

---

## Recursos do Ambiente de Trabalho no Terminal

> A extensão do VS Code e o terminal compartilham o mesmo núcleo de agente. O terminal oferece máxima velocidade e controle.

<div align="center">
  <video src="https://github.com/user-attachments/assets/5203a1d8-9c6d-4d8f-bee3-7b4316f6fb22" autoplay loop muted playsinline width="100%"></video>
</div>

**Perfis (Profiles).** Alterne o que o agente deve priorizar na sessão:
- `builder` — planeja primeiro, depois implementa
- `coder` — implementa diretamente, sem etapa de planejamento
- `reviewer` — somente leitura, produz relatórios de análise e auditoria
- `planner` — apenas cria especificações e planos, sem alterar arquivos

**Suporte MCP.** Adicione um `mcp.json` ao seu projeto. Os esquemas de ferramentas são carregados sob demanda — mantendo o consumo de tokens sob controle mesmo com mais de 50 ferramentas conectadas.

**Sessões.** Tudo é salvo. Use `/sessions` ou `Ctrl+O` para alternar. Use `/compact` quando o contexto ficar extenso. Use `/undo` para reverter o último turno e todas as suas alterações em arquivos.

**Modo Headless / Scripts:**
```bash
andromity run "adicionar tratamento de erros em auth.py"
andromity run "refatorar para async" --yes      # aprova tudo automaticamente
andromity run "revisar session.py" --dry-run       # simula o que seria feito
```

**Independência de Provedor.** Baseado em LiteLLM. Suporta Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, NVIDIA NIM. Troque de modelo com `Ctrl+L`.

---

## Privacidade e Segurança

Seu código vai para apenas um lugar: o provedor de LLM que você configurar. Não armazenamos seus códigos ou prompts.

- As chaves de API ficam salvas em `~/.andromity/config.toml` — criptografadas localmente
- Sessões salvas localmente em `~/.andromity/sessions/`
- Desativar telemetria: `export DO_NOT_TRACK=1`

---

## Histórico de Estrelas

<a href="https://www.star-history.com/?repos=agenticmarket%2Fandromity&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=agenticmarket/andromity&type=date&legend=top-left" />
 </picture>
</a>

---

## Registro de Alterações

Consulte [CHANGELOG.md](CHANGELOG.md) para detalhes de versão.

---

## Contribuindo

Abra uma issue ou pull request!

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para estrutura de projeto e ambiente de desenvolvimento.

**Licença MIT** — consulte [LICENSE](LICENSE).
