/**
 * Styles for the Andromity Changes Review Webview Panel.
 * Uses VS Code CSS variables for seamless theme adaptation (Dark, Light, High Contrast).
 */
export function getReviewStyles(): string {
  return `
    :root {
      --review-font: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      --review-code-font: var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace);
      --review-font-size: var(--vscode-editor-font-size, 13px);
      --diff-add-bg: var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.15));
      --diff-del-bg: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.15));
      --diff-add-gutter: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.35));
      --diff-del-gutter: var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.35));
      --diff-add-text: #3fb950;
      --diff-del-text: #f85149;
      --border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      --hover-bg: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
      --active-bg: var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.1));
      --active-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
      --header-bg: var(--vscode-editorGroupHeader-tabsBackground, #18181b);
      --card-bg: var(--vscode-sideBar-background, #121214);
      --unmodified-bg: var(--vscode-badge-background, rgba(128, 128, 128, 0.1));
      --unmodified-fg: var(--vscode-descriptionForeground, #8b949e);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }

    body {
      font-family: var(--review-font);
      font-size: var(--review-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Top Bar / Header ────────────────────────────────────────── */
    .review-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 44px;
      padding: 0 16px;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
      gap: 12px;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .branch-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 12px;
      background: rgba(128, 128, 128, 0.15);
      border: 1px solid var(--border-color);
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-foreground);
    }

    .branch-pill .branch-icon {
      font-size: 13px;
      opacity: 0.8;
    }

    .target-badge {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-left: 2px;
    }

    .scope-toggles,
    .view-toggles {
      display: inline-flex;
      background: rgba(128, 128, 128, 0.12);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 2px;
      margin-left: 8px;
    }

    .scope-btn,
    .view-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      padding: 3px 10px;
      font-size: 12px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.15s ease;
    }

    .scope-btn:hover,
    .view-btn:hover {
      color: var(--vscode-foreground);
    }

    .scope-btn.active,
    .view-btn.active {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }

    .metrics-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .stat-add {
      color: var(--diff-add-text);
      font-weight: 600;
    }

    .stat-del {
      color: var(--diff-del-text);
      font-weight: 600;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      font-size: 12px;
      background: rgba(128, 128, 128, 0.15);
      border: 1px solid var(--border-color);
      border-radius: 5px;
      color: var(--vscode-foreground);
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .action-btn:hover {
      background: rgba(128, 128, 128, 0.25);
    }

    .action-btn.primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      border-color: transparent;
    }

    .action-btn.primary:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }

    /* ── Main Layout: Sidebar + Diff Viewer ──────────────────────── */
    .review-body {
      display: flex;
      flex: 1;
      overflow: hidden;
      position: relative;
    }

    /* ── Left Sidebar (Tree) ─────────────────────────────────────── */
    .review-sidebar {
      width: 290px;
      min-width: 200px;
      max-width: 500px;
      background: var(--card-bg);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
    }

    .sidebar-search-box {
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-color);
    }

    .sidebar-search-input {
      width: 100%;
      padding: 5px 8px;
      font-size: 12px;
      background: var(--vscode-input-background, #252526);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      outline: none;
    }

    .sidebar-search-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .tree-scroll-area {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 6px 0;
    }

    .tree-folder-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
      color: var(--vscode-foreground);
      border-radius: 3px;
      margin: 1px 4px;
      transition: background 0.1s ease;
    }

    .tree-folder-row:hover {
      background: var(--hover-bg);
    }

    .folder-chevron {
      font-size: 11px;
      width: 14px;
      text-align: center;
      opacity: 0.7;
      transition: transform 0.15s ease;
    }

    .folder-chevron.collapsed {
      transform: rotate(-90deg);
    }

    .folder-name {
      font-weight: 500;
      opacity: 0.9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tree-file-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
      border-radius: 4px;
      margin: 1px 4px;
      color: var(--vscode-foreground);
      transition: background 0.1s ease;
      position: relative;
    }

    .tree-file-row:hover {
      background: var(--hover-bg);
    }

    .tree-file-row.active {
      background: var(--active-bg);
      color: var(--active-fg);
      font-weight: 500;
    }

    .tree-file-row.active::before {
      content: "";
      position: absolute;
      left: 0;
      top: 3px;
      bottom: 3px;
      width: 3px;
      background: var(--vscode-focusBorder, #007fd4);
      border-radius: 2px;
    }

    .file-status-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
    }

    .file-status-badge.M {
      color: #e3b341;
      background: rgba(227, 179, 65, 0.15);
    }

    .file-status-badge.A,
    .file-status-badge.U {
      color: #3fb950;
      background: rgba(63, 185, 80, 0.15);
    }

    .file-status-badge.D {
      color: #f85149;
      background: rgba(248, 81, 73, 0.15);
    }

    .file-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-diff-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-family: var(--review-code-font);
      flex-shrink: 0;
    }

    /* ── Splitter Resizer ────────────────────────────────────────── */
    .sidebar-resizer {
      width: 4px;
      cursor: col-resize;
      background: transparent;
      transition: background 0.15s ease;
      flex-shrink: 0;
    }

    .sidebar-resizer:hover,
    .sidebar-resizer.resizing {
      background: var(--vscode-focusBorder, #007fd4);
    }

    /* ── Right Main Area (Diff Viewer) ───────────────────────────── */
    .review-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }

    .diff-file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 40px;
      padding: 0 16px;
      background: rgba(128, 128, 128, 0.05);
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }

    .diff-file-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 13px;
    }

    .file-path-crumb {
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
    }

    .diff-file-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .icon-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      width: 26px;
      height: 26px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .icon-btn:hover {
      background: var(--hover-bg);
      color: var(--vscode-foreground);
    }

    /* ── Diff Scroll Area & Code Tables ──────────────────────────── */
    .diff-scroll-area {
      flex: 1;
      overflow: auto;
      font-family: var(--review-code-font);
      font-size: var(--review-font-size);
      line-height: 20px;
      user-select: text;
    }

    .diff-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .diff-line {
      display: flex;
      align-items: stretch;
      width: 100%;
      min-width: 100%;
    }

    .diff-line.add {
      background-color: var(--diff-add-bg);
    }

    .diff-line.del {
      background-color: var(--diff-del-bg);
    }

    .gutter-old,
    .gutter-new {
      width: 48px;
      min-width: 48px;
      max-width: 48px;
      padding: 0 8px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground, #6e7681);
      font-size: 11px;
      user-select: none;
      flex-shrink: 0;
      border-right: 1px solid rgba(128, 128, 128, 0.1);
    }

    .diff-line.add .gutter-new {
      background-color: var(--diff-add-gutter);
      color: var(--diff-add-text);
      font-weight: 500;
    }

    .diff-line.del .gutter-old {
      background-color: var(--diff-del-gutter);
      color: var(--diff-del-text);
      font-weight: 500;
    }

    .gutter-marker {
      width: 22px;
      min-width: 22px;
      text-align: center;
      user-select: none;
      font-weight: 600;
      flex-shrink: 0;
    }

    .diff-line.add .gutter-marker {
      color: var(--diff-add-text);
    }

    .diff-line.del .gutter-marker {
      color: var(--diff-del-text);
    }

    .line-content {
      flex: 1;
      padding: 0 10px;
      white-space: pre;
      overflow-x: visible;
      color: var(--vscode-editor-foreground, #e6edf3);
    }

    /* ── Split (Side-by-Side) Diff View Styles ───────────────────── */
    .split-diff-header {
      display: flex;
      width: 100%;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border-color);
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      position: sticky;
      top: 0;
      z-index: 5;
    }

    .split-pane-header {
      flex: 1;
      padding: 4px 12px;
      letter-spacing: 0.05em;
    }

    .split-pane-header.left-pane-header {
      border-right: 1px solid var(--border-color);
    }

    .split-row {
      display: flex;
      width: 100%;
      align-items: stretch;
      min-width: 100%;
    }

    .split-pane {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: stretch;
      position: relative;
    }

    .split-pane.left-pane {
      border-right: 1px solid var(--border-color);
    }

    .split-pane.add {
      background-color: var(--diff-add-bg);
    }

    .split-pane.del {
      background-color: var(--diff-del-bg);
    }

    .split-pane.empty {
      background-color: rgba(128, 128, 128, 0.04);
      background-image: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 5px,
        rgba(128, 128, 128, 0.03) 5px,
        rgba(128, 128, 128, 0.03) 10px
      );
    }

    .split-pane.add .gutter-new {
      background-color: var(--diff-add-gutter);
      color: var(--diff-add-text);
      font-weight: 500;
    }

    .split-pane.del .gutter-old {
      background-color: var(--diff-del-gutter);
      color: var(--diff-del-text);
      font-weight: 500;
    }

    .split-pane.add .gutter-marker {
      color: var(--diff-add-text);
    }

    .split-pane.del .gutter-marker {
      color: var(--diff-del-text);
    }

    /* ── Collapsed Unmodified Context Banner ─────────────────────── */
    .unmodified-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 16px;
      background: var(--unmodified-bg);
      color: var(--unmodified-fg);
      border-top: 1px solid var(--border-color);
      border-bottom: 1px solid var(--border-color);
      font-size: 11px;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease;
    }

    .unmodified-banner:hover {
      background: rgba(128, 128, 128, 0.2);
      color: var(--vscode-foreground);
    }

    .unmodified-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .expand-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 11px;
      color: inherit;
      cursor: pointer;
    }

    .expand-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    /* ── Empty & Loading States ──────────────────────────────────── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 12px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 40px;
    }

    .empty-state-icon {
      font-size: 40px;
      opacity: 0.6;
    }

    .empty-state h3 {
      font-size: 16px;
      font-weight: 500;
      color: var(--vscode-foreground);
    }

    .empty-state p {
      font-size: 13px;
      max-width: 400px;
      line-height: 1.4;
    }
  `;
}
