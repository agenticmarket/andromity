import * as vscode from "vscode";
import { getNonce } from "../webviewSecurity.js";
import { getFingerprintStyles } from "./fingerprintStyles.js";
import { getFingerprintScript } from "./fingerprintScript.js";

export { getNonce };

function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const FINGERPRINT_ICON = '<path d="M12 2a10 10 0 0 0-10 10c0 4.4 2.9 8.2 7 9.5"/><path d="M12 6a6 6 0 0 0-6 6c0 2.2 1.2 4.1 3 5.1"/><path d="M12 10a2 2 0 0 0-2 2c0 1.1.9 2 2 2s2-.9 2-2a2 2 0 0 0-2-2"/><path d="M18 10a6 6 0 0 0-6-6"/><path d="M22 12c0-5.5-4.5-10-10-10"/>';

export function getFingerprintHtml(
  webview: vscode.Webview,
  sessionId: string,
  sessionName: string,
  extensionUri?: vscode.Uri,
  noticeDismissed: boolean = false
): string {
  const nonce = getNonce();
  const styles = getFingerprintStyles();
  const script = getFingerprintScript(sessionId);
  const safeSessionName = escapeHtml(sessionName || "Session");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fingerprint — ${safeSessionName}</title>
  <style>
    ${styles}
  </style>
</head>
<body>
  ${noticeDismissed ? "" : `
  <div class="wf-banner-pill" id="banner-pill">
    <div class="wf-banner-pill-left">
      <span class="wf-banner-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FINGERPRINT_ICON}</svg>
      </span>
      <span>Fingerprint shows what the agent read, changed and ran in this session, turn by turn. Select a card for details.</span>
    </div>
    <div class="wf-banner-pill-actions">
      <button class="wf-pill-btn" id="btn-banner-dismiss">Dismiss</button>
    </div>
  </div>`}

  <header class="wf-header">
    <div class="wf-header-row1">
      <div class="wf-title-area">
        <span class="wf-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--cyan);">${FINGERPRINT_ICON}</svg>
          Fingerprint
        </span>
        <span class="wf-session-pill" title="${safeSessionName}">${safeSessionName}</span>
        <div class="wf-live-status" id="status-pill">
          <span class="wf-live-dot"></span>
          <span id="status-text">Idle</span>
        </div>
      </div>
      <div class="wf-actions">
        <button class="wf-btn active" id="btn-toggle-left-sidebar" title="Show or hide the turn list" aria-pressed="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
          Turns
        </button>
        <button class="wf-btn" id="btn-toggle-right-sidebar" title="Show or hide the inspector" aria-pressed="false">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
          Inspector
        </button>
        <button class="wf-btn" id="btn-docs" title="Open the Fingerprint documentation">Docs</button>
        <button class="wf-btn" id="btn-export-json" title="Save this report as JSON">Export JSON</button>
      </div>
    </div>

    <div class="wf-metrics-row">
      <div class="wf-metric" title="Time the agent spent working on turns, not counting time between turns">
        <span class="wf-metric-label">Agent time</span>
        <span class="wf-metric-value purple" id="metric-duration">0s</span>
      </div>
      <div class="wf-metric" title="Unique files written or edited, including by subagents">
        <span class="wf-metric-label">Files changed</span>
        <span class="wf-metric-value green" id="metric-modified">0</span>
      </div>
      <div class="wf-metric" title="Unique files read with read_file. Directory listings, file searches and web lookups are counted as searches">
        <span class="wf-metric-label">Files read</span>
        <span class="wf-metric-value accent" id="metric-read">0</span>
      </div>
      <div class="wf-metric" title="Shell commands started (shell_exec and shell_bg)">
        <span class="wf-metric-label">Commands</span>
        <span class="wf-metric-value amber" id="metric-commands">0</span>
      </div>
      <div class="wf-metric" title="Files matching Andromity's sensitive-path rules, such as .env, SSH keys and credentials. Blocked: the agent was refused. Accessed: the content reached the model">
        <span class="wf-metric-label">Sensitive files</span>
        <span class="wf-metric-value muted" id="metric-security">None</span>
      </div>
    </div>

    <div class="wf-controls">
      <div class="wf-tabs" role="tablist">
        <button class="wf-tab active" id="tab-dag" role="tab" aria-selected="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="6" y1="9" x2="6" y2="15"/><circle cx="18" cy="12" r="3"/><path d="M9 6h3a3 3 0 0 1 3 3v3"/></svg>
          Timeline
        </button>
        <button class="wf-tab" id="tab-blast" role="tab" aria-selected="false">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><circle cx="5" cy="5" r="2"/><line x1="12" y1="9" x2="19" y2="5"/><line x1="12" y1="15" x2="5" y2="19"/><line x1="14.5" y1="13.5" x2="19" y2="19"/><line x1="9.5" y1="10.5" x2="5" y2="5"/></svg>
          Blast radius
        </button>
      </div>
      <div class="wf-filters">
        <button class="wf-filter-pill active" data-filter="all">All</button>
        <button class="wf-filter-pill" data-filter="write">Changed</button>
        <button class="wf-filter-pill" data-filter="read">Read</button>
        <button class="wf-filter-pill" data-filter="shell">Shell</button>
        <button class="wf-filter-pill" data-filter="subagent">Subagents</button>
        <button class="wf-filter-pill" data-filter="sensitive">Sensitive</button>
        <input type="text" class="wf-search-input" id="search-input" placeholder="Search files, commands…" aria-label="Search files and commands">
      </div>
    </div>
  </header>

  <div class="fp-subagent-breadcrumb" id="subagent-breadcrumb" style="display:none;">
    <div class="fp-breadcrumb-left">
      <button class="fp-breadcrumb-back-btn" id="btn-back-to-session" title="Back to the session">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        <span>Back to session</span>
      </button>
      <div class="fp-breadcrumb-trail">
        <span class="fp-crumb link" id="crumb-main-session" role="button" tabindex="0">Session</span>
        <span class="fp-crumb-sep">/</span>
        <span class="fp-crumb current" id="crumb-subagent-role">Subagent</span>
        <span class="fp-subagent-pill" id="crumb-subagent-id"></span>
      </div>
    </div>
    <div class="fp-subagent-meta-pills">
      <span class="fp-badge-subagent" id="subagent-badge-status">Done</span>
      <span class="fp-subagent-actions-badge" id="subagent-badge-actions">0 actions</span>
    </div>
  </div>

  <div class="fp-workspace">
    <aside class="fp-sidebar" id="fp-sidebar">
      <div class="fp-sidebar-header">
        <span id="sidebar-title">Turns</span>
        <button class="fp-sidebar-toggle-btn" id="btn-collapse-left" title="Hide the turn list">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>
      <div class="fp-turn-item fp-turn-all active" id="turn-item-all" data-turn="all" role="button" tabindex="0">
        <span id="turn-item-all-label">All turns</span>
        <span class="fp-badge" id="badge-all-turns">0</span>
      </div>
      <div class="fp-turn-list" id="dynamic-turn-list"></div>
      <div class="fp-sidebar-subagents-section" id="sidebar-subagents-section" style="display:none;">
        <div class="fp-sidebar-section-title">Subagents</div>
        <div id="dynamic-subagent-list"></div>
      </div>
    </aside>

    <main class="fp-canvas-container">
      <div class="fp-viewport" id="viewport">
        <svg class="fp-svg-layer" id="svg-layer">
          <defs>
            <linearGradient id="grad-dag-1" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#bc8cff" stop-opacity="0.7"/>
              <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.7"/>
            </linearGradient>
            <linearGradient id="grad-dag-2" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.7"/>
              <stop offset="100%" stop-color="#bc8cff" stop-opacity="0.7"/>
            </linearGradient>
            <linearGradient id="grad-dag-3" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#bc8cff" stop-opacity="0.7"/>
              <stop offset="100%" stop-color="#3fb950" stop-opacity="0.7"/>
            </linearGradient>
            <linearGradient id="grad-dag-4" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#bc8cff" stop-opacity="0.7"/>
              <stop offset="100%" stop-color="#d29922" stop-opacity="0.7"/>
            </linearGradient>
          </defs>
        </svg>
        <div class="fp-nodes-layer" id="nodes-layer"></div>
      </div>

      <div class="fp-empty-state" id="empty-state" style="display:none;">
        <div class="fp-empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${FINGERPRINT_ICON}</svg>
        </div>
        <div>
          <div class="fp-empty-title" id="empty-title">No activity yet</div>
          <div class="fp-empty-text" id="empty-text">Send a prompt to the agent. The files it reads, changes and runs appear here.</div>
          <button class="fp-empty-retry" id="empty-retry" type="button" style="display:none;">Retry</button>
        </div>
      </div>

      <div class="fp-canvas-toolbar">
        <button class="fp-canvas-btn" id="btn-zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
        <span class="fp-zoom-text" id="zoom-label">100%</span>
        <button class="fp-canvas-btn" id="btn-zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        <button class="fp-canvas-btn" id="btn-zoom-fit" title="Fit everything in view">Fit</button>
      </div>
    </main>

    <aside class="fp-inspector collapsed" id="fp-inspector" aria-label="Inspector">
      <div class="fp-inspector-tabs">
        <div class="fp-inspector-tab">
          <span id="insp-icon" style="display:flex; align-items:center;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </span>
          <span id="insp-tab-title">Inspector</span>
        </div>
        <div class="fp-inspector-tab-actions">
          <button class="fp-sidebar-toggle-btn" id="btn-pin-inspector" title="Keep the inspector open when clicking the canvas">
            <svg id="pin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
          </button>
          <button class="fp-sidebar-toggle-btn" id="btn-collapse-right" title="Close the inspector">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <div class="fp-inspector-content" id="insp-content">
        <p class="fp-insp-placeholder">Select a card to see its details.</p>
      </div>
    </aside>
  </div>

  <script nonce="${nonce}">
    ${script}
  </script>
</body>
</html>`;
}
