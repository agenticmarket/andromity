import { describe, it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {};
  return originalRequire.apply(this, arguments);
};
const { isReadableReceipt, readResponse, renderReceipt } = require("../src/providers/receipt/receiptView.js");
const { getReceiptStyles } = require("../src/providers/receipt/receiptStyles.js");
Module.prototype.require = originalRequire;

const NL = "\\u000a";
const PREVIEW = 160;
const HOSTILE = [
  "</code></summary></details><script>alert(1)</script>",
  '"><img src=x onerror="alert(1)">',
  "'><svg onload=alert(1)>",
  "<!--", "-->", "]]>", "</li></ul><form action=//evil>", "`${alert(1)}`", "&lt;b&gt;", "&#x3c;script&#x3e;",
  "<style>*{display:none}</style>", "<details open>", "</details>", "</code><p class=\"rc-detail\">Approved by you</p><code>",
];

function base(overrides: Record<string, unknown> = {}): any {
  return {
    version: 1, session_id: "s1", turn_index: 0, started_at: null, ended_at: null, duration_seconds: null,
    models: [], mode: "", snapshot: { before: "a".repeat(40), after: "b".repeat(40) },
    summary: {
      files_changed: 0, lines_added: 0, lines_deleted: 0, files_read: 0, searches: 0, commands: 0,
      commands_failed: 0, blocked: 0, denied: 0, approved_by_person: 0, denied_by_person: 0, subagents: 0, web_searches: 0,
    },
    files_changed: [], edited_not_in_snapshot: [], files_read: [], commands: [], checks: [], web_hosts: [],
    mcp_servers: [], other_tools: {}, needs_attention: [], approvers: [], cost_usd: null, tokens: null, notes: [],
    command_chars: 2000, record_hash: "d".repeat(64), ...overrides,
  };
}

function ran(command: string): any {
  return { command, outcome: "ok", exit_code: null, background: false, check: false, by: "agent",
    decided_by_person: null, decided_by: null };
}

function withSubject(subject: string): any {
  return base({ needs_attention: [{ kind: "destructive", severity: "high", detail: "Destructive command, ran without asking", subject }] });
}

function findingHtml(subject: string): string {
  const html = renderReceipt(withSubject(subject), null);
  const start = html.indexOf('<li class="rc-finding');
  const end = html.indexOf("</li>", start);
  assert.ok(start >= 0 && end > start, "the finding was not drawn");
  return html.slice(start, end + 5);
}

function commandHtml(command: string): string {
  return renderReceipt(base({ commands: [ran(command)], summary: { ...base().summary, commands: 1 } }), null);
}

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#96;/g, "`").replace(/&amp;/g, "&");
}

function subjectText(html: string): string {
  const match = html.match(/<code class="rc-subject">([\s\S]*?)<\/code>/);
  assert.ok(match, "no subject");
  return unescapeHtml(match[1]);
}

function fullText(html: string): string {
  const match = html.match(/<code class="rc-command rc-command-full">([\s\S]*?)<\/code>/);
  assert.ok(match, "no expanded text");
  return unescapeHtml(match[1]);
}

function previewText(html: string): string {
  const summary = html.match(/<summary>([\s\S]*?)<\/summary>/);
  assert.ok(summary, "no summary");
  const match = summary[1].match(/<code class="rc-command">([\s\S]*?)<\/code>/);
  assert.ok(match, "no preview");
  return unescapeHtml(match[1]);
}

function tagBalance(html: string, tag: string): void {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
  assert.equal(open, close, `<${tag}> is unbalanced`);
}

function assertNoInjectedMarkup(html: string): void {
  assert.doesNotMatch(html, /<script|<img|<svg|<form|<style|<!--|<details open|class="rc-detail">Approved/i);
  for (const tag of ["details", "summary", "code", "li", "span", "div", "p"]) tagBalance(html, tag);
}

describe("finding subjects are shown in full", () => {
  it("never folds a subject, however long or however many lines", () => {
    for (const subject of ["rm -rf dist", "r".repeat(PREVIEW), "x".repeat(PREVIEW) + "Z", "y".repeat(2000) + "... [destructive part: rm -rf ~/projects]",
      `echo "all good"${NL}rm -rf ~/projects`, `${NL}rm -rf ~/projects`]) {
      const html = findingHtml(subject);
      assert.doesNotMatch(html, /<details|<summary|rc-cmd-more/, subject.slice(0, 30));
      assert.equal(subjectText(html), subject.split(NL).join("\n"));
    }
  });

  it("shows escaped brackets in an engine suffix as written, without turning them back into brackets", () => {
    const subject = "echo " + "a".repeat(1992) + "... [destructive part: rm -rf ~ \\u005d \\u005bdestructive part: rm -rf ./cache]";
    const html = findingHtml(subject);
    assert.equal(subjectText(html), subject);
    assert.equal((subjectText(html).match(/\[destructive part: /g) || []).length, 1);
  });

  it("keeps one line per escaped newline", () => {
    for (const count of [1, 2, 7, 1000]) {
      const lines = Array.from({ length: count + 1 }, (_, i) => `line ${i} <b>`);
      assert.deepEqual(subjectText(findingHtml(lines.join(NL))).split("\n"), lines);
    }
  });

  it("round-trips a 2000-character subject with every printable character and hostile markup", () => {
    let printable = "";
    for (let c = 32; c < 127; c++) printable += String.fromCharCode(c);
    const pieces = [printable, ...HOSTILE, "é中\u{1F600}", NL, "\\u202e", "\\U000e0041"];
    let subject = "";
    for (let i = 0; subject.length < 2000; i++) subject += pieces[i % pieces.length];
    subject = subject.slice(0, 1997) + "... [destructive part: rm -rf ~/projects]";
    const html = findingHtml(subject);
    assertNoInjectedMarkup(html);
    assert.equal(subjectText(html), subject.split(NL).join("\n"));
    assert.match(html, /<p class="rc-detail">Destructive command, ran without asking<\/p>\s*<code class="rc-subject">/);
  });

  it("cannot inject markup or a fake detail line at any position", () => {
    for (const attack of HOSTILE) {
      for (let offset = 0; offset <= 3; offset++) {
        const subject = "a".repeat(offset) + attack + NL + attack + "b".repeat(offset);
        const html = findingHtml(subject);
        assertNoInjectedMarkup(html);
        assert.equal(subjectText(html), subject.split(NL).join("\n"));
        assert.equal((html.match(/<p class="rc-detail">/g) || []).length, 1);
      }
    }
  });

  it("wraps a long subject instead of overflowing", () => {
    const css = getReceiptStyles();
    const rule = css.match(/\.rc-subject, \.rc-command \{([^}]*)\}/);
    assert.ok(rule, "no subject style");
    assert.match(rule[1], /white-space: pre-wrap/);
    assert.match(rule[1], /word-break: break-all/);
  });

  it("ignores a part field, which the engine no longer writes", () => {
    const r = base({ needs_attention: [{ kind: "destructive", severity: "high", detail: "Destructive command, ran without asking",
      subject: "rm -rf ~", part: "rm -rf ./cache" }] });
    assert.doesNotMatch(renderReceipt(r, null), /rm -rf \.\/cache|Destructive part/);
  });
});

describe("long commands in the commands list still fold", () => {
  it("folds and round-trips a full-length command next to its status", () => {
    const command = "rm -rf " + "./d/".repeat(497) + "...";
    const html = commandHtml(command);
    assert.match(html, /<span class="rc-cmd-more"><span class="rc-cmd-closed">show all<\/span><span class="rc-cmd-open">hide<\/span><\/span><\/summary>/);
    assert.equal(fullText(html), command);
    assertNoInjectedMarkup(html);
  });

  it("puts the toggle text in the markup the stylesheet switches", () => {
    const css = getReceiptStyles();
    assert.doesNotMatch(css, /rc-cmd-more::before/);
    assert.match(css, /\.rc-cmd-open, \.rc-cmd\[open\] \.rc-cmd-closed \{ display: none; \}/);
    assert.match(css, /\.rc-cmd\[open\] \.rc-cmd-open \{ display: inline; \}/);
    const html = commandHtml("y".repeat(300));
    assert.equal((html.match(/rc-cmd-closed/g) || []).length, 1);
    assert.equal((html.match(/rc-cmd-open"/g) || []).length, 1);
  });

  it("cannot inject markup at any cut position of the preview", () => {
    for (const attack of HOSTILE) {
      for (let offset = 0; offset <= attack.length + 1; offset++) {
        const command = "a".repeat(PREVIEW - offset) + attack + "b".repeat(40);
        const html = commandHtml(command);
        assertNoInjectedMarkup(html);
        assert.equal(fullText(html), command);
      }
    }
  });

  it("never splits a character in two at the preview cut", () => {
    const preview = previewText(commandHtml("x".repeat(PREVIEW - 1) + "\u{1F600}" + "tail".repeat(10)));
    assert.doesNotMatch(preview, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("draws 200 full-length commands and 200 full findings quickly", () => {
    const long = (i: number) => `rm -rf ./build${i}/` + "<x>&\"'`".repeat(280) + NL + "echo done";
    const commands = Array.from({ length: 200 }, (_, i) => ran(long(i)));
    const needs_attention = Array.from({ length: 200 }, (_, i) => ({ kind: "destructive", severity: "high",
      detail: "Destructive command, ran without asking", subject: long(i) }));
    const r = base({ commands, needs_attention, summary: { ...base().summary, commands: 200 } });
    assert.ok(isReadableReceipt(r));
    const started = process.hrtime.bigint();
    const html = renderReceipt(r, null);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[200x2000] render ${ms.toFixed(1)}ms html ${html.length} chars`);
    assert.ok(ms < 1500, `${ms}ms`);
    assert.equal((html.match(/<details class="rc-cmd">/g) || []).length, 200);
    assertNoInjectedMarkup(html);
  });
});

describe("the seal is true or false only", () => {
  it("accepts true and false and nothing else", () => {
    for (const matches of [true, false]) assert.equal(isReadableReceipt(base({ sealed: { hash: "c".repeat(64), matches } })), true);
    for (const matches of [null, undefined, "true", 0, 1, {}]) {
      assert.equal(isReadableReceipt(base({ sealed: { hash: "c".repeat(64), matches } })), false, String(matches));
    }
    assert.equal(isReadableReceipt(base({ sealed: null })), false);
    const response = readResponse({ success: true, receipt: base({ sealed: { hash: "c".repeat(64), matches: null } }) });
    assert.equal(response.success, false);
  });

  it("says a changed record differs and never shows a third state", () => {
    const differs = renderReceipt(base({ sealed: { hash: "c".repeat(64), matches: false } }), null);
    assert.match(differs, /<p class="rc-seal rc-seal-bad"[^>]*>Differs from the record made when the turn ended\.<\/p>/);
    assert.doesNotMatch(differs, /earlier build|can(&#39;|')t be compared/);
  });
});
