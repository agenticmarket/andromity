import * as vscode from "vscode";
import { getFingerprintStyles } from "./fingerprintStyles.js";
import { getFingerprintScript } from "./fingerprintScript.js";

export function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function getFingerprintHtml(
  webview: vscode.Webview,
  sessionId: string,
  sessionName: string,
  extensionUri?: vscode.Uri
): string {
  const nonce = getNonce();
  const styles = getFingerprintStyles();
  const script = getFingerprintScript(sessionId);
  const safeSessionName = escapeHtml(sessionName || "Session");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} https://fonts.gstatic.com data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fingerprint — ${safeSessionName}</title>
  <style>
    ${styles}
  </style>
</head>
<body>

  <!-- Top Auto-Open Banner Pill (Matching Waterfall) -->
  <div class="wf-banner-pill" id="banner-pill">
    <div class="wf-banner-pill-left">
      <span class="wf-banner-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 0-10 10c0 4.4 2.9 8.2 7 9.5"/><path d="M12 6a6 6 0 0 0-6 6c0 2.2 1.2 4.1 3 5.1"/><path d="M12 10a2 2 0 0 0-2 2c0 1.1.9 2 2 2s2-.9 2-2a2 2 0 0 0-2-2"/><path d="M18 10a6 6 0 0 0-6-6"/><path d="M22 12c0-5.5-4.5-10-10-10"/></svg>
      </span>
      <span><strong>Live Fingerprint</strong> opened for this session · Visualizing exact files read, modified, and commands executed</span>
    </div>
    <div class="wf-banner-pill-actions">
      <button class="wf-pill-btn" id="btn-banner-safety">Safety Guarantee</button>
      <button class="wf-pill-btn" id="btn-banner-dismiss">Dismiss</button>
    </div>
  </div>

  <!-- Header Bar -->
  <header class="wf-header">
    <div class="wf-header-row1">
      <div class="wf-title-area">
        <span class="wf-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--cyan);"><path d="M12 2a10 10 0 0 0-10 10c0 4.4 2.9 8.2 7 9.5"/><path d="M12 6a6 6 0 0 0-6 6c0 2.2 1.2 4.1 3 5.1"/><path d="M12 10a2 2 0 0 0-2 2c0 1.1.9 2 2 2s2-.9 2-2a2 2 0 0 0-2-2"/><path d="M18 10a6 6 0 0 0-6-6"/><path d="M22 12c0-5.5-4.5-10-10-10"/></svg>
          Fingerprint Trace
        </span>
        <span class="wf-session-pill" title="${safeSessionName}">${safeSessionName}</span>
        <div class="wf-live-status">
          <span class="wf-live-dot"></span>
          <span>READ-ONLY VIEW</span>
        </div>
      </div>
      <div class="wf-actions">
        <button class="wf-btn active" id="btn-toggle-left-sidebar" title="Toggle Turns Sidebar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
          Turns
        </button>
        <button class="wf-btn" id="btn-toggle-right-sidebar" title="Toggle Inspector Drawer">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
          Inspector
        </button>
        <button class="wf-btn" id="btn-safety-guard">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Read-Only Guard
        </button>
        <button class="wf-btn" id="btn-fit-canvas">Fit Canvas</button>
        <button class="wf-btn" id="btn-export-json">Export JSON</button>
      </div>
    </div>

    <!-- Summary Metrics Row -->
    <div class="wf-metrics-row">
      <div class="wf-metric" title="Total wall-clock duration of this session">
        <span class="wf-metric-label">Duration</span>
        <span class="wf-metric-value purple" id="metric-duration">0.00s</span>
      </div>
      <div class="wf-metric" title="Files modified by the agent with net lines">
        <span class="wf-metric-label">Files Modified</span>
        <span class="wf-metric-value green" id="metric-modified">0 Files</span>
      </div>
      <div class="wf-metric" title="Files read into the LLM context window">
        <span class="wf-metric-label">Files Read</span>
        <span class="wf-metric-value accent" id="metric-read">0 Context Ingested</span>
      </div>
      <div class="wf-metric" title="Shell and terminal processes executed">
        <span class="wf-metric-label">Commands Run</span>
        <span class="wf-metric-value amber" id="metric-commands">0 Executed</span>
      </div>
      <div class="wf-metric" title="AirGap Guard confidentiality verification">
        <span class="wf-metric-label">AirGap Sentinel</span>
        <span class="wf-metric-value green" id="metric-security">0 Leaks · Clean</span>
      </div>
    </div>

    <!-- Controls, Tabs & Filters -->
    <div class="wf-controls">
      <div class="wf-tabs">
        <button class="wf-tab active" id="tab-dag">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="6" y1="9" x2="6" y2="15"/><circle cx="18" cy="12" r="3"/><path d="M9 6h3a3 3 0 0 1 3 3v3"/></svg>
          Causal DAG
        </button>
        <button class="wf-tab" id="tab-blast">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><circle cx="5" cy="5" r="2"/><line x1="12" y1="9" x2="19" y2="5"/><line x1="12" y1="15" x2="5" y2="19"/><line x1="14.5" y1="13.5" x2="19" y2="19"/><line x1="9.5" y1="10.5" x2="5" y2="5"/></svg>
          Blast Radius Graph
        </button>
      </div>
      <div class="wf-filters">
        <button class="wf-filter-pill active" data-filter="all">All</button>
        <button class="wf-filter-pill" data-filter="write">Modified</button>
        <button class="wf-filter-pill" data-filter="read">Read</button>
        <button class="wf-filter-pill" data-filter="shell">Shell</button>
        <button class="wf-filter-pill" data-filter="subagent">Subagents</button>
        <button class="wf-filter-pill" data-filter="security">AirGap</button>
        <input type="text" class="wf-search-input" id="search-input" placeholder="Search touched files...">
      </div>
    </div>
  </header>

  <!-- Subagent Drilldown Breadcrumb Bar -->
  <div class="fp-subagent-breadcrumb" id="subagent-breadcrumb" style="display:none;">
    <div class="fp-breadcrumb-left">
      <button class="fp-breadcrumb-back-btn" id="btn-back-to-session" title="Return to Main Session Trace">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        <span>Back to Main Session</span>
      </button>
      <div class="fp-breadcrumb-trail">
        <span class="fp-crumb link" id="crumb-main-session">Main Session Trace</span>
        <span class="fp-crumb-sep">/</span>
        <span class="fp-crumb current" id="crumb-subagent-role">Subagent</span>
        <span class="fp-subagent-pill" id="crumb-subagent-id"></span>
      </div>
    </div>
    <div class="fp-subagent-meta-pills">
      <span class="fp-badge-subagent" id="subagent-badge-status">DONE</span>
      <span class="fp-subagent-actions-badge" id="subagent-badge-actions">0 Actions</span>
    </div>
  </div>

  <!-- Main 3-Column Workspace -->
  <div class="fp-workspace">

    <!-- Left Sidebar: Turn Execution Tree -->
    <aside class="fp-sidebar" id="fp-sidebar">
      <div class="fp-sidebar-header">
        <span id="sidebar-title">Turn Sequence</span>
        <button class="fp-sidebar-toggle-btn" id="btn-collapse-left" title="Collapse Turns Sidebar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>
      <div class="fp-turn-item active" id="turn-item-all" data-turn="all">
        <span id="turn-item-all-label">All Turns &amp; Lineage</span>
        <span class="fp-badge" id="badge-all-turns">0</span>
      </div>
      <div id="dynamic-turn-list"></div>
      <div class="fp-sidebar-subagents-section" id="sidebar-subagents-section" style="display:none;">
        <div class="fp-sidebar-section-title">Spawned Subagents</div>
        <div id="dynamic-subagent-list"></div>
      </div>
    </aside>

    <!-- Center Canvas: Causal DAG & Blast Radius Graph -->
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

      <!-- Empty State -->
      <div class="fp-empty-state" id="empty-state" style="display:none;">
        <div class="fp-empty-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 0 0-10 10c0 4.4 2.9 8.2 7 9.5"/><path d="M12 6a6 6 0 0 0-6 6c0 2.2 1.2 4.1 3 5.1"/><path d="M12 10a2 2 0 0 0-2 2c0 1.1.9 2 2 2s2-.9 2-2a2 2 0 0 0-2-2"/></svg>
        </div>
        <div>
          <div style="font-weight:600; color:var(--fg); margin-bottom:4px;">No actions recorded yet</div>
          <div style="font-size:11.5px;">Send a prompt to the agent to see the real-time execution DAG, file changes, and blast radius.</div>
        </div>
      </div>

      <!-- Zoom / Pan Controls -->
      <div class="fp-canvas-toolbar">
        <button class="fp-canvas-btn" id="btn-zoom-out" title="Zoom Out">-</button>
        <span class="fp-zoom-text" id="zoom-label">88%</span>
        <button class="fp-canvas-btn" id="btn-zoom-in" title="Zoom In">+</button>
        <button class="fp-canvas-btn" id="btn-zoom-fit" title="Reset Pan & Zoom">Fit</button>
      </div>
    </main>

    <!-- Right Inspector Drawer -->
    <aside class="fp-inspector collapsed" id="fp-inspector">
      <div class="fp-inspector-tabs">
        <div class="fp-inspector-tab">
          <span id="insp-icon" style="display:flex; align-items:center;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </span>
          <span id="insp-tab-title">Inspector</span>
        </div>
        <div class="fp-inspector-tab-actions">
          <button class="fp-sidebar-toggle-btn" id="btn-pin-inspector" title="Pin Inspector (Keep open on canvas click)">
            <svg id="pin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
          </button>
          <button class="fp-sidebar-toggle-btn" id="btn-collapse-right" title="Close Inspector Drawer">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <div class="fp-inspector-content" id="insp-content">
        <p style="color:var(--muted); font-size:12px; margin-top:20px; text-align:center;">
          Select any node or file card in the canvas to view details and open files directly.
        </p>
      </div>
    </aside>

  </div>

  <script nonce="${nonce}">
    ${script}
  </script>
</body>
</html>`;
}
