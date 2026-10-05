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
  const codiconFontUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicon.ttf"));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Changes Review</title>
  <style>
    @font-face {
      font-family: "codicon";
      font-display: block;
      src: url("${codiconFontUri}") format("truetype");
    }
    .codicon[class*="codicon-"] {
      font-family: "codicon";
      font-weight: normal;
      font-style: normal;
      display: inline-block;
      text-rendering: auto;
      text-align: center;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      line-height: 1;
      vertical-align: middle;
      user-select: none;
    }
    /* Chevrons */
    .codicon-chevron-down::before    { content: "\\eab4"; }
    .codicon-chevron-down.collapsed::before { content: "\\eab7"; }
    .codicon-chevron-right::before   { content: "\\eab6"; }
    .codicon-chevron-up::before      { content: "\\eab7"; }
    /* Folder */
    .codicon-folder::before          { content: "\\ea83"; }
    .codicon-folder-opened::before   { content: "\\eaf7"; }
    /* File types */
    .codicon-file::before            { content: "\\ea7b"; }
    .codicon-file-code::before       { content: "\\eae9"; }
    .codicon-file-media::before      { content: "\\eaea"; }
    .codicon-file-zip::before        { content: "\\eaef"; }
    .codicon-markdown::before        { content: "\\eb1d"; }
    .codicon-json::before            { content: "\\eb0f"; }
    .codicon-database::before        { content: "\\eace"; }
    .codicon-settings-gear::before   { content: "\\eb51"; }
    .codicon-file-pdf::before        { content: "\\eaeb"; }
    .codicon-file-text::before       { content: "\\ec5e"; }
    .codicon-symbol-class::before    { content: "\\eb5b"; }
    /* Actions / UI */
    .codicon-diff::before            { content: "\\eae1"; }
    .codicon-diff-single::before     { content: "\\eae1"; }
    .codicon-go-to-file::before      { content: "\\ea94"; }
    .codicon-discard::before         { content: "\\eae2"; }
    .codicon-refresh::before         { content: "\\eb37"; }
    .codicon-unfold::before          { content: "\\eb73"; }
    .codicon-check-all::before       { content: "\\ebb1"; }
    .codicon-git-branch::before      { content: "\\ec6f"; }
    .codicon-loading::before         { content: "\\eb19"; }
    ${styles}
  </style>
</head>
<body>
  <!-- Top Header Bar -->
  <header class="review-header">
    <div class="header-left">
      <div class="branch-pill">
        <span id="branch-label">HEAD</span>
      </div>
      <span class="target-badge">↔ Working Tree</span>

      <div class="scope-toggles" id="scope-toggles" style="display: none;">
        <button id="btn-scope-turn" class="scope-btn active" title="Show files changed in current agent turn">Turn (<span id="turn-files-count">0</span>)</button>
        <button id="btn-scope-all" class="scope-btn" title="Show all uncommitted repository changes">All (<span id="all-files-count">0</span>)</button>
      </div>

      <div class="view-toggles">
        <button id="btn-unified" class="view-btn active" title="Unified diff view" aria-label="Unified diff">Unified</button>
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
        <input type="text" id="search-input" class="sidebar-search-input" placeholder="Filter files" aria-label="Filter changed files" />
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
