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
    .status-bar { border-top: none; padding-left: var(--chat-edge); padding-right: var(--chat-edge); }

    button:focus-visible, [role="button"]:focus-visible, a:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, var(--accent));
      outline-offset: 2px;
    }
    .message-wrap:focus-within .message-footer { opacity: 1; visibility: visible; }
    body.vscode-light .zero-gateway-pulse { background: var(--vscode-testing-iconPassed, #16825d); }
    body.vscode-highContrast .starter-chip,
    body.vscode-highContrastLight .starter-chip,
    body.vscode-highContrast .prompt-box,
    body.vscode-highContrastLight .prompt-box {
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
  `;
}
