// Independent adversarial tests for the AI change record (changeRecord.ts): buildChangeRecord's aggregation and
// composeChangeRecord's Markdown. Spec: private/design/pr-record/DESIGN.md. Receipts are treated as hostile input.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChangeRecord, composeChangeRecord, RECORD_START, RECORD_END, type RecordFile, type RecordTurn } from "../src/integrations/pullRequest/changeRecord.js";
import { GITHUB_BODY_LIMIT } from "../src/integrations/pullRequest/body.js";

const T = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 10, h, m)).toISOString();

function receipt(over: Record<string, any> = {}): any {
  const { summary, ...rest } = over;
  return {
    version: 1, session_id: "s1", turn_index: 0, started_at: null, ended_at: T(10), duration_seconds: 5, models: ["anthropic/claude-x"], mode: "full",
    snapshot: {}, files_changed: [], edited_not_in_snapshot: [], files_read: [], commands: [], checks: [], web_hosts: [], mcp_servers: [],
    other_tools: {}, needs_attention: [], approvers: [], cost_usd: 12.34, tokens: 98765, notes: [], record_hash: "e".repeat(64),
    summary: { files_changed: 1, lines_added: 4242, lines_deleted: 1717, files_read: 0, searches: 0, commands: 0, commands_failed: 0, blocked: 0,
      denied: 0, approved_by_person: 0, denied_by_person: 0, subagents: 0, web_searches: 0, ...(summary ?? {}) },
    ...rest,
  };
}
const turn = (key: string, over: Record<string, any> = {}): RecordTurn => ({ key, receipt: receipt(over) });
const file = (path: string, turns: string[], coverage: RecordFile["coverage"] = "covered"): RecordFile => ({ path, coverage, turns });
const check = (command: string, result: "passed" | "failed", exit_code: number | null = result === "passed" ? 0 : 1) => ({ command, result, exit_code, failed_first: false, runs: 1 });
const finding = (kind: string, severity: string, detail: string, subject?: string, approver?: string) => ({ kind, severity, detail, ...(subject !== undefined ? { subject } : {}), ...(approver ? { approver } : {}) });

function build(input: { files: RecordFile[]; turns: RecordTurn[]; later?: RecordTurn[]; unread?: number; scope?: "pull_request" | "turn" }) {
  return buildChangeRecord({ head: "a".repeat(40), scope: input.scope ?? "pull_request", files: input.files, turns: input.turns, later: input.later, unread: input.unread });
}
const compose = (input: Parameters<typeof build>[0], budget = GITHUB_BODY_LIMIT - 512) => composeChangeRecord(build(input), budget);

/** Replaces every code span with a placeholder, so what's left is what GitHub parses as Markdown/HTML. */
function outsideCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") { out += text[i++]; continue; }
    let n = 0;
    while (text[i + n] === "`") n++;
    let j = i + n;
    let close = -1;
    while (j < text.length) {
      if (text[j] === "`") {
        let m = 0;
        while (text[j + m] === "`") m++;
        if (m === n) { close = j; break; }
        j += m;
      } else j++;
    }
    if (close < 0) { out += text.slice(i, i + n); i += n; continue; }
    out += "CODE";
    i = close + n;
  }
  return out;
}

const tableLines = (text: string) => text.split("\n").filter((line) => line.startsWith("|"));
const unescapedPipes = (line: string) => (line.match(/(?<!\\)\|/g) || []).length;
function row(text: string, label: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith(`| **${label}** |`));
  return line?.slice(`| **${label}** |`.length, -1).trim();
}

/** Things in rendered Markdown that notify people, link, embed or hide text. */
function markup(text: string): string[] {
  const outside = outsideCode(text)
    .replace(/<!-- \/?andromity-receipts -->/g, "")
    .replace(/<\/?sub>|<br>/g, "");
  const found: string[] = [];
  for (const [name, re] of [
    ["@mention", /(^|[^\w`])@[A-Za-z0-9-]+/],
    ["issue reference", /(^|\s)#\d+/],
    ["link", /\]\(|https?:\/\/|www\./i],
    ["html tag", /<[A-Za-z!/]/],
    ["image", /!\[/],
  ] as [string, RegExp][]) if (re.test(outside)) found.push(name);
  return found;
}

// ── Files ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("change record: files", () => {
  it("Files changed with AI counts covered, partial and edited; only partial and edited are 'modified outside'", () => {
    const text = compose({
      files: [file("a.py", ["s1:0"]), file("b.py", ["s1:0"], "partial"), file("c.py", ["s1:0"], "edited"), file("d.md", [], "none")],
      turns: [turn("s1:0")],
    });
    assert.equal(row(text, "Files changed with AI"), "3 of 4");
    assert.equal(row(text, "Modified outside Andromity"), "`b.py`, `c.py`");
    assert.equal(row(text, "Not recorded by Andromity"), "`d.md`");
  });

  it("all covered: no 'Modified outside' row and 'Not recorded' says None", () => {
    const text = compose({ files: [file("a.py", ["s1:0"])], turns: [turn("s1:0")] });
    assert.equal(row(text, "Modified outside Andromity"), undefined);
    assert.equal(row(text, "Not recorded by Andromity"), "None");
  });

  it("the same path listed twice by the engine is one file, not two", () => {
    const record = build({ files: [file("a.py", ["s1:0"]), file("a.py", ["s1:0"]), file("b.py", [], "none")], turns: [turn("s1:0")] });
    assert.equal(`${record.files.withAi} of ${record.files.total}`, "1 of 2");
  });
});

// ── Checks and "No check after last change" ─────────────────────────────────────────────────────────────────────

describe("change record: checks ordering", () => {
  it("a check that ended before the file's last change doesn't count", () => {
    const record = build({
      files: [file("a.py", ["s1:1"])],
      turns: [turn("s1:0", { ended_at: T(9), checks: [check("pytest", "passed")] }), turn("s1:1", { ended_at: T(10) })],
    });
    assert.deepEqual(record.noCheckAfter, ["a.py"]);
  });

  it("a check in the same turn counts", () => {
    const record = build({ files: [file("a.py", ["s1:0"])], turns: [turn("s1:0", { checks: [check("pytest", "passed")] })] });
    assert.deepEqual(record.noCheckAfter, []);
  });

  it("a check from a later turn that changed none of the files counts; its findings, models and commands don't", () => {
    const record = build({
      files: [file("a.py", ["s1:0"])],
      turns: [turn("s1:0", { ended_at: T(10) }), turn("s1:x", { ended_at: T(8), checks: [check("ruff", "passed")] })],
      later: [turn("s1:1", { ended_at: T(11), checks: [check("pytest", "passed")], models: ["later/model"], mode: "yolo",
        needs_attention: [finding("destructive", "high", "Destructive command, approved by a person", "rm -rf /")],
        summary: { commands: 9, commands_failed: 9, web_searches: 5, subagents: 3 }, web_hosts: ["later.example"], mcp_servers: ["latermcp"],
        sealed: { hash: "x", matches: false } })],
    });
    assert.deepEqual(record.noCheckAfter, []);
    assert.ok(record.checks.some((c) => c.command === "pytest" && c.passed));
    assert.ok(!record.models.includes("later/model"));
    assert.ok(!record.modes.includes("yolo"));
    assert.equal(record.items.length, 0, JSON.stringify(record.items));
    assert.deepEqual(record.commands, { total: 0, failed: 0 });
    assert.equal(record.webSearches, 0);
    assert.equal(record.subagents, 0);
    assert.deepEqual(record.webHosts, []);
    assert.deepEqual(record.mcpServers, []);
  });

  it("across chats, by end time: a check in another chat that ended earlier doesn't cover a later change", () => {
    const record = build({
      files: [file("a.py", ["chatA:0"]), file("b.py", ["chatB:0"])],
      turns: [turn("chatA:0", { session_id: "chatA", ended_at: T(11) }), turn("chatB:0", { session_id: "chatB", ended_at: T(10), checks: [check("pytest", "passed")] })],
    });
    assert.deepEqual(record.noCheckAfter, ["a.py"]);
  });

  it("a file is judged by its newest turn, not its oldest", () => {
    const record = build({
      files: [file("a.py", ["s1:0", "s1:2"])],
      turns: [turn("s1:0", { ended_at: T(9) }), turn("s1:1", { ended_at: T(10), checks: [check("pytest", "passed")] }), turn("s1:2", { ended_at: T(11) })],
    });
    assert.deepEqual(record.noCheckAfter, ["a.py"]);
  });

  it("a turn whose end time is unknown isn't assumed to come before every check", () => {
    // The change's time can't be placed; the record must not imply a check ran after it.
    const record = build({
      files: [file("a.py", ["s1:5"])],
      turns: [turn("s1:0", { ended_at: T(9), checks: [check("pytest", "passed")] }), turn("s1:5", { ended_at: "not a date", started_at: null })],
    });
    assert.deepEqual(record.noCheckAfter, ["a.py"], "a.py's change has no known time, yet it is reported as checked afterwards");
  });

  it("a file whose newest turn couldn't be read isn't reported as checked after its last change", () => {
    // s1:2 changed a.py last but its receipt failed to load; a check at 10:00 only followed the older change.
    const record = build({
      files: [file("a.py", ["s1:0", "s1:2"])],
      turns: [turn("s1:0", { ended_at: T(9) }), turn("s1:1", { ended_at: T(10), checks: [check("pytest", "passed")] })],
      unread: 1,
    });
    assert.deepEqual(record.noCheckAfter, ["a.py"], "the unread newer change was ignored, so a.py looks checked");
  });

  it("a turn whose checks are all malformed doesn't count as a check after the change", () => {
    const record = build({
      files: [file("a.py", ["s1:1"])],
      turns: [turn("s1:0", { ended_at: T(9), checks: [check("pytest", "passed")] }), turn("s1:1", { ended_at: T(10) }),
        turn("s1:2", { ended_at: T(11), checks: [null, { command: "" }, { command: "   " }, { command: 5 }] })],
    });
    assert.deepEqual(record.noCheckAfter, ["a.py"], "a turn with only empty/invalid check entries was counted as a check");
  });

  it("no checks at all: Checks says None recorded and there is no 'No check after last change' row", () => {
    const text = compose({ files: [file("a.py", ["s1:0"])], turns: [turn("s1:0")] });
    assert.equal(row(text, "Checks"), "None recorded");
    assert.equal(row(text, "No check after last change"), undefined);
  });
});

describe("change record: check results and check_failed items", () => {
  const failed = finding("check_failed", "high", "Check still failed at the end of the turn", "pytest -q");

  it("a failed check that later passed shows passed and its check_failed item is dropped", () => {
    const record = build({
      files: [file("a.py", ["s1:0"])],
      turns: [turn("s1:0", { ended_at: T(9), checks: [check("pytest -q", "failed")], needs_attention: [failed] })],
      later: [turn("s1:1", { ended_at: T(10), checks: [check("pytest  -q", "passed")] })],
    });
    assert.equal(record.checks.length, 1);
    assert.equal(record.checks[0].passed, true);
    assert.equal(record.items.length, 0);
  });

  it("a passing check that later failed shows failed and keeps the item", () => {
    const record = build({
      files: [file("a.py", ["s1:0", "s1:1"])],
      turns: [turn("s1:0", { ended_at: T(9), checks: [check("pytest -q", "passed")] }),
        turn("s1:1", { ended_at: T(10), checks: [check("pytest -q", "failed", 2)], needs_attention: [failed] })],
    });
    assert.deepEqual(record.checks, [{ command: "pytest -q", passed: false, exitCode: 2 }]);
    assert.equal(record.items.length, 1);
  });

  it("order is by end time, not by the order turns are given", () => {
    const record = build({
      files: [file("a.py", ["s1:1", "s1:0"])],
      turns: [turn("s1:1", { ended_at: T(10), checks: [check("pytest -q", "failed")], needs_attention: [failed] }),
        turn("s1:0", { ended_at: T(9), checks: [check("pytest -q", "passed")] })],
    });
    assert.equal(record.checks[0].passed, false);
    assert.equal(record.items.length, 1);
  });

  it("another command passing doesn't hide a check that failed", () => {
    const record = build({
      files: [file("a.py", ["s1:0"])],
      turns: [turn("s1:0", { checks: [check("pytest -q", "failed"), check("pytest", "passed")], needs_attention: [failed] })],
    });
    assert.equal(record.items.length, 1);
  });

  it("a failing check is never hidden behind 'and N more' while ten older passing checks are listed", () => {
    const passing = Array.from({ length: 12 }, (_, i) => check(`check-${i}`, "passed"));
    const text = compose({
      files: [file("a.py", ["s1:0"])],
      turns: [turn("s1:0", { ended_at: T(9), checks: passing })],
      later: [turn("s1:1", { ended_at: T(10), checks: [check("pytest", "failed", 1)] })],
    });
    assert.match(row(text, "Checks") ?? "", /failed/, `the only failed check is folded into 'and N more':\n${row(text, "Checks")}`);
  });
});

// ── Items for review ────────────────────────────────────────────────────────────────────────────────────────────

describe("change record: items for review", () => {
  it("large_change, long_command and low/unknown severities are skipped", () => {
    const record = build({
      files: [file("a.py", ["s1:0"])],
      turns: [turn("s1:0", { needs_attention: [
        finding("large_change", "medium", "Large change"), finding("long_command", "high", "Very long", "x"),
        finding("sensitive", "low", "Low one", ".env"), finding("sensitive", "HIGH", "Upper", ".env"),
      ] })],
    });
    assert.equal(record.items.length, 0);
  });

  it("findings are deduped by kind + subject across turns (spec), even if the wording differs", () => {
    const record = build({
      files: [file("a.py", ["s1:0", "s1:1"])],
      turns: [
        turn("s1:0", { ended_at: T(9), needs_attention: [finding("sensitive", "high", "Read a sensitive file", ".env")] }),
        turn("s1:1", { ended_at: T(10), needs_attention: [finding("sensitive", "high", "Edited a sensitive file", ".env"), finding("sensitive", "high", "Read a sensitive file", ".env")] }),
      ],
    });
    assert.equal(record.items.length, 1, JSON.stringify(record.items));
  });

  it("capped at 15 with 'and N more'", () => {
    const many = Array.from({ length: 20 }, (_, i) => finding("sensitive", "high", "Read a sensitive file", `secret-${i}.env`));
    const text = compose({ files: [file("a.py", ["s1:0"])], turns: [turn("s1:0", { needs_attention: many })] });
    const items = row(text, "Items for review")!;
    assert.equal(items.split("<br>").length, 16);
    assert.match(items, /and 5 more/);
    assert.ok(text.indexOf("Items for review") < text.indexOf("Files changed with AI"), "items come first when there are any");
  });

  it("a high finding isn't cut while medium ones from earlier turns fill the 15", () => {
    const medium = Array.from({ length: 15 }, (_, i) => finding("outside_workspace", "medium", "Tried to read a file outside the workspace; it did not succeed", `/tmp/f${i}`));
    const text = compose({
      files: [file("a.py", ["s1:0", "s1:1"])],
      turns: [turn("s1:0", { ended_at: T(9), needs_attention: medium }),
        turn("s1:1", { ended_at: T(10), needs_attention: [finding("git_internals", "high", "Git configuration or hooks changed during this turn; they can run code on later git commands")] })],
    });
    assert.match(row(text, "Items for review") ?? "", /Git configuration or hooks changed/, "the high finding is hidden in 'and 1 more'");
  });

  it("sealed mismatches and unread receipts are items; no turn numbers or chat ids", () => {
    const text = compose({
      files: [file("a.py", ["sess-42:7"])],
      turns: [turn("sess-42:7", { session_id: "sess-42", turn_index: 7, sealed: { hash: "f".repeat(64), matches: false } })],
      unread: 2,
    });
    const items = row(text, "Items for review")!;
    assert.match(items, /differs from the copy sealed/);
    assert.match(items, /records of 2 turns could not be read/);
    assert.ok(!/sess-42|turn 8|turn 7|chat \d/i.test(text), text);
    assert.ok(!text.includes("f".repeat(16)), "the seal checksum leaked");
  });

  it("no items: the last row says None", () => {
    const text = compose({ files: [file("a.py", ["s1:0"])], turns: [turn("s1:0")] });
    const lines = tableLines(text);
    assert.equal(lines.at(-1), "| **Items for review** | None |");
  });
});

// ── Approvals, modes, commands, network, tools ──────────────────────────────────────────────────────────────────

describe("change record: approvals and counts", () => {
  it("sums approvals across turns and ignores NaN, negative, fractional, string and huge counts", () => {
    const record = build({
      files: [file("a.py", ["s1:0", "s1:1", "s1:2"])],
      turns: [
        turn("s1:0", { summary: { approved_by_person: 2, denied_by_person: 1, blocked: 1, commands: 3, commands_failed: 1, web_searches: 1, subagents: 1 } }),
        turn("s1:1", { summary: { approved_by_person: NaN, denied_by_person: -4, blocked: 1.5, commands: "7", commands_failed: Infinity, web_searches: 2 ** 60, subagents: null } }),
        turn("s1:2", { summary: null }),
      ],
    });
    assert.deepEqual(record.approvals, { approved: 2, declined: 1, blocked: 1 });
    assert.deepEqual(record.commands, { total: 3, failed: 1 });
    assert.equal(record.webSearches, 1);
    assert.equal(record.subagents, 1);
  });

  it("declined calls without a recorded person aren't summarised as 'No approvals requested'", () => {
    const text = compose({ files: [file("a.py", ["s1:0"])], turns: [turn("s1:0", { mode: "safe", summary: { denied: 2 } })] });
    assert.doesNotMatch(row(text, "Permission mode") ?? "", /No approvals requested/, "two calls were declined, yet the record says no approval was asked for");
  });

  it("more models than are listed are counted, not silently dropped", () => {
    const models = Array.from({ length: 13 }, (_, i) => `vendor/model-${i}`);
    const text = compose({ files: [file("a.py", ["s1:0"])], turns: [turn("s1:0", { models })] });
    assert.match(row(text, "Models") ?? "", /more/, `three models vanished: ${row(text, "Models")}`);
  });

  it("andromity/auto gets the gateway note; models, hosts and servers are unions in order seen", () => {
    const record = build({
      files: [file("a.py", ["s1:0", "s1:1"])],
      turns: [turn("s1:0", { ended_at: T(9), models: ["andromity/auto", "x/y"], web_hosts: ["pypi.org"], mcp_servers: ["github"] }),
        turn("s1:1", { ended_at: T(10), models: ["x/y", "z/w"], web_hosts: ["pypi.org", "docs.python.org"], mcp_servers: ["github", "jira"] })],
    });
    assert.deepEqual(record.models, ["andromity/auto", "x/y", "z/w"]);
    assert.deepEqual(record.webHosts, ["pypi.org", "docs.python.org"]);
    assert.deepEqual(record.mcpServers, ["github", "jira"]);
    assert.match(composeChangeRecord(record, 60_000), /`andromity\/auto` \(model selected per request by the Andromity gateway\)/);
  });
});

// ── Malformed receipts ──────────────────────────────────────────────────────────────────────────────────────────

describe("change record: malformed receipts never throw", () => {
  const shapes: [string, Record<string, any>][] = [
    ["null arrays", { models: null, web_hosts: null, mcp_servers: null, checks: null, needs_attention: null, approvers: null }],
    ["wrong types", { models: "m", web_hosts: {}, mcp_servers: 5, checks: "pytest", needs_attention: {}, approvers: "ada", mode: 7, sealed: "no" }],
    ["null entries", { models: [null, 5], web_hosts: [null], mcp_servers: [undefined], checks: [null, 5, "x"], needs_attention: [null, 5, "x"] }],
    ["null approver entries", { approvers: [null, 5, { id: "p1" }], needs_attention: [finding("destructive", "high", "Destructive command, approved", "rm x", "p1")] }],
    ["non-string finding fields", { checks: [check("pytest", "passed")], needs_attention: [{ kind: "check_failed", severity: "high", detail: 5, subject: 5 }, { kind: {}, severity: "high", detail: null, subject: ["a"] }] }],
    ["unparseable dates", { ended_at: "yesterday", started_at: {} }],
    ["missing summary", { summary: undefined }],
  ];
  for (const [name, over] of shapes) {
    it(name, () => {
      const r = receipt(over);
      if (name === "missing summary") delete r.summary;
      assert.doesNotThrow(() => composeChangeRecord(buildChangeRecord({ head: "zz", scope: "pull_request", files: [file("a.py", ["s1:0"])], turns: [{ key: "s1:0", receipt: r }] }), 60_000));
    });
  }
});

// ── Language ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("change record: language rules", () => {
  it("never certifies, never shows cost, line counts, tokens or checksums, says where it comes from once", () => {
    const text = compose({
      files: [file("a.py", ["s1:0"]), file("b.py", [], "none")],
      turns: [turn("s1:0", { checks: [check("pytest", "passed")], summary: { commands: 1 }, sealed: { hash: "d".repeat(64), matches: true } })],
    });
    const words = text.replace(/not verified/g, "");
    assert.ok(!/\b(verified|secure|compliant|certified|guarantee)/i.test(words), text);
    assert.ok(!/\$|12\.34|4242|1717|98765|cost|tokens|lines/i.test(text), text);
    assert.ok(!text.includes("d".repeat(16)) && !text.includes("e".repeat(16)), "a checksum leaked");
    assert.equal(text.split("Generated from Andromity session records").length - 1, 1);
    assert.ok(text.startsWith(RECORD_START) && text.endsWith(RECORD_END));
    assert.match(text, /Commit `aaaaaaa`/);
  });

  it("a non-hex head isn't shown as a commit", () => {
    const record = buildChangeRecord({ head: "`@evil` [x](http://e)", scope: "pull_request", files: [file("a.py", ["s1:0"])], turns: [turn("s1:0")] });
    const text = composeChangeRecord(record, 60_000);
    assert.ok(!text.includes("evil"));
  });
});

// ── Injection ───────────────────────────────────────────────────────────────────────────────────────────────────

const HOSTILE = [
  "a|b", "x\n| **Items for review** | None |", "``", "`", "a`b", "<br>", "-->", RECORD_END, "<details>", "<img src=x onerror=alert(1)>",
  "[click](https://evil.example)", "![i](https://evil.example/i.png)", "@octocat", "#123", "\\", "x\\|y", "‮⁦evil", "\r\n|---|---|\r\n",
  "<!--", "a".repeat(3000),
];

describe("change record: agent-controlled strings can't break or inject into the table", () => {
  for (const hostile of HOSTILE) {
    it(`value ${JSON.stringify(hostile.slice(0, 40))}`, () => {
      const record = buildChangeRecord({
        head: "b".repeat(40), scope: "pull_request",
        files: [file(`src/${hostile}.py`, ["s1:0"], "partial"), file(`docs/${hostile}`, [], "none"), file(`t/${hostile}`, ["s1:0"])],
        turns: [turn("s1:0", {
          models: [`m/${hostile}`], web_hosts: [`h${hostile}`], mcp_servers: [`s${hostile}`],
          checks: [check(`pytest ${hostile}`, "failed")],
          needs_attention: [finding("destructive", "high", "Destructive command, approved", `rm ${hostile}`, "p1")],
          approvers: [{ id: "p1", name: "Ada Tester" }],
        })],
        later: [turn("s1:1", { ended_at: T(8), checks: [check(`other ${hostile}`, "passed")] })],
      });
      const text = composeChangeRecord(record, 60_000);
      const lines = tableLines(text);
      for (const line of lines) assert.equal(unescapedPipes(line), 3, `row split into extra cells: ${line.slice(0, 300)}`);
      assert.equal(text.split(RECORD_START).length - 1, 1);
      assert.equal(lines.filter((l) => l.startsWith("| **Items for review**")).length, 1, "a second Items row");
      assert.deepEqual(markup(text), [], `markup outside code spans:\n${outsideCode(text).slice(0, 2000)}`);
      assert.ok(!/[‪-‮⁦-⁩]/.test(text), "bidi control characters reached the pull request");
    });
  }

  it("a hostile approver name can't mention, link or inject HTML", () => {
    const record = build({
      files: [file("a.py", ["s1:0"])],
      turns: [turn("s1:0", {
        approvers: [{ id: "p1", name: "@octocat [see](https://evil.example) <img src=x> #1" }],
        needs_attention: [finding("destructive", "high", "Destructive command, approved", "rm -rf build", "p1")],
      })],
    });
    const text = composeChangeRecord(record, 60_000);
    assert.deepEqual(markup(text), [], `approver name rendered as Markdown:\n${row(text, "Items for review")}`);
  });

  it("a hostile finding detail can't mention, link or inject HTML", () => {
    const record = build({
      files: [file("a.py", ["s1:0"])],
      turns: [turn("s1:0", { needs_attention: [finding("destructive", "high", "Ping @octocat, see [docs](https://evil.example) <details><summary>x</summary> fixes #12", "rm x")] })],
    });
    const text = composeChangeRecord(record, 60_000);
    assert.deepEqual(markup(text), [], `finding detail rendered as Markdown:\n${row(text, "Items for review")}`);
  });

  it("a hostile permission mode can't mention, link or inject HTML", () => {
    const record = build({ files: [file("a.py", ["s1:0"])], turns: [turn("s1:0", { mode: "@octocat <img src=x> [x](https://evil.example)" })] });
    const text = composeChangeRecord(record, 60_000);
    assert.deepEqual(markup(text), [], `mode rendered as Markdown: ${row(text, "Permission mode")}`);
  });

  it("bidi characters in a committed path (turn fallback passes git paths straight in) don't reach the pull request", () => {
    const record = buildChangeRecord({ head: "c".repeat(40), scope: "turn", files: [file("invoice‮gpj.exe", [], "none")], turns: [turn("s1:0")] });
    assert.ok(!/[‪-‮⁦-⁩]/.test(composeChangeRecord(record, 60_000)));
  });
});

// ── Size ────────────────────────────────────────────────────────────────────────────────────────────────────────

function hugeRecord(distinctModes = 1) {
  const long = (p: string, i: number) => `${p}${i}-${"z".repeat(1990)}`;
  const turns: RecordTurn[] = Array.from({ length: 60 }, (_, t) => turn(`s1:${t}`, {
    turn_index: t, ended_at: T(0, t), mode: t < distinctModes ? `mode-${t}-${"m".repeat(480)}` : "full",
    models: Array.from({ length: 50 }, (_, i) => long(`model${t}-`, i).slice(0, 600)),
    web_hosts: Array.from({ length: 100 }, (_, i) => long(`host${t}-`, i)),
    mcp_servers: Array.from({ length: 100 }, (_, i) => long(`srv${t}-`, i)),
    checks: Array.from({ length: 50 }, (_, i) => check(long(`chk${t}-`, i), i % 2 ? "passed" : "failed")),
    needs_attention: Array.from({ length: 50 }, (_, i) => finding("destructive", "high", "D".repeat(400), long(`cmd${t}-`, i), "p1")),
    approvers: [{ id: "p1", name: "N".repeat(400) }],
    summary: { commands: 2 ** 40, approved_by_person: 2 ** 40 },
  }));
  const files = Array.from({ length: 3000 }, (_, i) => file(long("f", i).slice(0, 1000), i % 3 ? [`s1:${i % 60}`] : [], (["covered", "partial", "edited", "none"] as const)[i % 4]));
  return buildChangeRecord({ head: "d".repeat(40), scope: "pull_request", files, turns, unread: 5, truncated: true, notes: ["N".repeat(500)] });
}

describe("change record: size", () => {
  for (const budget of [GITHUB_BODY_LIMIT - 512, 20_000, 4_190, 2_000]) {
    it(`a huge record fits a ${budget}-character budget`, () => {
      const text = composeChangeRecord(hugeRecord(), budget);
      assert.ok(text.length <= budget, `${text.length} > ${budget}`);
      assert.ok(text.startsWith(RECORD_START) && text.endsWith(RECORD_END));
    });
  }

  it("never returns more than the budget, even a tiny one", () => {
    for (const budget of [0, 50, 120]) {
      const text = composeChangeRecord(hugeRecord(), budget);
      assert.ok(text.length <= budget, `budget ${budget}: returned ${text.length} characters`);
    }
  });

  it("with the longest description the form accepts there's still room for more than 'too long'", () => {
    // 60,000-character description leaves ~4,190 characters for the record; a normal record should fit.
    const text = compose({
      files: Array.from({ length: 40 }, (_, i) => file(`src/module_${i}/file_${i}.py`, ["s1:0"])),
      turns: [turn("s1:0", { checks: [check("pytest -q", "passed")], summary: { commands: 4 } })],
    }, 4_190);
    assert.match(text, /Files changed with AI/);
  });

  it("many distinct permission modes don't push out the whole record", () => {
    const text = composeChangeRecord(hugeRecord(60), 20_000);
    assert.match(text, /Files changed with AI/, "60 long mode strings made the record collapse to 'too long'");
  });

  it("when lists are shortened to fit, no cell is left blank", () => {
    const record = build({
      files: [file("a.py", ["s1:0"])],
      turns: [turn("s1:0", {
        models: ["vendor/model-a", "vendor/model-b"],
        checks: [check("pytest", "passed")],
        needs_attention: Array.from({ length: 15 }, (_, i) => finding("sensitive", "high", "S".repeat(290), `secret-${i}-${"q".repeat(190)}`)),
      })],
    });
    const text = composeChangeRecord(record, 2_200);
    assert.match(text, /Files changed with AI/, "precondition: the table is still shown");
    for (const line of tableLines(text).slice(2)) assert.doesNotMatch(line, /\|\s+\|$/, `blank cell: ${line}`);
    assert.doesNotMatch(row(text, "Checks") ?? "", /^<br>/, "the Checks cell starts with a line break");
  });
});
