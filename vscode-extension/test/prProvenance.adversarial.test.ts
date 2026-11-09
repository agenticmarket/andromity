// Independent adversarial tests for multi-turn receipts in a pull request: composeProvenance (body.ts), the
// controller's receiptsSection/publishedBody/commentFor, the flow's "a pull request already exists" path, GraphQL
// errors (github.ts), and the review hand-off (_claimPendingExternal, startExternalTask's folder).
// The controller runs against a real temporary git repository; GitHub is a fake behind a patched global fetch.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { installVscodeStub, resetState, state } from "./helpers/prVscodeStub.js";
import { FakeGitHub } from "./helpers/prFakes.js";
import { CliApiRepository, makeSandbox, gitOk, type Sandbox } from "./helpers/prRealGit.js";
import { GITHUB_BODY_LIMIT } from "../src/integrations/pullRequest/body.js";
import { RECORD_START as PROVENANCE_START } from "../src/integrations/pullRequest/changeRecord.js";
import { GitHubClient, GitHubError } from "../src/integrations/pullRequest/github.js";

const vscodeStub: any = installVscodeStub();
const { PullRequestController } = require("../src/panels/pullRequestController.js") as typeof import("../src/panels/pullRequestController.js");
const { ChatViewProvider } = require("../src/providers/ChatViewProvider.js");

// ── GraphQL errors ──────────────────────────────────────────────────────────────────────────────────────────────

function graphqlClient(body: unknown) {
  return new GitHubClient("t", async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }));
}

describe("graphql(): nested errors", () => {
  it("partial search results come back when only some items failed", async () => {
    const data = await graphqlClient({ data: { search: { nodes: [{ number: 1 }, null] } }, errors: [{ type: "FORBIDDEN", path: ["search", "nodes", 1], message: "no" }] })
      .graphql("q", {});
    assert.ok(data.search);
  });

  it("a SAML or rate-limit error is still reported when GitHub puts it on a nested field", async () => {
    const saml = graphqlClient({ data: { repository: { pullRequest: null } },
      errors: [{ type: "FORBIDDEN", path: ["repository", "pullRequest"], message: "Resource protected by organization SAML enforcement. You must grant your OAuth token access." }] });
    await assert.rejects(saml.graphql("q", {}), (e: unknown) => e instanceof GitHubError && (e as any).kind === "sso");
  });

  it("the pull request asked for not existing is GitHub's NOT_FOUND, not an empty answer", async () => {
    const missing = graphqlClient({ data: { repository: { pullRequest: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 9." }] });
    await assert.rejects(missing.graphql("q", {}), (e: unknown) => e instanceof GitHubError);
  });

  it("a top-level error still fails", async () => {
    await assert.rejects(graphqlClient({ data: null, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "x" }] }).graphql("q", {}));
  });
});

// ── hand-off ────────────────────────────────────────────────────────────────────────────────────────────────────

function provider() {
  const p: any = Object.create(ChatViewProvider.prototype);
  p._pendingExternal = new Map();
  p._reviewSessions = new Map();
  p._sessionNames = new Map();
  return p;
}
const EXT = { source: "github:acme/orders#7", text: "PR text" };

describe("hand-off: claim, confirm, release", () => {
  it("a released claim can be claimed again; a confirmed one can't, and a second claim of the same prompt finds nothing", () => {
    const p = provider();
    p._pendingExternal.set("s", [{ prompt: "Review #7", external: EXT, target: { owner: "acme", repo: "orders", number: 7, title: "t" } }]);
    const first = p._claimPendingExternal("Review #7", "s");
    assert.ok(first);
    assert.equal(p._claimPendingExternal("Review #7", "s"), null, "double submit took the GitHub text twice");
    first.release();
    const again = p._claimPendingExternal("Review #7", "s");
    assert.ok(again, "reject then resubmit lost the GitHub text");
    again.confirm();
    again.release();
    assert.equal(p._claimPendingExternal("Review #7", "s"), null, "release after confirm put it back");
    assert.ok(p._reviewSessions.get("s"), "the review target is kept once the engine accepts");
  });

  it("busy: released under the re-queued prompt text, found when that text is sent again", () => {
    const p = provider();
    p._pendingExternal.set("s", [{ prompt: "Review #7", external: EXT, target: null }]);
    const claim = p._claimPendingExternal("Review #7", "s");
    claim.release("Review #7\n\n[Editor: a.py:10]");
    assert.equal(p._claimPendingExternal("Review #7", "s"), null);
    assert.ok(p._claimPendingExternal("Review #7\n\n[Editor: a.py:10]", "s"));
  });

  it("a claim for another chat or another prompt finds nothing", () => {
    const p = provider();
    p._pendingExternal.set("s", [{ prompt: "Review #7", external: EXT, target: null }]);
    assert.equal(p._claimPendingExternal("Review #7", "other"), null);
    assert.equal(p._claimPendingExternal("review #7", "s"), null);
    assert.equal(p._claimPendingExternal("Review #7", undefined), null);
  });
});

describe("hand-off: the chat's folder", () => {
  async function created(folders: string[], projectPath: string | undefined) {
    const p = provider();
    const calls: any[] = [];
    p._rpcClient = { call: async (method: string, params: any) => { calls.push({ method, params }); return method === "session.create" ? { id: "new", name: "x" } : {}; } };
    p.fetchAndPostSessions = async () => {};
    p.sendPromptFromExternal = async () => {};
    vscodeStub.workspace.workspaceFolders = folders.map((f) => ({ uri: { fsPath: f } }));
    await p.reviewHost().startExternalTask("Review #7", EXT, "Review PR #7", null, projectPath);
    return calls.find((c) => c.method === "session.create").params.project_path;
  }
  const A = path.resolve("/ws/alpha");
  const B = path.resolve("/ws/beta");

  it("a repository inside the second root is used; one outside every root falls back to the first", async () => {
    assert.equal(await created([A, B], path.join(B, "repo")), path.join(B, "repo"));
    assert.equal(await created([A, B], path.resolve("/elsewhere/repo")), A);
    assert.equal(await created([A, B], path.resolve("/ws/alpha-other")), A);
    assert.equal(await created([A, B], undefined), A);
  });

  it("a folder whose name starts with two dots inside the workspace is inside it", async () => {
    assert.equal(await created([A], path.join(A, "..cache-repo")), path.join(A, "..cache-repo"));
  });
});

// ── controller: receipts in the pushed pull request ─────────────────────────────────────────────────────────────

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

const TOKEN = "gho_provenance_test_token_ABCDEFGHIJKLMNOP";

function receiptFor(turnFiles: string[], turnIndex = 0) {
  return {
    version: 1, session_id: "s1", turn_index: turnIndex, started_at: null, ended_at: null, duration_seconds: null, models: ["m"], mode: null,
    snapshot: {}, files_changed: turnFiles.map((p) => ({ path: p, status: "M", added: 1, deleted: 1, via: "edit" })),
    edited_not_in_snapshot: [], files_read: [], commands: [], checks: [], web_hosts: [], mcp_servers: [], other_tools: {},
    needs_attention: [], approvers: [], cost_usd: null, tokens: null, notes: [], record_hash: "e".repeat(64),
    summary: { files_changed: turnFiles.length, lines_added: 1, lines_deleted: 1, files_read: 0, searches: 0, commands: 0, commands_failed: 0,
      blocked: 0, denied: 0, approved_by_person: 0, denied_by_person: 0, subagents: 0, web_searches: 0 },
  };
}

/** provenance: a function answering pr.provenance, or "unsupported" for an older engine (unknown method). */
async function harness(provenance: ((params: any) => unknown) | "unsupported") {
  resetState();
  api = new FakeGitHub("test", "orders");
  const sb: Sandbox = makeSandbox("orders");
  cleanups.push(() => sb.cleanup());
  fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "def total(x):\n    return round(x, 2)\n");
  const files = [{ path: "orders/totals.py", status: "M" as const, additions: 1, deletions: 1 }];
  const repo = new CliApiRepository(sb.work, sb.env);
  await repo.status();
  const exportsApi = { enabled: true, getAPI: () => ({ repositories: [repo] }) };
  state.gitExtension = { isActive: true, exports: exportsApi, activate: async () => exportsApi };
  state.session = { accessToken: TOKEN, account: { label: "ada", id: "1" }, scopes: ["repo"] };
  const rpcCalls: { method: string; params: any }[] = [];
  const rpc = {
    call: async (method: string, params: any) => {
      rpcCalls.push({ method, params });
      if (method === "session.receipt") {
        const index = params.turn_index === undefined ? 0 : Number(params.turn_index);
        return { success: true, receipt: receiptFor(["orders/totals.py"], index), markdown: `### Andromity receipt for turn ${index + 1}`, text: "", turns: [index] };
      }
      if (method === "pr.provenance") {
        if (provenance === "unsupported") throw new Error("Method not found: pr.provenance");
        return provenance(params);
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

const lastView = (posts: any[]) => posts.filter((m) => m.type === "pr_view").map((m) => m.view).at(-1);

async function waitFor(pred: () => boolean, what: string, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function openReady(h: Awaited<ReturnType<typeof harness>>) {
  await h.ctrl.handle({ type: "pr_open" });
  await waitFor(() => lastView(h.posts)?.phase === "form", "the form");
  await waitFor(() => lastView(h.posts)?.form?.receipt?.available === true, "the receipt");
  await waitFor(() => !lastView(h.posts).form.drafting && !!(h.ctrl as any).form.commitMessage, "the draft: " + JSON.stringify({ rpc: h.rpcCalls.map((c) => c.method), form: (h.ctrl as any).form }).slice(0, 1500));
  await new Promise((r) => setTimeout(r, 300));
}

function provenanceAnswer(rows: any[], extra: Record<string, unknown> = {}) {
  return {
    success: true, head: "b".repeat(40), base: "c".repeat(40), truncated: false,
    files: rows, totals: { files: rows.length, covered: rows.filter((r) => r.coverage === "covered").length, partial: 0, edited: 0 },
    turns: [{ session_id: "s1", turn_index: 0 }], ...extra,
  };
}

const someoneElsesPull = { number: 77, html_url: "https://github.com/test/orders/pull/77", title: "Someone else's" };

describe("controller: receipts when the pull request already exists at create time", { timeout: 120_000 }, () => {
  it("an older engine without pr.provenance: the turn's receipt is still added as a comment", async () => {
    const h = await harness("unsupported");
    await openReady(h);
    api.routes["GET /repos/test/orders/pulls"] = { status: 200, body: [someoneElsesPull] };
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    await waitFor(() => lastView(h.posts)?.phase === "done" || lastView(h.posts)?.phase === "failed", "the run");
    assert.ok(!api.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls")), "no second pull request");
    const comments = api.calls.filter((c) => c.method === "POST" && c.path === "/repos/test/orders/issues/77/comments");
    assert.equal(comments.length, 1, "the receipt was dropped: nothing was added to the existing pull request");
    assert.match(comments[0].body.body, /AI change record/);
    assert.match(comments[0].body.body, /Only the turn this pull request was created from was matched/);
  });

  it("the description the user wrote isn't silently dropped", async () => {
    const h = await harness(() => provenanceAnswer([{ path: "orders/totals.py", old_path: null, additions: 1, deletions: 1, binary: false, coverage: "covered", turns: [{ session_id: "s1", turn_index: 0 }] }]));
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { description: "Rounds order totals. UNIQUE-DESCRIPTION-MARKER" } });
    api.routes["GET /repos/test/orders/pulls"] = { status: 200, body: [someoneElsesPull] };
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    await waitFor(() => lastView(h.posts)?.phase === "done" || lastView(h.posts)?.phase === "failed", "the run");
    const comments = api.calls.filter((c) => c.method === "POST" && c.path === "/repos/test/orders/issues/77/comments");
    assert.equal(comments.length, 1);
    assert.ok(comments[0].body.body.includes(PROVENANCE_START), "the receipts section was posted");
    const everything = JSON.stringify({ calls: api.calls, view: lastView(h.posts) });
    assert.ok(everything.includes("UNIQUE-DESCRIPTION-MARKER") || /already (had|has|existed|open)/i.test(JSON.stringify(lastView(h.posts))),
      "the description went nowhere and the done view doesn't say the pull request already existed");
  });
});

describe("controller: a receipts comment that GitHub refuses", { timeout: 120_000 }, () => {
  it("is reported to the user instead of a plain success", async () => {
    const h = await harness(() => provenanceAnswer([{ path: "orders/totals.py", old_path: null, additions: 1, deletions: 1, binary: false, coverage: "covered", turns: [{ session_id: "s1", turn_index: 0 }] }]));
    await openReady(h);
    api.routes["GET /repos/test/orders/pulls"] = { status: 200, body: [someoneElsesPull] };
    api.routes["POST /repos/test/orders/issues/77/comments"] = { status: 422, body: { message: "Body is too long" } };
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    await waitFor(() => lastView(h.posts)?.phase === "done" || lastView(h.posts)?.phase === "failed", "the run");
    assert.ok(api.calls.some((c) => c.method === "POST" && c.path === "/repos/test/orders/issues/77/comments"), "the comment was tried");
    const shown = JSON.stringify({ view: lastView(h.posts), warnings: state.warnings, infos: state.infos });
    assert.match(shown, /receipt|AI change record/i, "nothing tells the user the receipts never reached the pull request");
    assert.ok(/couldn.t|could not|failed|wasn.t|not added/i.test(shown), shown.slice(0, 2000));
  });
});

describe("controller: the published body", { timeout: 120_000 }, () => {
  it("a long description and a long file list never exceed GitHub's limit", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ path: `${"pkg/sub/".repeat(60)}file_${i}.ts`, old_path: null, additions: 2, deletions: 1, binary: false,
      coverage: "covered", turns: [{ session_id: "s1", turn_index: 0 }] }));
    const h = await harness(() => provenanceAnswer(rows));
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { description: "Long description line.\n".repeat(1500) } });
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    await waitFor(() => lastView(h.posts)?.phase === "done" || lastView(h.posts)?.phase === "failed", "the run");
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
    assert.ok(create, "a pull request was created");
    assert.ok(create.body.body.length <= GITHUB_BODY_LIMIT, `body is ${create.body.body.length} chars; GitHub answers 422 above ${GITHUB_BODY_LIMIT}`);
  });

  it("pr.provenance failing falls back to the single receipt", async () => {
    const h = await harness(() => ({ success: false, error: "The base branch isn't known here" }));
    await openReady(h);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    await waitFor(() => lastView(h.posts)?.phase === "done" || lastView(h.posts)?.phase === "failed", "the run");
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.match(create.body.body, /AI change record/);
    assert.match(create.body.body, /Only the turn this pull request was created from was matched/);
  });

  it("asks the engine about the base branch on the remote it pushes to", async () => {
    const h = await harness(() => provenanceAnswer([]));
    await openReady(h);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    await waitFor(() => lastView(h.posts)?.phase === "done" || lastView(h.posts)?.phase === "failed", "the run");
    const ask = h.rpcCalls.find((c) => c.method === "pr.provenance");
    assert.ok(ask);
    assert.equal(ask.params.base_ref, "origin/main");
    assert.equal(gitOk(h.sb.work, h.sb.env, ["rev-parse", "--verify", "--quiet", "origin/main"]).length, 40);
  });
});
