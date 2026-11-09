// Independent adversarial tests for the Create pull request host controller (PullRequestController), run against a
// real temporary git repository through the real VscodeGitPort and a CLI-backed stand-in for vscode.git's API.
// GitHub is a fake behind a patched global fetch that refuses every host but api.github.com, and answers locally.
// Spec: private/design/create-pr/DESIGN.md 3.2–3.7, 4, 5, 6, 7.1, 7.2.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { installVscodeStub, resetState, state } from "./helpers/prVscodeStub.js";
import { FakeGitHub } from "./helpers/prFakes.js";
import { CliApiRepository, Sandbox, gitOk, gitSync, makeSandbox, writeHook } from "./helpers/prRealGit.js";
import type { PrFile } from "../src/integrations/pullRequest/types.js";

installVscodeStub();
const { PullRequestController } = require("../src/panels/pullRequestController.js") as typeof import("../src/panels/pullRequestController.js");
const { onFeatureUse } = require("../src/telemetry/featureUsage.js") as typeof import("../src/telemetry/featureUsage.js");

const TOKEN = "gho_controller_test_token_ABCDEFGHIJKLMNOP";
const SECRET_IN_ENV = "SUPERSECRET_VALUE_9f8e7d";
const AWS = "AKIA" + "POIUYTREWQLKJHGF";

// ── fake GitHub behind global fetch ─────────────────────────────
let api = new FakeGitHub("test", "orders");
/** Per-test hook in front of the fake API: answer a request yourself, delay it, or return undefined to pass through. */
let fetchOverride: ((url: string, init: any) => Promise<unknown> | unknown) | null = null;
const fetchLog: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input);
  fetchLog.push(url);
  if (new URL(url).origin !== "https://api.github.com") throw new Error(`blocked fetch to ${url}`);
  const custom = fetchOverride ? await fetchOverride(url, init) : undefined;
  if (custom) return custom as any;
  return api.fetch(url, init) as any;
}) as typeof fetch;
process.on("exit", () => { globalThis.fetch = originalFetch; });

const features: string[] = [];
onFeatureUse((name) => features.push(name));

interface Harness {
  sb: Sandbox;
  repo: CliApiRepository;
  ctrl: InstanceType<typeof PullRequestController>;
  posts: any[];
  logs: string[];
  rpcCalls: { method: string; params: any }[];
  prompts: string[];
  release: { receipt(): void; draft(): void };
  files: PrFile[];
  host: any;
  setTurn(turn: { sessionId: string; turnIndex: number | null } | null): void;
  setSession(id: string | null): void;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  fetchOverride = null;
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function receiptFor(turnFiles: string[], findings: { kind: string; severity: string; detail: string; subject?: string }[], turnIndex = 0) {
  return {
    version: 1, session_id: "s1", turn_index: turnIndex, started_at: null, ended_at: null, duration_seconds: null, models: ["m"], mode: null,
    snapshot: {}, files_changed: turnFiles.map((p) => ({ path: p, status: "M", added: 1, deleted: 1, via: "edit" })),
    edited_not_in_snapshot: [], files_read: [], commands: [], checks: [], web_hosts: [], mcp_servers: [], other_tools: {},
    needs_attention: findings, approvers: [], cost_usd: null, tokens: null, notes: [], record_hash: "e".repeat(64),
    summary: { files_changed: turnFiles.length, lines_added: 1, lines_deleted: 1, files_read: 0, searches: 0, commands: 0, commands_failed: 0,
      blocked: 0, denied: 0, approved_by_person: 0, denied_by_person: 0, subagents: 0, web_searches: 0 },
  };
}

function changedFiles(sb: Sandbox): PrFile[] {
  const out: PrFile[] = [];
  for (const line of gitOk(sb.work, sb.env, ["diff", "--numstat", "HEAD"]).split("\n").filter(Boolean)) {
    const [a, d, p] = line.split("\t");
    out.push({ path: p, status: "M", additions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  return out;
}

interface Options {
  findings?: { kind: string; severity: string; detail: string; subject?: string }[];
  holdReceipt?: boolean;
  holdDraft?: boolean;
  signedIn?: boolean;
  airGap?: boolean;
  draftText?: string;
  remoteName?: string;
  host?: string;
  agentRunning?: () => boolean;
  repositories?: (repo: CliApiRepository) => any[];
  /** The turn Changes Review shows; change it later with Harness.setTurn. null = no turn. */
  turn?: { sessionId: string; turnIndex: number | null } | null;
  /** Turn indexes whose receipt the engine fails to load. */
  failingReceipts?: number[];
  /** Gives the host a currentSession() (the chat session). */
  currentSession?: string | null;
  /** Engine sessions for session.receipt: turn index -> files changed (repo paths) and line counts. */
  /** Answers session.receipt with whatever this returns (for real engine answers). */
  engineResponder?: (params: any) => unknown;
  /** host.files() reads the repository's changes live, as the refreshed panel does. */
  liveFiles?: boolean;
  engineSessions?: Record<string, Record<number, { path: string; added?: number; deleted?: number }[]>>;
}

async function harness(opts: Options = {}): Promise<Harness> {
  resetState();
  api = new FakeGitHub("test", "orders");
  const sb = makeSandbox("orders");
  cleanups.push(() => sb.cleanup());
  if (opts.host) {
    const url = gitOk(sb.work, sb.env, ["config", "--get", "remote.origin.url"]);
    const other = url.replace("github.com", opts.host);
    gitOk(sb.work, sb.env, ["remote", "set-url", "origin", other]);
    gitOk(sb.work, sb.env, ["config", `url.${sb.bare.replace(/\\/g, "/")}.insteadOf`, other]);
  }
  fs.writeFileSync(path.join(sb.work, ".env"), "API_KEY=old\n");
  gitOk(sb.work, sb.env, ["add", ".env"]);
  gitOk(sb.work, sb.env, ["commit", "-qm", "env"]);
  gitOk(sb.work, sb.env, ["push", "-q", "origin", "main"]);
  fs.writeFileSync(path.join(sb.work, ".env"), `API_KEY=${SECRET_IN_ENV}\n`);
  fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "def total(x):\n    return round(x, 2)\n");
  const files = changedFiles(sb);
  const turnFiles = files.map((f) => f.path);

  const repo = new CliApiRepository(sb.work, sb.env);
  await repo.status();
  const exportsApi = { enabled: true, getAPI: () => ({ repositories: opts.repositories ? opts.repositories(repo) : [repo] }) };
  state.gitExtension = { isActive: true, exports: exportsApi, activate: async () => exportsApi };
  state.session = opts.signedIn === false ? null : { accessToken: TOKEN, account: { label: "ada", id: "1" }, scopes: ["repo"] };
  if (opts.airGap) state.config.andromity = { "airGap.enabled": true };

  let releaseReceipt = () => {};
  let releaseDraft = () => {};
  const receiptGate = opts.holdReceipt ? new Promise<void>((r) => (releaseReceipt = r)) : Promise.resolve();
  const draftGate = opts.holdDraft ? new Promise<void>((r) => (releaseDraft = r)) : Promise.resolve();
  cleanups.push(() => { releaseReceipt(); releaseDraft(); });
  const rpcCalls: Harness["rpcCalls"] = [];
  const prompts: string[] = [];
  const findings = opts.findings ?? [{ kind: "sensitive", severity: "high", detail: "Changed a sensitive file", subject: ".env" }];
  const rpc = {
    call: async (method: string, params: any) => {
      rpcCalls.push({ method, params });
      if (method === "session.receipt" && opts.engineResponder) {
        await receiptGate;
        return opts.engineResponder(params);
      }
      if (method === "session.receipt" && opts.engineSessions) {
        await receiptGate;
        const turns = opts.engineSessions[params.session_id];
        if (!turns) return { success: false, error: "That session was not found." };
        const numbers = Object.keys(turns).map(Number).sort((a, b) => a - b);
        const index = params.turn_index === undefined ? numbers[numbers.length - 1] : Number(params.turn_index);
        if (!(index in turns)) return { success: false, error: "no checkpoint" };
        const r: any = receiptFor([], findings, index);
        r.session_id = params.session_id;
        r.files_changed = turns[index].map((f) => ({ path: f.path, status: "M", added: f.added ?? 1, deleted: f.deleted ?? 1, via: "edit" }));
        r.summary.files_changed = turns[index].length;
        return { success: true, receipt: r, markdown: `### Receipt ${params.session_id} turn ${index + 1}`, text: "", turns: numbers };
      }
      if (method === "session.receipt") {
        await receiptGate;
        const index = Number(params.turn_index);
        if ((opts.failingReceipts ?? []).includes(index)) return { success: false, error: "no receipt" };
        const markdown = index === 0 ? "### Andromity receipt\n\n**Needs your eyes**\n- High · Changed a sensitive file: `.env`" : `### Andromity receipt for turn ${index + 1}`;
        return { success: true, receipt: receiptFor(turnFiles, findings, index), markdown, text: "", turns: [index] };
      }
      if (method === "git.file_diff") {
        const diff = gitSync(sb.work, sb.env, ["diff", "--no-ext-diff", "HEAD", "--", params.path]).stdout;
        return { diff };
      }
      if (method === "agent.quickPrompt") {
        prompts.push(String(params.prompt));
        await draftGate;
        return opts.draftText ?? "<commit_message>fix(orders): round totals to cents</commit_message>\n<pr_description>Rounds order totals.</pr_description>";
      }
      if (method === "telemetry.recordFeature") return {};
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  const posts: any[] = [];
  const logs: string[] = [];
  let currentSessionId: string | null = opts.currentSession ?? null;
  let currentTurn: { sessionId: string; turnIndex: number | null } | null = opts.turn === undefined ? { sessionId: "s1", turnIndex: 0 } : opts.turn;
  const host = {
    post: (m: unknown) => posts.push(JSON.parse(JSON.stringify(m))),
    rpc: () => rpc as any,
    repositoryRoot: () => sb.work,
    projectPath: () => sb.work,
    // liveFiles: what Changes Review lists right now (it refreshes on file and git events, so after the commit
    // the committed files are gone from it), instead of the list taken when the harness started.
    files: () => (opts.liveFiles ? changedFiles(sb) : files),
    turnFiles: () => (currentTurn ? turnFiles : null),
    turn: () => currentTurn,
    ...(opts.currentSession !== undefined ? { currentSession: () => currentSessionId } : {}),
    scope: () => "turn" as const,
    agentRunning: opts.agentRunning ?? (() => false),
    refresh: async () => {},
    log: (m: string) => logs.push(m),
  };
  const ctrl = new PullRequestController(host);
  cleanups.push(() => ctrl.dispose());
  return { sb, repo, ctrl, posts, logs, rpcCalls, prompts, release: { receipt: releaseReceipt, draft: releaseDraft }, files, host, setTurn: (t) => { currentTurn = t; }, setSession: (id) => { currentSessionId = id; } };
}

const views = (h: Harness) => h.posts.filter((m) => m.type === "pr_view").map((m) => m.view);
const lastView = (h: Harness) => views(h).at(-1);
const form = (h: Harness) => lastView(h)?.form;

async function waitFor(pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function openReady(h: Harness, opts: { receipt?: boolean; draft?: boolean } = {}) {
  await h.ctrl.handle({ type: "pr_open" });
  await waitFor(() => lastView(h)?.phase === "form", "the form");
  await waitFor(() => !!form(h) && form(h).sizeLine.text !== "Counting lines…", "the file checks");
  if (opts.receipt !== false) await waitFor(() => form(h).receipt.available === true, "the receipt");
  if (opts.draft !== false) await waitFor(() => !form(h).drafting && !!(h.ctrl as any).form.commitMessage, "the draft");
  await new Promise((r) => setTimeout(r, 350));
}

const remoteBranches = (h: Harness) => gitOk(h.sb.dir, h.sb.env, ["--git-dir", h.sb.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
const gitMutations = (h: Harness) => h.repo.calls.filter((c) => ["createBranch", "checkout", "add", "revert", "commit", "push"].includes(c.name)).map((c) => c.name);

describe("controller: sensitive files and drafting (3.2, 3.4, 7.1)", { timeout: 60_000 }, () => {
  it("the AI draft is built from the ticked files only: a sensitive file that starts unticked never goes to the model", async () => {
    const h = await harness();
    await openReady(h);
    const env = form(h).files.find((f: any) => f.path === ".env");
    assert.equal(env.checked, false, ".env starts unticked once the receipt flags it");
    assert.ok(h.prompts.length >= 1, "a draft was requested");
    for (const prompt of h.prompts) {
      assert.ok(!prompt.includes(SECRET_IN_ENV), "the .env diff (with its secret) was sent to the model provider for drafting");
    }
  });

  it("submitting before the receipt has loaded can't ship the sensitive file or skip the high-finding acknowledgement (3.2, 3.6)", async () => {
    const h = await harness({ holdReceipt: true });
    await openReady(h, { receipt: false });
    const before = form(h);
    await h.ctrl.handle({ type: "pr_submit", action: "primary", form: { commitMessage: "fix: quick" } });
    await new Promise((r) => setTimeout(r, 300));
    const committed = gitSync(h.sb.work, h.sb.env, ["log", "--all", "--format=%H", "--", ".env"]).stdout.trim().split("\n").filter(Boolean).length;
    assert.ok(committed <= 1, `.env was committed (button was ${before.primary.enabled ? "enabled" : "disabled"}: ${before.disabledReason})`);
    assert.ok(!remoteBranches(h).some((b) => b !== "main"), "pushed before the receipt (and its high findings) loaded");
  });

  it("ticking a sensitive file after acknowledging needs a fresh acknowledgement (3.6: the ack can't be reused after what it covers changes)", async () => {
    const h = await harness();
    await openReady(h);
    const key = form(h).checks.key;
    await h.ctrl.handle({ type: "pr_update", changes: { ack: key } });
    assert.equal(form(h).checks.acked, true);
    await h.ctrl.handle({ type: "pr_update", changes: { file: { path: ".env", checked: true } } });
    await waitFor(() => form(h).files.find((f: any) => f.path === ".env").checked === true, "the tick");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(form(h).checks.notes.some((n: string) => n.includes("sensitive file is ticked")));
    assert.equal(form(h).checks.acked, false, "the acknowledgement given while .env was left out still counts after ticking .env");
  });
});

describe("controller: the things-to-check acknowledgement (3.6)", { timeout: 60_000 }, () => {
  const runsCode = [{ kind: "runs_code", severity: "high", detail: "Changed a file that runs code", subject: ".github/workflows/ci.yml" }];

  it("can't be bypassed: a wrong or missing key never runs the flow", async () => {
    const h = await harness({ findings: runsCode });
    await openReady(h);
    assert.ok(form(h).checks && !form(h).checks.acked);
    assert.equal(form(h).primary.enabled, false);
    for (const ack of [undefined, "wrong", true, 1, { toString: () => form(h).checks.key }, form(h).checks.key + " "]) {
      await h.ctrl.handle({ type: "pr_submit", action: "primary", form: { ack } });
      await h.ctrl.handle({ type: "pr_submit", action: "commit_only", form: { ack } });
    }
    assert.deepEqual(gitMutations(h), [], "the flow ran without the acknowledgement");
  });

  it("is reset when the items change: a key pasted into the commit message", async () => {
    const h = await harness({ findings: runsCode });
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { ack: form(h).checks.key } });
    assert.equal(form(h).primary.enabled, true, form(h).disabledReason);
    await h.ctrl.handle({ type: "pr_update", changes: { commitMessage: `fix: x\n\nkey ${AWS}` } });
    assert.equal(form(h).checks.acked, false);
    assert.ok(form(h).checks.items.some((i: any) => i.label === "Secret" && /commit message/.test(i.text)));
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.deepEqual(gitMutations(h), []);
    assert.ok(!JSON.stringify(h.posts.filter((m) => m.type === "pr_view")).includes(AWS), "the key reached the webview in a view");
  });

  it("a key written into the file after acknowledging is caught by the last scan before staging (4.1)", async () => {
    const h = await harness({ findings: runsCode });
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { ack: form(h).checks.key } });
    fs.appendFileSync(path.join(h.sb.work, "orders", "totals.py"), `KEY = "${AWS}"\n`);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.deepEqual(gitMutations(h), [], "a secret added after the acknowledgement went into a commit");
    assert.ok(form(h).checks.items.some((i: any) => i.label === "Secret" && i.path === "orders/totals.py" && i.line === 3));
    assert.ok(!JSON.stringify(h.posts).includes(AWS.slice(4)), "secret value reached the webview");
  });
});

describe("controller: messages from the webview are untrusted (7.2 rules 2, 3, 4)", { timeout: 60_000 }, () => {
  it("odd shapes, unknown paths, prototype keys and huge strings change nothing they shouldn't", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    const internal = (h.ctrl as any).form;
    const tickedBefore = [...internal.ticked];
    const junk: any[] = [
      null, undefined, 5, "pr_submit", { type: 5 }, { type: "pr_update" }, { type: "pr_update", changes: "x" }, { type: "pr_update", changes: [1, 2] },
      { type: "pr_update", changes: { file: { path: "../../outside.txt", checked: true } } },
      { type: "pr_update", changes: { file: { path: "C:\\Windows\\win.ini", checked: true } } },
      { type: "pr_update", changes: { file: { path: "__proto__", checked: true } } },
      { type: "pr_update", changes: { file: { path: { toString: () => "orders/totals.py" }, checked: false } } },
      { type: "pr_update", changes: JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted2": true}}}') },
      { type: "pr_update", changes: { base: "evil-not-listed" } }, { type: "pr_update", changes: { base: "--upload-pack=x" } },
      { type: "pr_update", changes: { scope: "everything" } }, { type: "pr_update", changes: { stagedChoice: "force" } },
      { type: "pr_action", action: "open_link" }, { type: "pr_action", action: "authorize_sso" }, { type: "pr_action", action: "switch_back" },
      { type: "pr_action", action: "retry" }, { type: "pr_action", action: "push_new_name" }, { type: "pr_action", action: { id: "x" } },
      { type: "pr_action", action: "constructor" }, { type: "pr_open_link", url: "https://evil.example" }, { type: "pr_copy", text: "x" },
    ];
    for (const message of junk) await h.ctrl.handle(message);
    assert.deepEqual([...internal.ticked], tickedBefore);
    assert.ok(!internal.ticked.has("../../outside.txt") && !internal.unticked.has("__proto__"));
    assert.equal(internal.base, "main");
    assert.equal(internal.scope, "turn");
    assert.equal(internal.stagedChoice, null);
    assert.equal(({} as any).polluted, undefined);
    assert.equal(({} as any).polluted2, undefined);
    assert.deepEqual(state.opened, []);
    assert.deepEqual(state.clipboard, []);
    assert.deepEqual(gitMutations(h), []);

    const huge = "x".repeat(5_000_000);
    await h.ctrl.handle({ type: "pr_update", changes: { title: huge, description: huge, commitMessage: huge, branchName: huge, reviewers: Array(100_000).fill("a".repeat(10_000)) } });
    assert.ok(internal.title.length <= 512 && internal.description.length <= 61_000 && internal.commitMessage.length <= 20_000, "lengths are capped");
    assert.ok(internal.reviewers.length <= 30 && internal.reviewers.every((r: string) => r.length <= 120));
    assert.equal(form(h).primary.enabled, false, "a 61,000-character description must not be sendable");
    await h.ctrl.handle({ type: "pr_update", changes: { commitMessage: "fix\u0000:\u202e evil\u0007", title: "t\u0000i\u202et\u2066le" } });
    assert.equal(internal.commitMessage, "fix: evil");
    assert.equal(internal.title, "title");
  });

  it("branch names are checked in the host: a bad name from the webview never reaches git", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    for (const branchName of ["-f", "--force", "x..y", "@{-1}", "a b", "main.lock", "refs/../x", "a".repeat(150)]) {
      await h.ctrl.handle({ type: "pr_submit", action: "primary", form: { branchName } });
      assert.deepEqual(gitMutations(h), [], `ran with branch ${JSON.stringify(branchName)}`);
    }
  });

  it("while the agent is running nothing can be submitted (2)", async () => {
    let running = false;
    const h = await harness({ findings: [], agentRunning: () => running });
    await openReady(h);
    running = true;
    h.ctrl.refreshView();
    assert.equal(form(h).primary.enabled, false);
    assert.match(form(h).disabledReason, /Wait for the turn to finish/);
    await h.ctrl.handle({ type: "pr_submit", action: "commit_only" });
    assert.deepEqual(gitMutations(h), []);
  });
});

describe("controller: the run, the token and URLs (4, 5, 7.1, 7.2 rules 5, 7)", { timeout: 90_000 }, () => {
  it("creates the pull request; the token never reaches the webview, the engine, logs, telemetry or notifications", async () => {
    features.length = 0;
    const h = await harness({ findings: [] });
    await openReady(h);
    assert.equal(form(h).primary.label, "Create pull request");
    assert.equal(form(h).primary.enabled, true, form(h).disabledReason);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.equal(lastView(h).phase, "done", JSON.stringify(lastView(h).failed ?? lastView(h)));
    assert.ok(remoteBranches(h).includes("andromity/round-totals-to-cents"), remoteBranches(h).join(","));
    const pushes = h.repo.calls.filter((c) => c.name === "push");
    assert.deepEqual(pushes.map((c) => c.args), [["origin", "andromity/round-totals-to-cents", true]], "push with set-upstream and no force mode");
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.match(create.body.body, /\*\*AI change record\*\* · Generated from Andromity session records · Commit `[0-9a-f]{7}`/);
    // .env is left unticked by name (engine's sensitive-path rule) even though this fake receipt doesn't flag it;
    // a real receipt always flags a changed .env (DESIGN 3.2 as amended in 2358148).
    assert.ok(!create.body.body.includes(".env"), "a file left out of the commit is named in the record");
    assert.equal(gitSync(h.sb.work, h.sb.env, ["log", "--format=%H", "andromity/round-totals-to-cents", "--", ".env"]).stdout.trim().split("\n").filter(Boolean).length, 1, ".env was committed by default");
    const everything = JSON.stringify({ posts: h.posts, logs: h.logs, rpc: h.rpcCalls, features, infos: state.infos, warnings: state.warnings, clipboard: state.clipboard, commands: state.commands });
    assert.ok(!everything.includes(TOKEN) && !everything.includes(TOKEN.slice(4, 20)), "the token leaked");
    for (const c of api.calls) assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(fetchLog.every((u) => u.startsWith("https://api.github.com/")));
  });

  it("opens only links it built: a hostile html_url from the API is never opened", async () => {
    const h = await harness({ findings: [] });
    api.routes["POST /repos/test/orders/pulls"] = { status: 201, body: { number: 42, html_url: "https://evil.example/phish", title: "t" } };
    await openReady(h);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.equal(lastView(h).phase, "done");
    assert.equal(lastView(h).done.url, "https://github.com/test/orders/pull/42");
    await h.ctrl.handle({ type: "pr_action", action: "open_link" });
    await h.ctrl.handle({ type: "pr_action", action: "copy_link" });
    assert.deepEqual(state.opened, ["https://github.com/test/orders/pull/42"]);
    assert.deepEqual(state.clipboard, ["https://github.com/test/orders/pull/42"]);
  });

  it("commit only: nothing leaves the machine", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    const before = api.calls.filter((c) => c.method === "POST").length;
    await h.ctrl.handle({ type: "pr_submit", action: "commit_only" });
    assert.equal(lastView(h).phase, "done");
    assert.ok(!h.repo.calls.some((c) => c.name === "push"));
    assert.deepEqual(remoteBranches(h), ["main"]);
    assert.equal(api.calls.filter((c) => c.method === "POST").length, before);
  });

  it("not signed in and the sign-in is declined: nothing has changed (3.7)", async () => {
    const h = await harness({ findings: [], signedIn: false });
    await openReady(h);
    assert.equal(form(h).primary.label, "Sign in and create pull request");
    assert.ok(form(h).secondary.some((a: any) => a.id === "push_open_page"));
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.ok(state.sessionRequests.some((r) => r.options?.createIfNone === true && r.scopes.includes("repo")));
    assert.deepEqual(gitMutations(h), [], "git was touched although sign-in was declined");
  });

  it("signed out, Push and open GitHub: compare page built from parts, description copied, not in the URL (5)", async () => {
    const h = await harness({ findings: [], signedIn: false });
    const fetchesBefore = fetchLog.length;
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { description: "Secretless description & stuff #1" } });
    await h.ctrl.handle({ type: "pr_submit", action: "push_open_page" });
    assert.equal(lastView(h).phase, "done", JSON.stringify(lastView(h)));
    assert.deepEqual(state.opened, ["https://github.com/test/orders/compare/main...andromity/round-totals-to-cents?expand=1"]);
    assert.ok(state.clipboard[0].includes("Secretless description & stuff #1"));
    assert.ok(state.clipboard[0].includes("AI change record"), "the record is copied with the description");
    assert.ok(!state.opened[0].includes("Secretless"));
    assert.equal(fetchLog.length, fetchesBefore, "GitHub's API was called while signed out");
  });

  it("GitLab remote: pushes and opens the merge request page on the remote's own host", async () => {
    const h = await harness({ findings: [], host: "gitlab.com" });
    await openReady(h);
    assert.equal(form(h).primary.label, "Push and open merge request page");
    const fetchesBefore = fetchLog.length;
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.equal(lastView(h).phase, "done", JSON.stringify(lastView(h)));
    const opened = new URL(state.opened[0]);
    assert.equal(opened.hostname, "gitlab.com");
    assert.equal(opened.searchParams.get("merge_request[source_branch]"), "andromity/round-totals-to-cents");
    assert.equal(fetchLog.length, fetchesBefore, "GitHub's API was called for a GitLab remote");
  });

  it("air-gap mode: Commit only, no push, no GitHub call, no fetch of the remote (6)", async () => {
    const h = await harness({ findings: [], airGap: true });
    const fetchesBefore = fetchLog.length;
    await openReady(h, { receipt: true });
    assert.equal(form(h).primary.label, "Commit");
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.equal(lastView(h).phase, "done");
    assert.ok(!h.repo.calls.some((c) => c.name === "push" || c.name === "fetch"));
    assert.equal(fetchLog.length, fetchesBefore);
    assert.ok(!state.sessionRequests.length, "asked VS Code for a GitHub session in air-gap mode");
  });

  it("a pre-commit hook stops the commit: failure view, Switch back offered and works", async () => {
    const h = await harness({ findings: [] });
    writeHook(path.join(h.sb.work, ".git"), "pre-commit", "exit 1");
    await openReady(h);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    const failed = lastView(h).failed;
    assert.equal(lastView(h).phase, "failed");
    assert.equal(failed.heading, "Git couldn't commit");
    assert.ok(failed.actions.some((a: any) => a.id === "switch_back"));
    assert.ok(!JSON.stringify(failed).includes("exit 1"));
    await h.ctrl.handle({ type: "pr_action", action: "switch_back" });
    assert.equal(gitOk(h.sb.work, h.sb.env, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  });

  it("the panel closing mid-flow still reports the result as a notification (5)", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    const run = h.ctrl.handle({ type: "pr_submit", action: "primary" });
    h.ctrl.dispose();
    await run;
    assert.ok(state.infos.some((t) => /Pull request #\d+ opened/.test(t)), state.infos.join(" | "));
  });

  it("acts on exactly the repository Changes Review shows, never another one VS Code has open (7.2 rule 1)", async () => {
    const decoy = { rootUri: { fsPath: path.join(path.dirname(path.dirname(process.cwd())), "not-this-repo") }, state: { remotes: [], indexChanges: [] }, status: async () => { throw new Error("decoy used"); } };
    const h = await harness({ findings: [], repositories: (repo) => [decoy, repo] });
    await openReady(h);
    assert.equal(lastView(h).phase, "form");
    const lonely = await harness({ findings: [], repositories: () => [decoy] });
    await lonely.ctrl.handle({ type: "pr_open" });
    await waitFor(() => lastView(lonely)?.phase === "blocked", "the blocked view");
    assert.match(lastView(lonely).blocked.title, /doesn't see this repository/);
  });
});

describe("controller: late drafts never overwrite what the user typed (3.1, 3.4, 3.5)", { timeout: 60_000 }, () => {
  it("commit message, title and branch name typed before the draft arrives are kept", async () => {
    const h = await harness({ findings: [], holdDraft: true });
    await openReady(h, { draft: false });
    await h.ctrl.handle({ type: "pr_update", changes: { commitMessage: "feat: mine", title: "My title", branchName: "me/my-branch", description: "My words" } });
    const postsBefore = h.posts.length;
    h.release.draft();
    await waitFor(() => h.prompts.length > 0 && !form(h).drafting, "the draft to finish");
    await new Promise((r) => setTimeout(r, 400));
    const internal = (h.ctrl as any).form;
    assert.equal(internal.commitMessage, "feat: mine");
    assert.equal(internal.title, "My title");
    assert.equal(internal.branchName, "me/my-branch");
    assert.equal(internal.description, "My words");
    const fields = h.posts.slice(postsBefore).filter((m) => m.type === "pr_field");
    assert.deepEqual(fields, [], "the host pushed a late draft over typed text");
  });

  it("the title follows the commit message's subject until the user edits the title (3.5)", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { commitMessage: "fix(orders): a better subject\n\nbody" } });
    assert.equal((h.ctrl as any).form.title, "fix(orders): a better subject");
  });
});

describe("telemetry names are fixed pr_* strings (7.1)", () => {
  it("every name used is pr_*, at most 31 characters, and carries no user data", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "panels", "pullRequestController.ts"), "utf8");
    const literal = [...source.matchAll(/track(?:Once)?\(\s*"([^"]+)"/g)].map((m) => m[1]);
    const ternary = [...source.matchAll(/track(?:Once)?\([^;]*?\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)].flatMap((m) => [m[1], m[2]]);
    const templates = [...source.matchAll(/track(?:Once)?\(\s*`([^`]+)`/g)].map((m) => m[1]);
    for (const name of [...literal, ...ternary]) {
      assert.match(name, /^pr_[a-z0-9_]+$/, name);
      assert.ok(name.length <= 31, `${name} is ${name.length} characters`);
    }
    const allowedHoles = /\$\{(?:context\.remote \? .*|context\.github\.problem|failure\.kind|STEP_NAMES\[failure\.step\]|mode|this\.form\.scope)\}/;
    for (const template of templates) {
      assert.ok(template.startsWith("pr_"), template);
      for (const hole of template.match(/\$\{[^}]+\}/g) || []) assert.match(hole, allowedHoles, `telemetry name built from ${hole}`);
    }
    assert.ok(features.every((name) => /^pr_[a-z0-9_]{1,28}$/.test(name) || !name.startsWith("pr_")), features.join(","));
    assert.ok(features.filter((n) => n.startsWith("pr_")).every((n) => !/orders|test|ada|round|andromity|priya|gitlab_com|main/.test(n.replace(/^pr_host_gitlab$/, ""))), features.join(","));
  });
});

describe("controller: attacking the fixes in 2358148", { timeout: 90_000 }, () => {
  it("without a turn (no receipt), ticking a file named like a secrets file still needs 'I've checked these' (3.2, 3.6)", async () => {
    const h = await harness({ findings: [], turn: null });
    await openReady(h, { receipt: false });
    const env = form(h).files.find((f: any) => f.path === ".env");
    assert.equal(env.checked, false, ".env starts unticked by name");
    await h.ctrl.handle({ type: "pr_update", changes: { file: { path: ".env", checked: true } } });
    await waitFor(() => form(h).files.find((f: any) => f.path === ".env").checked === true, "the tick");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(form(h).checks, "a ticked sensitive file shows no things-to-check box, so its warning note is dropped and nothing needs acknowledging");
    await h.ctrl.handle({ type: "pr_submit", action: "commit_only" });
    assert.deepEqual(gitMutations(h), [], "committed a sensitive file with no acknowledgement");
  });

  it("switching to a turn whose receipt isn't ready drops the previous turn's receipt (3.5)", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    assert.equal(form(h).receipt.available, true);
    h.setTurn({ sessionId: "s1", turnIndex: null });
    h.ctrl.turnChanged();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(form(h).receipt.available, false, "the form still offers turn 1's receipt for a different turn");
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
    assert.ok(!create || !create.body.body.includes("AI change record"), "the pull request carries the previous turn's record");
  });

  it("switching to a turn whose receipt fails to load drops the previous turn's receipt (3.5)", async () => {
    const h = await harness({ findings: [], failingReceipts: [3] });
    await openReady(h);
    h.setTurn({ sessionId: "s1", turnIndex: 3 });
    h.ctrl.turnChanged();
    await waitFor(() => !/Loading the receipt/.test(form(h).disabledReason ?? ""), "the receipt load to finish");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(form(h).receipt.available, false, "turn 1's receipt is still attached after turn 4's failed to load");
  });

  it("switching to another turn with a receipt attaches that turn's receipt", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    h.setTurn({ sessionId: "s1", turnIndex: 1 });
    h.ctrl.turnChanged();
    await waitFor(() => /turn 2/.test(form(h).receipt.summary ?? ""), "turn 2's receipt");
    await waitFor(() => form(h).primary.enabled === true, `the button (${form(h).disabledReason})`);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.match(create.body.body, /AI change record/);
  });

  it("while the receipt loads the button waits, and the draft never contains a secret from any ticked file", async () => {
    const h = await harness({ findings: [], holdReceipt: true });
    fs.writeFileSync(path.join(h.sb.work, "orders", "totals.py"), `def total(x):\n    return round(x, 2)\nKEY = "${AWS}"\n`);
    await openReady(h, { receipt: false });
    assert.equal(form(h).primary.enabled, false);
    assert.match(form(h).disabledReason, /Loading the receipt/);
    for (const prompt of h.prompts) {
      assert.ok(!prompt.includes(SECRET_IN_ENV) && !prompt.includes(AWS), "a secret went to the model");
    }
  });
});

// ── Round 3: git identity, description drafting, two GitHub accounts (commit b8e1b57) ──────────
const TOKEN_B = "gho_second_account_token_ZYXWVUTSRQPONM";
function reply(status: number, body: unknown) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}
/** Account A (TOKEN) can't see the private repository; account B (TOKEN_B) can. */
function twoAccounts(opts: { slowUser?: number } = {}) {
  fetchOverride = async (url: string, init: any) => {
    const u = new URL(url);
    const auth = init?.headers?.Authorization;
    if (u.pathname === "/user") {
      if (opts.slowUser) await new Promise((r) => setTimeout(r, opts.slowUser));
      return reply(200, { login: auth === `Bearer ${TOKEN_B}` ? "ada-work" : "ada" });
    }
    if (auth !== `Bearer ${TOKEN_B}` && u.pathname.startsWith("/repos/test/orders")) return reply(404, { message: "Not Found" });
    return undefined;
  };
}

describe("round 3: git identity (DESIGN 4.1)", { timeout: 90_000 }, () => {
  it("identity only in the global ~/.gitconfig: no block, no warning, and the commit carries it", async () => {
    const h = await harness({ findings: [] });
    gitOk(h.sb.work, h.sb.env, ["config", "--local", "--unset", "user.name"]);
    gitOk(h.sb.work, h.sb.env, ["config", "--local", "--unset", "user.email"]);
    gitOk(h.sb.work, h.sb.env, ["config", "--global", "user.name", "Global Ada"]);
    gitOk(h.sb.work, h.sb.env, ["config", "--global", "user.email", "global@example.invalid"]);
    await openReady(h);
    assert.ok(!form(h).notes.some((n: any) => /git name and email/.test(n.text)), "the form says it can't see the identity although it is set globally");
    await h.ctrl.handle({ type: "pr_submit", action: "commit_only" });
    assert.equal(lastView(h).phase, "done", JSON.stringify(lastView(h).failed ?? lastView(h).form?.disabledReason));
    assert.equal(gitOk(h.sb.work, h.sb.env, ["log", "-1", "--format=%an <%ae>"]), "Global Ada <global@example.invalid>");
  });

  it("no identity anywhere: refused before anything is touched (4.1 'checks first, with no side effects')", async () => {
    const h = await harness({ findings: [] });
    gitOk(h.sb.work, h.sb.env, ["config", "--local", "--unset", "user.name"]);
    gitOk(h.sb.work, h.sb.env, ["config", "--local", "--unset", "user.email"]);
    await openReady(h);
    await h.ctrl.handle({ type: "pr_submit", action: "commit_only" });
    const view = lastView(h);
    if (view.phase === "failed") assert.equal(view.failed.heading, "Set your git name and email first");
    assert.deepEqual(gitMutations(h), [], `a branch was created and files staged before the missing identity stopped the commit (phase ${view.phase})`);
  });
});

describe("round 3: Draft with AI for the description (DESIGN 3.4, 3.5)", { timeout: 90_000 }, () => {
  it("fills the description and leaves the commit message, title and branch alone", async () => {
    const h = await harness({ findings: [], draftText: "<commit_message>feat: first draft</commit_message>\n<pr_description>First description.</pr_description>" });
    await openReady(h);
    const before = { ...(h.ctrl as any).form };
    assert.equal(before.description, "First description.", "the initial draft didn't fill the description");
    const call = h.rpcCalls.filter((c) => c.method === "agent.quickPrompt").at(-1)!;
    assert.equal(call.params.raw, true, "the engine only returns the full text (with <pr_description>) in raw mode");
    await h.ctrl.handle({ type: "pr_update", changes: { description: "" } });
    const postsBefore = h.posts.length;
    await h.ctrl.handle({ type: "pr_draft_description" });
    await waitFor(() => !form(h).drafting && (h.ctrl as any).form.description !== "", "the description draft");
    await new Promise((r) => setTimeout(r, 400));
    const after = (h.ctrl as any).form;
    assert.equal(after.description, "First description.");
    assert.equal(after.commitMessage, before.commitMessage);
    assert.equal(after.title, before.title);
    assert.equal(after.branchName, before.branchName);
    const fields = h.posts.slice(postsBefore).filter((m) => m.type === "pr_field").map((m) => m.field);
    assert.deepEqual(fields, ["description"]);
  });

  it("with a pull request template, pressing Draft with AI twice doesn't stack drafts on the template (3.5)", async () => {
    const h = await harness({ findings: [], draftText: "<commit_message>feat: x</commit_message>\n<pr_description>Drafted summary.</pr_description>" });
    fs.mkdirSync(path.join(h.sb.work, ".github"), { recursive: true });
    fs.writeFileSync(path.join(h.sb.work, ".github", "pull_request_template.md"), "## Checklist\n- [ ] Tests\n");
    gitOk(h.sb.work, h.sb.env, ["add", ".github"]);
    gitOk(h.sb.work, h.sb.env, ["commit", "-qm", "template"]);
    await openReady(h);
    assert.match((h.ctrl as any).form.description, /^## Checklist/);
    for (let i = 0; i < 2; i++) {
      await h.ctrl.handle({ type: "pr_draft_description" });
      await waitFor(() => !form(h).drafting && /Drafted summary/.test((h.ctrl as any).form.description), "a draft");
      await new Promise((r) => setTimeout(r, 300));
    }
    const description: string = (h.ctrl as any).form.description;
    assert.equal(description.split("Drafted summary.").length - 1, 1, `drafts stacked:\n${description}`);
    assert.equal(description.split("## Checklist").length - 1, 1, "the template was duplicated");
  });

  it("a model that writes no description: the note says so and the description stays as it was", async () => {
    const h = await harness({ findings: [], draftText: "<commit_message>feat: only a commit</commit_message>" });
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { description: "Mine." } });
    await h.ctrl.handle({ type: "pr_draft_description" });
    await waitFor(() => !form(h).drafting && !!form(h).draftNote, "the note");
    assert.equal((h.ctrl as any).form.description, "Mine.");
    assert.match(form(h).draftNote, /didn't write a description/);
  });
});

describe("round 3: two GitHub accounts (DESIGN 5 'Not signed in', 'No push access')", { timeout: 90_000 }, () => {
  it("names the account that can't see the repository, and Use another account switches to the one that can", async () => {
    twoAccounts();
    const h = await harness({ findings: [] });
    state.sessionOnPrompt = { accessToken: TOKEN_B, account: { label: "ada-work", id: "2" }, scopes: ["repo"] };
    await openReady(h);
    assert.equal(form(h).primary.label, "Push and open pull request page");
    const note = form(h).notes.find((n: any) => /can't find/.test(n.text));
    assert.ok(note && note.text.includes("@ada") && note.text.includes("test/orders") && /Use another account/.test(note.text), JSON.stringify(form(h).notes));
    assert.deepEqual(form(h).account, { kind: "signed_in", login: "ada", switchable: true });
    await h.ctrl.handle({ type: "pr_switch_account" });
    const request = state.sessionRequests.at(-1)!;
    assert.equal(request.options.clearSessionPreference, true);
    assert.equal(request.options.createIfNone, true);
    await waitFor(() => form(h).primary.label === "Create pull request", "the form to use the second account");
    assert.equal(form(h).account.login, "ada-work");
    await waitFor(() => form(h).primary.enabled, `the button (${form(h).disabledReason})`);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.equal(lastView(h).phase, "done", JSON.stringify(lastView(h).failed));
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.equal(create.headers.Authorization, `Bearer ${TOKEN_B}`);
    assert.ok(!JSON.stringify(h.posts).includes(TOKEN_B), "the second account's token reached the webview");
  });

  it("the account is named even when GitHub answers /user after the repository's 404", async () => {
    twoAccounts({ slowUser: 300 });
    const h = await harness({ findings: [] });
    await openReady(h);
    const note = form(h).notes.find((n: any) => /can't find/.test(n.text));
    assert.ok(note && note.text.includes("@ada"), `the note doesn't say which account was used: ${note?.text}`);
  });

  it("cancelling the account picker changes nothing", async () => {
    twoAccounts();
    const h = await harness({ findings: [] });
    state.sessionOnPrompt = null;
    await openReady(h);
    const before = JSON.stringify(form(h));
    await h.ctrl.handle({ type: "pr_switch_account" });
    assert.equal(JSON.stringify(form(h)), before);
    assert.deepEqual(gitMutations(h), []);
  });

  it("a switch-account message while a run is in flight doesn't change the account the run uses", async () => {
    const h = await harness({ findings: [] });
    writeHook(path.join(h.sb.work, ".git"), "pre-push", "sleep 2");
    state.sessionOnPrompt = { accessToken: TOKEN_B, account: { label: "other", id: "2" }, scopes: ["repo"] };
    await openReady(h);
    const run = h.ctrl.handle({ type: "pr_submit", action: "primary" });
    await waitFor(() => lastView(h)?.phase === "running" && lastView(h).run.steps.some((s: any) => s.id === "push" && s.status === "running"), "the push to start");
    await h.ctrl.handle({ type: "pr_switch_account" });
    await run;
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
    assert.ok(create, JSON.stringify(lastView(h)));
    assert.equal(create.headers.Authorization, `Bearer ${TOKEN}`, "the pull request was opened with an account the form never checked");
  });
});

// ── Round 4: the receipt recovered from the chat's latest turn when no turn is known (commit 2e4bf2d) ──────────
describe("round 4: receipt recovered after a restart (DESIGN 3.5)", { timeout: 120_000 }, () => {
  const totals = (added = 1, deleted = 1) => ({ path: "orders/totals.py", added, deleted });

  it("the founder's path: no turn reference, the chat's session has the turn → the receipt is attached and the form says so", async () => {
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 0: [{ path: "x.md" }], 4: [totals(), { path: ".env" }] } } });
    await openReady(h);
    const call = h.rpcCalls.find((c) => c.method === "session.receipt")!;
    assert.equal(call.params.session_id, "s9");
    assert.ok(!("turn_index" in call.params), "asked for a specific turn although none is known");
    assert.equal(form(h).receipt.available, true, form(h).receipt.reason);
    assert.match(form(h).receipt.summary, /turn 5 \(found by matching these changes\)/);
    assert.match(form(h).plan, /An AI change record/);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.equal(lastView(h).phase, "done", JSON.stringify(lastView(h).failed ?? form(h)?.disabledReason));
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.match(create.body.body, /Commit `[0-9a-f]{7}`/);
    assert.match(create.body.body, /\| \*\*Files changed with AI\*\* \| 1 of 1 \|/);
    assert.ok(!/matched by file names only/.test(create.body.body), "an exact match is labelled as a name-only match");
    assert.ok(lastView(h).done.lines.some((l: string) => /AI change record for turn 5 is at the end/.test(l)));
  });

  it("a follow-up turn that changed nothing (a question) doesn't hide the turn that made these changes", async () => {
    // Every trusted turn gets a checkpoint (rpc_handler start_turn_record), so "the latest finished turn" is often a chat-only turn.
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 3: [totals(), { path: ".env" }], 4: [] } } });
    await openReady(h, { receipt: false });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(form(h).receipt.available, true, `no receipt: ${form(h).receipt.reason}`);
    assert.match(form(h).receipt.summary, /turn 4/);
  });

  it("a turn that only touched a same-named path, with different line counts, is attached only with a visible 'found by file name' label", async () => {
    // Policy since 6a9aabb (agreed): attach with a plain label rather than nothing. Earlier this test expected no attachment.
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 7: [totals(40, 0)] } } });
    await openReady(h);
    assert.match(form(h).receipt.summary, /turn 8 \(found by file name; these files also have other changes\)/);
    assert.ok(form(h).files.find((f: any) => f.path === "orders/totals.py").tags.some((t: any) => /outside this turn/.test(t.text)));
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.ok(create, JSON.stringify(lastView(h)));
    assert.match(create.body.body, /matched by file names only, so these files may also hold changes from other turns or from outside Andromity/);
  });

  it("no session, a hostile session id, or an unknown session: no receipt, no request with the bad id", async () => {
    for (const id of [null, "", "../../x", "s/1", "a".repeat(129), "s1\nx", "s1 ", "ś1"]) {
      const h = await harness({ findings: [], turn: null, currentSession: id, engineSessions: { s9: { 0: [totals()] } } });
      await openReady(h, { receipt: false });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(h.rpcCalls.filter((c) => c.method === "session.receipt").length, 0, `asked the engine with ${JSON.stringify(id)}`);
      assert.equal(form(h).receipt.available, false);
      assert.match(form(h).plan, /No AI change record is added/);
      h.ctrl.dispose();
    }
    const unknown = await harness({ findings: [], turn: null, currentSession: "nope", engineSessions: { s9: { 0: [totals()] } } });
    await openReady(unknown, { receipt: false });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(form(unknown).receipt.available, false);
  });

  it("the chat's latest turn changed none of these files: not attached, and the reason says why", async () => {
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 2: [{ path: "other/project/file.ts" }] } } });
    await openReady(h, { receipt: false });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(form(h).receipt.available, false);
    assert.match(form(h).receipt.reason, /No turn in this chat made these changes as they are now/);
  });

  it("partly related: the fixed line lists what the turn changed that is left out and what else is committed", async () => {
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 5: [totals(), { path: "docs/already-committed.md" }] } } });
    await openReady(h);
    await h.ctrl.handle({ type: "pr_update", changes: { file: { path: ".env", checked: true } } });
    await waitFor(() => form(h).files.find((f: any) => f.path === ".env").checked, "the tick");
    await new Promise((r) => setTimeout(r, 300));
    await waitFor(() => form(h).sizeLine.text !== "Counting lines…", "the file checks");
    if (form(h).checks) await h.ctrl.handle({ type: "pr_update", changes: { ack: form(h).checks.key } });
    await waitFor(() => form(h).primary.enabled, `the button (${form(h).disabledReason})`);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.ok(create, JSON.stringify(lastView(h)));
    assert.match(create.body.body, /\| \*\*Not recorded by Andromity\*\* \| `\.env` \|/);
    assert.ok(!create.body.body.includes("docs/already-committed.md"), "a file outside the commit is named in the record");
  });

  it("engine offline: no receipt, the plan sentence says so, nothing breaks", async () => {
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 0: [totals()] } } });
    h.host.rpc = () => null;
    await openReady(h, { receipt: false, draft: false });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(form(h).receipt.available, false);
    assert.match(form(h).receipt.reason, /Reconnect/);
    assert.match(form(h).plan, /No AI change record is added/);
  });

  it("reopening the form after the chat switched sessions uses the new session; a known turn always wins over recovery", async () => {
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 1: [totals()] }, s10: { 6: [totals()] } } });
    await openReady(h);
    assert.match(form(h).receipt.summary, /turn 2/);
    h.ctrl.close();
    h.setSession("s10");
    await openReady(h);
    assert.match(form(h).receipt.summary, /turn 7/);
    h.ctrl.close();
    h.setTurn({ sessionId: "s9", turnIndex: 1 });
    await openReady(h);
    assert.match(form(h).receipt.summary, /^Receipt · turn 2 ·/, "a known turn must not be replaced by the chat's latest turn");
  });
});

// The engine's real session.receipt: a session where turn 1 edits orders/totals.py and turn 2 is a question.
const ENGINE_PY = process.env.ANDROMITY_E2E_PYTHON || "D:\\saas\\agent\\.venv\\Scripts\\python.exe";
const SESSION_PROBE = String.raw`import asyncio, json, sys
sys.path.insert(0, sys.argv[1])
project = sys.argv[2]
followup = sys.argv[3] == "1"
from pathlib import Path
from andromity.config import config
from andromity.core.session import Session
from andromity.core.git_ops import ensure_git_tracking, create_pre_edit_snapshot
from andromity.core.receipt import start_turn_record, close_turn_record
from andromity.server.rpc_handler import JsonRpcHandler
config.set_trusted(project)
p = Path(project)
session = Session(name="probe", project_path=project)
def turn(prompt, edit):
    ensure_git_tracking(p)
    record = start_turn_record(session, create_pre_edit_snapshot(p))
    session.add_message("user", prompt)
    if edit:
        target = p / "orders" / "totals.py"
        target.write_bytes(b"def total(x):\n    return round(x, 2)\n")
    session.add_message("assistant", "Done.")
    record.update(close_turn_record(session))
    record["after_hash"] = create_pre_edit_snapshot(p)
    session.save()
turn("Round totals to cents", True)
if followup:
    turn("What did you change?", False)
class Self:
    _active_sessions = {session.id: session}
async def main():
    out = {}
    for turn_index in [None, 0, 1]:
        params = {"session_id": session.id, "project_path": project}
        if turn_index is not None:
            params["turn_index"] = turn_index
        out[str(turn_index)] = await JsonRpcHandler.rpc_session_receipt(Self(), params)
    print("@@" + json.dumps({"session_id": session.id, "answers": out}, default=str))
asyncio.run(main())
`;

function realEngineSession(followup: boolean): { session_id: string; answers: Record<string, any> } {
  const sb = makeSandbox("engine");
  try {
    const script = path.join(sb.dir, "probe.py");
    fs.writeFileSync(script, SESSION_PROBE);
    const env: NodeJS.ProcessEnv = { ...sb.env, ANDROMITY_CONFIG_DIR: path.join(sb.dir, "cfg"), APPDATA: sb.dir, LOCALAPPDATA: sb.dir };
    delete env.ANDROMITY_AIRGAP;
    const engineSrc = path.resolve(__dirname, "..", "..", "..", "src");
    const r = require("node:child_process").spawnSync(ENGINE_PY, ["-I", script, engineSrc, sb.work, followup ? "1" : "0"], { env, encoding: "utf8", timeout: 120_000, windowsHide: true });
    const line = String(r.stdout || "").split("\n").find((l: string) => l.startsWith("@@"));
    if (!line) throw new Error(`engine probe failed: ${String(r.stderr).slice(-2000)}`);
    return JSON.parse(line.slice(2));
  } finally {
    // The engine's git and SQLite handles can linger for a moment on Windows.
    fs.rmSync(sb.dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
}

describe("round 4 with the real engine's session.receipt (founder's path: turn ends → restart → Create pull request)", { timeout: 240_000 }, () => {
  const skip = !fs.existsSync(ENGINE_PY) && `no engine Python at ${ENGINE_PY}`;

  it("the turn that edited the file is the chat's latest turn: its receipt is recovered and attached", { skip }, async () => {
    const engine = realEngineSession(false);
    assert.equal(engine.answers["None"].receipt.turn_index, 0);
    const h = await harness({ findings: [], turn: null, currentSession: engine.session_id,
      engineResponder: (params) => engine.answers[params.turn_index === undefined ? "None" : String(params.turn_index)] ?? { success: false } });
    await openReady(h);
    assert.equal(form(h).receipt.available, true, form(h).receipt.reason);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    const create = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.ok(create, JSON.stringify(lastView(h)));
    assert.match(create.body.body, /\*\*AI change record\*\*/);
    assert.ok(!/matched by file names only/.test(create.body.body));
  });

  it("the founder asked a follow-up question after the edit: the editing turn's receipt is still recovered", { skip }, async () => {
    const engine = realEngineSession(true);
    assert.equal(engine.answers["None"].receipt.turn_index, 1, "the engine's latest turn is the question");
    assert.deepEqual(engine.answers["None"].receipt.files_changed, []);
    assert.deepEqual(engine.answers["0"].receipt.files_changed.map((f: any) => f.path), ["orders/totals.py"]);
    const h = await harness({ findings: [], turn: null, currentSession: engine.session_id,
      engineResponder: (params) => engine.answers[params.turn_index === undefined ? "None" : String(params.turn_index)] ?? { success: false } });
    await openReady(h, { receipt: false });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(form(h).receipt.available, true, `no receipt after a follow-up question: ${form(h).receipt.reason}`);
  });
});

// ── Round 5 (commit 6a9aabb): left-out list after the commit, and the recovery walk ──────────
describe("round 5: the receipt line is built from what was committed, not from the refreshed panel", { timeout: 120_000 }, () => {
  it("founder's live bug: a committed turn file is never listed as 'left out' once the panel has refreshed", async () => {
    const h = await harness({ findings: [], liveFiles: true });
    await openReady(h);
    assert.equal(form(h).files.find((f: any) => f.path === ".env").checked, false);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.equal(lastView(h).phase, "done", JSON.stringify(lastView(h).failed ?? form(h)?.disabledReason));
    assert.ok(!h.host.files().some((f: PrFile) => f.path === "orders/totals.py"), "precondition: the panel no longer lists the committed file");
    const body: string = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!.body.body;
    assert.match(body, /\| \*\*Files changed with AI\*\* \| 1 of 1 \|/, body);
    assert.match(body, /\| \*\*Not recorded by Andromity\*\* \| None \|/, body);
    assert.ok(!body.includes(".env"), `a file left out of the commit is named: ${body}`);
  });

  it("the same holds for the copied description on a host page, including 'Copy description again' after the panel refreshed", async () => {
    const h = await harness({ findings: [], liveFiles: true, host: "gitlab.com" });
    await openReady(h);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    assert.equal(lastView(h).phase, "done", JSON.stringify(lastView(h).failed));
    await h.ctrl.handle({ type: "pr_action", action: "copy_description" });
    assert.equal(state.clipboard.length, 2);
    for (const text of state.clipboard) {
      assert.match(text, /\| \*\*Files changed with AI\*\* \| 1 of 1 \|/, text);
      assert.ok(!text.includes(".env"), text);
    }
  });
});

describe("round 5: the recovery walk (DESIGN 3.5)", { timeout: 120_000 }, () => {
  const totals = (added = 1, deleted = 1) => ({ path: "orders/totals.py", added, deleted });

  it("an exact match on an older turn beats a name-only match on a newer one", async () => {
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 1: [totals()], 2: [{ path: "x.md" }], 3: [totals(9, 9)] } } });
    await openReady(h);
    assert.match(form(h).receipt.summary, /^Receipt · turn 2 \(found by matching these changes\)/);
  });

  it("looks at no more than ten turns and never trusts an answer for a different turn than asked", async () => {
    const turns: Record<number, { path: string; added?: number; deleted?: number }[]> = { 0: [totals()] };
    for (let i = 1; i <= 14; i++) turns[i] = [{ path: "x.md" }];
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: turns } });
    await openReady(h, { receipt: false });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(h.rpcCalls.filter((c) => c.method === "session.receipt").length <= 10);
    assert.equal(form(h).receipt.available, false);
    const latest = { success: true, receipt: { ...receiptFor([], [], 9), files_changed: [{ path: "x.md", status: "M", added: 1, deleted: 1, via: "edit" }] }, markdown: "### latest", text: "", turns: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] };
    const liar = await harness({ findings: [], turn: null, currentSession: "s9", engineResponder: () => ({ ...latest, receipt: { ...latest.receipt, files_changed: [{ path: "orders/totals.py", status: "M", added: 7, deleted: 7, via: "edit" }] } }) });
    await openReady(liar);
    // Every answer claims turn 10, whatever was asked: only the answer to the unscoped request may be used.
    assert.match(form(liar).receipt.summary, /^Receipt · turn 10 /);
  });

  it("a name-only match doesn't claim the files changed 'after that turn' when an earlier turn of the chat also changed them", async () => {
    // Turn 3 and turn 4 both edited orders/totals.py; the diff against HEAD is the sum of both turns, so no single
    // turn's counts match. Nothing changed after turn 4, but the public receipt line says it did.
    const h = await harness({ findings: [], turn: null, currentSession: "s9", engineSessions: { s9: { 3: [totals(1, 0)], 4: [totals(0, 1)] } } });
    await openReady(h);
    await h.ctrl.handle({ type: "pr_submit", action: "primary" });
    const body: string = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!.body.body;
    assert.match(body, /\*\*AI change record\*\*/);
    assert.ok(!/Modified outside Andromity/.test(body), `the pull request states as fact something the code doesn't know: ${body}`);
  });
});

// ── Guards against working on andromity-snapshots (uncommitted work on top of 7ee2c23) ──────────
describe("snapshot branch: the form refuses to ship from it", { timeout: 120_000 }, () => {
  it("on andromity-snapshots: blocked with Switch branch; the button only opens VS Code's picker; nothing touched", async () => {
    const h = await harness({ findings: [] });
    gitOk(h.sb.work, h.sb.env, ["checkout", "-q", "-b", "andromity-snapshots"]);
    await h.ctrl.handle({ type: "pr_open" });
    await waitFor(() => lastView(h)?.phase === "blocked", "the blocked view");
    assert.match(lastView(h).blocked.title, /andromity-snapshots/);
    assert.ok(lastView(h).blocked.actions.some((a: any) => a.id === "switch_branch"));
    for (const message of [{ type: "pr_submit", action: "primary" }, { type: "pr_submit", action: "commit_only" }, { type: "pr_update", changes: { createBranch: true } }]) {
      await h.ctrl.handle(message);
    }
    await h.ctrl.handle({ type: "pr_action", action: "switch_branch" });
    assert.deepEqual(state.commands.map((c) => c.command), ["git.checkout"]);
    assert.deepEqual(gitMutations(h), []);
    assert.equal(gitOk(h.sb.work, h.sb.env, ["rev-parse", "--abbrev-ref", "HEAD"]), "andromity-snapshots", "something switched branches");
  });

  it("Switch branch does nothing outside the blocked view", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    await h.ctrl.handle({ type: "pr_action", action: "switch_branch" });
    assert.deepEqual(state.commands.filter((c) => c.command === "git.checkout"), []);
  });

  it("on the snapshot branch checked out as Andromity-Snapshots (same ref on Windows/macOS): blocked too", async () => {
    const h = await harness({ findings: [] });
    gitOk(h.sb.work, h.sb.env, ["branch", "andromity-snapshots"]);
    const switched = gitSync(h.sb.work, h.sb.env, ["checkout", "-q", "Andromity-Snapshots"]);
    if (switched.status !== 0) return; // case-sensitive file system: a different, missing branch
    await h.ctrl.handle({ type: "pr_open" });
    await waitFor(() => lastView(h)?.phase === "blocked" || lastView(h)?.phase === "form", "the form");
    assert.equal(lastView(h).phase, "blocked", "the form opened on the snapshot branch because its name differs only in case");
  });

  it("a typed branch name equal to it in any case is refused with the reason", async () => {
    const h = await harness({ findings: [] });
    await openReady(h);
    for (const name of ["andromity-snapshots", "ANDROMITY-SNAPSHOTS", "Andromity-Snapshots"]) {
      await h.ctrl.handle({ type: "pr_update", changes: { branchName: name } });
      assert.match(form(h).disabledReason, /reserved for Andromity's undo snapshots/, name);
      await h.ctrl.handle({ type: "pr_submit", action: "commit_only" });
    }
    assert.deepEqual(gitMutations(h), []);
    await h.ctrl.handle({ type: "pr_update", changes: { branchName: "andromity-snapshots2" } });
    assert.ok(!/reserved/.test(form(h).disabledReason ?? ""));
  });

  it("the base list never offers the snapshot branch (a pushed andromity-snapshots on GitHub)", async () => {
    const h = await harness({ findings: [] });
    api.routes["GET /repos/test/orders/branches"] = { status: 200, body: [{ name: "main" }, { name: "andromity-snapshots" }] };
    await openReady(h);
    assert.ok(!form(h).baseOptions.includes("andromity-snapshots"), "offered as a base; choosing it ends in 'Git couldn't finish this step'");
  });
});
