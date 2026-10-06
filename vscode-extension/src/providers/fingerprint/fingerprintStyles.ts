export function getFingerprintStyles(): string {
  return `
    :root {
      --bg: var(--vscode-sideBar-background, #18181b);
      --fg: var(--vscode-foreground, #e4e4e7);
      --card-bg: var(--vscode-editor-background, #1e1e1e);
      --input-bg: var(--vscode-input-background, #252526);
      --border: var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
      --border-hover: rgba(255, 255, 255, 0.16);
      --accent: var(--vscode-focusBorder, #007fd4);
      --green: #3fb950;
      --red: #f85149;
      --purple: #bc8cff;
      --amber: #d29922;
      --cyan: #38bdf8;
      --blue: #58a6ff;
      --muted: var(--vscode-descriptionForeground, #888888);
      --radius: 6px;
      --font-ui: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font-ui);
      font-size: 13px;
      line-height: 1.5;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
      user-select: none;
    }

    /* Auto-Open Informational Banner Pill */
    .wf-banner-pill {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 14px;
      background: linear-gradient(90deg, rgba(56, 189, 248, 0.08) 0%, rgba(188, 140, 255, 0.06) 100%);
      border-bottom: 1px solid rgba(56, 189, 248, 0.18);
      font-size: 11.5px;
      color: var(--fg);
      flex-shrink: 0;
      z-index: 101;
    }

    .wf-banner-pill-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .wf-banner-icon {
      font-size: 13px;
      color: var(--cyan);
      display: flex;
      align-items: center;
    }

    .wf-banner-pill-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .wf-pill-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 10.5px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, border-color 0.15s;
    }

    .wf-pill-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: var(--border-hover);
    }

    /* Top Navigation Header */
    .wf-header {
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      padding: 10px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex-shrink: 0;
      z-index: 100;
    }

    .wf-header-row1 {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .wf-title-area {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .wf-logo {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      letter-spacing: -0.01em;
    }

    .wf-session-pill {
      font-size: 11px;
      font-family: var(--font-mono);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2px 10px;
      color: var(--muted);
      max-width: 220px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wf-live-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .wf-live-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px rgba(63, 185, 80, 0.6);
    }

    .wf-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .wf-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 4px 10px;
      border-radius: var(--radius);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .wf-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--border-hover);
    }

    .wf-btn.active {
      background: rgba(56, 189, 248, 0.12);
      border-color: var(--cyan);
      color: var(--cyan);
    }

    /* Summary Metrics Row */
    .wf-metrics-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }

    .wf-metric {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 4px 10px;
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .wf-metric-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.04em;
    }

    .wf-metric-value {
      font-size: 12px;
      font-weight: 600;
      font-family: var(--font-mono);
      color: var(--fg);
    }

    .wf-metric-value.accent { color: var(--cyan); }
    .wf-metric-value.green { color: var(--green); }
    .wf-metric-value.purple { color: var(--purple); }
    .wf-metric-value.amber { color: var(--amber); }

    /* Controls Bar: Tabs & Filters */
    .wf-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-top: 1px solid var(--border);
      padding-top: 8px;
    }

    .wf-tabs {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .wf-tab {
      padding: 4px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      font-weight: 500;
      color: var(--muted);
      cursor: pointer;
      background: transparent;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .wf-tab:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.04);
    }

    .wf-tab.active {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--border);
    }

    .wf-filters {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .wf-filter-pill {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 12px;
      padding: 2px 10px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .wf-filter-pill:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.04);
    }

    .wf-filter-pill.active {
      background: rgba(255, 255, 255, 0.1);
      color: var(--fg);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .wf-search-input {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--fg);
      font-size: 12px;
      padding: 3px 8px;
      width: 170px;
      outline: none;
      transition: border-color 0.15s ease;
    }

    .wf-search-input:focus {
      border-color: var(--accent);
    }

    /* Main Workspace Layout */
    .fp-workspace {
      display: flex;
      flex: 1;
      height: calc(100vh - 150px);
      overflow: hidden;
      position: relative;
    }

    /* Left Sidebar: Turn & Flow Explorer */
    .fp-sidebar {
      width: 240px;
      min-width: 240px;
      background: var(--bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow-y: auto;
      transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1), min-width 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.15s ease;
    }

    .fp-sidebar.collapsed {
      width: 0 !important;
      min-width: 0 !important;
      border-right: none !important;
      opacity: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }

    .fp-sidebar-header {
      padding: 10px 12px 6px;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .fp-sidebar-toggle-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 2px 5px;
      border-radius: var(--radius);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s ease, background 0.15s ease;
    }

    .fp-sidebar-toggle-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.08);
    }

    .fp-turn-item {
      padding: 8px 12px;
      margin: 2px 6px;
      border-radius: var(--radius);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--muted);
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }

    .fp-turn-item:hover {
      background: rgba(255, 255, 255, 0.04);
      color: var(--fg);
    }

    .fp-turn-item.active {
      background: var(--card-bg);
      border-color: var(--border);
      color: var(--fg);
    }

    .fp-badge {
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--muted);
    }

    /* Center Canvas Container */
    .fp-canvas-container {
      flex: 1;
      position: relative;
      background: radial-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px);
      background-size: 20px 20px;
      background-color: #121214;
      overflow: hidden;
      cursor: grab;
      user-select: none;
    }

    .fp-canvas-container.panning {
      cursor: grabbing;
    }

    .fp-empty-state {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      color: var(--muted);
      text-align: center;
      max-width: 360px;
      pointer-events: none;
    }

    .fp-empty-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--cyan);
    }

    /* Canvas Floating Viewport */
    .fp-viewport {
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
    }

    svg.fp-svg-layer {
      width: 16000px;
      height: 10000px;
      position: absolute;
      top: 0;
      left: 0;
      overflow: visible;
      pointer-events: none;
    }

    .fp-nodes-layer {
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
    }

    /* Canvas Bottom Toolbar */
    .fp-canvas-toolbar {
      position: absolute;
      bottom: 16px;
      left: 16px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 3px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      z-index: 100;
    }

    .fp-canvas-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: 12px;
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 3px;
    }

    .fp-canvas-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
    }

    .fp-zoom-text {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--muted);
      padding: 0 4px;
    }

    /* Node Cards */
    .fp-node-card {
      position: absolute;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 12px;
      width: 250px;
      cursor: grab;
      pointer-events: auto;
      user-select: none;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .fp-node-card.dragging {
      cursor: grabbing;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.8);
      z-index: 50;
    }

    .fp-node-card:hover {
      border-color: var(--cyan);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.6);
    }

    .fp-node-card.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 6px 20px rgba(0, 0, 0, 0.7);
    }

    .fp-node-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 5px;
    }

    .fp-node-tag {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .fp-node-tag.llm { color: var(--purple); }
    .fp-node-tag.read { color: var(--blue); }
    .fp-node-tag.write { color: var(--green); }
    .fp-node-tag.shell { color: var(--amber); }
    .fp-node-tag.subagent { color: #f97316; }
    .fp-node-tag.security { color: var(--red); }

    .fp-node-badge {
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--muted);
    }

    .fp-node-badge.green { color: var(--green); background: rgba(63, 185, 80, 0.12); }
    .fp-node-badge.red { color: var(--red); background: rgba(248, 81, 73, 0.12); }

    .fp-node-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 3px;
    }

    .fp-node-sub {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Direct File Action Row in Card */
    .fp-node-file-link {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
    }

    .fp-file-path-text {
      font-family: var(--font-mono);
      color: var(--cyan);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 170px;
      text-decoration: underline;
      cursor: pointer;
    }

    .fp-file-path-text:hover {
      color: #7dd3fc;
    }

    .fp-file-open-icon {
      font-size: 10px;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 3px;
    }

    /* Right Inspector Drawer */
    .fp-inspector {
      width: 360px;
      min-width: 360px;
      background: var(--bg);
      border-left: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1), min-width 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.15s ease;
    }

    .fp-inspector.collapsed {
      width: 0 !important;
      min-width: 0 !important;
      border-left: none !important;
      opacity: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }

    .fp-inspector-tabs {
      height: 35px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      gap: 6px;
    }

    .fp-inspector-tab {
      font-size: 11.5px;
      font-weight: 500;
      color: var(--fg);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .fp-inspector-tab-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .fp-sidebar-toggle-btn.active,
    .fp-sidebar-toggle-btn.pinned {
      color: var(--cyan);
      background: rgba(56, 189, 248, 0.15);
    }

    .fp-inspector-content {
      padding: 14px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .fp-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px;
    }

    .fp-box-label {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-bottom: 6px;
    }

    .fp-box-val {
      font-family: var(--font-mono);
      font-size: 11.5px;
      color: var(--fg);
      word-break: break-all;
    }

    /* Action Button for File Open */
    .fp-btn-open-file {
      width: 100%;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--cyan);
      padding: 6px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
      margin-top: 8px;
    }

    .fp-btn-open-file:hover {
      background: rgba(56, 189, 248, 0.18);
      border-color: var(--cyan);
    }

    /* Diff Lines Box */
    .fp-diff-container {
      background: #141416;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 11px;
      overflow-x: auto;
      margin-top: 6px;
    }

    .fp-diff-row {
      display: flex;
      padding: 1px 8px;
      gap: 8px;
      white-space: pre;
    }

    .fp-diff-row.add { background: rgba(63, 185, 80, 0.15); color: #4ade80; }
    .fp-diff-row.del { background: rgba(248, 81, 73, 0.15); color: #f87171; }
    .fp-diff-row.ctx { color: var(--muted); }

    .fp-diff-num {
      width: 22px;
      text-align: right;
      color: var(--muted);
      opacity: 0.5;
    }

    /* Terminal Command Box */
    .fp-term-box {
      background: #141416;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--amber);
      line-height: 1.4;
    }

    /* Subagent Drilldown Breadcrumb Bar */
    .fp-subagent-breadcrumb {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 7px 16px;
      background: linear-gradient(90deg, rgba(188, 140, 255, 0.12) 0%, rgba(56, 189, 248, 0.08) 100%);
      border-bottom: 1px solid rgba(188, 140, 255, 0.25);
      font-size: 12px;
      color: var(--fg);
      flex-shrink: 0;
      z-index: 99;
      animation: fpFadeIn 0.2s ease-out;
    }

    @keyframes fpFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .fp-breadcrumb-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .fp-breadcrumb-back-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(188, 140, 255, 0.15);
      border: 1px solid rgba(188, 140, 255, 0.35);
      color: #e4e4e7;
      border-radius: var(--radius);
      padding: 4px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s ease;
    }

    .fp-breadcrumb-back-btn:hover {
      background: rgba(188, 140, 255, 0.25);
      border-color: var(--purple);
      color: #ffffff;
      transform: translateX(-1px);
    }

    .fp-breadcrumb-trail {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }

    .fp-crumb.link {
      color: var(--muted);
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .fp-crumb.link:hover {
      color: var(--cyan);
    }

    .fp-crumb-sep {
      color: var(--muted);
      font-size: 11px;
    }

    .fp-crumb.current {
      font-weight: 600;
      color: var(--purple);
    }

    .fp-subagent-pill {
      font-size: 10.5px;
      font-family: var(--font-mono);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.05);
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    .fp-subagent-meta-pills {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .fp-badge-subagent {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 10px;
      text-transform: uppercase;
      background: rgba(56, 189, 248, 0.12);
      color: var(--cyan);
      border: 1px solid rgba(56, 189, 248, 0.3);
    }

    .fp-badge-subagent.done {
      background: rgba(63, 185, 80, 0.12);
      color: var(--green);
      border-color: rgba(63, 185, 80, 0.3);
    }

    .fp-badge-subagent.running {
      background: rgba(210, 153, 34, 0.15);
      color: var(--amber);
      border-color: rgba(210, 153, 34, 0.35);
    }

    .fp-badge-subagent.failed {
      background: rgba(248, 81, 73, 0.15);
      color: var(--red);
      border-color: rgba(248, 81, 73, 0.35);
    }

    .fp-subagent-actions-badge {
      font-size: 10.5px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.05);
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }

    /* Subagent Card & Drilldown Button */
    .fp-node-card.subagent {
      border-color: rgba(188, 140, 255, 0.35);
      background: linear-gradient(180deg, rgba(30, 30, 30, 0.95) 0%, rgba(188, 140, 255, 0.05) 100%);
    }

    .fp-node-card.subagent:hover {
      border-color: var(--purple);
      box-shadow: 0 4px 18px rgba(188, 140, 255, 0.18);
    }

    .fp-card-drilldown-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-top: 8px;
      padding: 5px 8px;
      width: 100%;
      background: rgba(188, 140, 255, 0.12);
      border: 1px solid rgba(188, 140, 255, 0.3);
      color: #e4e4e7;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s ease;
    }

    .fp-card-drilldown-btn:hover {
      background: rgba(188, 140, 255, 0.22);
      border-color: var(--purple);
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(188, 140, 255, 0.2);
    }

    /* Inspector Subagent Controls & List */
    .fp-btn-primary-drilldown {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 8px 12px;
      background: linear-gradient(90deg, rgba(188, 140, 255, 0.25) 0%, rgba(56, 189, 248, 0.20) 100%);
      border: 1px solid rgba(188, 140, 255, 0.45);
      color: #ffffff;
      border-radius: var(--radius);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.18s ease;
      margin-top: 8px;
    }

    .fp-btn-primary-drilldown:hover {
      background: linear-gradient(90deg, rgba(188, 140, 255, 0.35) 0%, rgba(56, 189, 248, 0.30) 100%);
      border-color: var(--purple);
      box-shadow: 0 4px 14px rgba(188, 140, 255, 0.25);
      transform: translateY(-1px);
    }

    .fp-subagent-tools-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 8px;
      max-height: 220px;
      overflow-y: auto;
    }

    .fp-subagent-tool-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 5px 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.12s;
    }

    .fp-subagent-tool-row:hover {
      background: rgba(255, 255, 255, 0.07);
      border-color: var(--border-hover);
    }

    .fp-subagent-tool-name {
      font-weight: 600;
      color: var(--cyan);
      white-space: nowrap;
    }

    .fp-subagent-tool-desc {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .fp-subagent-tool-tag {
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
    }

    /* Sidebar Subagents Section */
    .fp-sidebar-subagents-section {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }

    .fp-sidebar-section-title {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      padding: 4px 8px 6px;
    }

    .fp-subagent-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      border-radius: var(--radius);
      color: var(--fg);
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s;
      margin-bottom: 2px;
    }

    .fp-subagent-item:hover {
      background: rgba(188, 140, 255, 0.12);
    }

    .fp-subagent-item.active {
      background: rgba(188, 140, 255, 0.22);
      border-left: 2px solid var(--purple);
      font-weight: 600;
    }

    .fp-subagent-item-left {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
}
