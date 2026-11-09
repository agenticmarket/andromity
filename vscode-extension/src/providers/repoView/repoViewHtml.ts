import * as vscode from "vscode";
import { getNonce } from "../webviewSecurity.js";
import { repoViewClient } from "./repoViewClient.js";

const ICONS: Record<string, string> = {
  "issues": "eb0c", "issue-closed": "eba4", "git-pull-request": "ea64", "git-pull-request-draft": "ebdb", "git-pull-request-closed": "ebda",
  "git-merge": "eafe", "comment": "ea6b", "comment-discussion": "eac7", "close": "ea76", "error": "ea87", "pass-filled": "ebb3",
  "refresh": "eb37", "search": "ea6d", "link-external": "eb14", "sparkle": "ec10", "account": "eb99", "shield": "eb53", "clock": "ea82",
  "git-branch": "ec6f", "chevron-down": "eab4", "repo": "ea62", "warning": "ea6c", "lock": "ea75", "copy": "ebcc", "ellipsis": "ea7c",
  "circle-slash": "eabd", "organization": "ea7e", "debug-disconnect": "ead0",
};

function iconCss(): string {
  return Object.entries(ICONS).map(([name, code]) => `.codicon-${name}::before { content: "\\${code}"; }`).join("\n");
}

const STYLES = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
button, select, input, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
[hidden] { display: none !important; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
#app { display: flex; flex-direction: column; height: 100vh; }
.topbar { min-height: 44px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); flex: none; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-contrastBorder, transparent); cursor: pointer; white-space: nowrap; }
.chip:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.chip:disabled { cursor: default; }
.chip .codicon { font-size: 14px; }
.muted { color: var(--vscode-descriptionForeground); }
.small { font-size: 11.5px; }
.seg { display: inline-flex; background: var(--vscode-button-secondaryBackground); border-radius: 6px; padding: 2px; }
.seg button { border: none; background: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; color: var(--vscode-button-secondaryForeground); }
.seg button[aria-selected=true] { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.count { font-size: 11px; padding: 0 6px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.search { flex: 1 1 220px; max-width: 380px; display: flex; align-items: center; gap: 6px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 3px 8px; }
.search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--vscode-input-foreground); }
.search .codicon { font-size: 14px; color: var(--vscode-descriptionForeground); }
.spacer { flex: 1; }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--vscode-contrastBorder, transparent); cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); white-space: nowrap; }
.btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.btn:disabled { opacity: .55; cursor: default; }
.btn .codicon { font-size: 14px; }
.btn.icon { padding: 4px 6px; }
.updated { font-size: 11.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.notice { display: flex; gap: 8px; align-items: center; padding: 6px 12px; font-size: 12.5px; border-bottom: 1px solid var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); }
.notice .codicon { color: var(--vscode-editorWarning-foreground); }
.main { flex: 1; display: flex; min-height: 0; }
.side { width: 420px; flex: none; border-right: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; background: var(--vscode-sideBar-background); }
.filters { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); align-items: center; }
.filters .chip { font-size: 12px; padding: 2px 9px; }
.filters .chip[aria-pressed=true] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-focusBorder); }
.filters select { margin-left: auto; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; padding: 2px 4px; font-size: 12px; }
.banner { margin: 10px 12px 0; padding: 8px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent); background: color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent); font-size: 12.5px; display: flex; gap: 8px; align-items: center; }
.banner code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
.link { color: var(--vscode-textLink-foreground); cursor: pointer; background: none; border: none; padding: 0; text-decoration: underline; }
.banner .link { margin-left: auto; white-space: nowrap; }
.list { flex: 1; overflow: auto; padding: 4px 0 12px; }
.group { padding: 12px 14px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); display: flex; gap: 6px; }
.row { display: flex; gap: 10px; padding: 8px 14px; cursor: pointer; border-left: 3px solid transparent; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row[aria-selected=true] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); }
.row .codicon { margin-top: 1px; }
.st-open { color: var(--vscode-charts-green); } .st-draft { color: var(--vscode-descriptionForeground); } .st-merged { color: var(--vscode-charts-purple); } .st-closed { color: var(--vscode-charts-red); }
.row .body { flex: 1; min-width: 0; }
.row .title { font-weight: 600; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.row .meta { margin-top: 3px; font-size: 11.5px; color: var(--vscode-descriptionForeground); display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.row[aria-selected=true] .meta { color: inherit; opacity: .85; }
.row .meta .codicon, .sig .codicon, .line .codicon { font-size: 13px; }
.row .sig { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11.5px; }
.pass { color: var(--vscode-testing-iconPassed); } .fail { color: var(--vscode-errorForeground); } .pend { color: var(--vscode-editorWarning-foreground); }
.label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; white-space: nowrap; }
.label i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; border: 1px solid var(--vscode-panel-border); }
.tag { font-size: 10.5px; padding: 0 7px; border-radius: 9px; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); line-height: 16px; white-space: nowrap; margin-left: 4px; }
.tag.you { background: color-mix(in srgb, var(--vscode-charts-blue) 24%, transparent); }
.more, .none { display: flex; justify-content: center; padding: 14px; color: var(--vscode-descriptionForeground); text-align: center; flex-direction: column; align-items: center; gap: 8px; }
.detail { flex: 1; min-width: 0; overflow: auto; }
.dhead { padding: 18px 24px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
.dtitle { font-size: 20px; font-weight: 600; line-height: 1.3; margin: 0 0 8px; overflow-wrap: anywhere; }
.dtitle .num { color: var(--vscode-descriptionForeground); font-weight: 400; }
.pill { display: inline-flex; gap: 5px; align-items: center; padding: 2px 9px; border-radius: 14px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
.pill .codicon { font-size: 14px; }
.dmeta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; color: var(--vscode-descriptionForeground); }
.dmeta b { color: var(--vscode-foreground); }
.dmeta code, code { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.line { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 12px; font-size: 12.5px; align-items: center; }
.line .k { color: var(--vscode-descriptionForeground); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; align-items: center; }
.menu-wrap { position: relative; }
.menu { position: absolute; top: 30px; left: 0; z-index: 20; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 6px; box-shadow: 0 4px 14px var(--vscode-widget-shadow); padding: 4px; min-width: 250px; }
.menu button { display: flex; gap: 8px; align-items: center; width: 100%; text-align: left; background: none; border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
.menu button:hover, .menu button:focus-visible { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
.menu .sep { height: 1px; background: var(--vscode-panel-border); margin: 4px 0; }
.menu .hint { font-size: 11.5px; color: var(--vscode-descriptionForeground); padding: 4px 10px 6px; }
.tabs { display: flex; gap: 2px; padding: 0 20px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 2; }
.tabs button { border: none; background: none; padding: 9px 12px; cursor: pointer; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; display: inline-flex; gap: 6px; align-items: center; }
.tabs button[aria-selected=true] { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
.pane { padding: 18px 24px 40px; max-width: 980px; }
.untrusted { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--vscode-descriptionForeground); padding: 8px 10px; border-radius: 6px; background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); margin-bottom: 14px; }
.md { line-height: 1.6; overflow-wrap: anywhere; }
.md p { margin: 0 0 10px; white-space: pre-wrap; }
.md .md-h { font-weight: 600; }
.md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
.md blockquote { margin: 0 0 10px; padding-left: 10px; border-left: 3px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
pre.code, pre.diff { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 6px; overflow: auto; white-space: pre; margin: 0 0 10px; }
.hidden-text { font-size: 12px; color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); border-radius: 6px; padding: 6px 8px; margin: 0 0 10px; white-space: pre-wrap; }
.hidden-label { font-weight: 600; }
.host { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: 5px; }
.host::before { content: "("; } .host::after { content: ")"; }
.ref { color: var(--vscode-textLink-foreground); }
.section { margin-top: 22px; }
.section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 0 0 8px; font-weight: 600; }
.linkrow { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
.people { display: flex; flex-direction: column; gap: 6px; }
.person { display: flex; gap: 8px; align-items: center; }
.avatar { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; flex: none; background: color-mix(in srgb, var(--vscode-foreground) 22%, transparent); color: var(--vscode-foreground); }
.assoc { font-size: 10.5px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.thread { border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
.thread .th { display: flex; gap: 6px; align-items: center; padding: 8px 12px; background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); border-bottom: 1px solid var(--vscode-panel-border); font-size: 12.5px; flex-wrap: wrap; }
.cmt { padding: 10px 12px; display: flex; gap: 10px; }
.cmt + .cmt { border-top: 1px solid var(--vscode-panel-border); }
.cmt .cbody { min-width: 0; flex: 1; }
.cmt .who { font-weight: 600; } .cmt .when { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
.cmt .md { margin-top: 4px; }
details.file { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 8px; }
details.file summary { cursor: pointer; padding: 7px 10px; font-size: 12.5px; }
.fpath { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.fstatus { font-weight: 700; }
.fstatus.added { color: var(--vscode-gitDecoration-addedResourceForeground); } .fstatus.removed { color: var(--vscode-gitDecoration-deletedResourceForeground); } .fstatus.modified, .fstatus.changed { color: var(--vscode-gitDecoration-modifiedResourceForeground); } .fstatus.renamed { color: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-gitDecoration-modifiedResourceForeground)); }
.a { color: var(--vscode-gitDecoration-addedResourceForeground); } .d { color: var(--vscode-gitDecoration-deletedResourceForeground); }
.patch { padding: 0 8px 8px; }
.dl { display: block; }
.dl.add { background: var(--vscode-diffEditor-insertedLineBackground, color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 15%, transparent)); }
.dl.del { background: var(--vscode-diffEditor-removedLineBackground, color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 15%, transparent)); }
.dl.hunk { color: var(--vscode-descriptionForeground); }
.check { display: flex; gap: 10px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--vscode-panel-border); }
.check .n { flex: 1; overflow-wrap: anywhere; }
.check .s { color: var(--vscode-descriptionForeground); font-size: 12px; }
.box { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; font-size: 12.5px; line-height: 1.55; margin-bottom: 12px; }
.box.warn { border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground) 55%, transparent); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 8%, transparent); }
.box ul { margin: 4px 0 0; padding-left: 18px; }
#sheet-back { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 10; }
#sheet { position: fixed; top: 0; right: 0; bottom: 0; width: 560px; max-width: 100%; background: var(--vscode-sideBar-background); border-left: 1px solid var(--vscode-panel-border); box-shadow: -8px 0 24px var(--vscode-widget-shadow); display: flex; flex-direction: column; z-index: 11; }
#sheet[hidden] { display: none; }
.sh { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; align-items: center; }
.sh h2 { font-size: 14px; margin: 0; font-weight: 600; }
.sh .x { margin-left: auto; background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); }
.sb { padding: 16px 18px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 14px; }
.sf { padding: 12px 18px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }
.sf .note { margin-right: auto; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.field label { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 5px; }
.field textarea { width: 100%; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); border-radius: 4px; padding: 7px 9px; resize: vertical; }
.suggest { display: flex; flex-wrap: wrap; gap: 6px; }
.suggest .chip { font-size: 12px; }
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 10px; font-size: 12.5px; }
.kv .k { color: var(--vscode-descriptionForeground); }
.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; color: var(--vscode-descriptionForeground); padding: 40px; }
.empty > .codicon { font-size: 40px; opacity: .6; }
.empty h2 { margin: 0; color: var(--vscode-foreground); font-size: 16px; }
.empty p { margin: 0; max-width: 480px; line-height: 1.55; }
.row-actions { display: flex; gap: 8px; }
.detail-line { font-size: 12px; max-width: 640px; overflow-wrap: anywhere; }
@media (max-width: 980px) { .side { width: 340px; } }
@media (max-width: 760px) { .main { flex-direction: column; } .side { width: auto; max-height: 45vh; border-right: none; border-bottom: 1px solid var(--vscode-panel-border); } .search { max-width: none; flex-basis: 100%; order: 9; } }
`;

export function getRepoViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const font = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicon.ttf"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pull Requests and Issues</title>
  <style>
    @font-face { font-family: "codicon"; font-display: block; src: url("${font}") format("truetype"); }
    .codicon[class*="codicon-"] { font-family: "codicon"; font-size: 16px; font-style: normal; font-weight: normal; display: inline-block; line-height: 1; vertical-align: middle; -webkit-font-smoothing: antialiased; user-select: none; }
    ${iconCss()}
    ${STYLES}
  </style>
</head>
<body>
  <div id="app"></div>
  <div id="sheet-back" hidden></div>
  <div id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" hidden></div>
  <div id="live" class="sr" aria-live="polite"></div>
  <script nonce="${nonce}">
    (${repoViewClient.toString()})(acquireVsCodeApi());
  </script>
</body>
</html>`;
}
