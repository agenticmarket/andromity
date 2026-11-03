import * as vscode from "vscode";
import { escapeHtml, getNonce } from "../webviewSecurity.js";
import { getReceiptStyles } from "./receiptStyles.js";
import type {
  Receipt,
  ReceiptCheck,
  ReceiptCommand,
  ReceiptFileChange,
  ReceiptFinding,
  ReceiptResponse,
  ReceiptViewState,
} from "./types.js";

const RECEIPT_ICON =
  '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15h4"/>';
const FILES_READ_SHOWN = 8;
const UNREADABLE = "This receipt is in a format this version can't show. Update Andromity, or open the turn again.";
const SUMMARY_FIELDS = [
  "files_changed", "lines_added", "lines_deleted", "files_read", "searches", "commands", "commands_failed",
  "blocked", "denied", "approved_by_person", "denied_by_person", "subagents", "web_searches",
] as const;
const LISTS = ["needs_attention", "commands", "files_changed", "files_read", "checks", "notes", "models", "web_hosts",
  "mcp_servers", "edited_not_in_snapshot", "approvers"] as const;
const STATUS_TITLES: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", T: "Type changed" };

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

/** Only receipts this version understands are drawn; anything else fails closed instead of looking clean. */
export function isReadableReceipt(value: unknown): value is Receipt {
  if (!isObject(value) || value.version !== 1 || !isCount(value.turn_index) || !isText(value.record_hash)) return false;
  if (!LISTS.every((key) => Array.isArray(value[key]))) return false;
  const summary = value.summary;
  if (!isObject(summary) || !SUMMARY_FIELDS.every((key) => isCount(summary[key]))) return false;
  if (!isObject(value.other_tools) || !Object.values(value.other_tools).every(isCount)) return false;
  if (value.sealed !== undefined && (!isObject(value.sealed) || typeof value.sealed.matches !== "boolean")) return false;
  const lists = value as unknown as Receipt;
  return lists.needs_attention.every((f) => isObject(f) && isText(f.detail) && isText(f.kind)
      && (f.subject === undefined || isText(f.subject)) && (f.approver === undefined || isText(f.approver)))
    && lists.commands.every((c) => isObject(c) && isText(c.command) && isText(c.outcome) && isText(c.by))
    && lists.files_changed.every((e) => isObject(e) && isText(e.path) && isText(e.status) && isText(e.via)
      && (e.added === null || isCount(e.added)) && (e.deleted === null || isCount(e.deleted)))
    && lists.checks.every((c) => isObject(c) && isText(c.command) && isText(c.result))
    && lists.approvers.every((p) => isObject(p) && isText(p.id) && isText(p.name))
    && [lists.files_read, lists.notes, lists.models, lists.web_hosts, lists.mcp_servers,
      lists.edited_not_in_snapshot].every((items) => items.every(isText));
}

/** Validate the engine's answer before anything uses it. */
export function readResponse(value: unknown): ReceiptResponse {
  if (!isObject(value)) return { success: false, error: UNREADABLE };
  if (value.success !== true) {
    return { success: false, error: isText(value.error) && value.error ? value.error : "The receipt could not be loaded." };
  }
  if (!isReadableReceipt(value.receipt)) return { success: false, error: UNREADABLE };
  const turns = Array.isArray(value.turns) ? value.turns.filter(isCount) : [];
  return {
    success: true,
    receipt: value.receipt,
    text: isText(value.text) ? value.text : undefined,
    markdown: isText(value.markdown) ? value.markdown : undefined,
    viewer_id: isText(value.viewer_id) ? value.viewer_id : null,
    turns,
  };
}

function n(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : "?";
}

function plural(count: number, word: string, many?: string): string {
  return `${n(count)} ${count === 1 ? word : many || word + "s"}`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function you(id: string | null | undefined, viewerId: string | null | undefined): string {
  return viewerId && id && id === viewerId ? ' <span class="rc-you">(you)</span>' : "";
}

function approverNames(receipt: Receipt): Map<string, string> {
  return new Map(receipt.approvers.map((person) => [person.id, person.name]));
}

/** A person's name in its own element, so text inside a name can never pass for Andromity's "(you)". */
function person(id: string | null | undefined, names: Map<string, string>, viewerId?: string | null): string {
  const name = id ? names.get(id) : undefined;
  return name ? `<span class="rc-name">${escapeHtml(name)}</span>${you(id, viewerId)}` : "a person";
}

function commandStatus(command: ReceiptCommand): { label: string; tone: string } {
  switch (command.outcome) {
    case "failed":
      return { label: command.exit_code !== null ? `failed ${n(command.exit_code)}` : "failed", tone: "bad" };
    case "error":
      return { label: "error", tone: "bad" };
    case "timeout":
      return { label: "timed out", tone: "bad" };
    case "cancelled":
      return { label: "cancelled", tone: "muted" };
    case "denied":
      return { label: command.decided_by_person === false ? "declined" : "not run", tone: "muted" };
    case "blocked":
      return { label: "blocked", tone: "warn" };
    case "skipped":
      return { label: "not run", tone: "muted" };
    case "dry_run":
      return { label: "dry run", tone: "muted" };
    case "no_result":
      return { label: "no result", tone: "muted" };
    default:
      return { label: command.background ? "background" : "ran", tone: "ok" };
  }
}

function commandApproval(command: ReceiptCommand, names: Map<string, string>, viewerId?: string | null): string {
  if (command.decided_by_person === true) return `approved by ${person(command.decided_by, names, viewerId)}`;
  if (command.decided_by_person === false) return `declined by ${person(command.decided_by, names, viewerId)}`;
  if (command.outcome === "ok" || command.outcome === "failed") return "without asking";
  return "";
}

function renderFinding(finding: ReceiptFinding, names: Map<string, string>, viewerId?: string | null): string {
  const severity = finding.severity === "high" ? "high" : "medium";
  const decided = finding.approver ? ` by ${person(finding.approver, names, viewerId)}` : "";
  const subject = finding.subject ? `<code class="rc-subject">${escapeHtml(finding.subject)}</code>` : "";
  return `<li class="rc-finding rc-${severity}">
      <span class="rc-sev">${severity === "high" ? "High" : "Medium"}</span>
      <div class="rc-finding-body">
        <p class="rc-detail">${escapeHtml(finding.detail)}${decided}</p>
        ${subject}
      </div>
    </li>`;
}

function renderAttention(receipt: Receipt, viewerId?: string | null): string {
  const findings = receipt.needs_attention;
  if (!findings.length) {
    return `<section class="rc-calm" aria-label="Needs your eyes">
        <span class="rc-calm-dot" aria-hidden="true"></span>Nothing in this turn needs your eyes.
      </section>`;
  }
  const names = approverNames(receipt);
  return `<section class="rc-attention" aria-labelledby="rc-attention-title">
      <h2 id="rc-attention-title">Needs your eyes <span class="rc-count">${n(findings.length)}</span></h2>
      <ul class="rc-findings">${findings.map((finding) => renderFinding(finding, names, viewerId)).join("")}</ul>
    </section>`;
}

function renderCommands(receipt: Receipt, viewerId?: string | null): string {
  const commands = receipt.commands;
  const total = receipt.summary.commands;
  if (!commands.length && !total) return "";
  const names = approverNames(receipt);
  const rows = commands.map((command) => {
    const status = commandStatus(command);
    const by = command.by !== "agent" ? `<span class="rc-tag">${escapeHtml(command.by)}</span>` : "";
    const approval = commandApproval(command, names, viewerId);
    return `<li class="rc-row rc-row-cmd">
        <span class="rc-pill rc-${status.tone}">${escapeHtml(status.label)}</span>
        <code class="rc-command">${escapeHtml(command.command)}</code>
        <span class="rc-row-meta">${by}${approval ? `<span class="rc-approval">${approval}</span>` : ""}</span>
      </li>`;
  }).join("");
  const hidden = total - commands.length;
  return `<section aria-labelledby="rc-commands-title">
      <h2 id="rc-commands-title">Commands <span class="rc-count">${n(total)}</span></h2>
      <ul class="rc-rows">${rows}</ul>
      ${hidden > 0 ? `<p class="rc-more">${plural(hidden, "more command")} not listed.</p>` : ""}
    </section>`;
}

function renderChecks(checks: ReceiptCheck[]): string {
  if (!checks.length) return "";
  const rows = checks.map((check) => {
    const passed = check.result === "passed";
    const code = !passed && check.exit_code !== null ? ` (exit ${n(check.exit_code)})` : "";
    const recovered = check.failed_first === true ? '<span class="rc-row-meta">failed first, passed after</span>' : "";
    return `<li class="rc-row rc-row-cmd">
        <span class="rc-pill rc-${passed ? "ok" : "bad"}">${passed ? "passed" : "failed" + code}</span>
        <code class="rc-command">${escapeHtml(check.command)}</code>${recovered}
      </li>`;
  }).join("");
  return `<section aria-labelledby="rc-checks-title"><h2 id="rc-checks-title">Checks</h2><ul class="rc-rows">${rows}</ul></section>`;
}

function fileButton(path: string, openable: boolean): string {
  const shown = escapeHtml(path);
  return openable
    ? `<button type="button" class="rc-file" data-action="open-file" data-path="${shown}" title="Open ${shown}">${shown}</button>`
    : `<span class="rc-file rc-file-gone">${shown}</span>`;
}

function statusTitle(status: string): string {
  return Object.prototype.hasOwnProperty.call(STATUS_TITLES, status) ? STATUS_TITLES[status] : "Changed";
}

function renderFilesChanged(receipt: Receipt): string {
  const files = receipt.files_changed;
  const untracked = receipt.edited_not_in_snapshot;
  const s = receipt.summary;
  if (!files.length && !untracked.length && !s.files_changed) return "";
  const via = (entry: ReceiptFileChange) =>
    entry.via === "other" ? '<span class="rc-tag rc-tag-warn">not by the agent\'s edits</span>'
      : entry.via === "subagent" ? '<span class="rc-tag">subagent</span>' : "";
  const rows = files.map((entry) => {
    const counts = entry.added === null
      ? '<span class="rc-counts">binary</span>'
      : `<span class="rc-counts"><span class="rc-add">+${n(entry.added)}</span> <span class="rc-del">-${n(entry.deleted ?? 0)}</span></span>`;
    const status = entry.status.slice(0, 1);
    return `<li class="rc-row rc-row-file">
        <span class="rc-status rc-status-${escapeHtml(status.toLowerCase())}" title="${statusTitle(status)}">${escapeHtml(status)}</span>
        ${fileButton(entry.path, status !== "D")}<span class="rc-row-meta">${via(entry)}${counts}</span>
      </li>`;
  }).join("");
  const hidden = s.files_changed - files.length;
  const untrackedNote = untracked.length
    ? `<p class="rc-note">Edited, but not in the diff because git ignores ${untracked.length === 1 ? "it" : "them"}:
        ${untracked.map((path) => fileButton(path, true)).join(", ")}</p>`
    : "";
  return `<section aria-labelledby="rc-files-title">
      <h2 id="rc-files-title">Files changed <span class="rc-count">${n(s.files_changed)}</span>
        <span class="rc-h-counts"><span class="rc-add">+${n(s.lines_added)}</span>
        <span class="rc-del">-${n(s.lines_deleted)}</span></span></h2>
      <ul class="rc-rows">${rows}</ul>
      ${hidden > 0 ? `<p class="rc-more">${plural(hidden, "more file")} not listed.</p>` : ""}
      ${untrackedNote}
    </section>`;
}

function renderFilesRead(receipt: Receipt): string {
  const files = receipt.files_read;
  if (!files.length) return "";
  const items = files.map((path) => `<li>${fileButton(path, true)}</li>`);
  const shown = items.slice(0, FILES_READ_SHOWN).join("");
  const rest = items.slice(FILES_READ_SHOWN).join("");
  return `<section aria-labelledby="rc-read-title">
      <h2 id="rc-read-title">Files read <span class="rc-count">${n(receipt.summary.files_read)}</span></h2>
      <ul class="rc-chips">${shown}</ul>
      ${rest ? `<details class="rc-details"><summary>Show ${plural(files.length - FILES_READ_SHOWN, "more file")}</summary>
        <ul class="rc-chips">${rest}</ul></details>` : ""}
    </section>`;
}

function renderReach(receipt: Receipt): string {
  const groups: string[] = [];
  const chips = (values: string[]) => values.map((value) => `<li><span class="rc-chip">${escapeHtml(value)}</span></li>`).join("");
  if (receipt.web_hosts.length) groups.push(`<div><h3>Websites</h3><ul class="rc-chips">${chips(receipt.web_hosts)}</ul></div>`);
  if (receipt.mcp_servers.length) groups.push(`<div><h3>MCP servers</h3><ul class="rc-chips">${chips(receipt.mcp_servers)}</ul></div>`);
  const tools = Object.entries(receipt.other_tools).map(([name, count]) => (count > 1 ? `${name} x${n(count)}` : name));
  if (tools.length) groups.push(`<div><h3>Other tools</h3><ul class="rc-chips">${chips(tools)}</ul></div>`);
  const s = receipt.summary;
  const counts = [
    s.searches ? plural(s.searches, "code search", "code searches") : "",
    s.web_searches ? plural(s.web_searches, "web search", "web searches") : "",
    s.subagents ? plural(s.subagents, "subagent") : "",
  ].filter(Boolean);
  if (counts.length) groups.push(`<div><h3>Also</h3><p class="rc-plain">${escapeHtml(counts.join(", "))}</p></div>`);
  if (!groups.length) return "";
  return `<section aria-labelledby="rc-reach-title"><h2 id="rc-reach-title">Reached</h2><div class="rc-reach">${groups.join("")}</div></section>`;
}

function renderStats(receipt: Receipt): string {
  const s = receipt.summary;
  const stats = [
    `<li><strong>${n(s.files_changed)}</strong> ${s.files_changed === 1 ? "file" : "files"} changed
      <span class="rc-add">+${n(s.lines_added)}</span> <span class="rc-del">-${n(s.lines_deleted)}</span></li>`,
    `<li><strong>${n(s.files_read)}</strong> read</li>`,
  ];
  if (s.commands) {
    stats.push(`<li><strong>${n(s.commands)}</strong> ${s.commands === 1 ? "command" : "commands"}` +
      (s.commands_failed ? `, <span class="rc-bad-text">${n(s.commands_failed)} failed</span>` : "") + "</li>");
  }
  if (s.blocked) stats.push(`<li><strong>${n(s.blocked)}</strong> blocked</li>`);
  if (s.denied) stats.push(`<li><strong>${n(s.denied)}</strong> declined</li>`);
  if (typeof receipt.cost_usd === "number" && Number.isFinite(receipt.cost_usd)) {
    stats.push(`<li><strong>$${receipt.cost_usd.toFixed(2)}</strong></li>`);
  }
  return `<ul class="rc-stats">${stats.join("")}</ul>`;
}

function renderFooter(receipt: Receipt, viewerId?: string | null): string {
  const parts: string[] = [];
  if (receipt.models.length) parts.push(`Model: ${escapeHtml(receipt.models.join(", "))}`);
  if (isText(receipt.mode) && receipt.mode) parts.push(`Mode: ${escapeHtml(receipt.mode)}`);
  const s = receipt.summary;
  if (s.approved_by_person || s.denied_by_person) {
    const names = approverNames(receipt);
    const people = receipt.approvers.map((p) => person(p.id, names, viewerId)).join(", ");
    parts.push(`Approvals${people ? ` by ${people}` : ""}: ${n(s.approved_by_person)} approved, ${n(s.denied_by_person)} declined`);
  }
  if (typeof receipt.tokens === "number" && Number.isFinite(receipt.tokens)) {
    parts.push(`${Math.trunc(receipt.tokens).toLocaleString("en-US")} tokens`);
  }
  const before = receipt.snapshot?.before;
  const after = receipt.snapshot?.after;
  const snapshots = isText(before) && isText(after)
    ? `Snapshots <code>${escapeHtml(before.slice(0, 7))}</code> to <code>${escapeHtml(after.slice(0, 7))}</code> · `
    : "";
  const sealed = receipt.sealed
    ? receipt.sealed.matches === true
      ? '<span class="rc-sealed">Matches the record made when the turn ended</span>'
      : '<span class="rc-unsealed">Differs from the record made when the turn ended</span>'
    : "";
  const notes = receipt.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  return `<footer class="rc-foot">
      ${parts.length ? `<p>${parts.join(" · ")}</p>` : ""}
      <p>${snapshots}Checksum <code title="${escapeHtml(receipt.record_hash)}">${escapeHtml(receipt.record_hash.slice(0, 12))}</code>${sealed ? " · " + sealed : ""}</p>
      ${notes ? `<ul class="rc-notes">${notes}</ul>` : ""}
      <p class="rc-limits">Not covered: most files git ignores, and files outside this folder.
        No prompts, file contents or command output are included. The checksum shows whether this record changed; it is not a signature.</p>
    </footer>`;
}

export function renderReceipt(receipt: Receipt, viewerId?: string | null): string {
  const when = [formatWhen(receipt.started_at), formatDuration(receipt.duration_seconds)].filter(Boolean).join(" · ");
  const turn = n(receipt.turn_index + 1);
  return `<article class="rc-doc" aria-label="Receipt for turn ${turn}">
      <section class="rc-overview">
        <p class="rc-when">Turn ${turn}${when ? " · " + escapeHtml(when) : ""}</p>
        ${renderStats(receipt)}
      </section>
      ${renderAttention(receipt, viewerId)}
      ${renderCommands(receipt, viewerId)}
      ${renderChecks(receipt.checks)}
      ${renderFilesChanged(receipt)}
      ${renderFilesRead(receipt)}
      ${renderReach(receipt)}
      ${renderFooter(receipt, viewerId)}
    </article>`;
}

function renderTurnNav(turns: number[], current: number | null): string {
  const valid = turns.filter(isCount);
  if (!valid.length) return "";
  const position = current === null ? -1 : valid.indexOf(current);
  const prev = position > 0 ? valid[position - 1] : null;
  const next = position >= 0 && position < valid.length - 1 ? valid[position + 1] : null;
  const options = (position < 0 ? ['<option value="" selected disabled>Choose a turn</option>'] : []).concat(
    valid.map((turn) => `<option value="${n(turn)}"${turn === current ? " selected" : ""}>Turn ${n(turn + 1)}</option>`)).join("");
  const arrow = (target: number | null, label: string, glyph: string) =>
    `<button type="button" class="rc-icon-btn" data-action="turn" ${target === null ? "disabled" : `data-turn="${n(target)}"`}
      aria-label="${label}" title="${label}">${glyph}</button>`;
  return `<nav class="rc-turns" aria-label="Turns">
      ${arrow(prev, "Previous turn", "&#8249;")}
      <select data-action="pick-turn" aria-label="Choose a turn">${options}</select>
      ${arrow(next, "Next turn", "&#8250;")}
    </nav>`;
}

function errorView(message: string, pinned: boolean): string {
  return `<div class="rc-empty" role="status"><p>${escapeHtml(message)}</p>
      <div class="rc-actions">
        <button type="button" class="rc-btn" data-action="refresh">Try again</button>
        ${pinned ? '<button type="button" class="rc-btn" data-action="latest">Show latest turn</button>' : ""}
      </div></div>`;
}

export function renderReceiptBody(state: ReceiptViewState): string {
  const header = (nav: string, actions: string) => `<header class="rc-head">
      <div class="rc-title">
        <svg class="rc-logo" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RECEIPT_ICON}</svg>
        <h1>Receipt</h1>
        <span class="rc-session" title="${escapeHtml(state.sessionName)}">${escapeHtml(state.sessionName)}</span>
      </div>
      ${nav}
      ${actions}
    </header>`;
  const response = state.response;
  const receipt = response?.success && isReadableReceipt(response.receipt) ? response.receipt : null;
  try {
    let main: string;
    if (state.loading && !receipt) {
      main = '<p class="rc-empty" role="status">Building the receipt...</p>';
    } else if (!receipt) {
      main = errorView(response?.success ? UNREADABLE : response?.error || "This receipt could not be loaded.", state.pinned);
    } else {
      main = renderReceipt(receipt, response?.viewer_id);
    }
    const actions = receipt && !state.loading
      ? `<div class="rc-actions">
          <button type="button" class="rc-btn" data-action="copy-text" title="Copy the receipt as plain text">Copy as text</button>
          ${response?.markdown ? '<button type="button" class="rc-btn" data-action="copy-markdown" title="Copy as Markdown to paste into a pull request">Copy as Markdown</button>' : ""}
          <button type="button" class="rc-btn" data-action="export-json" title="Save the full receipt as JSON">Save JSON</button>
        </div>`
      : "";
    return `${header(renderTurnNav(state.turns, receipt ? receipt.turn_index : null), actions)}
      <main class="rc-main" aria-busy="${state.loading ? "true" : "false"}">${main}</main>`;
  } catch {
    return `${header("", "")}<main class="rc-main" aria-busy="false">${errorView(UNREADABLE, state.pinned)}</main>`;
  }
}

function receiptScript(): string {
  return `(function () {
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || target.hasAttribute('disabled')) return;
    const action = target.getAttribute('data-action');
    if (action === 'turn') {
      vscode.postMessage({ type: 'turn', turnIndex: Number(target.getAttribute('data-turn')) });
    } else if (action === 'open-file') {
      vscode.postMessage({ type: 'open_file', path: target.getAttribute('data-path') || '' });
    } else if (action === 'copy-text') {
      vscode.postMessage({ type: 'copy_text' });
    } else if (action === 'copy-markdown') {
      vscode.postMessage({ type: 'copy_markdown' });
    } else if (action === 'export-json') {
      vscode.postMessage({ type: 'export_json' });
    } else if (action === 'refresh') {
      vscode.postMessage({ type: 'refresh' });
    } else if (action === 'latest') {
      vscode.postMessage({ type: 'latest' });
    }
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.getAttribute('data-action') === 'pick-turn' && target.value !== '') {
      vscode.postMessage({ type: 'turn', turnIndex: Number(target.value) });
    }
  });
})();`;
}

export function getReceiptHtml(webview: vscode.Webview, state: ReceiptViewState): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipt</title>
  <style>${getReceiptStyles()}</style>
</head>
<body>
  ${renderReceiptBody(state)}
  <script nonce="${nonce}">${receiptScript()}</script>
</body>
</html>`;
}
