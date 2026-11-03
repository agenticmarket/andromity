import { describe, it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments);
};
const { formatDuration, formatWhen, getReceiptHtml, isReadableReceipt, readResponse, renderReceipt, renderReceiptBody } =
  require("../src/providers/receipt/receiptView.js");
Module.prototype.require = originalRequire;

const ME = "a1b2c3d4e5f60718";
const TEAMMATE = "0f0e0d0c0b0a0908";
const ATTACK = '<img src=x onerror="alert(1)">';
const UNREADABLE = /in a format this version can(&#39;|')t show/;

function receipt(overrides: Record<string, unknown> = {}): any {
  return {
    version: 1,
    session_id: "s1",
    turn_index: 2,
    started_at: "2026-10-27T11:30:05+00:00",
    ended_at: "2026-10-27T11:31:17+00:00",
    duration_seconds: 72,
    models: ["provider/model-a"],
    mode: "trust",
    snapshot: { before: "a".repeat(40), after: "b".repeat(40) },
    summary: {
      files_changed: 2, lines_added: 12, lines_deleted: 3, files_read: 1, searches: 2, commands: 2,
      commands_failed: 1, blocked: 1, denied: 1, approved_by_person: 1, denied_by_person: 1, subagents: 0, web_searches: 0,
    },
    files_changed: [
      { path: "app.py", status: "M", added: 10, deleted: 3, via: "edit" },
      { path: "old.py", status: "D", added: 0, deleted: 0, via: "other" },
    ],
    edited_not_in_snapshot: [],
    files_read: ["README.md"],
    commands: [
      { command: "rm -rf dist", outcome: "ok", exit_code: null, background: false, check: false, by: "agent",
        decided_by_person: true, decided_by: ME },
      { command: "git push --force", outcome: "denied", exit_code: null, background: false, check: false, by: "agent",
        decided_by_person: false, decided_by: TEAMMATE },
    ],
    checks: [{ command: "pytest -q", result: "passed", exit_code: null, failed_first: true, runs: 2 }],
    web_hosts: ["example.com"],
    mcp_servers: [],
    other_tools: {},
    needs_attention: [
      { kind: "destructive", severity: "high", detail: "Destructive command, approved", subject: "rm -rf dist", approver: ME },
      { kind: "destructive", severity: "medium", detail: "Destructive command, declined", subject: "git push --force", approver: TEAMMATE },
    ],
    approvers: [{ id: ME, name: "Shubham" }, { id: TEAMMATE, name: "Alex" }],
    cost_usd: 0.042,
    tokens: 12345,
    notes: ["Approver names come from git settings on this machine and are not verified."],
    sealed: { hash: "c".repeat(64), matches: true },
    record_hash: "d".repeat(64),
    ...overrides,
  };
}

function state(response: any, extra: Record<string, unknown> = {}): any {
  return { sessionName: "Session", loading: false, response, turns: [0, 2, 5], pinned: false, ...extra };
}

const ok = (r: any, extra: Record<string, unknown> = {}) =>
  state({ success: true, receipt: r, text: "t", viewer_id: ME, turns: [0, 2, 5], ...extra });

describe("receipt view", () => {
  it("marks only the reader's own decisions with (you), set apart from the name", () => {
    const html = renderReceipt(receipt(), ME);
    assert.match(html, /Destructive command, approved by <span class="rc-name">Shubham<\/span> <span class="rc-you">\(you\)<\/span>/);
    assert.match(html, /Destructive command, declined by <span class="rc-name">Alex<\/span><\/p>/);
    assert.match(html, /approved by <span class="rc-name">Shubham<\/span> <span class="rc-you">\(you\)<\/span><\/span>/);
    assert.match(html, /Approvals by <span class="rc-name">Shubham<\/span> <span class="rc-you">\(you\)<\/span>, <span class="rc-name">Alex<\/span>: 1 approved, 1 declined/);
    assert.doesNotMatch(renderReceipt(receipt(), null), /rc-you/);
    assert.doesNotMatch(renderReceipt(receipt(), "ffffffffffffffff"), /rc-you/);
  });

  it("never lets a name pass for Andromity's own (you)", () => {
    const html = renderReceipt(receipt({ approvers: [{ id: ME, name: "Shubham" }, { id: TEAMMATE, name: "Alex (you)" }] }), ME);
    assert.match(html, /<span class="rc-name">Alex \(you\)<\/span><\/p>/);
    assert.equal((html.match(/class="rc-you"/g) || []).length, 3, "finding, command row and footer for the reader only");
  });

  it("names an unknown approver only as a person", () => {
    const html = renderReceipt(receipt({ approvers: [] }), ME);
    assert.match(html, /Destructive command, approved by a person<\/p>/);
    assert.doesNotMatch(html, /rc-name|rc-you/);
  });

  it("escapes everything the agent or a person controls", () => {
    const hostile = receipt({
      needs_attention: [{ kind: "sensitive", severity: "high", detail: ATTACK, subject: ATTACK, approver: ME }],
      commands: [{ command: ATTACK, outcome: "failed", exit_code: ATTACK, background: false, check: false, by: ATTACK,
        decided_by_person: true, decided_by: ME }],
      files_changed: [{ path: `"><script>alert(1)</script>`, status: `"><b>`, added: 1, deleted: 0, via: "edit" }],
      files_read: [ATTACK], web_hosts: [ATTACK], mcp_servers: [ATTACK], other_tools: { [ATTACK]: 2 },
      approvers: [{ id: ME, name: ATTACK }], models: [ATTACK], mode: ATTACK, notes: [ATTACK],
      checks: [{ command: ATTACK, result: "failed", exit_code: ATTACK, failed_first: false, runs: 1 }],
      snapshot: { before: ATTACK, after: ATTACK }, record_hash: ATTACK, session_id: ATTACK,
    });
    const html = getReceiptHtml({ cspSource: "vscode-webview:" } as any, ok(hostile, { sessionName: ATTACK }));
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<b>/);
    assert.doesNotMatch(html, /onerror="/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /failed \?<\/span>/);
    assert.equal((html.match(/<script/g) || []).length, 1, "only the panel's own nonce'd script");
  });

  it("allows only the panel's own script under a strict policy", () => {
    const html = getReceiptHtml({ cspSource: "vscode-webview:" } as any, ok(receipt()));
    const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || "";
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'nonce-[0-9a-f]{32}'/);
    assert.doesNotMatch(policy, /script-src[^;]*(unsafe|https?:|\*)/);
    const nonce = /nonce-([0-9a-f]{32})/.exec(policy)?.[1];
    assert.ok(html.includes(`<script nonce="${nonce}">`));
  });

  it("keeps the agent's text after Andromity's own words and out of them", () => {
    const html = renderReceipt(receipt({
      needs_attention: [{ kind: "destructive", severity: "high", detail: "Destructive command, ran without asking",
        subject: "rm -rf dist # approved by Shubham (you)" }],
    }), ME);
    assert.match(html, /<p class="rc-detail">Destructive command, ran without asking<\/p>\s*<code class="rc-subject">rm -rf dist # approved by Shubham \(you\)<\/code>/);
    const finding = html.slice(html.indexOf('class="rc-findings"'), html.indexOf("</ul>", html.indexOf('class="rc-findings"')));
    assert.doesNotMatch(finding, /rc-you|rc-name/);
  });

  it("says when nothing needs a look and when the record changed", () => {
    const calm = renderReceipt(receipt({ needs_attention: [] }), ME);
    assert.match(calm, /Nothing in this turn needs your eyes/);
    assert.match(calm, /Matches the record made when the turn ended/);
    const changed = renderReceipt(receipt({ sealed: { hash: "c".repeat(64), matches: false } }), ME);
    assert.match(changed, /Differs from the record made when the turn ended/);
    assert.doesNotMatch(renderReceipt(receipt({ sealed: undefined }), ME), /record made when the turn ended/);
  });

  it("links files that exist and not deleted ones", () => {
    const html = renderReceipt(receipt(), ME);
    assert.match(html, /data-action="open-file" data-path="app.py"/);
    assert.doesNotMatch(html, /data-path="old.py"/);
    assert.match(html, /rc-file-gone">old.py<\/span><span class="rc-row-meta"><span class="rc-tag rc-tag-warn">/);
    assert.match(html, /not by the agent's edits/);
  });

  it("offers Markdown only when the engine sent it", () => {
    assert.match(renderReceiptBody(ok(receipt(), { markdown: "### r" })), /data-action="copy-markdown"/);
    assert.doesNotMatch(renderReceiptBody(ok(receipt())), /data-action="copy-markdown"/);
  });

  it("navigates only between turns that have receipts", () => {
    const middle = renderReceiptBody(ok(receipt()));
    assert.match(middle, /data-action="turn" data-turn="0"/);
    assert.match(middle, /data-action="turn" data-turn="5"/);
    assert.match(middle, /<option value="2" selected>Turn 3<\/option>/);
    const first = renderReceiptBody({ ...ok(receipt({ turn_index: 0 })), turns: [0, 2, 5] });
    assert.match(first, /<button type="button" class="rc-icon-btn" data-action="turn" disabled/);
    const junk = renderReceiptBody({ ...ok(receipt()), turns: [-1, 1.5, "3", NaN, 2] });
    assert.doesNotMatch(junk, /value="-1"|value="1.5"|value="3"|NaN/);
  });

  it("hides copy and save while a newer receipt is loading", () => {
    const loading = renderReceiptBody({ ...ok(receipt(), { markdown: "### r" }), loading: true });
    assert.match(loading, /Turn 3/);
    assert.match(loading, /aria-busy="true"/);
    assert.doesNotMatch(loading, /data-action="(copy-text|copy-markdown|export-json)"/);
    assert.match(renderReceiptBody(ok(receipt())), /data-action="copy-text"/);
  });

  it("keeps the way back after an error", () => {
    const pinned = renderReceiptBody(state({ success: false, error: ATTACK }, { pinned: true }));
    assert.doesNotMatch(pinned, /<img/);
    assert.match(pinned, /data-action="refresh"/);
    assert.match(pinned, /data-action="latest"/);
    assert.match(pinned, /<option value="" selected disabled>Choose a turn<\/option>/);
    assert.match(pinned, /<option value="5">Turn 6<\/option>/);
    assert.doesNotMatch(pinned, /data-action="copy-text"/);
    const following = renderReceiptBody(state({ success: false, error: "x" }));
    assert.doesNotMatch(following, /data-action="latest"/);
    assert.match(renderReceiptBody(state(null, { loading: true })), /Building the receipt/);
  });

  it("refuses receipts this version does not understand instead of drawing them clean", () => {
    const broken: Array<[string, any]> = [
      ["newer version", receipt({ version: 2 })],
      ["version as text", receipt({ version: "1" })],
      ["missing findings", receipt({ needs_attention: undefined })],
      ["findings not a list", receipt({ needs_attention: { length: 0 } })],
      ["missing approvers", receipt({ approvers: undefined })],
      ["approver without a name", receipt({ approvers: [{ id: ME }] })],
      ["finding without detail", receipt({ needs_attention: [{ kind: "destructive", severity: "high" }] })],
      ["finding with object subject", receipt({ needs_attention: [{ kind: "x", severity: "high", detail: "d", subject: {} }] })],
      ["command without outcome", receipt({ commands: [{ command: "rm -rf /", by: "agent" }] })],
      ["file without path", receipt({ files_changed: [{ status: "M", added: 1, deleted: 0, via: "edit" }] })],
      ["negative line count", receipt({ files_changed: [{ path: "a", status: "M", added: -1, deleted: 0, via: "edit" }] })],
      ["summary count as text", receipt({ summary: { ...receipt().summary, blocked: "0" } })],
      ["summary count huge", receipt({ summary: { ...receipt().summary, files_changed: 2 ** 60 } })],
      ["missing summary field", receipt({ summary: { files_changed: 1 } })],
      ["seal match as text", receipt({ sealed: { hash: "c", matches: "true" } })],
      ["seal not an object", receipt({ sealed: "matches" })],
      ["negative turn", receipt({ turn_index: -1 })],
      ["tool count as text", receipt({ other_tools: { shell: "2" } })],
      ["files read with objects", receipt({ files_read: [{}] })],
      ["no checksum", receipt({ record_hash: undefined })],
    ];
    for (const [name, value] of broken) {
      assert.equal(isReadableReceipt(value), false, name);
      const read = readResponse({ success: true, receipt: value, text: "looks fine" });
      assert.equal(read.success, false, name);
      const html = renderReceiptBody(state(read));
      assert.match(html, UNREADABLE, name);
      assert.doesNotMatch(html, /Nothing in this turn needs your eyes|Matches the record/, name);
    }
    assert.match(renderReceiptBody(state({ success: true, receipt: { turn_index: 0 } })), UNREADABLE);
    assert.equal(isReadableReceipt(receipt()), true);
    assert.equal(isReadableReceipt(receipt({ sealed: undefined })), true);
  });

  it("reads only the parts of an answer it trusts", () => {
    for (const junk of [null, undefined, "receipt", 7, []]) {
      assert.deepEqual(readResponse(junk), { success: false, error: "This receipt is in a format this version can't show. Update Andromity, or open the turn again." });
    }
    assert.deepEqual(readResponse({ success: false }), { success: false, error: "The receipt could not be loaded." });
    assert.deepEqual(readResponse({ success: "true", receipt: receipt() }), { success: false, error: "The receipt could not be loaded." });
    assert.equal(readResponse({ success: false, error: ATTACK }).error, ATTACK);
    const read = readResponse({ success: true, receipt: receipt(), text: 5, markdown: { x: 1 }, viewer_id: 9,
      turns: [0, "1", -1, 2.5, 4, 2 ** 60] });
    assert.equal(read.success, true);
    assert.equal(read.text, undefined);
    assert.equal(read.markdown, undefined);
    assert.equal(read.viewer_id, null);
    assert.deepEqual(read.turns, [0, 4]);
    for (const turns of ["0,1,2", { length: 2, 0: 1, 1: 2 }, 3, null]) {
      assert.deepEqual(readResponse({ success: true, receipt: receipt(), turns }).turns, [], JSON.stringify(turns));
    }
  });

  it("formats times and durations plainly", () => {
    assert.equal(formatWhen("2026-10-27T11:30:05+00:00"), "2026-10-27 11:30 UTC");
    assert.equal(formatWhen("not a date"), "");
    assert.equal(formatDuration(6), "6s");
    assert.equal(formatDuration(72), "1m 12s");
    assert.equal(formatDuration(3720), "1h 2m");
    assert.equal(formatDuration(-1), "");
  });
});
