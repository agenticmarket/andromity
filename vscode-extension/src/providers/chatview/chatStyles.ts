export function getChatStyles(): string {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,300..700&family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&display=swap');

    :root {
      --bg: var(--vscode-sideBar-background, #18181b);
      --fg: var(--vscode-foreground, #e4e4e7);
      --card-bg: var(--vscode-editor-background, #1e1e1e);
      --input-bg: var(--vscode-input-background, #252526);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --border: var(--vscode-widget-border, rgba(255,255,255,0.08));
      --accent: var(--vscode-focusBorder, #007fd4);
      --accent-glow: rgba(0, 127, 212, 0.25);
      --green: #3fb950;
      --red: #f85149;
      --purple: #bc8cff;
      --muted: var(--vscode-descriptionForeground, #888888);
      --radius: 6px;
      --font-ui: 'Inter', 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      --font-mono: 'JetBrains Mono', 'Geist Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, 'Courier New', monospace;
      --font: var(--font-ui);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font);
      font-feature-settings: "cv02", "cv03", "cv04", "cv11", "ss01", "ss02";
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
      letter-spacing: -0.011em;
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ”--€ Top Bar: Minimal, Sleek, Professional ”--------------------------------------------€ */
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      gap: 6px;
      flex-shrink: 0;
      position: relative;
    }

    .top-bar-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }

    .top-bar-right {
      display: flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }

    .top-bar-icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      border-radius: 4px;
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: all 0.15s ease;
    }

    .top-bar-icon-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.12);
    }

    /* Session Badge */
    .session-badge-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 10px;
      color: var(--fg);
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 700;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: all 0.15s ease;
    }
    .session-badge-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--accent);
    }
    .session-badge-icon {
      width: 12px;
      height: 12px;
      color: var(--accent);
      flex-shrink: 0;
    }
    .session-badge-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Model Pill */
    .model-badge-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 3px 8px;
      color: var(--fg);
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      max-width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: all 0.15s ease;
    }

    .model-badge-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: var(--accent);
    }

    .model-badge-icon {
      width: 12px;
      height: 12px;
      color: var(--accent);
      flex-shrink: 0;
    }

    .model-badge-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chevron-icon {
      width: 10px;
      height: 10px;
      color: var(--muted);
      flex-shrink: 0;
    }

    /* Mode Badge */
    .mode-badge-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(63, 185, 80, 0.12);
      border: 1px solid rgba(63, 185, 80, 0.3);
      border-radius: 4px;
      padding: 2px 6px;
      color: var(--green);
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      letter-spacing: 0.3px;
      flex-shrink: 0;
      transition: all 0.15s ease;
    }

    .mode-badge-btn svg { width: 10px; height: 10px; }
    .mode-badge-btn:hover { background: rgba(63, 185, 80, 0.2); }

    .mode-badge-btn.mode-safe {
      background: rgba(63, 185, 80, 0.12);
      border-color: rgba(63, 185, 80, 0.35);
      color: var(--green);
    }
    .mode-badge-btn.mode-safe:hover { background: rgba(63, 185, 80, 0.22); }

    .mode-badge-btn.mode-trust {
      background: rgba(88, 166, 255, 0.12);
      border-color: rgba(88, 166, 255, 0.35);
      color: #58a6ff;
    }
    .mode-badge-btn.mode-trust:hover { background: rgba(88, 166, 255, 0.22); }

    .mode-badge-btn.mode-full {
      background: rgba(188, 140, 255, 0.12);
      border-color: rgba(188, 140, 255, 0.35);
      color: #bc8cff;
    }
    .mode-badge-btn.mode-full:hover { background: rgba(188, 140, 255, 0.22); }

    .mode-badge-btn.mode-yolo {
      background: rgba(240, 136, 62, 0.12);
      border-color: rgba(240, 136, 62, 0.35);
      color: #f0883e;
    }
    .mode-badge-btn.mode-yolo:hover { background: rgba(240, 136, 62, 0.22); }

    /* ”--€ Sessions Drawer / Flyout ”--------------------------------------------------------------------€ */
    .sessions-flyout {
      position: absolute;
      top: 36px;
      left: 8px;
      right: 8px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 10px 28px rgba(0,0,0,0.5);
      z-index: 120;
      display: flex;
      flex-direction: column;
      max-height: 340px;
      overflow: hidden;
    }
    .sessions-flyout-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.02);
    }
    .sessions-search {
      flex: 1;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--fg);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 11px;
      outline: none;
    }
    .sessions-search:focus { border-color: var(--accent); }
    .sessions-new-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 10px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .sessions-new-btn:hover { opacity: 0.9; }
    .sessions-filter-tabs {
      display: flex;
      gap: 4px;
      padding: 6px 8px 4px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-alt, rgba(0,0,0,0.1));
    }
    .sessions-filter-tab {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 4px 6px;
      border-radius: 4px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.12s;
    }
    .sessions-filter-tab:hover {
      color: var(--fg);
      background: rgba(255,255,255,0.04);
    }
    .sessions-filter-tab.active {
      background: var(--card-bg, rgba(255,255,255,0.08));
      color: var(--fg);
      border-color: var(--border);
      font-weight: 600;
    }
    .sessions-filter-tab .filter-count {
      font-size: 9.5px;
      padding: 0 4px;
      border-radius: 8px;
      background: rgba(255,255,255,0.08);
      color: var(--muted);
    }
    .sessions-filter-tab.active .filter-count {
      background: var(--accent);
      color: #fff;
    }
    .sessions-list {
      overflow-y: auto;
      padding: 4px;
    }
    .session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      color: var(--fg);
      transition: background 0.12s;
      border: 1px solid transparent;
    }
    .session-item:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .session-item.active {
      background: rgba(6, 182, 212, 0.08);
      border-color: rgba(6, 182, 212, 0.25);
      color: var(--accent);
    }
    .session-item-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .session-item-title {
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .session-badge-status {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--card-bg, rgba(255,255,255,0.06));
      color: var(--muted);
      flex-shrink: 0;
    }
    .session-badge-status.session-status-running {
      background: rgba(234, 179, 8, 0.15);
      color: #eab308;
    }
    .session-badge-status.session-status-error {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }
    .session-badge-status.session-status-approval_required {
      background: rgba(249, 115, 22, 0.15);
      color: #f97316;
    }
    .session-item-meta {
      font-size: 10px;
      color: var(--muted);
      display: flex;
      gap: 8px;
    }
    .session-item-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.12s;
    }
    .session-item:hover .session-item-actions {
      opacity: 1;
    }
    .session-action-icon {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 3px;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .session-action-icon:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.1);
    }
    .session-action-delete:hover {
      color: var(--red);
    }

    .sessions-load-more-wrap {
      padding: 6px 8px;
      text-align: center;
      border-top: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.01);
    }
    .btn-load-more-sessions {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--fg);
      font-size: 11px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-load-more-sessions:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: var(--accent);
    }

    /* ”--€ Scheduled Crons Overlay ”------------------------------------------------------------------------€ */
    .crons-flyout {
      position: absolute;
      top: 36px;
      left: 8px;
      right: 8px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 10px 28px rgba(0,0,0,0.5);
      z-index: 120;
      display: flex;
      flex-direction: column;
      max-height: 320px;
      overflow: hidden;
    }
    .crons-flyout-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.02);
    }
    .crons-header-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--fg);
    }
    .crons-close-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 2px;
      border-radius: 3px;
    }
    .crons-close-btn:hover { color: var(--fg); }
    .crons-list {
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cron-card {
      padding: 8px 10px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cron-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .cron-card-schedule {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--accent);
    }
    .cron-status-pill {
      font-size: 9.5px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 1px 6px;
      border-radius: 8px;
    }
    .cron-status-active { background: rgba(63, 185, 80, 0.15); color: var(--green); }
    .cron-status-paused { background: rgba(148, 163, 184, 0.15); color: var(--pending-fg); }
    .cron-prompt {
      font-size: 11px;
      color: var(--fg);
      line-height: 1.3;
    }

    /* ─── Collapsible Todo / Plan Tracker (Above Input Section) ─────────────── */
    .plan-tracker-strip {
      margin: 0 10px 8px 10px;
      padding: 7px 11px;
      background: var(--card-bg, #18181b);
      border: 1px solid var(--card-border, rgba(255, 255, 255, 0.08));
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: all 0.2s ease;
      animation: bannerSlideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .tracker-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      user-select: none;
    }
    .tracker-info {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      color: var(--fg, #f4f4f5);
      min-width: 0;
      flex: 1;
      cursor: pointer;
    }
    .tracker-chevron {
      color: var(--muted, #a1a1aa);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease;
      flex-shrink: 0;
    }
    .plan-tracker-strip.collapsed .tracker-chevron {
      transform: rotate(-90deg);
    }
    .tracker-icon {
      color: #c084fc;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
    }
    .tracker-title {
      font-weight: 600;
      letter-spacing: -0.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tracker-count {
      color: var(--muted, #a1a1aa);
      font-size: 10.5px;
      font-family: var(--font-mono);
      background: rgba(255, 255, 255, 0.06);
      padding: 1px 6px;
      border-radius: 10px;
      white-space: nowrap;
    }
    .tracker-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .btn-tracker-open {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--fg, #f4f4f5);
      font-size: 10.5px;
      font-weight: 500;
      padding: 2px 7px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .btn-tracker-open:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .btn-tracker-close {
      background: transparent;
      border: none;
      color: var(--muted, #71717a);
      cursor: pointer;
      padding: 2px 3px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.12s ease;
    }
    .btn-tracker-close:hover {
      color: var(--fg, #f4f4f5);
      background: rgba(255, 255, 255, 0.08);
    }
    .tracker-progress-track {
      width: 100%;
      height: 3.5px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
    }
    .tracker-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #c084fc, #38bdf8);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .tracker-todos-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 3px;
      max-height: 140px;
      overflow-y: auto;
      padding-right: 2px;
    }
    .plan-tracker-strip.collapsed .tracker-todos-list {
      display: none;
    }
    .tracker-todo-item {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      font-size: 11px;
      line-height: 1.35;
      color: var(--fg, #e4e4e7);
      padding: 1px 0;
    }
    .tracker-todo-item.is-done {
      color: var(--muted, #71717a);
      text-decoration: line-through;
    }
    .tracker-todo-item.is-active {
      color: #38bdf8;
      font-weight: 500;
    }
    .tracker-todo-bullet {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.08);
      color: var(--muted, #a1a1aa);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 8.5px;
      font-weight: 600;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .tracker-todo-item.is-done .tracker-todo-bullet {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }
    .tracker-todo-item.is-active .tracker-todo-bullet {
      background: rgba(6, 182, 212, 0.2);
      color: #38bdf8;
    }
    .tracker-todo-item.is-failed .tracker-todo-bullet {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    .tracker-todo-text {
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }

    /* ─── Compaction In-Progress Indicator Banner ────────────────────────────── */
    .compaction-banner {
      display: flex;
      flex-direction: column;
      background: linear-gradient(135deg, rgba(6, 182, 212, 0.12) 0%, rgba(139, 92, 246, 0.12) 100%);
      border: 1px solid rgba(6, 182, 212, 0.35);
      border-radius: var(--radius);
      margin: 8px 10px 4px 10px;
      padding: 9px 12px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      animation: bannerSlideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 50;
      flex-shrink: 0;
    }

    .compaction-banner.success {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(6, 182, 212, 0.1) 100%);
      border-color: rgba(16, 185, 129, 0.4);
    }

    .compaction-banner-inner {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .compaction-icon-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: rgba(6, 182, 212, 0.18);
      color: #38bdf8;
      flex-shrink: 0;
    }

    .compaction-banner.success .compaction-icon-wrap {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }

    .compaction-spin-svg {
      animation: compactSpin 2.5s infinite linear;
    }

    .compaction-banner.success .compaction-spin-svg {
      animation: none;
    }

    @keyframes compactSpin {
      0% { transform: rotate(0deg) scale(1); }
      50% { transform: rotate(180deg) scale(1.1); }
      100% { transform: rotate(360deg) scale(1); }
    }

    .compaction-info {
      flex: 1;
      min-width: 0;
    }

    .compaction-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      letter-spacing: -0.01em;
      line-height: 1.3;
    }

    .compaction-detail {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .compaction-progress-track {
      width: 100%;
      height: 3px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      margin-top: 8px;
      overflow: hidden;
      position: relative;
    }

    .compaction-progress-bar {
      height: 100%;
      width: 100%;
      background: linear-gradient(90deg, transparent, #06b6d4, #8b5cf6, transparent);
      background-size: 200% 100%;
      animation: compactShimmer 1.8s infinite linear;
      border-radius: 2px;
    }

    .compaction-banner.success .compaction-progress-bar {
      background: #10b981;
      animation: none;
    }

    @keyframes compactShimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    @keyframes bannerSlideIn {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .top-bar-icon-btn.compacting {
      color: #38bdf8 !important;
      animation: pulseCompact 1.5s infinite ease-in-out;
      pointer-events: none;
      opacity: 0.8;
    }

    @keyframes pulseCompact {
      0%, 100% { opacity: 0.5; transform: scale(0.95); }
      50% { opacity: 1; transform: scale(1.08); }
    }

    .inline-compaction-card {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: rgba(6, 182, 212, 0.08);
      border: 1px solid rgba(6, 182, 212, 0.25);
      border-radius: 6px;
      margin: 8px 0;
      font-size: 11.5px;
      color: #67e8f9;
      animation: bannerSlideIn 0.2s ease-out;
    }

    .compaction-summary-card {
      background: rgba(147, 51, 234, 0.08);
      border: 1px solid rgba(147, 51, 234, 0.25);
      border-radius: 8px;
      margin: 8px 0 12px 0;
      overflow: hidden;
      font-size: 11.5px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }
    .compaction-summary-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      background: rgba(147, 51, 234, 0.12);
      color: #d8b4fe;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
    }
    .compaction-summary-header:hover {
      background: rgba(147, 51, 234, 0.18);
    }
    .compaction-summary-tag {
      font-size: 9px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(147, 51, 234, 0.3);
      color: #f3e8ff;
      letter-spacing: 0.5px;
    }
    .compaction-summary-header .compaction-chevron {
      margin-left: auto;
      width: 11px;
      height: 11px;
      transition: transform 0.15s ease;
    }
    .compaction-summary-card.expanded .compaction-chevron {
      transform: rotate(90deg);
    }
    .compaction-summary-body {
      padding: 10px 12px;
      color: var(--fg);
      font-size: 11.5px;
      line-height: 1.5;
      display: none;
      border-top: 1px solid rgba(147, 51, 234, 0.15);
      max-height: 320px;
      overflow-y: auto;
    }
    .compaction-summary-card.expanded .compaction-summary-body {
      display: block;
    }

    /* ”--€ Model Quick Switcher Flyout ”----------------------------------------------------------------€ */
    .model-flyout {
      position: absolute;
      top: 36px;
      left: 10px;
      right: 10px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 100;
      display: flex;
      flex-direction: column;
      max-height: 280px;
      overflow: hidden;
    }

    .flyout-header {
      display: flex;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }

    .flyout-search {
      flex: 1;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--fg);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 11px;
      outline: none;
    }

    .flyout-hub-link {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }

    .flyout-list {
      overflow-y: auto;
      padding: 4px;
    }

    .flyout-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      color: var(--fg);
      transition: background 0.12s;
    }

    .flyout-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .flyout-item.active {
      color: var(--green);
      font-weight: 600;
    }

    .flyout-item-meta {
      font-size: 10px;
      color: var(--muted);
    }

    /* ─── Chat Feed ─────────────────────────────────────────────────────────────────── */
    .chat-container {
      min-width: 0;
      word-break: break-word;
      overflow-wrap: break-word;
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
      padding: 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      position: relative;
    }

    /* ─── Zero State: Minimalist & Left-Aligned (Inspiration-Matched) ─────────────────────────── */
    .zero-state {
      margin: 0;
      padding: 32px 18px 20px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      text-align: left;
      gap: 24px;
      width: 100%;
      box-sizing: border-box;
      animation: fadeInZero 0.2s ease-out;
    }

    @keyframes fadeInZero {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ─── Onboarding Guide Section ───────────────────────────────────────── */
    .onboarding-guide-section {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 16px;
      animation: fadeInZero 0.25s ease-out;
    }
    .onboarding-hero {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .onboarding-step-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: rgba(9, 249, 148, 0.12);
      color: #09f994;
      border: 1px solid rgba(9, 249, 148, 0.25);
      width: fit-content;
    }
    .onboarding-step-pill .step-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #09f994;
      box-shadow: 0 0 6px #09f994;
    }
    .onboarding-title {
      font-size: 20px;
      font-weight: 600;
      color: var(--fg, #ffffff);
      margin: 0;
      letter-spacing: -0.4px;
    }
    .onboarding-subtitle {
      font-size: 12px;
      color: var(--muted, #888888);
      margin: 0;
      line-height: 1.45;
    }
    .onboarding-card {
      background: var(--card-bg, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: 10px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }
    .onboarding-card-header {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .onboarding-label {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--fg, #f4f4f5);
      letter-spacing: -0.1px;
    }
    .onboarding-sublabel {
      font-size: 10.5px;
      color: var(--muted, #888888);
    }
    .onboarding-providers-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px;
    }
    .onboarding-provider-chip {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      background: rgba(255, 255, 255, 0.03);
      color: var(--fg, #f4f4f5);
      cursor: pointer;
      text-align: left;
      transition: all 0.15s ease;
      position: relative;
    }
    .onboarding-provider-chip:hover {
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-1px);
    }
    .onboarding-provider-chip.active {
      background: rgba(9, 249, 148, 0.08);
      border-color: #09f994;
      box-shadow: 0 0 10px rgba(9, 249, 148, 0.15);
    }
    .provider-color-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
      margin-bottom: 2px;
    }
    .provider-chip-name {
      font-size: 11.5px;
      font-weight: 600;
    }
    .provider-chip-badge {
      font-size: 9.5px;
      color: var(--muted, #888888);
    }
    .onboarding-provider-chip.active .provider-chip-badge {
      color: #09f994;
    }
    .onboarding-form-area, .onboarding-ollama-area {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    }
    .onboarding-input-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .onboarding-portal-link {
      font-size: 10.5px;
      color: #60a5fa;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      cursor: pointer;
      transition: color 0.12s;
    }
    .onboarding-portal-link:hover {
      color: #93c5fd;
      text-decoration: underline;
    }
    .onboarding-input-wrap {
      display: flex;
      align-items: center;
      position: relative;
      width: 100%;
    }
    .onboarding-key-input {
      width: 100%;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      border-radius: 6px;
      padding: 8px 30px 8px 10px;
      color: #ffffff;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .onboarding-key-input:focus {
      border-color: #09f994;
      box-shadow: 0 0 0 2px rgba(9, 249, 148, 0.15);
    }
    .onboarding-toggle-vis {
      position: absolute;
      right: 8px;
      background: transparent;
      border: none;
      color: var(--muted, #888888);
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .onboarding-toggle-vis:hover {
      color: var(--fg, #ffffff);
    }
    .btn-onboarding-save {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 14px;
      background: #09f994;
      color: #0b0f19;
      font-size: 12px;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      margin-top: 4px;
    }
    .btn-onboarding-save:hover {
      background: #10fba0;
      box-shadow: 0 0 14px rgba(9, 249, 148, 0.35);
      transform: translateY(-1px);
    }
    .btn-onboarding-save:active {
      transform: translateY(0);
    }
    .ollama-info-box {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px;
      border-radius: 6px;
      background: rgba(236, 72, 153, 0.08);
      border: 1px solid rgba(236, 72, 153, 0.2);
    }
    .ollama-info-icon {
      font-size: 18px;
    }
    .ollama-info-content {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ollama-info-title {
      font-size: 11.5px;
      font-weight: 600;
      color: #f472b6;
    }
    .ollama-info-desc {
      font-size: 10.5px;
      color: var(--muted, #888888);
      line-height: 1.35;
    }
    .onboarding-footer-links {
      display: flex;
      justify-content: center;
      padding-top: 4px;
    }
    .btn-link-settings {
      background: transparent;
      border: none;
      color: var(--muted, #888888);
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      transition: color 0.12s;
    }
    .btn-link-settings:hover {
      color: var(--fg, #ffffff);
      text-decoration: underline;
    }
    .ready-hero-section {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .zero-hero {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 16px;
      width: 100%;
    }

    .zero-brand-logo {
      display: flex;
      align-items: center;
      justify-content: flex-start;
    }

    .zero-logo-img {
      width: 32px;
      height: 32px;
      object-fit: contain;
      display: block;
      filter: drop-shadow(0 2px 10px rgba(9, 249, 148, 0.25));
      transition: transform 0.2s ease;
    }

    .zero-logo-img:hover {
      transform: scale(1.06);
    }

    .zero-statement-wrap {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 100%;
    }

    .zero-statement-main {
      font-size: 26px;
      font-weight: 600;
      line-height: 1.25;
      color: #f4f4f5;
      letter-spacing: -0.6px;
      margin: 0;
      font-family: var(--font);
    }

    .zero-statement-sub {
      font-size: 13px;
      font-weight: 400;
      color: var(--muted, #888888);
      line-height: 1.4;
      margin: 0;
      letter-spacing: -0.1px;
    }

    /* ─── Recent Sessions Section ────────────────────────────────────────── */
    .recent-sessions-section {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 6px;
    }

    .recent-sessions-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 0 2px;
    }

    .recent-header-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted, #71717a);
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }

    .recent-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .recent-header-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--fg, #e4e4e7);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      padding: 3px 8px;
      border-radius: 5px;
      transition: all 0.15s ease;
    }

    .recent-header-btn:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.18);
    }

    .recent-sessions-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 100%;
    }

    .recent-session-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      border-radius: 7px;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .recent-session-card:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(9, 249, 148, 0.4);
      transform: translateX(2px);
    }

    .recent-session-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .recent-session-title {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--fg, #e4e4e7);
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .recent-session-card:hover .recent-session-title {
      color: #ffffff;
    }

    .recent-session-sub {
      font-size: 11px;
      color: var(--muted, #71717a);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .recent-session-side {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .recent-session-date {
      font-size: 11px;
      color: var(--muted, #71717a);
      white-space: nowrap;
    }

    /* ─── Minimal Starter Prompt Chips ────────────────────────────────────── */
    .minimal-starters-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      width: 100%;
      margin-top: 4px;
    }

    .starter-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      border-radius: 6px;
      padding: 6px 10px;
      color: var(--muted, #a1a1aa);
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: var(--font);
    }

    .starter-chip svg {
      color: var(--muted, #71717a);
      flex-shrink: 0;
      transition: color 0.15s ease;
    }

    .starter-chip:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.14);
      color: var(--fg, #f4f4f5);
    }

    .starter-chip:hover svg {
      color: #09F994;
    }

    /* ”--€ Status Bar Footer ”----------------------------------------------€ */
    /* ─── Status Bar Footer ─────────────────────────────────────────────── */
    .status-bar {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 12px;
      border-top: 1px solid var(--border);
      background: var(--bg);
      font-size: 11px;
      color: var(--muted);
      flex-shrink: 0;
      height: 25px;
      z-index: 10000;
      overflow: visible;
    }

    .status-bar-left {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1 1 auto;
      overflow: visible;
      z-index: 10001;
    }

    .status-bar-right {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-shrink: 0;
      overflow: visible;
      z-index: 10001;
    }

    .token-capacity-widget {
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      transition: background 0.15s;
      z-index: 10002;
      overflow: visible;
    }

    .token-capacity-widget:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
    }

    .token-icon {
      width: 12px;
      height: 12px;
      color: var(--muted);
    }

    .token-mini-track {
      width: 44px;
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
      display: inline-flex;
    }

    .token-mini-bar {
      height: 100%;
      background: linear-gradient(90deg, #06b6d4, #10b981);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    /* ─── Rich Context Window Hover Popover ─────────────────────────────────── */
    .context-popover {
      position: absolute;
      bottom: calc(100% + 10px);
      left: 0;
      width: 250px;
      background: #151518;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      padding: 13px 15px;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.85), 0 4px 12px rgba(0, 0, 0, 0.5);
      z-index: 99999999;
      opacity: 0;
      visibility: hidden;
      transform: translateY(6px);
      transition: opacity 0.18s cubic-bezier(0.16, 1, 0.3, 1), transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.18s;
      pointer-events: none;
      font-family: var(--font);
    }

    .token-capacity-widget:hover .context-popover,
    .token-capacity-widget:focus .context-popover,
    .token-capacity-widget:focus-within .context-popover,
    .token-capacity-widget.active .context-popover {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
      pointer-events: auto;
    }

    .context-popover-top {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .context-ring-wrap {
      position: relative;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .context-ring-svg {
      width: 36px;
      height: 36px;
    }

    .context-ring-text {
      position: absolute;
      font-size: 10px;
      font-weight: 700;
      color: #f4f4f5;
      text-align: center;
      letter-spacing: -0.2px;
    }

    .context-popover-header-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .context-popover-title {
      font-size: 13.5px;
      font-weight: 600;
      color: #f4f4f5;
      letter-spacing: -0.2px;
      line-height: 1.2;
    }

    .context-popover-subtitle {
      font-size: 11.5px;
      font-weight: 500;
      color: #a1a1aa;
      letter-spacing: -0.1px;
      font-variant-numeric: tabular-nums;
    }

    .context-popover-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.08);
      margin: 11px 0 9px;
    }

    .context-popover-rows {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .context-popover-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
    }

    .context-row-label {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #a1a1aa;
      font-weight: 400;
    }

    .context-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }

    .dot-used {
      background: #e4e4e7;
    }

    .dot-avail {
      background: #3f3f46;
    }

    .context-row-val {
      font-weight: 600;
      color: #f4f4f5;
      font-variant-numeric: tabular-nums;
      font-size: 12px;
    }

    /* Messages */
    .message {
      display: flex;
      flex-direction: column;
      gap: 6px;
      animation: fadeIn 0.2s ease-out;
      word-break: break-word;
    }

    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* Messages */
    .message-wrap {
      display: flex;
      flex-direction: column;
      margin: 8px 0;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
      position: relative;
    }

    .message-wrap.user {
      align-items: flex-end;
    }

    .message-wrap.assistant {
      align-items: flex-start;
    }

    .message.user {
      background: rgba(0, 127, 212, 0.15);
      border: 1px solid rgba(0, 127, 212, 0.3);
      color: var(--fg);
      padding: 8px 12px;
      border-radius: 8px 8px 2px 8px;
      max-width: 85%;
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
      box-sizing: border-box;
    }

    .message.assistant {
      background: transparent;
      max-width: 100%;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      font-size: 13px;
      line-height: 1.5;
    }

    /* Assistant Header with Andromity Brand Icon */
    .assistant-header {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 6px;
      user-select: none;
    }
    .assistant-avatar {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .assistant-avatar svg {
      width: 13px;
      height: 13px;
    }
    .assistant-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      letter-spacing: 0.2px;
    }

    .message-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
      font-size: 11.5px;
      color: var(--muted);
      padding: 0 2px;
      min-height: 18px;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s ease, visibility 0.15s ease;
      z-index: 2;
    }
    .message-wrap:hover .message-footer {
      opacity: 1;
      visibility: visible;
    }

     .msg-copy-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      font-size: 12.5px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 5px;
      border-radius: 3px;
      opacity: 0.55;
      transition: all 0.15s;
    }
    .msg-copy-btn:hover {
      opacity: 1;
      color: var(--fg);
      background: rgba(255, 255, 255, 0.06);
    }
    /* User bubbles footer with prompt copy button */
    .message-wrap.user .message-footer {
      justify-content: flex-end;
      opacity: 0.65;
    }
    .message-wrap.user:hover .message-footer {
      opacity: 1;
      visibility: visible;
    }
    .message-wrap.user .msg-copy-btn {
      display: inline-flex;
    }

    .turn-duration-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family, monospace);
    }

    /* Thinking bubble -- TUI parity: auto-expand while streaming, auto-collapse when done, clickable anytime */
    .thinking-card {
      background: transparent;
      border: none;
      border-left: 1px solid rgba(188, 140, 255, 0.35);
      border-radius: 0;
      padding: 0;
      margin: 4px 0;
    }
    .thinking-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 400;
      font-style: italic;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
      padding: 4px 8px;
      border-radius: 4px;
      transition: background 0.15s, color 0.15s;
    }
    .thinking-header:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.04);
    }
    .thinking-pulse {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--purple);
      box-shadow: 0 0 6px var(--purple);
      animation: pulse 1.2s infinite;
      flex-shrink: 0;
    }
    @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
    .thinking-content {
      font-size: 12px;
      font-style: italic;
      color: var(--muted);
      margin: 0 0 0 18px;
      padding: 4px 10px 8px;
      white-space: pre-wrap;
      line-height: 1.55;
      max-height: 240px;
      overflow-y: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
      display: none;
      border-left: 1px dashed rgba(188,140,255,0.25);
    }
    .thinking-content::-webkit-scrollbar {
      display: none;
    }
    .thinking-card.expanded .thinking-content { display: block; }
    .thinking-card.expanded .thinking-chevron { transform: rotate(90deg); }
    .thinking-chevron {
      margin-left: auto;
      width: 10px; height: 10px;
      color: var(--muted);
      transition: transform 0.15s;
      flex-shrink: 0;
    }

    /* Markdown Typography & Blocks */
    .assistant-text {
      font-size: 13px;
      line-height: 1.6;
      color: var(--fg);
      word-break: break-word;
      overflow-wrap: break-word;
      max-width: 100%;
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
    }
    .assistant-text p {
      margin: 4px 0 6px;
      line-height: 1.55;
    }
    .assistant-text p:last-child {
      margin-bottom: 0;
    }
    .assistant-text ul, .assistant-text ol {
      margin: 4px 0 6px 18px;
      padding: 0;
    }
    .assistant-text li {
      margin: 2px 0;
      line-height: 1.5;
    }
    .assistant-text strong {
      font-weight: 600;
      color: #ffffff;
    }
    .assistant-text em {
      font-style: italic;
      color: var(--fg);
    }
    .assistant-text del {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .assistant-text :not(pre) > code,
    .assistant-text p code,
    .assistant-text li code,
    .assistant-text td code,
    .assistant-text th code,
    .assistant-text blockquote code {
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-feature-settings: "calt", "zero";
      letter-spacing: -0.015em;
      background: rgba(255, 255, 255, 0.08);
      color: #79c0ff;
      padding: 1.5px 5.5px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      word-break: break-word;
    }
    .assistant-text h1 {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -0.025em;
      margin: 14px 0 6px;
      color: #ffffff;
    }
    .assistant-text h2 {
      font-size: 15.5px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin: 12px 0 6px;
      color: #ffffff;
    }
    .assistant-text h3 {
      font-size: 14.5px;
      font-weight: 600;
      letter-spacing: -0.018em;
      margin: 10px 0 5px;
      color: #ffffff;
    }
    .assistant-text h4 {
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: -0.015em;
      margin: 8px 0 4px;
      color: #ffffff;
    }
    .assistant-text h5, .assistant-text h6 {
      font-size: 12px;
      font-weight: 600;
      margin: 8px 0 3px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .assistant-text blockquote {
      border-left: 3px solid var(--accent);
      padding: 4px 10px;
      margin: 6px 0;
      background: rgba(0, 127, 212, 0.08);
      border-radius: 0 4px 4px 0;
      color: var(--muted);
    }
    .assistant-text hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 10px 0;
    }
    .md-spacer {
      height: 8px;
    }
    .md-line {
      margin: 2px 0;
      line-height: 1.55;
    }
    .md-bullet {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      margin: 2px 0 2px 6px;
      line-height: 1.55;
    }
    .md-dot {
      color: var(--accent);
      font-size: 14px;
      line-height: 1.2;
      user-select: none;
      flex-shrink: 0;
    }
    .md-num {
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
      min-width: 14px;
      user-select: none;
      flex-shrink: 0;
    }
    .md-text {
      flex: 1;
    }
    .md-quote {
      border-left: 3px solid var(--accent);
      padding: 4px 10px;
      margin: 6px 0;
      background: rgba(0, 127, 212, 0.08);
      border-radius: 0 4px 4px 0;
      color: var(--muted);
    }

    /* Markdown Tables & Universal Table Styling */
    .table-scroll-wrapper {
      width: 100%;
      overflow-x: auto;
      margin: 10px 0;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.15);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    .assistant-text table,
    .md-table,
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      text-align: left;
      border-spacing: 0;
      margin: 0;
    }
    .assistant-text thead,
    .md-table thead,
    thead {
      background: rgba(255, 255, 255, 0.06);
    }
    .assistant-text th,
    .md-table th,
    th {
      font-weight: 600;
      padding: 7px 12px;
      border-bottom: 1px solid var(--border);
      color: #ffffff;
      white-space: nowrap;
      font-size: 11.5px;
      letter-spacing: 0.2px;
    }
    .assistant-text td,
    .md-table td,
    td {
      padding: 6px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      color: var(--fg);
      line-height: 1.45;
    }
    .assistant-text tr:nth-child(even) td,
    .md-table tr:nth-child(even) td {
      background: rgba(255, 255, 255, 0.02);
    }
    .assistant-text tr:hover td,
    .md-table tr:hover td {
      background: rgba(255, 255, 255, 0.05);
    }
    .assistant-text tr:last-child td,
    .md-table tr:last-child td {
      border-bottom: none;
    }

    /* Markdown Horizontal Rules & Task Lists */
    .md-hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 10px 0;
    }
    .md-task-item {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 3px 0 3px 4px;
      font-size: 12px;
    }
    .md-checkbox {
      margin: 0;
      accent-color: var(--accent);
      cursor: default;
    }
    .md-task-text.completed {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .md-image {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      border: 1px solid var(--border);
      margin: 6px 0;
      display: block;
    }
    details {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 10px;
      margin: 6px 0;
      font-size: 12px;
    }
    summary {
      font-weight: 600;
      cursor: pointer;
      color: var(--fg);
      user-select: none;
    }
    summary:hover {
      color: var(--accent);
    }
    .code-block-container {
      margin: 10px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: rgba(0, 0, 0, 0.25);
      overflow: hidden;
      max-width: 100%;
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
    }
    .code-block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 10px;
      background: rgba(255, 255, 255, 0.05);
      border-bottom: 1px solid var(--border);
      font-size: 10.5px;
      color: var(--muted);
      max-width: 100%;
      box-sizing: border-box;
    }
    .code-lang-tag {
      font-weight: 600;
      letter-spacing: 0.5px;
      color: var(--muted);
    }
     .code-block-actions {
      display: flex;
      gap: 6px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .code-block-container:hover .code-block-actions { opacity: 1; }
    .code-btn {
      padding: 2px 7px;
      font-size: 10.5px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .code-btn:hover {
      background: rgba(255,255,255,0.08);
      color: var(--fg);
      border-color: var(--border);
    }
    .code-block-pre {
      margin: 0;
      padding: 10px 12px;
      overflow-x: auto;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.35);
      border: none;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.55;
      letter-spacing: -0.015em;
      font-feature-settings: "calt", "zero";
      white-space: pre;
      word-break: normal;
    }
    .code-block-pre code {
      background: transparent !important;
      color: var(--vscode-editor-foreground, #e4e4e7) !important;
      padding: 0 !important;
      border: none !important;
      border-radius: 0 !important;
      font-family: inherit;
      font-size: inherit;
      white-space: pre;
      display: block;
    }

    /* Plan Ready Pill (shown in chat when a plan is created/updated) */
    .plan-ready-pill {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 10px 0 4px;
      padding: 8px 12px;
      background: var(--card-bg, #18181b);
      border: 1px solid var(--card-border, rgba(255, 255, 255, 0.08));
      border-radius: 8px;
      font-size: 12px;
      color: var(--fg, #f4f4f5);
      width: 100%;
      box-sizing: border-box;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      transition: all 0.15s ease;
    }
    .plan-ready-pill:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(255, 255, 255, 0.14);
    }
    .plan-ready-pill .pill-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 5px;
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      flex-shrink: 0;
    }
    .plan-ready-pill .pill-title {
      flex: 1;
      min-width: 0;
      font-weight: 500;
      color: var(--fg, #f4f4f5);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      letter-spacing: -0.01em;
    }
    .plan-ready-pill .pill-progress {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--muted, #a1a1aa);
      margin-left: 6px;
      font-weight: 400;
    }
    .plan-ready-pill .pill-btn {
      background: rgba(255, 255, 255, 0.06);
      color: var(--fg, #f4f4f5);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 5px;
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
      font-family: var(--font-ui);
    }
    .plan-ready-pill .pill-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.22);
      color: #ffffff;
    }

    /* Tool Card -- TUI parity: expand while running, collapse when done, toggle on click */
    .tool-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 6px 10px;
      margin: 4px 0;
      font-size: 11.5px;
    }
    .tool-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
    }
    .tool-header:hover {
      color: var(--fg);
    }
    .tool-title-group {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .tool-tag {
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 3px;
      background: rgba(0, 127, 212, 0.15);
      color: var(--accent);
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .tool-chevron {
      width: 10px;
      height: 10px;
      color: var(--muted);
      transition: transform 0.15s;
      flex-shrink: 0;
      margin-left: 6px;
    }
    .tool-card.expanded .tool-chevron {
      transform: rotate(90deg);
    }
    .tool-body {
      max-width: 100%;
      min-width: 0;
      overflow-x: auto;
      word-break: break-word;
      overflow-wrap: break-word;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family, "Consolas", monospace);
      font-size: 11.5px;
      line-height: 1.45;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      white-space: pre-wrap;
      max-height: 160px;
      overflow-y: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
      display: none;
    }
    .tool-body::-webkit-scrollbar {
      display: none;
    }
    .tool-card.expanded .tool-body {
      display: block;
    }

    /* Tool Sequence -- TUI parity: group tools under working/worked collapsible */
    .tool-sequence {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 6px 0;
      overflow: hidden;
    }
    .tool-seq-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      font-size: 11.5px;
      font-weight: 500;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
      background: rgba(255,255,255,0.02);
    }
    .tool-seq-header:hover { background: rgba(255,255,255,0.05); color: var(--fg); }
    .tool-seq-icon { font-size: 12px; }
    .tool-seq-title { flex: 1; font-weight: 600; }
    .tool-seq-chevron { width: 12px; height: 12px; color: var(--muted); transition: transform 0.15s; }
    .tool-sequence.collapsed .tool-seq-chevron { transform: rotate(90deg); }
    .tool-sequence.collapsed .tool-seq-body { display: none; }
    .tool-seq-body { padding: 4px 6px; display: flex; flex-direction: column; gap: 4px; }
    .tool-seq-copy {
      font-size: 10px;
      padding: 2px 7px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 4px;
      cursor: pointer;
    }
    .tool-seq-copy:hover { color: var(--fg); background: rgba(255,255,255,0.06); }
    .tool-sequence .tool-card { margin: 0; border-radius: 4px; }
    .tool-sequence .thinking-card { margin: 0; }

    /* Subagent Card -- Clean, Elegant, Live In-place Status */
    .subagent-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      margin: 6px 0;
      font-size: 11.5px;
    }
    .subagent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }
    .subagent-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
    }
    .subagent-header-right {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .subagent-icon {
      color: var(--accent);
    }
    .subagent-role {
      color: var(--fg);
      text-transform: capitalize;
    }
    .subagent-status {
      font-size: 9.5px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .subagent-status.running {
      background: rgba(6, 182, 212, 0.15);
      color: var(--accent);
    }
    .subagent-status.done {
      background: rgba(63, 185, 80, 0.15);
      color: var(--green);
    }
    .subagent-status.failed {
      background: rgba(239, 68, 68, 0.15);
      color: var(--red);
    }
    .subagent-chevron {
      color: var(--muted);
      transition: transform 0.15s;
    }
    .subagent-card.collapsed .subagent-chevron {
      transform: rotate(-90deg);
    }
    .subagent-card.collapsed .subagent-body {
      display: none;
    }
    .subagent-body {
      margin-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .subagent-task {
      color: var(--fg);
      font-size: 11.5px;
      line-height: 1.4;
      background: rgba(255, 255, 255, 0.02);
      padding: 4px 6px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.04);
    }
    .subagent-task-label {
      font-weight: 600;
      color: var(--muted);
      margin-right: 4px;
    }
    .subagent-live-status {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--accent);
      font-size: 11px;
      padding: 3px 0;
    }
    .subagent-spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid rgba(6, 182, 212, 0.2);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .subagent-result-box {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 11.5px;
      color: var(--fg);
      margin-top: 4px;
      max-height: 200px;
      overflow-y: auto;
    }
    .subagent-result-title {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 2px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .subagent-tools-container {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-top: 4px;
    }
    .subagent-tool-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 4px;
      overflow: hidden;
      font-size: 11px;
    }
    .subagent-tool-item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 6px;
      cursor: pointer;
      user-select: none;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .subagent-tool-item-header:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .subagent-tool-name {
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 4px;
      font-weight: 500;
    }
    .subagent-tool-desc {
      color: var(--muted);
      font-size: 10.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 260px;
    }
    .subagent-tool-item-body {
      display: none;
      padding: 4px 6px;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid rgba(255, 255, 255, 0.04);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      max-height: 120px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--muted);
    }
    .subagent-tool-item.expanded .subagent-tool-item-body {
      display: block;
    }

    /* Interactive Cards -- approval / questions */
    .approval-card {
      background: var(--card-bg, #1e1e1e);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      border-radius: 4px;
      padding: 12px;
      margin: 10px 0;
      font-size: 12px;
    }

    /* ”--€ Clarifying Questions Carousel ”--------------------------------------------------€ */
    .questions-card {
      background: var(--card-bg, #1e1e1e);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      border-radius: 4px;
      padding: 12px;
      margin: 10px 0;
      font-size: 12px;
    }

    .questions-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }

    .questions-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
    }

    .questions-step-badge {
      font-size: 11px;
      color: var(--muted);
      font-weight: 500;
    }

    .carousel-slides {
      margin-bottom: 12px;
    }

    .question-prompt {
      font-size: 12px;
      font-weight: 500;
      color: var(--fg);
      line-height: 1.4;
      margin-bottom: 8px;
    }

    .question-num-tag {
      color: var(--accent, #007fd4);
      font-weight: 600;
    }

    .question-options-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .question-option-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 3px;
      background: transparent;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      color: var(--fg);
      transition: background 0.1s ease;
    }

    .question-option-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
    }

    .question-option-row input {
      margin: 0;
      cursor: pointer;
      accent-color: var(--vscode-focusBorder, #007fd4);
    }

    .question-option-row span {
      line-height: 1.3;
    }

    .question-textarea {
      width: 100%;
      padding: 6px 8px;
      font-size: 12px;
      font-family: inherit;
      color: var(--fg);
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      outline: none;
      resize: vertical;
      box-sizing: border-box;
    }

    .question-textarea:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .carousel-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }

    .btn-carousel-prev,
    .btn-carousel-next,
    .btn-carousel-submit {
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 2px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      transition: background 0.1s ease;
    }

    .btn-carousel-prev {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
    }

    .btn-carousel-prev:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    .btn-carousel-next,
    .btn-carousel-submit {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }

    .btn-carousel-next:hover,
    .btn-carousel-submit:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }

    .approval-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .approval-icon {
      width: 26px; height: 26px;
      border-radius: 6px;
      background: rgba(210, 153, 34, 0.15);
      border: 1px solid rgba(210, 153, 34, 0.35);
      display: flex; align-items: center; justify-content: center;
      color: #d29922;
      flex-shrink: 0;
    }
    .approval-kicker {
      font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
      text-transform: uppercase; color: #d29922;
      margin-bottom: 2px;
    }
    .approval-title { font-size: 12.5px; font-weight: 600; color: var(--fg); }
    .approval-tool-meta {
      display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap;
    }
    .approval-tool-pill {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; font-weight: 500;
      padding: 3px 8px; border-radius: 4px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--border);
      color: var(--fg);
    }
    .approval-tool-pill.status-pill {
      font-size: 9.5px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .approval-tool-pill.status-pill.orange {
      background: rgba(210, 153, 34, 0.15);
      color: #d29922;
      border-color: rgba(210, 153, 34, 0.35);
    }
    .approval-tool-pill.status-pill.green {
      background: rgba(63, 185, 80, 0.15);
      color: var(--green);
      border-color: rgba(63, 185, 80, 0.35);
    }
    .approval-tool-pill.status-pill.blue {
      background: rgba(56, 139, 253, 0.15);
      color: #58a6ff;
      border-color: rgba(56, 139, 253, 0.35);
    }
    .approval-tool-pill.status-pill.red {
      background: rgba(248, 81, 73, 0.15);
      color: var(--red);
      border-color: rgba(248, 81, 73, 0.35);
    }
    .approval-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; color: var(--muted);
      background: rgba(0,0,0,0.25); border: 1px solid var(--border);
      padding: 3px 7px; border-radius: 4px;
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .approval-desc {
      font-size: 11.5px; color: var(--muted); line-height: 1.45; margin: 8px 0 0;
    }
    .approval-args {
      margin-top: 8px; padding: 8px 10px;
      background: rgba(0,0,0,0.25); border: 1px solid var(--border);
      border-radius: 6px; font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; color: var(--muted);
      max-height: 100px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
      display: none;
    }
    .approval-card.show-args .approval-args { display: block; }
    .approval-toggle-args {
      margin-top: 6px; font-size: 10.5px; color: var(--accent);
      cursor: pointer; user-select: none; display: inline-flex; align-items: center; gap: 4px;
    }
    .approval-toggle-args:hover { text-decoration: underline; }
    .approval-buttons {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    .btn-approve, .btn-reject {
      padding: 6px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11.5px;
      font-weight: 600;
      border: 1px solid transparent;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      transition: all 0.15s ease;
    }

    .btn-approve {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }
    .btn-approve:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
      box-shadow: 0 2px 10px rgba(0, 127, 212, 0.4);
    }
    .btn-reject {
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06));
      color: var(--vscode-button-secondaryForeground, var(--fg));
      border-color: var(--border);
    }
    .btn-reject:hover {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      border-color: rgba(239, 68, 68, 0.3);
    }
    .btn-ghost {
      margin-left: auto; padding: 6px 10px; font-size: 11px;
      background: transparent; border: 1px solid var(--border);
      color: var(--muted); border-radius: 6px; cursor: pointer;
    }
    .btn-ghost:hover { color: var(--fg); background: rgba(255,255,255,0.05); }

    /* ─── Image Lightbox Modal Overlay ─────────────────────────────────────── */
    .image-lightbox-overlay {
      position: fixed;
      inset: 0;
      background: rgba(8, 8, 10, 0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      z-index: 1000000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 18px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .image-lightbox-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }

    .image-lightbox-header {
      position: absolute;
      top: 16px;
      left: 20px;
      right: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 1000002;
      pointer-events: auto;
    }

    .image-lightbox-title {
      font-size: 13px;
      font-weight: 600;
      color: #f4f4f5;
      background: rgba(20, 20, 24, 0.85);
      padding: 5px 12px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      letter-spacing: -0.1px;
    }

    .image-lightbox-close {
      background: rgba(20, 20, 24, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #f4f4f5;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      line-height: 1;
    }

    .image-lightbox-close:hover {
      background: rgba(239, 68, 68, 0.25);
      border-color: #ef4444;
      color: #ef4444;
      transform: scale(1.1);
    }

    .image-lightbox-container {
      position: relative;
      max-width: 92vw;
      max-height: 85vh;
      display: flex;
      align-items: center;
      justify-content: center;
      transform: scale(0.95);
      transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      cursor: zoom-out;
    }

    .image-lightbox-overlay.open .image-lightbox-container {
      transform: scale(1);
    }

    .image-lightbox-img {
      max-width: 100%;
      max-height: 85vh;
      object-fit: contain;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9), 0 4px 16px rgba(0, 0, 0, 0.5);
    }

    /* Prompt Queue */
    .queue-container {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 4px 10px;
      background: rgba(255, 255, 255, 0.03);
      border-top: 1px solid var(--border);
    }

    .queue-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--muted);
      background: var(--input-bg);
      padding: 3px 8px;
      border-radius: 4px;
    }

    .queue-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .queue-remove { background: transparent; border: none; color: var(--muted); cursor: pointer; }

    /* Input Section (Codex-style prompt card) */
    .input-section {
      padding: 8px 10px 6px 10px;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
      position: relative;
    }

    /* Slash Command Palette Overlay */
    .slash-palette {
      position: absolute;
      bottom: calc(100% - 4px);
      left: 10px;
      right: 10px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
      z-index: 250;
      max-height: 250px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .slash-palette-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.02);
    }
    .palette-close-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
      border-radius: 3px;
      transition: all 0.12s ease;
    }
    .palette-close-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.1);
    }
    .skills-card-close-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.12s ease;
    }
    .skills-card-close-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.08);
    }
    .slash-palette-list {
      display: flex;
      flex-direction: column;
      padding: 3px 0;
    }
    .slash-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.12s;
    }
    .slash-item:hover, .slash-item.active {
      background: rgba(255, 255, 255, 0.08);
    }
    .slash-cmd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 600;
      color: var(--accent);
    }
    .slash-desc {
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .prompt-box {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 8px 10px 8px 10px;
      display: flex;
      flex-direction: column;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .prompt-box:focus-within {
      border-color: rgba(255, 255, 255, 0.18);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.05);
    }

    /* Ambient Generation Aura */
    .prompt-box.is-generating {
      border-color: rgba(9, 249, 148, 0.45);
      box-shadow: 0 0 16px rgba(9, 249, 148, 0.12), inset 0 0 10px rgba(9, 249, 148, 0.04);
      animation: promptAuraGlow 1.8s ease-in-out infinite alternate;
    }

    @media (prefers-reduced-motion: reduce) { .prompt-box.is-generating { animation: none !important; } }
    @keyframes promptAuraGlow {
      0% {
        border-color: rgba(9, 249, 148, 0.25);
        box-shadow: 0 0 8px rgba(9, 249, 148, 0.08), inset 0 0 6px rgba(9, 249, 148, 0.02);
      }
      100% {
        border-color: rgba(9, 249, 148, 0.6);
        box-shadow: 0 0 22px rgba(9, 249, 148, 0.22), 0 0 35px rgba(56, 189, 248, 0.1), inset 0 0 12px rgba(9, 249, 148, 0.06);
      }
    }

    /* ─── Image Attachment Chips in Input Area ──────────────────────────────── */
    .image-attachments-container {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 4px 0 8px 0;
    }

    .image-attachment-chip {
      position: relative;
      display: inline-flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      overflow: hidden;
      cursor: zoom-in;
      transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .image-attachment-chip:hover {
      transform: translateY(-1px);
      border-color: rgba(9, 249, 148, 0.5);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    .image-attachment-thumb {
      width: 46px;
      height: 46px;
      object-fit: cover;
      display: block;
      transition: opacity 0.15s ease;
    }

    .image-attachment-chip:hover .image-attachment-thumb {
      opacity: 0.9;
    }

    .image-attachment-remove {
      position: absolute;
      top: 3px;
      right: 3px;
      background: rgba(0, 0, 0, 0.85);
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 50%;
      width: 17px;
      height: 17px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
      z-index: 3;
    }

    .image-attachment-remove:hover {
      background: #ef4444;
      border-color: #ef4444;
      transform: scale(1.12);
    }



    #prompt-input {
      width: 100%;
      background: transparent;
      border: none;
      color: var(--fg);
      font-family: inherit;
      font-size: 13.5px;
      outline: none;
      resize: none;
      min-height: 38px;
      max-height: 160px;
      line-height: 1.5;
      padding: 2px 2px 6px 2px;
    }
    #prompt-input::placeholder {
      color: rgba(255, 255, 255, 0.35);
    }

    .prompt-box-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-top: 4px;
      padding-top: 2px;
      user-select: none;
    }

    .prompt-left-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      min-width: 0;
    }
    .prompt-right-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 auto;
      min-width: 0;
      justify-content: flex-end;
      overflow: hidden;
    }

    /* Icon button (+ button) */
    .prompt-icon-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      transition: all 0.15s;
    }
    .prompt-icon-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.08);
    }

    /* Pill buttons (Mode pill, Model pill, Context pill) — fixed flex to avoid layout shift when reasoning label changes */
    .prompt-pill-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--muted);
      border-radius: 6px;
      font-size: 11px;
      padding: 3px 7px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      min-width: 0;
      max-width: 100%;
      transition: all 0.15s;
    }
    .prompt-pill-btn span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    #btn-prompt-model { max-width: 150px; }
    #btn-prompt-reasoning { min-width: 52px; justify-content: center; }
    #btn-prompt-reasoning #prompt-reasoning-label { min-width: 28px; text-align: center; }
    #prompt-model-label { max-width: 118px; overflow: hidden; text-overflow: ellipsis; }
    .prompt-pill-btn:hover {
      color: var(--fg);
      border-color: rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.08);
    }
    .prompt-pill-btn svg {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
    }

    /* Send & Cancel Circular Buttons */
    .codex-send-btn {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.35);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
      padding: 0;
    }
    .codex-send-btn.has-text {
      background: #ffffff;
      color: #000000;
    }
    .codex-send-btn.has-text:hover {
      background: #e2e8f0;
      transform: translateY(-1px);
    }

    .codex-cancel-btn {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 1px solid rgba(248, 81, 73, 0.4);
      background: rgba(248, 81, 73, 0.2);
      color: var(--red);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
      padding: 0;
    }
    .codex-cancel-btn:hover {
      background: rgba(248, 81, 73, 0.35);
    }
    .codex-cancel-btn svg, .codex-send-btn svg {
      width: 12px;
      height: 12px;
    }

    /* Status Bar */
    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      font-size: 10px;
      color: var(--muted);
      border-top: 1px solid var(--border);
      background: var(--bg);
      flex-shrink: 0;
      gap: 8px;
    }
    .status-bar-left {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1 1 auto;
      overflow: visible;
    }
    .status-bar-right {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-shrink: 0;
      overflow: visible;
    }
    #prompt-profile-label { max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
    .status-bar .prompt-pill-btn {
      padding: 1px 6px;
      font-size: 10px;
      height: 18px;
      border-radius: 4px;
    }
    .status-bar .prompt-pill-btn svg {
      width: 10px;
      height: 10px;
    }

    /* Trust Prompt Banner */
    .trust-banner {
      background: rgba(210, 153, 34, 0.12);
      border: 1px solid rgba(210, 153, 34, 0.35);
      border-radius: var(--radius);
      padding: 12px 14px;
      margin: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .trust-banner-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #d29922;
    }
    .trust-banner-header svg { width: 16px; height: 16px; color: #d29922; }
    .trust-banner-desc { font-size: 11px; color: var(--muted); line-height: 1.4; }
    .trust-banner-actions { display: flex; gap: 8px; margin-top: 4px; }
    .trust-btn {
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      background: #d29922;
      color: #000;
      transition: background 0.15s;
    }
    .trust-btn:hover { background: #e3a830; }
    .trust-btn-sec {
      padding: 5px 10px;
      font-size: 11px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg);
      cursor: pointer;
    }
    .trust-btn-sec:hover { background: rgba(255,255,255,0.06); }

    /* AI Engine Setup Guide Card */
    .setup-guide-card {
      margin: 10px 12px;
      padding: 12px 14px;
      border-radius: var(--radius);
      background: rgba(234, 179, 8, 0.08);
      border: 1px solid rgba(234, 179, 8, 0.3);
      display: flex;
      flex-direction: column;
      gap: 8px;
      animation: fadeIn 0.2s ease-out;
    }
    .setup-guide-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      font-weight: 600;
      color: #eab308;
    }
    .setup-guide-icon {
      width: 16px;
      height: 16px;
      color: #eab308;
      flex-shrink: 0;
    }
    .setup-guide-body {
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--fg);
      opacity: 0.9;
    }
    .setup-guide-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .btn-setup-action {
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      border: 1px solid transparent;
    }
    .btn-setup-action.primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }
    .btn-setup-action.primary:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .btn-setup-action.secondary {
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06));
      color: var(--vscode-button-secondaryForeground, var(--fg));
      border-color: var(--border);
    }
    .btn-setup-action.secondary:hover {
      background: rgba(255,255,255,0.12);
    }

    /* Skeleton loading — shown until init_state arrives (no flash of wrong model/mode) */
    .skeleton {
      background: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 37%, rgba(255,255,255,0.04) 63%);
      background-size: 400% 100%;
      animation: skeleton-shimmer 1.4s ease infinite;
      border-radius: 4px;
      color: transparent !important;
      pointer-events: none;
      user-select: none;
    }
    .skeleton-text { height: 11px; min-width: 64px; display:inline-block; }
    .skeleton-pill { height: 16px; min-width: 72px; border-radius: 12px; display:inline-flex; }
    .skeleton-session { height: 13px; width: 110px; border-radius: 4px; }
    .skeleton-card { height: 42px; border-radius: 6px; margin: 6px 0; }
    @keyframes skeleton-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    /* ─── Modern Permission Approval Card (Linear / Claude Code Aesthetic) ─── */
    .permission-card {
      background: var(--card-bg, #18181b);
      border: 1px solid var(--card-border, rgba(255, 255, 255, 0.08));
      border-radius: 10px;
      margin: 10px 0;
      padding: 12px 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      animation: bannerSlideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-family: var(--font-ui);
    }

    .permission-header {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .permission-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .permission-icon-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--fg, #f4f4f5);
      letter-spacing: -0.01em;
    }

    .permission-icon-box {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--fg);
      flex-shrink: 0;
    }

    .permission-icon-box.command {
      background: rgba(6, 182, 212, 0.15);
      color: #38bdf8;
    }

    .permission-icon-box.file {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }

    .permission-icon-box.search {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
    }

    .permission-icon-box.web {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
    }

    .permission-icon-box.plan {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
    }

    .permission-close-btn {
      background: transparent;
      border: none;
      color: var(--muted, #71717a);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }

    .permission-close-btn:hover {
      color: var(--fg, #f4f4f5);
      background: rgba(255, 255, 255, 0.08);
    }

    .permission-code-box {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      padding: 8px 10px;
      font-family: var(--font-mono);
      font-size: 11.5px;
      line-height: 1.45;
      color: #e4e4e7;
      word-break: break-word;
      white-space: pre-wrap;
      max-height: 160px;
      overflow-y: auto;
    }

    .permission-params-toggle {
      font-size: 11px;
      color: var(--muted, #a1a1aa);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      user-select: none;
      width: fit-content;
      transition: color 0.15s;
    }

    .permission-params-toggle:hover {
      color: var(--fg, #ffffff);
    }

    .permission-params-body {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: var(--font-mono);
      font-size: 10.5px;
      color: var(--muted);
      max-height: 120px;
      overflow-y: auto;
    }

    .permission-options-group {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .permission-option-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 12px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      user-select: none;
    }

    .permission-option-row:last-child {
      border-bottom: none;
    }

    .permission-option-row:hover,
    .permission-option-row:focus-visible {
      background: rgba(255, 255, 255, 0.06);
      outline: none;
    }

    .permission-option-row.option-deny:hover,
    .permission-option-row.option-deny:focus-visible {
      background: rgba(239, 68, 68, 0.08);
    }

    .option-row-main {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }

    .option-row-title {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--fg, #f4f4f5);
      letter-spacing: -0.01em;
    }

    .option-row-title.deny-text {
      color: #f87171;
      font-weight: 600;
    }

    .option-row-sub {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--muted, #71717a);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .option-row-badge {
      display: flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }

    .perm-kbd {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      padding: 2px 5px;
      font-size: 10px;
      font-family: var(--font-mono);
      color: var(--muted, #a1a1aa);
      box-shadow: 0 1px 2px rgba(0,0,0,0.2);
    }

    /* ─── Plan Approval Card & Preview (Matching Permission Aesthetic) ─── */
    .plan-desc-text {
      font-size: 12px;
      color: var(--muted, #a1a1aa);
      line-height: 1.45;
      margin-top: -2px;
    }

    .plan-code-box {
      max-height: 220px;
      overflow-y: auto;
      padding: 8px 10px;
    }

    .plan-steps-preview {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .plan-step-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 11.5px;
      line-height: 1.4;
      color: #e4e4e7;
    }

    .plan-step-item.is-done {
      color: var(--muted, #71717a);
      text-decoration: line-through;
    }

    .plan-step-bullet {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.08);
      color: var(--muted, #a1a1aa);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 9.5px;
      font-weight: 600;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .plan-step-item.is-done .plan-step-bullet {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }

    .plan-step-txt {
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }

    .plan-feedback-wrapper {
      margin-top: 2px;
    }

    .plan-feedback-field {
      width: 100%;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 11.5px;
      color: var(--fg, #f4f4f5);
      font-family: var(--font-ui);
      outline: none;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .plan-feedback-field:focus {
      border-color: rgba(168, 85, 247, 0.5);
      background: rgba(0, 0, 0, 0.5);
    }

    .plan-feedback-field::placeholder {
      color: var(--muted, #71717a);
    }

    /* ─── Floating Scroll to Bottom Button ─────────────────────────────── */
    .scroll-bottom-btn {
      position: absolute;
      bottom: 12px;
      right: 18px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(30, 30, 32, 0.88);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--fg);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      z-index: 10;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      transform: translateY(6px);
      opacity: 0;
      pointer-events: none;
    }
    .scroll-bottom-btn.visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    .scroll-bottom-btn:hover {
      background: rgba(45, 45, 48, 0.95);
      border-color: var(--accent-green, #09f994);
      transform: translateY(-2px);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
    }
    .scroll-bottom-btn svg {
      width: 14px;
      height: 14px;
      color: var(--fg);
      transition: transform 0.15s ease;
    }
    .scroll-bottom-btn:hover svg {
      transform: translateY(1px);
    }
    .scroll-bottom-btn .unread-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #09f994;
      box-shadow: 0 0 6px #09f994;
      display: none;
    }
    .scroll-bottom-btn .unread-badge.has-unread {
      display: block;
    }

    /* ─── Turn Action Pills & File Edit Badges ─────────────────────────── */
    .turn-actions-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
      margin-bottom: 4px;
      align-items: center;
      width: 100%;
    }

    .file-edited-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      font-size: 11.5px;
      color: var(--fg);
      cursor: pointer;
      transition: all 0.15s ease;
      user-select: none;
    }
    .file-edited-chip:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--vscode-focusBorder, #38bdf8);
      transform: translateY(-1px);
    }
    .file-edited-chip svg {
      width: 12px;
      height: 12px;
      color: #38bdf8;
      flex-shrink: 0;
    }
    .file-edited-chip .chip-filename {
      font-family: var(--font-mono);
      font-size: 11px;
      color: #f4f4f5;
    }
    .file-edited-chip .chip-diff-label {
      font-size: 9.5px;
      font-weight: 600;
      padding: 1px 4px;
      border-radius: 3px;
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    /* ─── Conversation Timeline Drawer / Popover ────────────────────────── */
    .timeline-flyout {
      position: absolute;
      top: 40px;
      right: 10px;
      width: 320px;
      max-height: 480px;
      background: rgba(24, 24, 27, 0.96);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
      z-index: 100;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: fadeInZero 0.18s ease-out;
    }
    .timeline-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
    }
    .timeline-header-close {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .timeline-header-close:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.08);
    }
    .timeline-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .timeline-node {
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .timeline-node:hover {
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(255, 255, 255, 0.16);
      transform: translateX(2px);
    }
    .timeline-node-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10.5px;
      color: var(--muted);
    }
    .timeline-node-turn {
      font-weight: 600;
      color: var(--accent-cyan, #38bdf8);
    }
    .timeline-node-title {
      font-size: 11.5px;
      color: var(--fg);
      font-weight: 500;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .timeline-node-badges {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 2px;
    }
    .timeline-mini-badge {
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--muted);
    }
    .timeline-mini-badge.tools {
      background: rgba(56, 189, 248, 0.12);
      color: #38bdf8;
    }
    .session-ghost-empty { font-size: 10px; color: var(--muted); font-style: italic; margin-left: 6px; }
    .timeline-mini-badge.files {
      background: rgba(9, 249, 148, 0.12);
      color: #09f994;
    }
  </style>
`;
}
