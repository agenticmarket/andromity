import * as vscode from "vscode";
import { getChatStyles } from "./chatStyles.js";
import { getChatClientScript } from "./chatClientScript.js";

export interface ChatViewState {
  currentSessionId: string;
  currentModel: string;
  currentProvider: string;
  currentMode: string;
  currentProfile: string;
  currentReasoning: string;
  models?: { id: string; name: string }[];
}

export function formatModelDisplayName(id?: string, models?: { id: string; name: string }[]): string {
  if (!id || id === "Loading model...") return "Claude 3.7 Sonnet";
  const found = models?.find((m) => m.id === id);
  if (found?.name) return found.name;
  const parts = id.split("/");
  const raw = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
  return raw
    .replace(/-/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .replace(/Gpt/g, "GPT")
    .replace(/Claude/g, "Claude")
    .replace(/Gemini/g, "Gemini");
}

export function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getChatViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, state: ChatViewState): string {
  const nonce = getNonce();
  const doneAudioUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "done.wav"));
  const sidebarIconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "sidebar-icon.svg"));
  const markedScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "marked.min.js"));
  const styles = getChatStyles();
  const clientScript = getChatClientScript(sidebarIconUri.toString(), state);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} https://fonts.gstatic.com data:; media-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Andromity</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,300..700&family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
  <style>
${styles}
  </style>
</head>
<body class="loading">
  <audio id="audio-done" preload="auto" src="${doneAudioUri}"></audio>


  <!-- Image Lightbox Modal Overlay -->
  <div id="image-lightbox-overlay" class="image-lightbox-overlay" style="display:none;" role="dialog" aria-modal="true" aria-label="Image preview">
    <div class="image-lightbox-header">
      <span class="image-lightbox-title" id="image-lightbox-title">Image Preview</span>
      <button class="image-lightbox-close" id="btn-lightbox-close" title="Close (Esc)">&times;</button>
    </div>
    <div class="image-lightbox-container">
      <img id="image-lightbox-img" class="image-lightbox-img" src="" alt="Image Preview">
    </div>
  </div>

  <!-- Top Bar (Clean Session Header, No Duplicate Buttons) -->
  <div class="top-bar">
    <div class="top-bar-left">
      <button class="session-badge-btn" id="btn-session-picker" title="Sessions (Click to switch or manage sessions)">
        <svg class="session-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="session-badge-text skeleton skeleton-session" id="active-session-name" aria-busy="true">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
        <span class="session-activity-dot" id="session-activity-dot" style="display:none;" title="Background session activity"></span>
        <svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </div>
      <button class="top-bar-icon-btn" id="btn-top-open-tab" title="Open Session in New Editor Tab (Side-by-Side)" data-action="open-current-tab">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
      </button>
      <button class="top-bar-icon-btn" id="btn-top-timeline" title="Conversation Timeline & Milestones" data-action="toggle-timeline">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      </button>
      <button class="top-bar-icon-btn" id="btn-top-undo" title="Undo last turn & rollback file changes" data-action="undo-turn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 7v6h6"></path>
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>
        </svg>
      </button>
      <button class="top-bar-icon-btn" id="btn-top-compact" title="Compact context window" data-action="compact-session">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 14 10 14 10 20"></polyline>
          <polyline points="20 10 14 10 14 4"></polyline>
          <line x1="14" y1="10" x2="21" y2="3"></line>
          <line x1="3" y1="21" x2="10" y2="14"></line>
        </svg>
      </button>
    </div>
  </div>

  <!-- Sessions Flyout Drawer -->
  <div class="sessions-flyout" id="sessions-flyout" style="display:none;">
    <div class="sessions-flyout-header">
      <input type="text" class="sessions-search" id="sessions-search" placeholder="Search sessions by name...">
      <button class="sessions-new-btn" id="btn-sessions-new" title="Create Fresh Session">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        <span>New</span>
      </button>
    </div>
    <div class="sessions-filter-tabs" id="sessions-filter-tabs">
      <button class="sessions-filter-tab active" data-filter="main" id="filter-tab-main">
        <span>Main Sessions</span>
        <span class="filter-count" id="count-main-sessions">0</span>
      </button>
      <button class="sessions-filter-tab" data-filter="subagents" id="filter-tab-subagents">
        <span>Background / Subagents</span>
        <span class="filter-count" id="count-subagent-sessions">0</span>
      </button>
    </div>
    <div class="sessions-list" id="sessions-list">
      <div style="padding:14px; text-align:center; color:var(--muted); font-size:11px;">Loading sessions...</div>
    </div>
  </div>

  <!-- Scheduled Crons Flyout / Drawer -->
  <div class="crons-flyout" id="crons-flyout" style="display:none;">
    <div class="crons-flyout-header">
      <div class="crons-header-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        <span>Scheduled Cron Jobs</span>
      </div>
      <button class="crons-close-btn" id="btn-crons-close" title="Close">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
    <div class="crons-list" id="crons-list">
      <div style="padding:14px; text-align:center; color:var(--muted); font-size:11px;">Loading crons...</div>
    </div>
  </div>

  <!-- Conversation Timeline Flyout / Drawer -->
  <div class="timeline-flyout" id="timeline-flyout" style="display:none;">
    <div class="timeline-header">
      <div class="timeline-header-left">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        <span class="timeline-header-title">Conversation Timeline</span>
        <span class="timeline-count-badge" id="timeline-turn-count">0 turns</span>
      </div>
      <div class="timeline-header-actions">
        <button class="timeline-action-btn" id="btn-timeline-jump-first" title="Jump to First Turn">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
        <button class="timeline-action-btn" id="btn-timeline-jump-latest" title="Jump to Latest Turn">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <button class="timeline-header-close" id="btn-timeline-close" title="Close (Esc)">&times;</button>
      </div>
    </div>
    <div class="timeline-toolbar">
      <div class="timeline-search-wrap">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <input type="text" class="timeline-search-input" id="timeline-search" placeholder="Search prompts, tools, or files..." />
      </div>
    </div>
    <div class="timeline-list" id="timeline-list">
      <div style="padding:20px; text-align:center; color:var(--muted); font-size:11.5px;">No conversation turns yet.</div>
    </div>
  </div>

  <div class="model-flyout" id="model-flyout" style="display:none;">
    <div class="flyout-header">
      <input type="text" class="flyout-search" id="flyout-search" placeholder="Search 396+ models...">
      <button class="flyout-hub-link" id="btn-flyout-open-hub">Open Full Hub</button>
    </div>
    <div class="flyout-list" id="flyout-list"></div>
  </div>

  <!-- Trust Banner (shown if workspace not trusted) -->
  <div class="trust-banner" id="trust-banner" style="display:none;">
    <div class="trust-banner-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <span>Workspace Trust Required</span>
    </div>
    <div class="trust-banner-desc">
      Do you trust the files in this folder? Andromity requires workspace trust to edit files and execute shell commands safely.
    </div>
    <div class="trust-banner-actions">
      <button class="trust-btn" id="btn-trust-confirm">Trust Folder</button>
      <button class="trust-btn-sec" id="btn-trust-dismiss">Restricted Mode</button>
    </div>
  </div>

  <!-- AI Engine Setup Guide Card (Shown only if daemon fails to connect) -->
  <div class="setup-guide-card" id="setup-guide-card" style="display:none;">
    <div class="setup-guide-header">
      <svg class="setup-guide-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <span>AI Engine Setup Needed</span>
    </div>
    <div class="setup-guide-body" id="setup-guide-body">
      Andromity requires Python 3.11+ to run the autonomous coding daemon.
    </div>
    <div class="setup-guide-actions">
      <button class="btn-setup-action primary" data-action="run-setup-check">Run Setup Check</button>
      <button class="btn-setup-action secondary" data-action="install-python-web">Install Python &#x2197;</button>
      <button class="btn-setup-action secondary" data-action="configure-python-path">Configure Path</button>
    </div>
  </div>

  <!-- Compaction Indicator Banner -->
  <div class="compaction-banner" id="compaction-banner" style="display:none;" role="status" aria-live="polite">
    <div class="compaction-banner-inner">
      <div class="compaction-icon-wrap">
        <svg class="compaction-spin-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <polyline points="4 14 10 14 10 20"></polyline>
          <polyline points="20 10 14 10 14 4"></polyline>
          <line x1="14" y1="10" x2="21" y2="3"></line>
          <line x1="3" y1="21" x2="10" y2="14"></line>
        </svg>
      </div>
      <div class="compaction-info">
        <div class="compaction-title" id="compaction-title">Compacting Conversation Context...</div>
        <div class="compaction-detail" id="compaction-detail">Summarizing message history into dense semantic memory</div>
      </div>
    </div>
    <div class="compaction-progress-track">
      <div class="compaction-progress-bar"></div>
    </div>
  </div>

  <!-- Chat Viewport Wrapper with Floating Controls -->
  <div class="chat-viewport-wrapper" style="position:relative; flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; width:100%;">
    <!-- Floating Scroll-To-Bottom Button -->
    <button class="scroll-bottom-btn" id="btn-scroll-bottom" title="Scroll to bottom" aria-label="Scroll to bottom">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
      <span class="unread-badge" id="scroll-unread-badge"></span>
    </button>

    <!-- Chat Messages Feed -->
    <div class="chat-container" id="chat-messages" role="log" aria-label="Chat messages" aria-live="polite">
    <!-- Clean Minimalist Zero State & Onboarding Guide -->
    <div class="zero-state" id="zero-state">
      
      <!-- ONBOARDING SETUP GUIDE (Visible when no API keys are configured) -->
      <div class="onboarding-guide-section" id="onboarding-guide-section" style="display:none;">
        <div class="onboarding-hero">
          <div class="onboarding-brand-logo">
            <img class="zero-logo-img" src="${sidebarIconUri}" width="34" height="34" alt="Andromity" />
          </div>
          <div class="onboarding-title-wrap">
            <div class="onboarding-step-pill">
              <span class="step-dot"></span>
              <span>Step 1 of 2 · Quick Setup</span>
            </div>
            <h1 class="onboarding-title">Welcome to Andromity</h1>
            <p class="onboarding-subtitle">Connect your favorite AI provider to begin coding autonomously.</p>
          </div>
        </div>

        <div class="onboarding-card">
          <div class="onboarding-card-header">
            <span class="onboarding-label">1. Choose AI Provider</span>
            <span class="onboarding-sublabel">Select where your models run</span>
          </div>

          <div class="onboarding-providers-grid" id="onboarding-providers-grid">
            <button class="onboarding-provider-chip active" data-provider="anthropic" data-model="claude-sonnet-4-6" data-portal="https://console.anthropic.com/settings/keys" data-name="Anthropic (Claude)">
              <span class="provider-color-dot" style="background:#d97706;"></span>
              <span class="provider-chip-name">Anthropic</span>
              <span class="provider-chip-badge">Claude 3.7</span>
            </button>
            <button class="onboarding-provider-chip" data-provider="openai" data-model="gpt-4o" data-portal="https://platform.openai.com/api-keys" data-name="OpenAI (GPT-4o)">
              <span class="provider-color-dot" style="background:#10b981;"></span>
              <span class="provider-chip-name">OpenAI</span>
              <span class="provider-chip-badge">GPT-4o</span>
            </button>
            <button class="onboarding-provider-chip" data-provider="google" data-model="gemini-2.5-flash" data-portal="https://aistudio.google.com/app/apikey" data-name="Google Gemini">
              <span class="provider-color-dot" style="background:#3b82f6;"></span>
              <span class="provider-chip-name">Google</span>
              <span class="provider-chip-badge">Free Tier</span>
            </button>
            <button class="onboarding-provider-chip" data-provider="openrouter" data-model="anthropic/claude-3.7-sonnet" data-portal="https://openrouter.ai/keys" data-name="OpenRouter">
              <span class="provider-color-dot" style="background:#8b5cf6;"></span>
              <span class="provider-chip-name">OpenRouter</span>
              <span class="provider-chip-badge">396+ Models</span>
            </button>
            <button class="onboarding-provider-chip" data-provider="ollama" data-model="llama3.2:latest" data-portal="https://ollama.com" data-name="Ollama (Local)">
              <span class="provider-color-dot" style="background:#ec4899;"></span>
              <span class="provider-chip-name">Ollama</span>
              <span class="provider-chip-badge">100% Free / Local</span>
            </button>
            <button class="onboarding-provider-chip" data-provider="deepseek" data-model="deepseek-chat" data-portal="https://platform.deepseek.com/api_keys" data-name="DeepSeek">
              <span class="provider-color-dot" style="background:#06b6d4;"></span>
              <span class="provider-chip-name">DeepSeek</span>
              <span class="provider-chip-badge">V3 / R1</span>
            </button>
          </div>

          <!-- Form area for API Key providers -->
          <div class="onboarding-form-area" id="onboarding-key-form">
            <div class="onboarding-input-header">
              <span class="onboarding-label" id="onboarding-key-label">2. Paste API Key</span>
              <a class="onboarding-portal-link" id="onboarding-portal-link" data-action="open-portal" data-url="https://console.anthropic.com/settings/keys" title="Get API Key from provider console">
                <span>Get API Key</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              </a>
            </div>
            <div class="onboarding-input-wrap">
              <input type="password" class="onboarding-key-input" id="onboarding-key-input" placeholder="Paste your API key here (sk-ant-...)" autocomplete="off" spellcheck="false" />
              <button class="onboarding-toggle-vis" id="btn-toggle-key-vis" title="Toggle visibility">
                <svg class="icon-eye-open" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              </button>
            </div>
            <div class="onboarding-actions-row">
              <button class="btn-onboarding-save" id="btn-onboarding-save">
                <span>Connect & Start Coding</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
              </button>
            </div>
          </div>

          <!-- Form area for Ollama (Zero-key local setup) -->
          <div class="onboarding-ollama-area" id="onboarding-ollama-form" style="display:none;">
            <div class="ollama-info-box">
              <div class="ollama-info-icon">💻</div>
              <div class="ollama-info-content">
                <div class="ollama-info-title">Zero-Key Local AI</div>
                <div class="ollama-info-desc">Runs entirely on your local GPU/CPU. Fully private, offline, and free forever. Make sure Ollama is running on your machine.</div>
              </div>
            </div>
            <button class="btn-onboarding-save" id="btn-onboarding-ollama-save">
              <span>Activate Local Ollama</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          </div>

          <div class="onboarding-footer-links">
            <button class="btn-link-settings" data-action="open-full-settings">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              <span>Open Full Model Hub & Settings</span>
            </button>
          </div>
        </div>
      </div>

      <!-- READY ZERO STATE (Visible when keys are ready) -->
      <div class="ready-hero-section" id="ready-hero-section">
        <div class="zero-hero">
          <div class="zero-brand-logo" aria-hidden="true">
            <img class="zero-logo-img" src="${sidebarIconUri}" width="32" height="32" alt="Andromity" />
          </div>
          <div class="zero-statement-wrap">
            <h1 class="zero-statement-main" id="zero-statement-main">Make it work.<br>Make it right.</h1>
            <p class="zero-statement-sub" id="zero-statement-sub">Precision in every iteration.</p>
          </div>
        </div>

        <!-- Recent Sessions Section — skeleton until init_state -->
        <div class="recent-sessions-section" id="recent-sessions-section" style="display:flex;">
          <div class="recent-sessions-header">
            <div class="recent-header-left">
              <span class="recent-header-label">Recent Sessions</span>
            </div>
            <div class="recent-header-actions">
              <button class="recent-header-btn" data-action="view-all-sessions" title="View all sessions in drawer">
                <span>All</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
              </button>
            </div>
          </div>
          <div class="recent-sessions-list" id="recent-sessions-list" aria-busy="true">
            <div class="recent-session-card skeleton skeleton-card" style="height:44px;"></div>
            <div class="recent-session-card skeleton skeleton-card" style="height:44px;"></div>
            <div class="recent-session-card skeleton skeleton-card" style="height:44px; opacity:0.6;"></div>
          </div>
        </div>

        <div class="minimal-starters-row">
          <button class="starter-chip" data-action="send-starter" data-prompt="Explain the architecture of this project in detail" role="button" tabindex="0" aria-label="Explain architecture">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
            </svg>
            <span>Architecture</span>
          </button>
          <button class="starter-chip" data-action="send-starter" data-prompt="Analyze diagnostics and fix any syntax or type errors or security issue in the current project" role="button" tabindex="0" aria-label="Fix diagnostics & errors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
            </svg>
            <span>Fix Errors</span>
          </button>
          <button class="starter-chip" data-action="send-starter" data-prompt="Write comprehensive unit tests with edge cases for the active code" role="button" tabindex="0" aria-label="Generate unit tests">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 3h6v3H9zM10 6v7.3a4 4 0 1 0 4 0V6"></path>
              <circle cx="12" cy="17" r="1.5" fill="currentColor"></circle>
            </svg>
            <span>Unit Tests</span>
          </button>
          <button class="starter-chip" data-action="open-model-hub" role="button" tabindex="0" aria-label="Browse model catalog">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
            </svg>
            <span>396+ Models</span>
          </button>
        </div>
      </div>

    </div>
  </div>
  </div>

  <div id="interactive-slot" style="padding: 0 10px;"></div>

  <!-- Collapsible Todo / Plan Tracker (above prompt input) -->
  <div class="plan-tracker-strip" id="plan-tracker-strip" style="display:none;">
    <div class="tracker-row" id="tracker-header-row" title="Click to collapse / expand todos">
      <div class="tracker-info">
        <span class="tracker-chevron" id="tracker-chevron">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </span>
        <span class="tracker-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
        </span>
        <span class="tracker-title" id="tracker-title">Plan Tracker</span>
        <span class="tracker-count" id="tracker-count">0/0 done</span>
      </div>
      <div class="tracker-actions">
        <button class="btn-tracker-open" id="btn-tracker-open" title="Open Full Plan in Editor Tab">
          <span>View Plan</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        </button>
        <button class="btn-tracker-close" id="btn-tracker-close" title="Dismiss tracker">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    </div>
    <div class="tracker-progress-track">
      <div class="tracker-progress-bar" id="tracker-progress-bar" style="width:0%;"></div>
    </div>
    <div class="tracker-todos-list" id="tracker-todos-list"></div>
  </div>

  <div class="queue-container" id="queue-container" style="display:none;"></div>

  <div class="input-section" role="region" aria-label="Chat input">
    <!-- Floating Slash Command Palette -->
    <div class="slash-palette" id="slash-palette" style="display:none;" role="listbox" aria-label="Slash commands">
      <div class="slash-palette-header">
        <span>Commands (Click or press Enter)</span>
        <button class="palette-close-btn" id="btn-slash-close" title="Close (Esc)">&times;</button>
      </div>
      <div class="slash-palette-list" id="slash-palette-list"></div>
    </div>

    <div class="slash-palette" id="mention-palette" style="display:none;" role="listbox" aria-label="Skills and tools">
      <div class="slash-palette-header" style="color:#c084fc;">
        <span>Skills & Tools (Click to mention)</span>
        <button class="palette-close-btn" id="btn-mention-close" title="Close (Esc)">&times;</button>
      </div>
      <div class="slash-palette-list" id="mention-palette-list"></div>
    </div>

    <div class="prompt-box">
      <div class="image-attachments-container" id="image-attachments-container" style="display:none;"></div>
      <textarea id="prompt-input" autofocus placeholder="Ask Andromity or type / for commands, @ for skills..." rows="1" aria-label="Ask Andromity or type slash for commands, @ for skills"></textarea>
      <div class="prompt-box-footer">
        <div class="prompt-left-controls">

          <button class="prompt-pill-btn" id="btn-prompt-mode" title="Permission Governance Mode (Click to cycle)" aria-label="Permission mode">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            </svg>
            <span id="prompt-mode-label" class="skeleton skeleton-text" aria-busy="true">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
          </button>

        </div>

        <div class="prompt-right-controls">
          <button class="prompt-pill-btn" id="btn-prompt-model" title="Select or search model" aria-label="Select AI model">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <span id="prompt-model-label" class="skeleton skeleton-text" style="min-width:92px;" aria-busy="true">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
          </button>
          <button class="prompt-pill-btn" id="btn-prompt-reasoning" title="Reasoning / Thinking Effort (Click to switch)" aria-label="Reasoning effort">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
            <span id="prompt-reasoning-label" class="skeleton skeleton-text" aria-busy="true">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
          </button>
          <button class="codex-cancel-btn" id="btn-cancel" title="Stop Generation" style="display:none;" aria-label="Cancel agent turn">
            <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
          </button>
          <button class="codex-send-btn" id="btn-send" title="Send (Enter)" aria-label="Send message">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Status Bar Footer -->
  <div class="status-bar" id="status-bar-footer">
    <div class="status-bar-left">
      <button class="prompt-pill-btn" id="btn-prompt-profile" title="Agent Profile Persona (Click to cycle)" aria-label="Agent profile">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
        <span id="prompt-profile-label" class="skeleton skeleton-text" aria-busy="true">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
      </button>
      <div class="token-capacity-widget" id="token-capacity-widget" tabindex="0" role="button" aria-label="Token Usage & Model Capacity">
        <svg class="token-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        <span id="token-label" class="skeleton skeleton-text" style="min-width:56px;" aria-busy="true">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
        <div class="token-mini-track" id="token-mini-track">
          <div class="token-mini-bar" id="token-mini-bar" style="width: 0%;"></div>
        </div>

        <!-- Rich Context Window Popover Card -->
        <div class="context-popover" id="context-popover">
          <div class="context-popover-top">
            <div class="context-ring-wrap">
              <svg class="context-ring-svg" width="36" height="36" viewBox="0 0 36 36">
                <circle class="context-ring-bg" cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="3.5"></circle>
                <circle class="context-ring-fill" id="context-ring-fill" cx="18" cy="18" r="14" fill="none" stroke="#e4e4e7" stroke-width="3.5" stroke-dasharray="87.96" stroke-dashoffset="87.96" stroke-linecap="round" transform="rotate(-90 18 18)"></circle>
              </svg>
              <span class="context-ring-text" id="context-popover-pct">0%</span>
            </div>
            <div class="context-popover-header-info">
              <div class="context-popover-title">Context window</div>
              <div class="context-popover-subtitle" id="context-popover-ratio">0 / 200,000</div>
            </div>
          </div>

          <div class="context-popover-divider"></div>

          <div class="context-popover-rows">
            <div class="context-popover-row">
              <div class="context-row-label">
                <span class="context-dot dot-used"></span>
                <span>Used tokens</span>
              </div>
              <span class="context-row-val" id="context-popover-used">0</span>
            </div>
            <div class="context-popover-row">
              <div class="context-row-label">
                <span class="context-dot dot-avail"></span>
                <span>Available</span>
              </div>
              <span class="context-row-val" id="context-popover-avail">200,000</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="status-bar-right">
      <span id="cost-label" class="skeleton skeleton-text" style="min-width:64px;" aria-busy="true">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>
    </div>
  </div>


  <script nonce="${nonce}" src="${markedScriptUri}"></script>
  <script nonce="${nonce}">
${clientScript}
  </script>
</body>
</html>`;
}
