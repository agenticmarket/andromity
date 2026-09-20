import * as vscode from "vscode";
import { getReviewStyles } from "./reviewStyles.js";
import { getReviewClientScript } from "./reviewClientScript.js";

export function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getReviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const styles = getReviewStyles();
  const script = getReviewClientScript();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} https://fonts.gstatic.com data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Changes Review</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    ${styles}

    /* Embedded Minimal Icon Fallbacks */
    .codicon {
      display: inline-block;
      vertical-align: middle;
      line-height: 1;
    }
    .codicon-chevron-down::before { content: "▼"; font-size: 8px; }
    .codicon-chevron-down.collapsed::before { content: "▶"; font-size: 8px; }
    .codicon-folder::before {
      content: "";
      display: inline-block;
      width: 12px;
      height: 12px;
      vertical-align: -1px;
      background: currentColor;
      mask: url("data:image/svg+xml;utf8,<svg viewBox='0 0 24 24' fill='black' xmlns='http://www.w3.org/2000/svg'><path d='M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'/></svg>") center/contain no-repeat;
      -webkit-mask: url("data:image/svg+xml;utf8,<svg viewBox='0 0 24 24' fill='black' xmlns='http://www.w3.org/2000/svg'><path d='M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'/></svg>") center/contain no-repeat;
    }
    .codicon-file::before {
      content: "";
      display: inline-block;
      width: 12px;
      height: 12px;
      vertical-align: -1px;
      background: currentColor;
      mask: url("data:image/svg+xml;utf8,<svg viewBox='0 0 24 24' fill='black' xmlns='http://www.w3.org/2000/svg'><path d='M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z'/></svg>") center/contain no-repeat;
      -webkit-mask: url("data:image/svg+xml;utf8,<svg viewBox='0 0 24 24' fill='black' xmlns='http://www.w3.org/2000/svg'><path d='M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z'/></svg>") center/contain no-repeat;
    }
    .codicon-diff::before { content: "±"; font-weight: bold; }
    .codicon-check-all::before {
      content: "";
      display: inline-block;
      width: 12px;
      height: 12px;
      vertical-align: -1px;
      background: currentColor;
      mask: url("data:image/svg+xml;utf8,<svg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' xmlns='http://www.w3.org/2000/svg'><polyline points='20 6 9 17 4 12'/></svg>") center/contain no-repeat;
      -webkit-mask: url("data:image/svg+xml;utf8,<svg viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' xmlns='http://www.w3.org/2000/svg'><polyline points='20 6 9 17 4 12'/></svg>") center/contain no-repeat;
    }
    .codicon-go-to-file::before { content: "↗"; font-size: 14px; }
    .codicon-diff-single::before { content: "◫"; font-size: 13px; }
    .codicon-discard::before { content: "↩"; font-size: 13px; }
    .codicon-unfold::before { content: "↕"; }
    .codicon-refresh::before { content: "↻"; }
    .codicon-loading::before {
      content: "";
      display: inline-block;
      width: 11px;
      height: 11px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      vertical-align: -1px;
    }
  </style>
</head>
<body>
  <!-- Top Header Bar -->
  <header class="review-header">
    <div class="header-left">
      <div class="branch-pill">
        <span class="codicon codicon-git-branch branch-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg></span>
        <span id="branch-label">HEAD</span>
      </div>
      <span class="target-badge">↔ Working Tree</span>

      <div class="scope-toggles" id="scope-toggles" style="display: none;">
        <button id="btn-scope-turn" class="scope-btn active" title="Show files changed in current agent turn">Turn (<span id="turn-files-count">0</span>)</button>
        <button id="btn-scope-all" class="scope-btn" title="Show all uncommitted repository changes">All (<span id="all-files-count">0</span>)</button>
      </div>

      <div class="view-toggles">
        <button id="btn-unified" class="view-btn active" title="Unified diff view">Unified</button>
        <button id="btn-split" class="view-btn" title="Side-by-side split view">Split</button>
      </div>

      <div class="metrics-summary">
        <span id="total-files">0 Files Changed</span>
        <span id="total-additions" class="stat-add">+0</span>
        <span id="total-deletions" class="stat-del">-0</span>
      </div>
    </div>

    <div class="header-right">
      <button class="action-btn" id="refresh-btn" title="Refresh Git changes">
        <span class="codicon codicon-refresh"></span> Refresh
      </button>
    </div>
  </header>

  <!-- Main Body: File Tree + Diff Viewer -->
  <main class="review-body">
    <!-- Left Sidebar: Changed Files Tree -->
    <aside class="review-sidebar" id="review-sidebar">
      <div class="sidebar-search-box">
        <input type="text" id="search-input" class="sidebar-search-input" placeholder="Filter changed files..." />
      </div>
      <div class="tree-scroll-area" id="tree-scroll-area">
        <!-- Tree rendered dynamically by script -->
      </div>
    </aside>

    <!-- Resizer Divider -->
    <div class="sidebar-resizer" id="sidebar-resizer"></div>

    <!-- Right Diff Viewer -->
    <section class="review-content">
      <div id="diff-container" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
        <div class="empty-state">
          <div class="codicon codicon-diff empty-state-icon"></div>
          <h3>Select a file from the sidebar to review its changes</h3>
          <p>Choose any modified or untracked file to view line-by-line diffs.</p>
        </div>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    ${script}
  </script>
</body>
</html>
`;
}
