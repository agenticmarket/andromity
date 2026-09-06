export function getWaterfallStyles(): string {
  return `
    :root {
      --bg: var(--vscode-sideBar-background, #18181b);
      --fg: var(--vscode-foreground, #e4e4e7);
      --card-bg: var(--vscode-editor-background, #1e1e1e);
      --input-bg: var(--vscode-input-background, #252526);
      --border: var(--vscode-widget-border, rgba(255,255,255,0.08));
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

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font-ui);
      font-size: 13px;
      line-height: 1.5;
      overflow-x: hidden;
      overflow-y: auto;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Top Navigation Bar */
    .wf-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      padding: 10px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      backdrop-filter: blur(8px);
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
      font-size: 15px;
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
      background: var(--muted);
      transition: background 0.2s ease;
    }

    .wf-live-dot.active {
      background: var(--green);
      box-shadow: 0 0 8px rgba(63, 185, 80, 0.6);
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.25); opacity: 0.7; }
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
      border-color: rgba(255, 255, 255, 0.16);
    }

    .wf-btn:active {
      transform: translateY(1px);
    }

    .wf-btn.active {
      background: rgba(56, 189, 248, 0.12);
      border-color: var(--cyan);
      color: var(--cyan);
    }

    /* Summary Metric Pills */
    .wf-metrics-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }

    .wf-metric {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 5px 12px;
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
      font-size: 13px;
      font-weight: 600;
      font-family: var(--font-mono);
      color: var(--fg);
    }

    .wf-metric-value.accent {
      color: var(--cyan);
    }

    .wf-metric-value.green {
      color: var(--green);
    }

    .wf-metric-value.purple {
      color: var(--purple);
    }

    /* Tabs & Controls Bar */
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
      border: 1px solid transparent;
      transition: all 0.15s ease;
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
      gap: 8px;
    }

    .wf-search-input {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--fg);
      font-size: 12px;
      padding: 4px 10px;
      width: 180px;
      outline: none;
      transition: border-color 0.15s ease;
    }

    .wf-search-input:focus {
      border-color: var(--accent);
    }

    .wf-filter-pill {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid var(--border);
      color: var(--muted);
      cursor: pointer;
      background: transparent;
      transition: all 0.15s ease;
    }

    .wf-filter-pill:hover,
    .wf-filter-pill.active {
      color: var(--fg);
      border-color: rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.06);
    }

    /* Main Container Views */
    .wf-view-container {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
    }

    /* Timeline Waterfall Grid */
    .wf-timeline-view {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .wf-empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 80px 20px;
      color: var(--muted);
      text-align: center;
      gap: 12px;
    }

    .wf-empty-icon {
      font-size: 32px;
      opacity: 0.6;
    }

    /* Turn Group */
    .wf-turn-group {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      margin-bottom: 12px;
    }

    .wf-turn-header {
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border);
      padding: 8px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      user-select: none;
    }

    .wf-turn-header:hover {
      background: rgba(255, 255, 255, 0.04);
    }

    .wf-turn-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .wf-turn-badge {
      font-size: 11px;
      font-weight: 600;
      font-family: var(--font-mono);
      background: rgba(255, 255, 255, 0.06);
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--fg);
    }

    .wf-turn-query {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wf-turn-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--muted);
      flex-shrink: 0;
    }

    /* Timeline Table / Ruler */
    .wf-timeline-table {
      display: flex;
      flex-direction: column;
      width: 100%;
    }

    .wf-ruler {
      display: flex;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding: 4px 14px;
      background: rgba(0, 0, 0, 0.15);
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--muted);
    }

    .wf-ruler-left {
      width: 280px;
      flex-shrink: 0;
    }

    .wf-ruler-track {
      flex: 1;
      display: flex;
      justify-content: space-between;
      position: relative;
    }

    .wf-ruler-right {
      width: 100px;
      flex-shrink: 0;
      text-align: right;
      padding-left: 12px;
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--muted);
      letter-spacing: 0.04em;
    }

    /* Span Row */
    .wf-span-row {
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      transition: background 0.15s ease;
    }

    .wf-span-row:last-child {
      border-bottom: none;
    }

    .wf-span-row:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    .wf-span-main {
      display: flex;
      align-items: center;
      padding: 7px 14px;
      cursor: pointer;
      user-select: none;
    }

    .wf-span-left {
      width: 280px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding-right: 12px;
      overflow: hidden;
    }

    .wf-span-chevron {
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }

    .wf-span-row.expanded .wf-span-chevron {
      transform: rotate(90deg);
    }

    .wf-span-badge {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 6px;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .wf-span-badge.llm {
      background: rgba(188, 140, 255, 0.15);
      color: var(--purple);
      border: 1px solid rgba(188, 140, 255, 0.3);
    }

    .wf-span-badge.tool {
      background: rgba(88, 166, 255, 0.15);
      color: var(--blue);
      border: 1px solid rgba(88, 166, 255, 0.3);
    }

    .wf-span-badge.subagent {
      background: rgba(63, 185, 80, 0.15);
      color: var(--green);
      border: 1px solid rgba(63, 185, 80, 0.3);
    }

    .wf-span-name {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .wf-span-track {
      flex: 1;
      height: 24px;
      position: relative;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 4px;
      display: flex;
      align-items: center;
    }

    /* Timing Bar */
    .wf-bar {
      position: absolute;
      height: 16px;
      border-radius: 3px;
      display: flex;
      align-items: center;
      padding: 0 6px;
      min-width: 4px;
      overflow: hidden;
      white-space: nowrap;
      transition: width 0.1s linear, left 0.1s linear;
    }

    .wf-bar.llm {
      background: linear-gradient(90deg, rgba(188, 140, 255, 0.7), rgba(188, 140, 255, 0.9));
      border: 1px solid var(--purple);
      color: #fff;
    }

    .wf-bar.tool {
      background: linear-gradient(90deg, rgba(88, 166, 255, 0.7), rgba(88, 166, 255, 0.9));
      border: 1px solid var(--blue);
      color: #fff;
    }

    .wf-bar.subagent {
      background: linear-gradient(90deg, rgba(63, 185, 80, 0.7), rgba(63, 185, 80, 0.9));
      border: 1px solid var(--green);
      color: #fff;
    }

    .wf-bar.error {
      background: linear-gradient(90deg, rgba(248, 81, 73, 0.7), rgba(248, 81, 73, 0.9));
      border: 1px solid var(--red);
      color: #fff;
    }

    .wf-bar.cancelled {
      background: repeating-linear-gradient(
        45deg,
        rgba(210, 153, 34, 0.35),
        rgba(210, 153, 34, 0.35) 6px,
        rgba(210, 153, 34, 0.12) 6px,
        rgba(210, 153, 34, 0.12) 12px
      ) !important;
      border: 1px dashed var(--amber) !important;
      animation: none !important;
      color: var(--amber) !important;
    }

    .wf-bar.waiting {
      background: linear-gradient(90deg, rgba(210, 153, 34, 0.7), rgba(210, 153, 34, 0.9));
      border: 1px solid var(--amber);
      color: #fff;
      animation: pulse 1.5s infinite ease-in-out;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    /* Running Shimmer Animation */
    .wf-bar.running {
      background-size: 200% 100%;
      background-image: linear-gradient(90deg, rgba(56, 189, 248, 0.6) 0%, rgba(255, 255, 255, 0.8) 50%, rgba(56, 189, 248, 0.6) 100%);
      animation: shimmer 1.5s infinite linear;
      border-color: var(--cyan);
    }

    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* TTFB Marker Inside LLM Bar */
    .wf-bar-ttfb {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.25);
      border-right: 1px dashed rgba(255, 255, 255, 0.6);
      pointer-events: none;
    }

    .wf-span-time {
      width: 100px;
      flex-shrink: 0;
      text-align: right;
      padding-left: 12px;
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--muted);
      white-space: nowrap;
    }

    .wf-span-time.running {
      color: var(--cyan);
    }

    /* Expanded Details Box */
    .wf-span-details {
      display: none;
      padding: 12px 14px 14px 44px;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid rgba(255, 255, 255, 0.04);
      gap: 10px;
      flex-direction: column;
    }

    .wf-span-row.expanded .wf-span-details {
      display: flex;
    }

    .wf-detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
      margin-bottom: 8px;
    }

    .wf-detail-item {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 10px;
    }

    .wf-detail-key {
      font-size: 10px;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 2px;
    }

    .wf-detail-val {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--fg);
      word-break: break-all;
    }

    .wf-badge-pill {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 3px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .wf-badge-pill.thinking {
      background: rgba(188, 140, 255, 0.15);
      color: var(--purple);
      border: 1px solid rgba(188, 140, 255, 0.3);
    }

    .wf-badge-pill.response {
      background: rgba(56, 189, 248, 0.15);
      color: var(--cyan);
      border: 1px solid rgba(56, 189, 248, 0.3);
    }

    .wf-badge-pill.tools {
      background: rgba(88, 166, 255, 0.15);
      color: var(--blue);
      border: 1px solid rgba(88, 166, 255, 0.3);
    }

    .wf-badge-pill.cancelled {
      background: rgba(210, 153, 34, 0.15);
      color: var(--amber);
      border: 1px solid rgba(210, 153, 34, 0.3);
    }

    .wf-badge-pill.waiting {
      background: rgba(210, 153, 34, 0.15);
      color: var(--amber);
      border: 1px solid rgba(210, 153, 34, 0.3);
    }

    .wf-badge-pill.error {
      background: rgba(248, 81, 73, 0.15);
      color: var(--red);
      border: 1px solid rgba(248, 81, 73, 0.3);
    }

    .wf-thinking-box {
      background: rgba(188, 140, 255, 0.05);
      border: 1px solid rgba(188, 140, 255, 0.2);
      border-radius: 4px;
      padding: 8px 12px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: #d8b4fe;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow-y: auto;
      position: relative;
    }

    .wf-response-box {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
      font-family: var(--font-mono);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow-y: auto;
      position: relative;
    }

    .wf-code-box {
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
      font-family: var(--font-mono);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 240px;
      overflow-y: auto;
      position: relative;
    }

    .wf-copy-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 10px;
      cursor: pointer;
    }

    .wf-copy-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.15);
    }

    .wf-copy-btn.copied {
      color: var(--green);
      border-color: var(--green);
      background: rgba(63, 185, 80, 0.15);
    }

    /* Rendered Markdown in Model Response */
    .wf-rendered-markdown {
      font-size: 12px;
      line-height: 1.6;
      color: var(--fg);
      word-break: break-word;
    }

    .wf-rendered-markdown p {
      margin: 0 0 8px 0;
    }

    .wf-rendered-markdown p:last-child {
      margin-bottom: 0;
    }

    .wf-rendered-markdown pre {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
      overflow-x: auto;
      margin: 8px 0;
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .wf-rendered-markdown code {
      font-family: var(--font-mono);
      font-size: 11px;
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 4px;
      border-radius: 3px;
    }

    .wf-rendered-markdown pre code {
      background: transparent;
      padding: 0;
    }

    .wf-rendered-markdown ul, .wf-rendered-markdown ol {
      margin: 4px 0 8px 20px;
      padding: 0;
    }

    .wf-rendered-markdown li {
      margin-bottom: 3px;
    }

    /* Log Stream View */
    .wf-log-view {
      display: none;
      flex-direction: column;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-family: var(--font-mono);
      font-size: 11px;
      min-height: 400px;
      padding: 8px;
      overflow-y: auto;
    }

    .wf-log-view.active {
      display: flex;
    }

    .wf-log-line {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 3px 8px;
      border-radius: 3px;
    }

    .wf-log-line:hover {
      background: rgba(255, 255, 255, 0.04);
    }

    .wf-log-time {
      color: var(--muted);
      font-size: 10px;
      flex-shrink: 0;
    }

    .wf-log-tag {
      font-weight: 600;
      flex-shrink: 0;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 10px;
    }

    .wf-log-tag.llm { color: var(--purple); background: rgba(188, 140, 255, 0.1); }
    .wf-log-tag.tool { color: var(--blue); background: rgba(88, 166, 255, 0.1); }
    .wf-log-tag.subagent { color: var(--green); background: rgba(63, 185, 80, 0.1); }
    .wf-log-tag.done { color: var(--cyan); background: rgba(56, 189, 248, 0.1); }

    .wf-log-msg {
      color: var(--fg);
      word-break: break-all;
    }

    /* Stats View */
    .wf-stats-view {
      display: none;
      flex-direction: column;
      gap: 16px;
    }

    .wf-stats-view.active {
      display: flex;
    }

    .wf-stats-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px;
    }

    .wf-stats-card-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-bottom: 12px;
    }

    .wf-stats-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      font-family: var(--font-mono);
    }

    .wf-stats-table th {
      text-align: left;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
    }

    .wf-stats-table td {
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    .wf-stats-table tr:last-child td {
      border-bottom: none;
    }

    /* Guide / Help Modal */
    .wf-modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }

    .wf-modal-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.55);
      width: 100%;
      max-width: 620px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: modalPop 0.15s ease-out;
    }

    @keyframes modalPop {
      from { transform: scale(0.97); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .wf-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.02);
    }

    .wf-modal-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--fg);
    }

    .wf-modal-close {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      font-size: 14px;
      padding: 4px 8px;
      border-radius: 4px;
    }

    .wf-modal-close:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.08);
    }

    .wf-modal-body {
      padding: 18px;
      overflow-y: auto;
      font-size: 12px;
      line-height: 1.6;
      color: var(--fg);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .wf-guide-section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--cyan);
      margin-bottom: 6px;
    }

    .wf-guide-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px;
    }

    .wf-guide-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
    }

    .wf-guide-item strong {
      color: var(--fg);
      display: block;
      margin-bottom: 2px;
    }

    .wf-guide-item p {
      margin: 0;
      font-size: 11px;
      color: var(--muted);
    }
  `;
}
