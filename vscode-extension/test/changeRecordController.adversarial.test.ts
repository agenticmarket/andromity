// Independent adversarial tests for the AI change record in the controller: recordSection (pr.provenance + every
// turn's receipt + later turns for checks), the one-turn fallback (bodyFor), the update comment and the clipboard.
// Real temporary git repository; GitHub is a fake behind a patched global fetch; the engine is a fake rpc.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { installVscodeStub, resetState, state } from "./helpers/prVscodeStub.js";
import { FakeGitHub } from "./helpers/prFakes.js";
import { CliApiRepository, makeSandbox, gitOk, type Sandbox } from "./helpers/prRealGit.js";
import { GITHUB_BODY_LIMIT, closeOpenBlocks } from "../src/integrations/pullRequest/body.js";
import { RECORD_START, RECORD_END } from "../src/integrations/pullRequest/changeRecord.js";

installVscodeStub();
const { PullRequestController } = require("../src/panels/pullRequestController.js") as typeof import("../src/panels/pullRequestController.js");

let api = new FakeGitHub("test", "orders");
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input);
  if (new URL(url).origin !== "https://api.github.com") throw new Error(`blocked fetch to ${url}`);
  return api.fetch(url, init) as any;
}) as typeof fetch;
process.on("exit", () => { globalThis.fetch = originalFetch; });

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

const TOKEN = "gho_change_record_test_token_ABCDEFGHIJ";
const T = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 10, h, m)).toISOString();

function receipt(sessionId: string, turnIndex: number, over: Record<string, any> = {}): any {
  const { summary, ...rest } = over;
  return {
    version: 1, session_id: sessionId, turn_index: turnIndex, started_at: null, ended_at: T(10, turnIndex), duration_seconds: null, models: ["m/base"], mode: "full",
    snapshot: {}, files_changed: [{ path: "orders/totals.py", status: "M", added: 1, deleted: 1, via: "edit" }],
    edited_not_in_snapshot: [], files_read: [], commands: [], checks: [], web_hosts: [], mcp_servers: [], other_tools: {},
    needs_attention: [], approvers: [], cost_usd: null, tokens: null, notes: [], record_hash: "e".repeat(64),
    summary: { files_changed: 1, lines_added: 1, lines_deleted: 1, files_read: 0, searches: 0, commands: 0, commands_failed: 0,
      blocked: 0, denied: 0, approved_by_person: 0, denied_by_person: 0, subagents: 0, web_searches: 0, ...(summary ?? {}) },
    ...rest,
  };
}

type ReceiptAnswer = (sessionId: string, turnIndex: number) => unknown;
const defaultAnswer: ReceiptAnswer = (s, i) => (s === "s1" && i === 0 ? { success: true, receipt: receipt("s1", 0), turns: [0] } : { success: false, error: "No receipt" });

async function harness(opts: { provenance: ((params: any) => unknown) | "unsupported"; receipts?: ReceiptAnswer; branch?: string }) {
  resetState();
  api = new FakeGitHub("test", "orders");
  const sb: Sandbox = makeSandbox("orders");
  cleanups.push(() => sb.cleanup());
  if (opts.branch) {
    gitOk(sb.work, sb.env, ["checkout", "-q", "-b", opts.branch]);
    gitOk(sb.work, sb.env, ["push", "-q", "-u", "origin", opts.branch]);
  }
  fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "def total(x):\n    return round(x, 2)\n");
  const files = [{ path: "orders/totals.py", status: "M" as const, additions: 1, deletions: 1 }];
  const repo = new CliApiRepository(sb.work, sb.env);
  await repo.status();
  const exportsApi = { enabled: true, getAPI: () => ({ repositories: [repo] }) };
  state.gitExtension = { isActive: true, exports: exportsApi, activate: async () => exportsApi };
  state.session = { accessToken: TOKEN, account: { label: "ada", id: "1" }, scopes: ["repo"] };
  const rpcCalls: { method: string; params: any }[] = [];
  const answer = opts.receipts ?? defaultAnswer;
  const rpc = {
    call: async (method: string, params: any) => {
      rpcCalls.push({ method, params });
      if (method === "session.receipt") {
        const index = params.turn_index === undefined ? 0 : Number(params.turn_index);
        const result = answer(params.session_id, index);
        if (result instanceof Error) throw result;
        return result && (result as any).success === true ? { markdown: `### receipt ${index}`, text: "", ...(result as any) } : result;
      }
      if (method === "pr.provenance") {
        if (opts.provenance === "unsupported") throw new Error("Method not found: pr.provenance");
        return opts.provenance(params);
      }
      if (method === "agent.quickPrompt") return "<commit_message>fix(orders): round totals to cents</commit_message>\n<pr_description>Rounds order totals.</pr_description>";
      if (method === "git.file_diff") return { diff: gitOk(sb.work, sb.env, ["diff", "--no-ext-diff", "HEAD", "--", params.path]) };
      if (method === "telemetry.recordFeature") return {};
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  const posts: any[] = [];
  const host = {
    post: (m: unknown) => posts.push(JSON.parse(JSON.stringify(m))),
    rpc: () => rpc as any,
    repositoryRoot: () => sb.work,
    projectPath: () => sb.work,
    files: () => files,
    turnFiles: () => ["orders/totals.py"],
    turn: () => ({ sessionId: "s1", turnIndex: 0 }),
    scope: () => "turn" as const,
    agentRunning: () => false,
    refresh: async () => {},
    log: () => {},
  };
  const ctrl = new PullRequestController(host);
  cleanups.push(() => ctrl.dispose());
  return { sb, ctrl, posts, rpcCalls };
}
type H = Awaited<ReturnType<typeof harness>>;

const lastView = (posts: any[]) => posts.filter((m) => m.type === "pr_view").map((m) => m.view).at(-1);

async function waitFor(pred: () => boolean, what: string, ms = 150_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function openReady(h: H) {
  await h.ctrl.handle({ type: "pr_open" });
  await waitFor(() => lastView(h.posts)?.phase === "form", "the form");
  await waitFor(() => lastView(h.posts)?.form?.receipt?.available === true, "the receipt: " + JSON.stringify({ receipt: lastView(h.posts)?.form?.receipt, rpc: h.rpcCalls.slice(0, 5) }).slice(0, 1500));
  await waitFor(() => !lastView(h.posts).form.drafting && !!(h.ctrl as any).form.commitMessage, "the draft");
  await new Promise((r) => setTimeout(r, 300));
}

async function submit(h: H) {
  await waitFor(() => lastView(h.posts)?.form?.sizeLine?.text !== "Counting lines…", "the file checks");
  const checks = lastView(h.posts)?.form?.checks;
  if (checks?.key) await h.ctrl.handle({ type: "pr_update", changes: { ack: checks.key } });
  await waitFor(() => lastView(h.posts)?.form?.primary?.enabled === true, "the button: " + JSON.stringify(lastView(h.posts)?.form?.disabledReason ?? null));
  await h.ctrl.handle({ type: "pr_submit", action: "primary" });
  await waitFor(() => lastView(h.posts)?.phase === "done" || lastView(h.posts)?.phase === "failed", "the run");
}

const createdBody = () => api.calls.find((c) => c.method === "POST" && /\/repos\/test\/orders\/pulls$/.test(c.path))?.body?.body as string | undefined;
const turnRef = (session_id: string, turn_index: number) => ({ session_id, turn_index });
function provenance(rows: { path: string; coverage: string; turns: any[] }[]) {
  return { success: true, head: "b".repeat(40), base: "c".repeat(40), truncated: false, files: rows.map((r) => ({ old_path: null, additions: 1, deletions: 1, binary: false, ...r })) };
}
const receiptCalls = (h: H) => h.rpcCalls.filter((c) => c.method === "session.receipt").map((c) => ({ s: c.params.session_id, i: c.params.turn_index }));

describe("controller record: receipts that fail", { timeout: 180_000 }, () => {
  it("receipts that throw, fail or are malformed are counted as unreadable; the record is still published", async () => {
    const h = await harness({
      provenance: () => provenance([
        { path: "orders/totals.py", coverage: "covered", turns: [turnRef("s1", 0), turnRef("s1", 1)] },
        { path: "notes.txt", coverage: "covered", turns: [turnRef("s2", 0), turnRef("s3", 4)] },
      ]),
      receipts: (s, i) => {
        if (s === "s1" && i === 0) return { success: true, receipt: receipt("s1", 0), turns: [0] };
        if (s === "s1" && i === 1) return new Error("engine crashed");
        if (s === "s2") return { success: false, error: "gone" };
        if (s === "s3" && i === 4) return { success: true, receipt: { ...receipt("s3", 4), approvers: [null] } };
        return { success: false };
      },
    });
    await openReady(h);
    await submit(h);
    const body = createdBody();
    assert.ok(body, "no pull request created");
    assert.match(body!, /records of 3 turns could not be read/);
    assert.ok(body!.length <= GITHUB_BODY_LIMIT);
  });

  it("an answer for a different session or turn than asked is never used, for PR turns or later turns", async () => {
    const wrong = (s: string, i: number) => ({ success: true, receipt: receipt(s, i, { models: ["WRONG/model"], checks: [{ command: "WRONG-CHECK", result: "passed", exit_code: 0, failed_first: false, runs: 1 }] }), turns: [i] });
    const h = await harness({
      provenance: () => provenance([{ path: "orders/totals.py", coverage: "covered", turns: [turnRef("s1", 0), turnRef("s2", 3)] }]),
      receipts: (s, i) => {
        if (s === "s1" && i === 0) return { success: true, receipt: receipt("s1", 0), turns: [0] };
        if (s === "s2" && i === 3) return wrong("s9", 3); // other session
        if (s === "s1" && i === 1) return wrong("s1", 7); // other turn
        if (s === "s2" && i === 4) return wrong("s2", 3); // the PR turn again
        return { success: false };
      },
    });
    await openReady(h);
    await submit(h);
    const body = createdBody()!;
    assert.ok(!/WRONG/.test(body), body);
    assert.match(body, /records of 1 turn could not be read/);
  });
});

describe("controller record: later turns for checks", { timeout: 180_000 }, () => {
  it("looks at no more than 3 later turns per chat, stops at the first missing one, and uses their checks", async () => {
    const h = await harness({
      provenance: () => provenance([{ path: "orders/totals.py", coverage: "covered", turns: [turnRef("s1", 0), turnRef("s2", 5)] }]),
      receipts: (s, i) => {
        if (s === "s1") return { success: true, receipt: receipt("s1", i, { ended_at: T(11, i), checks: i === 3 ? [{ command: "pytest -q", result: "passed", exit_code: 0, failed_first: false, runs: 1 }] : [] }), turns: [i] };
        if (s === "s2" && i === 5) return { success: true, receipt: receipt("s2", 5, { ended_at: T(10) }), turns: [5] };
        if (s === "s2" && i === 7) return { success: true, receipt: receipt("s2", 7, { ended_at: T(12), checks: [{ command: "SKIPPED-GAP", result: "passed", exit_code: 0, failed_first: false, runs: 1 }] }), turns: [7] };
        return { success: false };
      },
    });
    await openReady(h);
    await submit(h);
    const body = createdBody()!;
    const s1Later = receiptCalls(h).filter((c) => c.s === "s1" && c.i > 0).map((c) => c.i);
    assert.deepEqual([...new Set(s1Later)], [1, 2, 3], `asked for s1 turns ${s1Later}`);
    const s2Later = receiptCalls(h).filter((c) => c.s === "s2" && c.i > 5).map((c) => c.i);
    assert.deepEqual([...new Set(s2Later)], [6], "kept looking past a missing turn");
    assert.match(body, /`pytest -q` passed/);
    assert.ok(!body.includes("SKIPPED-GAP"));
    assert.ok(!/No check after last change/.test(body), "the check in a later turn was ignored");
  });
});

describe("controller record: later turns beyond the tenth chat", { timeout: 180_000 }, () => {
  it("a file from an 11th chat isn't listed under 'No check after last change' when that chat's next turn ran a check", async () => {
    const chats = Array.from({ length: 11 }, (_, i) => `c${i}`);
    const pass = { command: "pytest -q", result: "passed", exit_code: 0, failed_first: false, runs: 1 };
    const h = await harness({
      provenance: () => provenance([
        { path: "orders/totals.py", coverage: "covered", turns: [turnRef("s1", 0), ...chats.slice(0, 10).map((c) => turnRef(c, 0))] },
        { path: "notes.txt", coverage: "covered", turns: [turnRef("c10", 0)] },
      ]),
      receipts: (s, i) => {
        if (s === "s1" && i === 0) return { success: true, receipt: receipt("s1", 0, { ended_at: T(9), checks: [pass] }), turns: [0] };
        if (chats.includes(s) && i === 0) return { success: true, receipt: receipt(s, 0, { ended_at: s === "c10" ? T(10) : T(8) }), turns: [0] };
        if (s === "c10" && i === 1) return { success: true, receipt: receipt("c10", 1, { ended_at: T(12), checks: [pass] }), turns: [1] };
        return { success: false };
      },
    });
    await openReady(h);
    await submit(h);
    const body = createdBody()!;
    assert.ok(!/No check after last change/.test(body), `a check ran after notes.txt's change in c10, but the record says none did:\n${body.split("\n").find((l) => l.includes("No check after")) ?? ""}`);
  });
});

describe("controller record: hostile ids from pr.provenance", { timeout: 180_000 }, () => {
  it("bad session ids or turn indexes never reach session.receipt", async () => {
    const bad = [turnRef("../../etc", 0), turnRef("a:b", 1), turnRef("a b", 0), turnRef("", 0), turnRef("s1", -1), turnRef("s1", 1.5),
      { session_id: "s1", turn_index: "2" }, { session_id: { toString: () => "s1" }, turn_index: 0 }, null, 5, turnRef("x".repeat(200), 0), turnRef("s1\u0000", 0)];
    const h = await harness({ provenance: () => provenance([{ path: "orders/totals.py", coverage: "covered", turns: [turnRef("s1", 0), ...bad] }]) });
    await openReady(h);
    await submit(h);
    for (const c of receiptCalls(h)) {
      assert.match(String(c.s), /^[A-Za-z0-9_-]{1,128}$/, `session.receipt asked with ${JSON.stringify(c)}`);
      assert.ok(c.i === undefined || (Number.isSafeInteger(c.i) && c.i >= 0), JSON.stringify(c));
    }
    assert.ok(createdBody()!.includes(RECORD_START));
  });

  it("more than 60 turns: no more than 60 PR receipts are read and the record says the rest aren't included", async () => {
    const turns = Array.from({ length: 65 }, (_, i) => turnRef("s1", i));
    const h = await harness({
      provenance: () => provenance([{ path: "orders/totals.py", coverage: "covered", turns }]),
      receipts: (s, i) => (s === "s1" ? { success: true, receipt: receipt("s1", i), turns: [i] } : { success: false }),
    });
    await openReady(h);
    await submit(h);
    const asked = new Set(receiptCalls(h).filter((c) => c.s === "s1" && c.i !== undefined && c.i < 65).map((c) => c.i));
    assert.ok(asked.size <= 61, `read ${asked.size} PR receipts`); // 60 + the form's own turn 0
    const body = createdBody()!;
    assert.match(body, /5 turns/, "the 5 turns over the cap aren't mentioned");
    assert.doesNotMatch(body, /could not be read/, "turns that were never asked for are reported as unreadable");
  });
});

describe("controller record: the one-turn fallback body", { timeout: 180_000 }, () => {
  it("the description is shortened without leaving a <details> it opened unclosed around the record", async () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({ kind: "outside_workspace", severity: "medium", detail: "Tried to read a file outside the workspace; it did not succeed " + "x".repeat(250), subject: `/tmp/${i}/${"p".repeat(1900)}` }));
    const h = await harness({
      provenance: "unsupported",
      receipts: (s, i) => (s === "s1" && i === 0 ? { success: true, receipt: receipt("s1", 0, { needs_attention: findings, web_hosts: Array.from({ length: 10 }, (_, k) => `h${k}-${"w".repeat(400)}`), mcp_servers: Array.from({ length: 10 }, (_, k) => `m${k}-${"v".repeat(400)}`) }), turns: [0] } : { success: false }),
    });
    await openReady(h);
    const description = "<details><summary>Notes</summary>\n\n" + "Plain words. ".repeat(4600) + "\n";
    await h.ctrl.handle({ type: "pr_update", changes: { description } });
    await submit(h);
    const body = createdBody();
    assert.ok(body, "no pull request created");
    assert.ok(body!.length <= GITHUB_BODY_LIMIT, `${body!.length}`);
    const at = body!.indexOf(RECORD_START);
    assert.ok(at > 0, "no record");
    const before = body!.slice(0, at);
    assert.equal(closeOpenBlocks(before.trimEnd()), before.trimEnd(), "the record sits inside the description's open <details>, collapsed and hidden");
  });

  it("host page (signed out, Push and open GitHub): the copied text holds the whole record and stays under the limit", async () => {
    const h = await harness({ provenance: "unsupported" });
    state.session = null as any;
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { description: "y".repeat(60_000) } });
    await h.ctrl.handle({ type: "pr_submit", action: "push_open_page" });
    await waitFor(() => lastView(h.posts)?.phase === "done" || lastView(h.posts)?.phase === "failed", "the run");
    assert.equal(lastView(h.posts).phase, "done", JSON.stringify(lastView(h.posts)).slice(0, 1000));
    const text = state.clipboard.find((t: string) => t.includes(RECORD_START)) ?? "";
    assert.ok(text.includes(RECORD_END), "the record was not copied whole");
    const body = text.slice(text.indexOf("\n\n") + 2);
    assert.ok(body.length <= GITHUB_BODY_LIMIT, `${body.length}`);
  });
});

describe("controller record: update mode comment", { timeout: 180_000 }, () => {
  it("updating an open pull request posts the whole-PR record as a comment, within the limit", async () => {
    const h = await harness({
      branch: "feature/round",
      provenance: () => provenance([{ path: "orders/totals.py", coverage: "partial", turns: [turnRef("s1", 0)] }]),
    });
    api.routes["GET /repos/test/orders/pulls"] = { status: 200, body: [{ number: 12, html_url: "https://github.com/test/orders/pull/12", title: "Round", state: "open", head: { ref: "feature/round", repo: { owner: { login: "test" } } } }] };
    await openReady(h);
    const view = lastView(h.posts);
    if (view?.form?.update?.number !== 12) {
      assert.fail(`not in update mode: ${JSON.stringify(view?.form?.update ?? null)} primary=${JSON.stringify(view?.primary ?? view?.form?.primaryLabel ?? null)}`);
    }
    await submit(h);
    const comment = api.calls.find((c) => c.method === "POST" && c.path === "/repos/test/orders/issues/12/comments");
    assert.ok(comment, `no comment; calls: ${api.calls.map((c) => c.method + " " + c.path).join(", ")}`);
    const text = comment.body.body as string;
    assert.ok(text.length <= GITHUB_BODY_LIMIT);
    assert.match(text, /AI change record/);
    assert.match(text, /Modified outside Andromity/, "the comment isn't the whole-PR record");
    assert.match(text, /Commit `[0-9a-f]{7}`/, "the comment has no commit id");
    assert.ok(!api.calls.some((c) => c.method === "PATCH" && /\/pulls\/12$/.test(c.path) && /andromity-receipts/.test(JSON.stringify(c.body))), "the earlier description was rewritten");
  });
});
