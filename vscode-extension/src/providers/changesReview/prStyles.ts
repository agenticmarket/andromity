/** Styles for the Create pull request side panel in Changes Review. Theme colours only. */
export function getPrStyles(): string {
  return `
    .pr-open-btn[hidden], .pr-sheet[hidden], .pr-section[hidden] { display: none !important; }
    .pr-open-btn:disabled { opacity: 0.5; cursor: default; }
    .pr-open-btn[aria-expanded="true"] { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

    .pr-sheet {
      position: fixed; top: 44px; right: 0; bottom: 0; width: min(540px, 100vw); z-index: 50;
      display: flex; flex-direction: column; font-size: 13px; line-height: 1.4;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-left: 1px solid var(--border-color);
      box-shadow: -10px 0 28px rgba(0, 0, 0, 0.3);
    }
    .pr-sheet * { user-select: text; }
    .pr-sheet button { font: inherit; }
    .pr-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border-color); }
    .pr-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
    .pr-icon-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 2px; border-radius: 4px; }
    .pr-icon-btn:hover { background: var(--hover-bg); }
    .pr-body { flex: 1; overflow: auto; padding: 0 16px 16px; }
    .pr-loading { margin-top: 16px; color: var(--vscode-descriptionForeground); }
    .pr-section { padding: 14px 0; border-bottom: 1px solid var(--border-color); }
    .pr-section:last-child { border-bottom: none; }
    .pr-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .pr-ai { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--vscode-descriptionForeground); }
    .pr-ai .codicon-sparkle { color: var(--vscode-textLink-foreground); }
    .pr-input, .pr-textarea, .pr-select {
      width: 100%; padding: 5px 8px; border-radius: 4px; font: inherit;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
    }
    .pr-input:focus, .pr-textarea:focus, .pr-select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .pr-textarea { display: block; min-height: 92px; resize: vertical; white-space: pre-wrap; font-family: var(--review-code-font); font-size: 12px; line-height: 1.5; }
    .pr-textarea:disabled { opacity: 0.6; }
    .pr-select { color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); border-color: var(--vscode-dropdown-border, transparent); }
    .pr-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .pr-repo { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
    .pr-muted { color: var(--vscode-descriptionForeground); }
    .pr-small { font-size: 12px; }
    .pr-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 400;
      background: rgba(128, 128, 128, 0.18); color: var(--vscode-foreground); white-space: nowrap; }
    .pr-chip.public, .pr-chip.warn { color: var(--vscode-editorWarning-foreground); background: rgba(128, 128, 128, 0.12); }
    .pr-chip.danger { color: var(--vscode-errorForeground); background: rgba(128, 128, 128, 0.12); }
    .pr-chip.muted { color: var(--vscode-descriptionForeground); }
    .pr-route { display: grid; grid-template-columns: 46px 1fr; gap: 8px 10px; align-items: center; margin-top: 12px; }
    .pr-k { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .pr-branch { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .pr-branch .pr-input { font-family: var(--review-code-font); font-size: 12px; }
    .pr-help { margin-top: 8px; font-size: 12px; line-height: 1.5; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .pr-help.warn, .pr-warn-text { color: var(--vscode-editorWarning-foreground); }
    .pr-help:empty { display: none; }
    .pr-sheet code, .pr-code { font-family: var(--review-code-font); font-size: 12px; padding: 0 3px; border-radius: 3px; background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.15)); overflow-wrap: anywhere; }
    .pr-link-btn { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; }
    .pr-link-btn:hover { text-decoration: underline; }
    .pr-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: 5px; overflow: hidden; text-transform: none; letter-spacing: 0; font-weight: 400; }
    .pr-seg button, .pr-seg span { padding: 2px 9px; font-size: 12px; border: none; background: none; color: var(--vscode-descriptionForeground); cursor: pointer; }
    .pr-seg .on { background: rgba(128, 128, 128, 0.25); color: var(--vscode-foreground); }
    .pr-files { display: flex; flex-direction: column; gap: 1px; }
    .pr-file { display: grid; grid-template-columns: 18px 14px 1fr auto; align-items: center; gap: 4px 8px; padding: 3px 6px; border-radius: 4px; }
    .pr-file:hover { background: var(--hover-bg); }
    .pr-path { font-family: var(--review-code-font); font-size: 12px; text-align: left; background: none; border: none; padding: 0; color: var(--vscode-foreground);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; min-width: 0; }
    .pr-path:hover { text-decoration: underline; }
    .pr-file.off .pr-path { color: var(--vscode-descriptionForeground); }
    .pr-status { font-family: var(--review-code-font); font-size: 11px; font-weight: 700; text-align: center; color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .pr-status.A, .pr-status.U { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .pr-status.D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .pr-status.R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
    .pr-counts { font-family: var(--review-code-font); font-size: 11px; white-space: nowrap; }
    .pr-counts .a { color: var(--diff-add-text); }
    .pr-counts .d { color: var(--diff-del-text); margin-left: 4px; }
    .pr-tags { grid-column: 3 / 5; display: flex; flex-wrap: wrap; gap: 6px; }
    .pr-sheet input[type="checkbox"] { width: 14px; height: 14px; margin: 0; accent-color: var(--vscode-button-background); }
    .pr-check { display: flex; align-items: flex-start; gap: 8px; margin-top: 10px; cursor: pointer; }
    .pr-check input { margin-top: 2px; }
    .pr-disabled { opacity: 0.55; cursor: default; }
    .pr-field + .pr-field { margin-top: 12px; }
    .pr-field-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; font-size: 12px; }
    .pr-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .pr-chips:empty { display: none; }
    .pr-desc-actions { margin-top: 6px; font-size: 12px; }
    .pr-tokens { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; padding: 4px 6px; border-radius: 4px;
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .pr-token { display: inline-flex; align-items: center; gap: 3px; padding: 1px 2px 1px 8px; border-radius: 3px; font-size: 12px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .pr-token .x { background: none; border: none; color: inherit; opacity: 0.75; cursor: pointer; padding: 0 4px; }
    .pr-token-input { flex: 1; min-width: 140px; border: none; outline: none; background: none; color: var(--vscode-input-foreground); font: inherit; font-size: 12px; padding: 2px; }
    .pr-receipt { margin-top: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: rgba(128, 128, 128, 0.06); }
    .pr-receipt-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; font-size: 12px; }
    .pr-receipt-preview { margin: 0; border-top: 1px solid var(--border-color); padding: 10px 12px; max-height: 320px; overflow: auto;
      white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--review-code-font); font-size: 11.5px; line-height: 1.5; }
    .pr-callout { margin-top: 10px; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--vscode-editorWarning-foreground); }
    .pr-callout p { font-size: 12px; margin-bottom: 8px; }
    .pr-attention { padding: 10px 12px; border-radius: 6px; border: 1px solid var(--vscode-errorForeground); background: rgba(128, 128, 128, 0.06); }
    .pr-attention-title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
    .pr-attention-title .codicon { color: var(--vscode-errorForeground); }
    .pr-attention ul { list-style: none; margin: 8px 0 0; display: flex; flex-direction: column; gap: 5px; font-size: 12px; overflow-wrap: anywhere; }
    .pr-sev { font-weight: 600; color: var(--vscode-errorForeground); }
    .pr-foot { padding: 12px 16px 14px; border-top: 1px solid var(--border-color); }
    .pr-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .pr-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; }
    .pr-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .pr-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .pr-btn.secondary { background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
    .pr-btn.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3)); }
    .pr-btn.ghost { background: none; color: var(--vscode-foreground); }
    .pr-btn:disabled { opacity: 0.45; cursor: default; }
    .pr-why { margin-top: 6px; font-size: 12px; color: var(--vscode-editorWarning-foreground); }
    .pr-plan { margin-top: 10px; font-size: 12px; line-height: 1.5; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .pr-steps { list-style: none; margin: 14px 0 4px; display: flex; flex-direction: column; gap: 2px; }
    .pr-steps li { display: grid; grid-template-columns: 20px 1fr; gap: 8px; padding: 6px 0; align-items: start; overflow-wrap: anywhere; }
    .pr-steps .codicon { font-size: 15px; margin-top: 1px; }
    .pr-steps .done .codicon { color: var(--vscode-testing-iconPassed, var(--diff-add-text)); }
    .pr-steps .running .codicon { color: var(--vscode-textLink-foreground); }
    .pr-steps .pending { color: var(--vscode-descriptionForeground); }
    .pr-steps .failed, .pr-steps .failed .codicon { color: var(--vscode-errorForeground); }
    .pr-result { margin-top: 16px; padding: 14px; border-radius: 6px; border: 1px solid var(--border-color); background: rgba(128, 128, 128, 0.06); }
    .pr-result.ok { border-color: var(--vscode-testing-iconPassed, var(--diff-add-text)); }
    .pr-result.bad { border-color: var(--vscode-errorForeground); }
    .pr-result-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; }
    .pr-result.ok .pr-result-title .codicon { color: var(--vscode-testing-iconPassed, var(--diff-add-text)); font-size: 18px; }
    .pr-result.bad .pr-result-title .codicon { color: var(--vscode-errorForeground); font-size: 18px; }
    .pr-result p { margin-top: 8px; font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
    .pr-result .pr-actions { margin-top: 12px; }
    .pr-url { margin: 8px 0 0; font-family: var(--review-code-font); font-size: 12.5px; overflow-wrap: anywhere; }
    .pr-signin { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 4px; font-size: 12px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
    @media (forced-colors: active) {
      .pr-btn, .pr-chip, .pr-attention, .pr-result, .pr-callout { border: 1px solid ButtonText; }
    }
  `;
}
