export function getReceiptStyles(): string {
  return `
:root {
  --rc-fg: var(--vscode-foreground);
  --rc-muted: var(--vscode-descriptionForeground);
  --rc-bg: var(--vscode-editor-background);
  --rc-border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
  --rc-code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  --rc-high: var(--vscode-errorForeground, #f14c4c);
  --rc-warn: var(--vscode-editorWarning-foreground, #cca700);
  --rc-ok: var(--vscode-testing-iconPassed, #3fb950);
  --rc-add: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
  --rc-del: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
  --rc-link: var(--vscode-textLink-foreground);
  --rc-focus: var(--vscode-focusBorder);
  --rc-mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  color: var(--rc-fg);
  background: var(--rc-bg);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.55;
}
button, select { font: inherit; color: inherit; }
:focus-visible { outline: 1px solid var(--rc-focus); outline-offset: 2px; }
code { font-family: var(--rc-mono); font-size: .92em; }
p { margin: 0; }

.rc-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 24px;
  background: var(--rc-bg);
  border-bottom: 1px solid var(--rc-border);
}
.rc-title { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; }
.rc-title h1 { margin: 0; font-size: 1em; font-weight: 600; }
.rc-logo { color: var(--rc-muted); flex: none; }
.rc-session { color: var(--rc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
.rc-turns { display: flex; align-items: center; gap: 4px; }
.rc-turns select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, var(--rc-border));
  border-radius: 2px;
  padding: 2px 6px;
}
.rc-icon-btn, .rc-btn {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--rc-fg));
  border: 1px solid transparent;
  border-radius: 2px;
  cursor: pointer;
}
.rc-icon-btn { width: 26px; height: 24px; line-height: 1; font-size: 16px; padding: 0; }
.rc-btn { padding: 3px 10px; }
.rc-icon-btn:hover:not([disabled]), .rc-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--rc-code-bg)); }
.rc-icon-btn[disabled] { opacity: .4; cursor: default; }
.rc-btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.rc-btn-primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
.rc-actions { display: flex; gap: 6px; }

.rc-main { max-width: 860px; margin: 0 auto; padding: 24px 24px 48px; }
.rc-empty { color: var(--rc-muted); padding: 32px 0; display: grid; gap: 12px; justify-items: start; }

.rc-verdict { margin: 0 0 28px; }
.rc-verdict-title { font-size: 1.3em; font-weight: 600; margin-bottom: 6px; }
.rc-verdict-warn .rc-verdict-title { color: var(--rc-warn); }
.rc-verdict-high .rc-verdict-title { color: var(--rc-high); }
.rc-sentence { margin-bottom: 4px; }
.rc-meta { color: var(--rc-muted); }
.rc-seal { margin-top: 4px; color: var(--rc-muted); }
.rc-seal-ok { color: var(--rc-ok); }
.rc-seal-bad { color: var(--rc-high); font-weight: 600; }
.rc-add { color: var(--rc-add); }
.rc-del { color: var(--rc-del); }
.rc-bad-text { color: var(--rc-high); }

section { margin: 0 0 26px; }
h2 {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin: 0 0 8px;
  font-size: 1em;
  font-weight: 600;
}
h3 { margin: 0 0 4px; font-size: 1em; font-weight: 400; color: var(--rc-muted); }
.rc-count, .rc-h-counts, .rc-h-note { font-weight: 400; color: var(--rc-muted); }

.rc-findings { list-style: none; margin: 0; padding: 0; }
.rc-finding { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; padding: 6px 0; }
.rc-sev { font-size: .92em; font-weight: 600; }
.rc-high .rc-sev { color: var(--rc-high); }
.rc-medium .rc-sev { color: var(--rc-warn); }
.rc-detail { margin-bottom: 4px; }
.rc-you { color: var(--rc-link); }
.rc-name { padding: 0 4px; border-radius: 2px; background: var(--rc-code-bg); }
.rc-subject, .rc-command {
  display: block;
  padding: 2px 8px;
  border-radius: 2px;
  background: var(--rc-code-bg);
  white-space: pre-wrap;
  word-break: break-all;
}

.rc-rows { list-style: none; margin: 0; padding: 0; }
.rc-row { display: grid; align-items: start; gap: 12px; padding: 3px 0; }
.rc-row-cmd { grid-template-columns: 76px minmax(0, 1fr) auto; }
.rc-row-file { grid-template-columns: 14px minmax(0, 1fr) auto; }
.rc-row-file .rc-file { justify-self: start; }
.rc-row-meta { display: flex; gap: 8px; align-items: baseline; color: var(--rc-muted); justify-content: end; white-space: nowrap; }
.rc-pill { padding-top: 2px; font-size: .92em; white-space: nowrap; }
.rc-ok { color: var(--rc-muted); }
.rc-bad { color: var(--rc-high); }
.rc-warn { color: var(--rc-warn); }
.rc-muted { color: var(--rc-muted); }
.rc-tag { color: var(--rc-muted); }
.rc-tag-warn { color: var(--rc-warn); }

.rc-cmd { min-width: 0; }
.rc-cmd summary { display: flex; align-items: start; gap: 8px; cursor: pointer; list-style: none; }
.rc-cmd summary::-webkit-details-marker { display: none; }
.rc-cmd summary .rc-command { flex: 1 1 auto; min-width: 0; }
.rc-cmd-more { flex: none; padding-top: 2px; color: var(--rc-link); font-size: .92em; white-space: nowrap; }
.rc-cmd[open] summary .rc-command { display: none; }
.rc-cmd-open, .rc-cmd[open] .rc-cmd-closed { display: none; }
.rc-cmd[open] .rc-cmd-open { display: inline; }

.rc-status { text-align: center; font-family: var(--rc-mono); color: var(--rc-muted); }
.rc-status-a { color: var(--rc-add); }
.rc-status-d { color: var(--rc-del); }
.rc-file {
  background: none;
  border: none;
  padding: 0;
  text-align: left;
  font-family: var(--rc-mono);
  font-size: .92em;
  color: var(--rc-link);
  cursor: pointer;
  word-break: break-all;
}
.rc-file:hover { text-decoration: underline; }
.rc-file-gone { color: var(--rc-muted); cursor: default; text-decoration: line-through; }
.rc-counts { font-family: var(--rc-mono); font-size: .92em; }
.rc-chips { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; }
.rc-chip { font-family: var(--rc-mono); font-size: .92em; }
.rc-details summary { cursor: pointer; color: var(--rc-link); margin-top: 6px; }
.rc-reach { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.rc-list { list-style: none; margin: 0; padding: 0; }
.rc-list li { padding: 1px 0; }
.rc-more, .rc-note { color: var(--rc-muted); margin-top: 6px; }

.rc-foot { margin-top: 36px; padding-top: 12px; border-top: 1px solid var(--rc-border); color: var(--rc-muted); font-size: .92em; }
.rc-foot p { margin: 0 0 4px; }
.rc-notes { margin: 0 0 4px; padding-left: 16px; }

.rc-feedback { margin-top: 20px; padding: 10px 12px; border: 1px solid var(--rc-border); border-radius: 6px; }
.rc-fb-step { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; }
.rc-fb-step[hidden] { display: none; }
.rc-fb-q { margin-right: 4px; }
.rc-fb-note {
  flex: 1 1 220px;
  min-width: 0;
  padding: 3px 6px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--rc-border));
  border-radius: 3px;
}
.rc-link {
  padding: 0;
  color: var(--rc-link);
  background: none;
  border: none;
  cursor: pointer;
}
.rc-link:hover { text-decoration: underline; }
.rc-feedback button:disabled, .rc-fb-note:disabled { opacity: .5; cursor: default; }
.rc-fb-hint { color: var(--rc-muted); font-size: .92em; }
.rc-fb-status { min-height: 1.4em; margin: 4px 0 0; color: var(--rc-muted); }

@media (max-width: 560px) {
  .rc-head, .rc-main { padding-left: 12px; padding-right: 12px; }
  .rc-row-cmd { grid-template-columns: 76px minmax(0, 1fr); }
  .rc-row-file { grid-template-columns: 14px minmax(0, 1fr); }
  .rc-row-meta { grid-column: 2; justify-content: start; }
}
`;
}
