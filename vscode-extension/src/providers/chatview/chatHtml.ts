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
  const sidebarIconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "sidebar-icon.png"));
  const styles = getChatStyles();
  const clientScript = getChatClientScript(sidebarIconUri.toString(), state);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; media-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Andromity</title>
  <style>
${styles}
  </style>
</head>
<body>
  <audio id="audio-done" preload="auto" src="${doneAudioUri}"></audio>


  <!-- Image Lightbox Modal Overlay -->
  <div id="image-lightbox-overlay" class="image-lightbox-overlay" style="display:none;">
    <div class="image-lightbox-container">
      <button class="image-lightbox-close" id="btn-lightbox-close" title="Close preview">&times;</button>
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
        <span class="session-badge-text" id="active-session-name">Main Session</span>
        <svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </div>
    <div class="top-bar-right">
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
      <button class="top-bar-icon-btn" id="btn-top-new" title="New Session" data-action="new-session">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>
      <button class="top-bar-icon-btn" id="btn-top-settings" title="Settings & Hub" data-action="open-settings">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
    </div>
  </div>

  <!-- Sessions Flyout / Drawer -->
  <div class="sessions-flyout" id="sessions-flyout" style="display:none;">
    <div class="sessions-flyout-header">
      <input type="text" class="sessions-search" id="sessions-search" placeholder="Search sessions...">
      <button class="sessions-new-btn" id="btn-sessions-new" title="Create Fresh Session">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        <span>New</span>
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

  <!-- Inline Todo Progress Bar (Live Planner Tracker Inside) -->
  <div class="plan-tracker-strip" id="plan-tracker-strip" style="display:none;">
    <div class="tracker-row">
      <div class="tracker-info">
        <svg class="tracker-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
        <span class="tracker-title" id="tracker-title">Plan Tracker</span>
        <span class="tracker-count" id="tracker-count">0/0 steps</span>
      </div>
      <button class="btn-tracker-open" id="btn-tracker-open" title="Open Full Plan in Editor Tab">
        <span>View Plan</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
      </button>
    </div>
    <div class="tracker-progress-track">
      <div class="tracker-progress-bar" id="tracker-progress-bar" style="width:0%;"></div>
    </div>
    <div class="tracker-step-title" id="tracker-step-title"></div>
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

  <!-- Chat Messages Feed -->
  <div class="chat-container" id="chat-messages" role="log" aria-label="Chat messages" aria-live="polite">
    <!-- Clean Onboarding Zero State (No Emojis) -->
    <div class="zero-state" id="zero-state">
      <div class="zero-brand-wrap">
        <img class="zero-icon" src="${sidebarIconUri}" width="38" height="38" alt="Andromity" />
      </div>
      <div class="zero-title">Andromity</div>
      <div class="zero-subtitle" id="zero-greeting">What can I do for you?</div>
      <div class="zero-context-pill">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        <span id="zero-workspace-label">Workspace Ready</span>
      </div>

      <!-- Recent Sessions Section (rendered dynamically when past sessions exist) -->
      <div class="recent-sessions-section" id="recent-sessions-section" style="display:none;">
        <div class="recent-sessions-header">
          <div class="recent-header-left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <span>RECENT</span>
          </div>
          <button class="recent-view-all-btn" data-action="view-all-sessions" title="View all sessions in drawer">
            <span>View All</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        </div>
        <div class="recent-sessions-list" id="recent-sessions-list"></div>
      </div>

      <div class="starter-cards">
        <div class="starter-header">Quick Starters</div>
        <div class="starter-card" data-action="send-starter" data-prompt="Explain the architecture of this project in detail" role="button" tabindex="0" aria-label="Explain architecture">
          <svg class="starter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
          <div class="starter-info">
            <span class="starter-name">Explain Architecture</span>
            <span class="starter-desc">Map dependencies and project design</span>
          </div>
        </div>
        <div class="starter-card" data-action="send-starter" data-prompt="Analyze diagnostics and fix any syntax or type errors in the current file" role="button" tabindex="0" aria-label="Fix diagnostics & errors">
          <svg class="starter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
          </svg>
          <div class="starter-info">
            <span class="starter-name">Fix Diagnostics & Errors</span>
            <span class="starter-desc">Inspect active errors and repair code</span>
          </div>
        </div>
        <div class="starter-card" data-action="send-starter" data-prompt="Write comprehensive unit tests with edge cases for the active code" role="button" tabindex="0" aria-label="Generate unit tests">
          <svg class="starter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 3h6v3H9zM10 6v7.3a4 4 0 1 0 4 0V6"></path>
            <circle cx="12" cy="17" r="1.5" fill="currentColor"></circle>
          </svg>
          <div class="starter-info">
            <span class="starter-name">Generate Unit Tests</span>
            <span class="starter-desc">Cover edge cases and critical paths</span>
          </div>
        </div>
        <div class="starter-card" data-action="open-model-hub" role="button" tabindex="0" aria-label="Browse model catalog">
          <svg class="starter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
          </svg>
          <div class="starter-info">
            <span class="starter-name">Model Catalog</span>
            <span class="starter-desc">Browse 396+ OpenRouter models</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Interactive Modals Slot -->
  <div id="interactive-slot" style="padding: 0 10px;"></div>

  <!-- Prompt Queue (messages waiting while agent runs) -->
  <div class="queue-container" id="queue-container" style="display:none;"></div>

  <!-- Input Box (Modern Card Layout) -->
  <div class="input-section" role="region" aria-label="Chat input">
    <!-- Floating Slash Command Palette -->
    <div class="slash-palette" id="slash-palette" style="display:none;" role="listbox" aria-label="Slash commands">
      <div class="slash-palette-header">Commands (Click or press Enter)</div>
      <div class="slash-palette-list" id="slash-palette-list"></div>
    </div>

    <!-- Floating Mention / Skills Palette -->
    <div class="slash-palette" id="mention-palette" style="display:none;" role="listbox" aria-label="Skills and tools">
      <div class="slash-palette-header" style="color:#c084fc;">&#x26A1; Skills & Tools (Click to mention)</div>
      <div class="slash-palette-list" id="mention-palette-list"></div>
    </div>

    <div class="prompt-box">
      <div class="image-attachments-container" id="image-attachments-container" style="display:none;"></div>
      <textarea id="prompt-input" placeholder="Ask Andromity or type / for commands, @ for skills..." rows="1" aria-label="Ask Andromity or type slash for commands, @ for skills"></textarea>
      <div class="prompt-box-footer">
        <div class="prompt-left-controls">
          <button class="prompt-icon-btn" id="btn-prompt-plus" title="Browse 396+ OpenRouter Models" data-action="open-model-hub" aria-label="Open model catalog">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>

          <button class="prompt-pill-btn" id="btn-prompt-mode" title="Permission Governance Mode (Click to cycle)" aria-label="Permission mode">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            </svg>
            <span id="prompt-mode-label">${(state.currentMode || 'safe').toUpperCase()}</span>
          </button>

        </div>

        <div class="prompt-right-controls">
          <button class="prompt-pill-btn" id="btn-prompt-model" title="Select or search model" aria-label="Select AI model">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <span id="prompt-model-label">${formatModelDisplayName(state.currentModel, state.models)}</span>
          </button>
          <button class="prompt-pill-btn" id="btn-prompt-reasoning" title="Reasoning / Thinking Effort (Click to switch)" aria-label="Reasoning effort">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
            <span id="prompt-reasoning-label">${(state.currentReasoning || 'medium').toUpperCase()}</span>
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
        <span id="prompt-profile-label">${(state.currentProfile || 'builder').toUpperCase()}</span>
      </button>
      <div class="token-capacity-widget" id="token-capacity-widget" title="Token Usage & Model Capacity">
        <svg class="token-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        <span id="token-label">0 tokens</span>
        <div class="token-mini-track" id="token-mini-track">
          <div class="token-mini-bar" id="token-mini-bar" style="width: 0%;"></div>
        </div>
      </div>
    </div>
    <div class="status-bar-right">
      <span id="cost-label">$0.0000 USD</span>
    </div>
  </div>


  <script nonce="${nonce}">
${clientScript}
  </script>
</body>
</html>`;
}
