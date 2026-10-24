/** Shared visual layer for the sidebar and the session editor. */
export function getChatPolishStyles(): string {
  return `
    :root {
      --chat-max-width: 800px;
      --chat-edge: 16px;
      --chat-line: var(--vscode-panel-border, var(--border));
      --chat-surface: var(--vscode-editorWidget-background, var(--card-bg));
      --cloud-success: var(--vscode-testing-iconPassed, #3fb950);
    }

    .top-bar { padding: 6px 12px; border-bottom-color: var(--chat-line); }
    .session-badge-btn { font-weight: 500; padding-left: 4px; }
    .top-bar-icon-btn { width: 28px; height: 30px; }
    .chat-container { padding: 20px var(--chat-edge) 16px; gap: 16px; }
    .zero-state { padding: 26px 4px 16px; }
    .ready-hero-section { gap: 22px; }
    .zero-hero { gap: 18px; }
    .zero-statement-main { font-size: 28px; line-height: 1.18; letter-spacing: -0.9px; }
    .zero-statement-sub { color: var(--muted); opacity: 1; line-height: 1.6; max-width: 360px; }

    .minimal-starters-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 0;
    }
    .starter-chip {
      position: relative;
      align-items: flex-start;
      gap: 10px;
      min-width: 0;
      padding: 12px;
      border-radius: 9px;
      border-color: var(--chat-line);
      background: var(--chat-surface);
      text-align: left;
      opacity: 1;
      line-height: 1.4;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .starter-chip > svg { width: 15px; height: 15px; margin-top: 1px; color: var(--muted); opacity: 1; }
    .starter-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .starter-title { font-size: 12px; font-weight: 500; color: var(--fg); }
    .starter-description { font-size: 11px; font-weight: 400; color: var(--muted); }
    .starter-chip:hover { background: var(--surface-hover); }
    .zero-gateway-banner {
      flex-wrap: wrap;
      padding: 12px 0 0;
      border: none;
      border-top: 1px solid var(--chat-line);
      border-radius: 0;
      background: transparent;
      gap: 10px;
    }
    .zero-gateway-banner:hover { border-color: var(--chat-line); }
    .zero-gateway-title { font-size: 11px; font-weight: 500; }
    .zero-gateway-sub { font-size: 10.5px; color: var(--muted); opacity: 1; }
    .zero-gateway-pulse { box-shadow: none; animation: none; }
    .zero-gateway-actions { flex-wrap: wrap; margin-left: auto; }
    .recent-sessions-section { margin-top: 0; gap: 8px; }
    .recent-header-label { font-size: 11px; text-transform: none; letter-spacing: 0; opacity: 1; color: var(--muted); }
    .recent-header-btn { background: transparent; border-color: transparent; }
    .recent-session-card { padding: 10px 12px; border-radius: 8px; background: transparent; }
    .recent-session-card:hover { transform: none; }

    .message-wrap { margin-top: 4px; margin-bottom: 4px; }
    .message.assistant { line-height: 1.65; }
    .assistant-header { gap: 8px; margin-bottom: 10px; }
    .assistant-avatar { width: 24px; height: 24px; border-radius: 7px; background: var(--chat-surface); }
    .assistant-name { letter-spacing: 0; }
    .message.user.prompt-card,
    body.andromity-session-tab .message.user.prompt-card {
      padding: 12px 14px;
      background: var(--chat-surface);
      border-color: var(--chat-line);
      border-radius: 10px;
      box-shadow: none;
    }
    .prompt-text-content { line-height: 1.6; }
    .activity-row { padding: 7px 9px; background: var(--chat-surface); border-color: var(--chat-line); border-radius: 6px; }
    .activity-row:hover { background: var(--surface-hover); border-color: var(--chat-line); }
    .message-footer { margin-top: 8px; }

    .account-popover { background: var(--chat-surface); border-color: var(--chat-line); border-radius: 10px; gap: 12px; }
    .account-section-label { font-size: 10px; font-weight: 500; color: var(--muted); letter-spacing: 0.03em; }
    .account-popover-body { background: var(--bg); border-color: var(--chat-line); padding: 12px; gap: 9px; }
    .account-quota-row { font-family: var(--font-ui); gap: 12px; }
    .account-quota-val { font-weight: 500; text-align: right; }
    .account-quota-meta { font-family: var(--font-ui); font-size: 10px; line-height: 1.5; }
    .account-quota-track { background: var(--input-border); }
    .account-scope-note { font-size: 11px; color: var(--muted); line-height: 1.5; margin: 0; }
    .btn-account-action.primary { background: #047857; color: #fff; min-height: 32px; border-radius: 6px; }
    .btn-account-action.primary:hover { background: #065f46; filter: none; }
    .btn-account-refresh { color: var(--muted); }
    body.vscode-light .account-avatar { color: #047857; }
    body.vscode-light { --cloud-success: var(--vscode-testing-iconPassed, #16825d); }

    .onboarding-guide-section { gap: 20px; }
    .onboarding-title { font-size: 22px; margin: 4px 0 6px; letter-spacing: -0.5px; }
    .onboarding-subtitle { line-height: 1.6; }
    .onboarding-card { padding: 0; border: none; background: transparent; gap: 14px; }
    .onboarding-instant-hero {
      padding: 18px;
      gap: 10px;
      border-radius: 10px;
      background: var(--chat-surface);
      border-color: var(--chat-line);
      box-shadow: none;
    }
    .onboarding-instant-hero::before { display: none; }
    .onboarding-instant-badge { padding: 0; border: none; background: transparent; color: var(--vscode-testing-iconPassed, #3fb950); }
    .onboarding-instant-badge svg { color: inherit; }
    .onboarding-instant-headline { font-size: 16px; }
    .onboarding-instant-subtext { font-size: 12px; line-height: 1.6; }
    .onboarding-instant-btn-group { margin-top: 4px; gap: 8px; }
    .btn-onboarding-instant-start { background: #047857; color: #fff; box-shadow: none; border-radius: 6px; min-height: 34px; }
    .btn-onboarding-instant-start:hover { background: #065f46; box-shadow: none; transform: none; }
    .btn-onboarding-github-login { background: transparent; border-color: var(--chat-line); color: var(--fg); min-height: 32px; border-radius: 6px; }
    .btn-onboarding-github-login:hover { background: var(--surface-hover); transform: none; }
    .onboarding-own-provider { border: 1px solid var(--chat-line); border-radius: 9px; background: var(--chat-surface); }
    .onboarding-own-provider .onboarding-step-view { padding: 16px; }
    .onboarding-provider-chip { background: transparent; border-color: var(--chat-line); border-radius: 6px; }
    .onboarding-provider-chip:hover { background: var(--surface-hover); border-color: var(--accent); }
    .onboarding-provider-chip.active { background: var(--surface-hover); }
    body.vscode-light .onboarding-instant-badge { color: var(--vscode-testing-iconPassed, #16825d); }

    .input-section { padding: 8px var(--chat-edge) 4px; }
    .prompt-box {
      padding: 8px 10px;
      background: var(--input-bg);
      border-color: var(--input-border);
      border-radius: 12px;
      box-shadow: none;
    }
    .prompt-box:focus-within {
      border-color: color-mix(in srgb, var(--accent) 40%, var(--input-border));
      box-shadow: none;
    }
    .prompt-box.is-generating { border-color: var(--vscode-testing-iconPassed, #3fb950); box-shadow: none; }
    #prompt-input { min-height: 36px; padding: 2px 2px 4px; line-height: 1.5; }
    #prompt-input::placeholder { color: var(--vscode-input-placeholderForeground, var(--muted)); }
    .prompt-box-footer { margin-top: 2px; padding-top: 2px; border-top: none; gap: 4px; }
    .prompt-left-controls, .prompt-right-controls { gap: 3px; }
    .prompt-btn { min-height: 26px; border-radius: 5px; }
    .codex-send-btn { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; background: var(--surface-hover); color: var(--muted); }
    .codex-send-btn.has-text { background: var(--vscode-button-background, #007fd4); color: var(--vscode-button-foreground, #fff); }
    .codex-send-btn.has-text:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    .prompt-box.is-generating .codex-send-btn.has-text { display: flex !important; align-items: center; justify-content: center; }
    .prompt-box.is-generating .codex-cancel-btn + .codex-send-btn { margin-left: 4px; }
    .action-tip {
      position: fixed;
      z-index: 1000;
      pointer-events: none;
      white-space: pre;
      font-size: 11px;
      line-height: 1.45;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--vscode-editorHoverWidget-background, var(--popover-bg));
      color: var(--vscode-editorHoverWidget-foreground, var(--fg));
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--popover-border));
      box-shadow: 0 2px 8px var(--popover-shadow);
    }
    .action-tip[hidden] { display: none; }
    .prompt-airgap-pill {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 10.5px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      color: var(--vscode-testing-iconPassed, #1a7f37);
      border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed, #1a7f37) 45%, transparent);
      white-space: nowrap;
    }
    .prompt-airgap-pill[hidden] { display: none; }
    .status-mcp-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 20px;
      margin-right: 6px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .status-mcp-btn:hover { color: var(--fg); background: var(--surface-hover); }
    .status-bar-right { display: flex; align-items: center; }

    /* Session panel. From 1500px it sits in the empty space right of the centred chat
       column; from 1100px the chat area gives up that space so the panel docks beside it.
       Narrower views show the chat only. */
    .side-panel, #btn-top-side-panel { display: none; }
    @media (min-width: 1100px) and (max-width: 1499.98px) {
      body:not(.side-panel-off) { --sp-reserve: 330px; padding-right: var(--sp-reserve); }
      body:not(.side-panel-off) .top-bar,
      body:not(.side-panel-off) .status-bar { margin-right: calc(-1 * var(--sp-reserve)); }
    }
    @media (min-width: 1100px) {
      body:not(.side-panel-off) .side-panel {
        display: flex;
        flex-direction: column;
        position: fixed;
        top: 88px;
        bottom: 56px;
        right: 20px;
        width: clamp(290px, calc((100vw - 860px) / 2 - 32px), 336px);
        z-index: 5;
      }
      body.side-panel-off #btn-top-side-panel { display: inline-flex; }
    }
    .side-panel-body {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow-y: auto;
      padding: 2px 2px 12px;
      scroll-padding-block: 12px;
      /* Only the panel scrolls; reaching its end never scrolls the chat behind it. */
      overscroll-behavior: contain;
      scrollbar-width: none;
      /* Soft edges show there is more to scroll, in place of a scrollbar. */
      --sp-fade-top: 0px;
      --sp-fade-bottom: 0px;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--sp-fade-top), #000 calc(100% - var(--sp-fade-bottom)), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 var(--sp-fade-top), #000 calc(100% - var(--sp-fade-bottom)), transparent 100%);
    }
    .side-panel-body::-webkit-scrollbar { display: none; }
    .side-panel-body.can-scroll-up { --sp-fade-top: 8px; }
    .side-panel-body.can-scroll-down { --sp-fade-bottom: 12px; }
    .side-panel-header {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 2px 14px;
    }
    .side-panel-heading { display: flex; flex-direction: column; gap: 4px; }
    .side-panel-eyebrow { font-size: 10px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .side-panel-title { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; color: var(--fg); }
    .side-panel-tools { display: inline-flex; gap: 2px; }
    .side-panel-tool {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      padding: 0;
    }
    .side-panel-tool:hover { color: var(--fg); background: var(--surface-hover); }
    .sp-empty-all { font-size: 12px; color: var(--muted); padding: 10px 6px; }
    .sp-empty-all[hidden] { display: none; }

    .sp-card {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--vscode-sideBar-background, var(--card-bg));
      font-size: 12px;
      line-height: 1.45;
      overflow: hidden;
      transition: border-color 0.15s ease;
      flex-shrink: 0;
    }
    .sp-card:hover { border-color: color-mix(in srgb, var(--fg) 22%, var(--border)); }
    .sp-card[hidden], .sp-card:empty { display: none; }
    .sp-card-header { display: flex; align-items: center; padding-left: 4px; }
    .sp-drag-handle { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 20px; height: 30px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--muted); cursor: grab; opacity: 0.55; }
    .sp-drag-handle:hover, .sp-drag-handle:focus-visible { opacity: 1; background: var(--surface-hover); }
    .sp-drag-handle:active { cursor: grabbing; }
    .sp-drag-handle svg { pointer-events: none; }
    .sp-card.sp-dragging { opacity: 0.45; }
    .sp-card.sp-drop-before { box-shadow: inset 0 3px 0 var(--accent); }
    .sp-card.sp-drop-after { box-shadow: inset 0 -3px 0 var(--accent); }
    .sp-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .sp-head {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      flex: 1;
      min-width: 0;
      min-height: 44px;
      padding: 12px 14px 12px 2px;
      border: none;
      background: transparent;
      color: var(--fg);
      font: inherit;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }
    .sp-head:hover { background: rgba(var(--tint), 0.03); }
    .sp-icon { color: var(--muted); flex-shrink: 0; }
    .sp-head-title { flex-shrink: 0; font-size: 12px; }
    .sp-head-summary {
      flex: 1;
      min-width: 0;
      display: flex;
      justify-content: flex-end;
      font-weight: 500;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      font-variant-numeric: tabular-nums;
    }
    .sp-head-summary > .sp-muted { overflow: hidden; text-overflow: ellipsis; }
    .sp-chevron { color: var(--muted); flex-shrink: 0; transition: transform 0.18s ease; }
    .sp-card.collapsed .sp-chevron { transform: rotate(-90deg); }
    .sp-body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 0 14px 12px;
    }
    .sp-card.collapsed .sp-body, .sp-body[hidden] { display: none; }
    .sp-description { color: var(--muted); font-size: 11px; line-height: 1.5; padding-bottom: 10px; }
    .side-panel button:focus-visible { outline-offset: -2px; }

    .sp-link {
      border: none;
      background: transparent;
      color: var(--vscode-textLink-foreground, var(--accent));
      cursor: pointer;
      font: inherit;
      font-size: 11.5px;
      padding: 0;
    }
    .sp-link:hover { text-decoration: underline; }
    .sp-actions { padding-top: 6px; }
    .sp-muted { color: var(--muted); }
    .sp-empty { color: var(--muted); padding: 4px 0 10px; line-height: 1.6; }
    .sp-more { padding: 8px 0 2px; font-size: 11px; text-align: left; }
    .sp-pill {
      display: inline-flex;
      align-items: center;
      padding: 0 7px;
      height: 17px;
      border-radius: 9px;
      font-size: 10.5px;
      font-weight: 600;
      background: rgba(var(--tint), 0.08);
      color: var(--fg);
    }
    .sp-pill.warn {
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d29922) 18%, transparent);
      color: var(--vscode-editorWarning-foreground, #d29922);
    }
    .sp-pill.full {
      background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 18%, transparent);
      color: var(--vscode-errorForeground, #f85149);
    }

    .sp-bar {
      display: flex;
      height: 6px;
      margin: 2px 0 4px;
      border-radius: 3px;
      background: rgba(var(--tint), 0.08);
      overflow: hidden;
    }
    .sp-bar > span { display: block; height: 100%; background: linear-gradient(90deg, #06b6d4, #10b981); }
    .sp-bar.segmented > span + span { box-shadow: -1px 0 0 var(--card-bg); }
    .sp-bar.warn:not(.segmented) > span { background: #f59e0b; }
    .sp-bar.full:not(.segmented) > span { background: #ef4444; }
    .sp-caption { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; padding-bottom: 4px; }
    .sp-swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }

    .sp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      min-height: 24px;
      border: none;
      background: transparent;
      color: var(--fg);
      font: inherit;
      text-align: left;
      padding: 2px 6px;
      margin: 0 -6px;
      width: calc(100% + 12px);
      border-radius: 5px;
    }
    button.sp-row { cursor: pointer; }
    button.sp-row:hover { background: var(--surface-hover); }
    .sp-row .sp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sp-row .sp-meta { color: var(--muted); white-space: nowrap; font-size: 11px; font-variant-numeric: tabular-nums; }
    .sp-dir { color: var(--muted); font-size: 11px; }
    .sp-status {
      width: 14px;
      flex-shrink: 0;
      text-align: center;
      font-size: 10px;
      font-weight: 700;
      font-family: var(--font-mono);
    }
    .sp-status.mod { color: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922); }
    .sp-status.new { color: var(--vscode-gitDecoration-untrackedResourceForeground, #3fb950); }
    .sp-status.del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    .sp-add { color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .sp-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
    @media (prefers-reduced-motion: reduce) { .sp-chevron { transition: none; } }

    .sp-kv {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 12px;
      margin: 0;
    }
    .sp-kv dt { color: var(--muted); }
    .sp-kv dd { margin: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Context card reuses the Context window pop-up's look. */
    .sp-card .context-popover-top { padding: 0 0 8px; gap: 12px; }
    .sp-card .context-ring-text, .sp-card .context-row-val { color: var(--fg); }
    .sp-card .context-popover-title { font-size: 11px; font-weight: 400; color: var(--muted); }
    .sp-card .context-popover-subtitle { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--fg); }
    .sp-card .context-row-label { color: var(--muted); }
    .sp-card .dot-used { background: var(--fg); }
    .sp-card .dot-avail { background: color-mix(in srgb, var(--fg) 22%, transparent); }
    .sp-card .context-popover-rows { padding: 8px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .sp-section-label {
      padding: 8px 0 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
    }
    .sp-breakdown-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      margin-top: 8px;
      padding: 4px 0;
      border: none;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .sp-breakdown-toggle:hover { color: var(--fg); }
    .sp-breakdown-toggle svg { transition: transform 0.18s ease; }
    .sp-breakdown-toggle[aria-expanded="false"] svg { transform: rotate(-90deg); }
    @media (prefers-reduced-motion: reduce) { .sp-breakdown-toggle svg { transition: none; } }
    .sp-card .context-stack { margin: 2px 0 8px; }
    .sp-context-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; margin-top: 6px; border-top: 1px solid var(--border); }
    .sp-card .context-breakdown-note { padding-top: 6px; }
    .sp-buttons { display: flex; gap: 6px; padding-top: 10px; margin-top: 8px; border-top: 1px solid var(--border); }
    .sp-buttons .context-compact-btn { flex: 1; justify-content: center; min-height: 30px; border-radius: 6px; font-size: 11px; font-weight: 500; }

    /* Changes */
    .sp-changes-summary { color: var(--muted); font-size: 11px; padding: 0 0 10px; overflow-wrap: anywhere; }
    .sp-changes-summary strong { color: var(--fg); font-weight: 500; }
    .sp-clean { display: flex; align-items: center; gap: 6px; color: var(--muted); padding: 2px 0 4px; }
    .sp-clean .codicon { color: var(--vscode-testing-iconPassed, #3fb950); }
    .sp-clean strong { color: var(--fg); font-weight: 600; }
    .sp-files { display: flex; flex-direction: column; margin: 0 -6px; }
    .sp-file {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 46px;
      padding: 7px 6px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      text-align: left;
      cursor: pointer;
      min-width: 0;
    }
    .sp-file:hover { background: var(--surface-hover); }
    .sp-file.deleted .sp-file-name { text-decoration: line-through; color: var(--muted); }
    .sp-file-icon { width: 16px; flex-shrink: 0; display: inline-flex; justify-content: center; font-size: 14px; }
    .sp-file-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; line-height: 1.35; }
    .sp-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .sp-file-dir { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 10px; }
    .sp-file-stats { display: flex; align-items: center; justify-content: flex-end; gap: 5px; flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums; }
    .sp-counts { display: inline-flex; gap: 4px; }
    .sp-diffbar { display: inline-flex; gap: 1px; }
    .sp-diffbar i { width: 4px; height: 5px; border-radius: 1px; background: rgba(var(--tint), 0.12); }
    .sp-diffbar i.add { background: var(--vscode-gitDecoration-addedResourceForeground, #3fb950); }
    .sp-diffbar i.del { background: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }

    /* MCP servers */
    .sp-server {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
      min-height: 46px;
      padding: 8px 6px;
      margin: 0 -6px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .sp-server:hover { background: var(--surface-hover); }
    .sp-server-list { display: flex; flex-direction: column; }
    .sp-server-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .sp-server-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .sp-server-kind { font-size: 10px; font-weight: 400; color: var(--muted); }
    .sp-server-status { flex-shrink: 0; font-size: 10px; color: var(--muted); white-space: nowrap; }
    .sp-server-status.running { color: var(--vscode-testing-iconPassed, #3fb950); }
    .sp-server-status.warn { color: var(--vscode-editorWarning-foreground, #d29922); }
    .sp-server-status.error { color: var(--vscode-errorForeground, #f85149); }
    .sp-server-total { padding-top: 6px; color: var(--muted); font-size: 10px; }

    /* Environment: each row opens its control */
    .sp-env-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 6px;
      margin: 0 -6px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      text-align: left;
      cursor: pointer;
      min-width: 0;
    }
    .sp-env-row:hover { background: var(--surface-hover); }
    .sp-env-divider { border-top: 1px solid var(--border); border-radius: 0 0 6px 6px; margin-top: 6px; padding-top: 12px; }
    .sp-env-icon { color: var(--muted); font-size: 13px; width: 14px; flex-shrink: 0; }
    .sp-env-label { color: var(--muted); width: 66px; flex-shrink: 0; }
    .sp-env-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; font-weight: 500; }
    .sp-env-value.mode-safe { color: #3fb950; }
    .sp-env-value.mode-trust { color: #58a6ff; }
    .sp-env-value.mode-full { color: #bc8cff; }
    .sp-env-value.mode-yolo { color: #f0883e; }
    .sp-env-value.airgap { color: var(--vscode-testing-iconPassed, #3fb950); }
    body.vscode-light .sp-env-value.mode-safe { color: #1a7f37; }
    body.vscode-light .sp-env-value.mode-trust { color: #0a66c2; }
    body.vscode-light .sp-env-value.mode-full { color: #7c3aed; }
    body.vscode-light .sp-env-value.mode-yolo { color: #b45309; }
    .sp-env-go { color: var(--muted); font-size: 11px; opacity: 0.5; transition: opacity 0.12s ease; }
    .sp-env-row:hover .sp-env-go, .sp-env-row:focus-visible .sp-env-go { opacity: 1; }

    .sp-menu {
      position: fixed;
      z-index: 1000;
      min-width: 180px;
      padding: 4px;
      border-radius: 8px;
      border: 1px solid var(--popover-border);
      background: var(--popover-bg);
      box-shadow: 0 6px 20px var(--popover-shadow);
      display: flex;
      flex-direction: column;
    }
    .sp-menu[hidden] { display: none; }
    .sp-menu-label {
      padding: 4px 8px 6px;
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    .sp-menu-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--fg);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .sp-menu-item:hover, .sp-menu-item:focus-visible { background: var(--vscode-list-hoverBackground, var(--surface-hover)); outline: none; }
    .sp-check { width: 14px; text-align: center; color: var(--accent); }
    .sp-menu-sep { height: 1px; margin: 4px 2px; background: var(--border); }
    body.vscode-high-contrast .sp-card, body.vscode-high-contrast-light .sp-card { border-color: var(--vscode-contrastBorder, var(--fg)); }

    .starter-chip.is-smart {
      border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    }
    .starter-chip.is-smart .starter-description { color: var(--fg); opacity: 0.8; }
    .status-bar { border-top: none; padding-left: var(--chat-edge); padding-right: var(--chat-edge); }

    button:focus-visible, [role="button"]:focus-visible, a:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, var(--accent));
      outline-offset: 2px;
    }
    .message-wrap:focus-within .message-footer { opacity: 1; visibility: visible; }
    body.vscode-light .zero-gateway-pulse { background: var(--vscode-testing-iconPassed, #16825d); }
    body.vscode-high-contrast .starter-chip,
    body.vscode-high-contrast-light .starter-chip,
    body.vscode-high-contrast .prompt-box,
    body.vscode-high-contrast-light .prompt-box {
      border-color: var(--vscode-contrastBorder, var(--fg));
    }

    @media (min-width: 600px) {
      :root { --chat-edge: 28px; }
      .zero-state { padding-top: 42px; }
      .minimal-starters-row { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }
    @media (max-width: 340px) {
      :root { --chat-edge: 10px; }
      .starter-chip { padding: 10px; gap: 7px; }
      .zero-statement-main { font-size: 25px; }
    }
    @media (max-width: 420px) {
      .prompt-box-footer { flex-wrap: wrap; }
      .prompt-right-controls { flex-basis: 100%; overflow: visible; justify-content: flex-start; }
      .codex-send-btn, .codex-cancel-btn { margin-left: auto; }
    }
    .agent-working { display: none; align-items: center; gap: 7px; color: var(--muted); font-size: 11px; padding: 0 2px 6px; }
    .prompt-box.is-generating .agent-working { display: flex; }
    .agent-working-wave, .scroll-live-wave { display: inline-flex; align-items: center; gap: 3px; height: 12px; }
    .agent-working-wave i, .scroll-live-wave i { width: 3px; height: 3px; border-radius: 50%; background: var(--accent); animation: agent-working-wave 1.1s ease-in-out infinite; }
    .agent-working-wave i:nth-child(2), .scroll-live-wave i:nth-child(2) { animation-delay: 0.15s; }
    .agent-working-wave i:nth-child(3), .scroll-live-wave i:nth-child(3) { animation-delay: 0.3s; }
    .scroll-live-wave { display: none; }
    body:has(.prompt-box.is-generating) .scroll-bottom-btn .scroll-live-wave { display: inline-flex; }
    body:has(.prompt-box.is-generating) .scroll-bottom-btn { width: 44px; height: 44px; flex-direction: column; gap: 0; }
    @keyframes agent-working-wave { 0%, 60%, 100% { transform: translateY(0); opacity: 0.45; } 30% { transform: translateY(-3px); opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
    }
    /* Wrappers that exist only while a reply streams; they must not affect layout. */
    .assistant-text > .md-stream-part { display: contents; }
  `;
}
