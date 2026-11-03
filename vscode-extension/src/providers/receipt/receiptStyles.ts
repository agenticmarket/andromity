export function getReceiptStyles(): string {
  return `
:root {
  --rc-fg: var(--vscode-foreground);
  --rc-muted: var(--vscode-descriptionForeground);
  --rc-bg: var(--vscode-editor-background);
  --rc-surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
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
  line-height: 1.5;
}
button, select { font: inherit; color: inherit; }
:focus-visible { outline: 1px solid var(--rc-focus); outline-offset: 2px; }
code { font-family: var(--rc-mono); font-size: .92em; }

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
.rc-title h1 { margin: 0; font-size: 1.05em; font-weight: 600; }
.rc-logo { color: var(--rc-link); flex: none; }
.rc-session {
  color: var(--rc-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40ch;
}
.rc-turns { display: flex; align-items: center; gap: 4px; }
.rc-turns select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, var(--rc-border));
  border-radius: 4px;
  padding: 2px 6px;
}
.rc-icon-btn, .rc-btn {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--rc-fg));
  border: 1px solid var(--rc-border);
  border-radius: 4px;
  cursor: pointer;
}
.rc-icon-btn { width: 26px; height: 24px; line-height: 1; font-size: 16px; padding: 0; }
.rc-btn { padding: 3px 10px; }
.rc-icon-btn:hover:not([disabled]), .rc-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--rc-code-bg)); }
.rc-icon-btn[disabled] { opacity: .4; cursor: default; }
.rc-actions { display: flex; gap: 6px; }

.rc-main { max-width: 920px; margin: 0 auto; padding: 18px 24px 40px; }
.rc-empty { color: var(--rc-muted); padding: 32px 0; display: grid; gap: 12px; justify-items: start; }
.rc-empty p { margin: 0; }

.rc-overview { margin-bottom: 18px; }
.rc-when { margin: 0 0 6px; color: var(--rc-muted); }
.rc-stats { list-style: none; display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 0; margin: 0; font-size: 1.05em; }
.rc-stats strong { font-weight: 600; }
.rc-add { color: var(--rc-add); }
.rc-del { color: var(--rc-del); }
.rc-bad-text { color: var(--rc-high); }

section { margin: 0 0 22px; }
h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: .78em;
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--rc-muted);
}
h3 { margin: 0 0 4px; font-size: .9em; font-weight: 600; color: var(--rc-muted); }
.rc-count {
  min-width: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: .95em;
  letter-spacing: 0;
  text-align: center;
}
.rc-h-counts { letter-spacing: 0; text-transform: none; font-weight: 400; }

.rc-attention {
  border: 1px solid var(--rc-border);
  border-left: 3px solid var(--rc-warn);
  border-radius: 6px;
  padding: 12px 14px 4px;
  background: var(--rc-surface);
}
.rc-attention:has(.rc-high) { border-left-color: var(--rc-high); }
.rc-findings { list-style: none; margin: 0; padding: 0; }
.rc-finding { display: grid; grid-template-columns: 52px 1fr; gap: 10px; padding: 6px 0 10px; }
.rc-finding + .rc-finding { border-top: 1px solid var(--rc-border); padding-top: 10px; }
.rc-sev {
  align-self: start;
  margin-top: 1px;
  padding: 0 6px;
  border-radius: 3px;
  font-size: .78em;
  font-weight: 600;
  text-align: center;
  border: 1px solid currentColor;
}
.rc-high .rc-sev { color: var(--rc-high); }
.rc-medium .rc-sev { color: var(--rc-warn); }
.rc-detail { margin: 0 0 4px; }
.rc-you { color: var(--rc-link); font-weight: 600; }
.rc-name {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--rc-code-bg);
  font-weight: 600;
}
.rc-subject, .rc-command {
  display: block;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--rc-code-bg);
  white-space: pre-wrap;
  word-break: break-all;
}
.rc-calm {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--rc-muted);
  padding: 10px 14px;
  border: 1px dashed var(--rc-border);
  border-radius: 6px;
}
.rc-calm-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--rc-ok); flex: none; }

.rc-rows { list-style: none; margin: 0; padding: 0; }
.rc-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.rc-row .rc-command { display: block; }
.rc-row-cmd { grid-template-columns: 84px minmax(0, 1fr) auto; }
.rc-row-cmd .rc-pill { justify-self: start; }
.rc-row-file { grid-template-columns: 18px minmax(0, 1fr) auto; }
.rc-row-file .rc-file { justify-self: start; }
.rc-row-meta { display: flex; gap: 6px; align-items: center; color: var(--rc-muted); font-size: .92em; justify-content: end; }
.rc-pill {
  padding: 0 7px;
  border-radius: 9px;
  font-size: .82em;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid currentColor;
}
.rc-ok { color: var(--rc-ok); }
.rc-bad { color: var(--rc-high); }
.rc-warn { color: var(--rc-warn); }
.rc-muted { color: var(--rc-muted); }
.rc-tag {
  padding: 0 6px;
  border-radius: 3px;
  background: var(--rc-code-bg);
  color: var(--rc-muted);
  font-size: .85em;
  white-space: nowrap;
}
.rc-tag-warn { color: var(--rc-warn); }
.rc-approval { white-space: nowrap; }

.rc-status {
  width: 18px;
  text-align: center;
  font-family: var(--rc-mono);
  font-weight: 700;
}
.rc-status-a { color: var(--rc-add); }
.rc-status-d { color: var(--rc-del); }
.rc-status-m { color: var(--rc-warn); }
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
.rc-counts { font-family: var(--rc-mono); font-size: .9em; white-space: nowrap; }
.rc-chips { list-style: none; display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; padding: 0; }
.rc-chip { font-family: var(--rc-mono); font-size: .92em; }
.rc-details summary { cursor: pointer; color: var(--rc-link); margin-top: 6px; }
.rc-reach { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.rc-plain { margin: 0; }
.rc-more, .rc-note { color: var(--rc-muted); margin: 6px 0 0; }

.rc-foot {
  margin-top: 28px;
  padding-top: 12px;
  border-top: 1px solid var(--rc-border);
  color: var(--rc-muted);
  font-size: .92em;
}
.rc-foot p { margin: 0 0 6px; }
.rc-notes { margin: 0 0 6px; padding-left: 18px; }
.rc-sealed { color: var(--rc-ok); }
.rc-unsealed { color: var(--rc-high); font-weight: 600; }
.rc-limits { font-size: .92em; }

@media (max-width: 560px) {
  .rc-head, .rc-main { padding-left: 12px; padding-right: 12px; }
  .rc-row { grid-template-columns: auto minmax(0, 1fr); }
  .rc-row-cmd { grid-template-columns: 84px minmax(0, 1fr); }
  .rc-row-file { grid-template-columns: 18px minmax(0, 1fr); }
  .rc-row-meta { grid-column: 2; justify-content: start; }
}
`;
}
