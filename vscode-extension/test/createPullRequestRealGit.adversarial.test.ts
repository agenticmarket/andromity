// End to end with real git (DESIGN 8 "End to end, real git"): a temp work repository whose origin says
// https://github.com/test/<name>.git but is redirected to a local bare repository with url.<path>.insteadOf,
// git refusing every network protocol, and a fake GitHub API on 127.0.0.1. The real flow (prepareContext,
// evaluateSelection, runPlan) drives a GitPort that runs the same git commands vscode.git v1 runs.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FlowDeps, FlowError, RepoContext, RunPlan, RunState, evaluateSelection, moveToFreshBranch, pathsToStage, prepareContext, runPlan,
} from "../src/integrations/pullRequest/flow.js";
import { FetchLike, GitHubClient, HttpResponse } from "../src/integrations/pullRequest/github.js";

import { PrFile } from "../src/integrations/pullRequest/types.js";
import { FakeApi, GitCliPort, Sandbox, gitOk, gitSync, makeSandbox, otherClone, startFakeGitHub, writeHook } from "./helpers/prRealGit.js";

const TOKEN = "gho_e2e_fake_token_never_real_0123456789";
const realFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<HttpResponse>;

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function setup(opts: { signedIn?: boolean } = {}) {
  const sb = makeSandbox("orders");
  const api = await startFakeGitHub(sb);
  cleanups.push(() => sb.cleanup(), () => api.close());
  const port = new GitCliPort(sb.work, sb.env);
  const deps: FlowDeps = {
    git: port,
    github: opts.signedIn === false ? null : new GitHubClient(TOKEN, realFetch, api.base, 5000),
    readFile: async (rel) => {
      const abs = path.join(sb.work, ...rel.split("/"));
      try {
        return fs.readFileSync(abs);
      } catch {
        return null;
      }
    },
    fileDiff: async (rel) => {
      const r = gitSync(sb.work, sb.env, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--", rel]);
      return { diff: r.stdout, omitted: !r.stdout };
    },
    airGap: { enabled: false, allowedHosts: [] },
    enterpriseHosts: [],
  };
  return { sb, api, port, deps };
}

function prFile(sb: Sandbox, rel: string, status = "M"): PrFile {
  const stat = gitSync(sb.work, sb.env, ["diff", "--numstat", "HEAD", "--", rel]).stdout.trim().split("\t");
  return { path: rel, status, additions: Number(stat[0]) || 0, deletions: Number(stat[1]) || 0 };
}

function buildPlan(ctx: RepoContext, files: PrFile[], fingerprints: Record<string, string>, overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    mode: "pull_request",
    remote: ctx.remote!.name,
    parsed: ctx.remote!.parsed,
    target: ctx.github.target,
    headOwner: ctx.github.headOwner,
    base: ctx.base,
    branch: "andromity/round-totals",
    createBranch: true,
    files: pathsToStage(files),
    unstageFirst: [],
    fingerprints,
    commitMessage: "fix(orders): round totals to cents\n\nCo-authored-by: Andromity <333054755+andromity-bot@users.noreply.github.com>",
    signoff: false,
    title: "fix(orders): round totals to cents",
    bodyFor: (commit) => `Rounds totals. Commit ${commit}`,
    draft: false,
    reviewers: [],
    teams: [],
    existingPull: null,
    commentFor: null,
    ...overrides,
  };
}

async function flowError(promise: Promise<unknown>): Promise<FlowError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof FlowError, `expected FlowError, got ${error instanceof Error ? error.stack : error}`);
    return error as FlowError;
  }
  assert.fail("expected the flow to fail");
}

const remoteRef = (sb: Sandbox, ref: string) => gitSync(sb.dir, sb.env, ["--git-dir", sb.bare, "rev-parse", "-q", "--verify", ref]).stdout.trim();
const forbidden = (port: GitCliPort) => port.log.filter((args) => args.some((a) => /^(--force|-f|--force-with-lease.*|--no-verify|-n|--amend|--mirror|--delete|-d|-D)$/.test(a) || a.startsWith("+")));

describe("real git: the whole flow", { timeout: 120_000 }, () => {
  it("branch, stage, commit with real hooks, push through the redirect, open the pull request", async () => {
    const { sb, api, port, deps } = await setup();
    const marker = path.join(sb.dir, "hook-ran.txt");
    writeHook(path.join(sb.work, ".git"), "pre-commit", `echo pre-commit >> "${marker.replace(/\\/g, "/")}"`);
    writeHook(path.join(sb.work, ".git"), "commit-msg", `grep -q "round totals" "$1" || exit 1\necho commit-msg >> "${marker.replace(/\\/g, "/")}"`);
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "def total(x):\n    return round(x, 2)\n");
    fs.writeFileSync(path.join(sb.work, "notes.txt"), "notes\nunrelated dirty edit\n");
    const mainBefore = remoteRef(sb, "refs/heads/main");

    const ctx = await prepareContext(deps);
    assert.equal(ctx.remote?.parsed?.display, "github.com/test/orders");
    assert.equal(ctx.base, "main");
    assert.equal(ctx.github.viewer, "ada-tester");
    assert.equal(ctx.behind, 0);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    assert.deepEqual(report.secrets, []);
    assert.deepEqual(report.stagedOutside, []);
    const state: RunState = {};
    const result = await runPlan(deps, buildPlan(ctx, files, report.fingerprints), state);

    assert.equal(fs.readFileSync(marker, "utf8").replace(/\r/g, ""), "pre-commit\ncommit-msg\n", "the user's hooks must run");
    assert.equal(remoteRef(sb, "refs/heads/andromity/round-totals"), result.commit, "the bare repository got the commit");
    assert.equal(remoteRef(sb, "refs/heads/main"), mainBefore, "main on the remote never moves");
    assert.equal(gitOk(sb.work, sb.env, ["rev-parse", "main"]), mainBefore, "local main never moves");
    assert.equal(gitOk(sb.work, sb.env, ["rev-parse", `${result.commit}^`]), mainBefore);
    assert.deepEqual(gitOk(sb.work, sb.env, ["show", "--name-only", "--format=", result.commit]).split("\n"), ["orders/totals.py"]);
    assert.equal(gitOk(sb.work, sb.env, ["status", "--porcelain"]), "M notes.txt", "the unrelated dirty file stays uncommitted");
    assert.equal(gitOk(sb.work, sb.env, ["rev-parse", "--abbrev-ref", "@{u}"]), "origin/andromity/round-totals", "upstream is set");
    assert.match(gitOk(sb.work, sb.env, ["log", "-1", "--format=%B"]), /Co-authored-by: Andromity/);

    const create = api.requests.find((r) => r.method === "POST" && r.url.endsWith("/pulls"))!;
    assert.equal(create.body.head, "andromity/round-totals");
    assert.equal(create.body.base, "main");
    assert.ok(create.body.body.includes(`Commit ${result.commit}`) || create.body.body.includes(`Commit \`${result.commit.slice(0, 7)}\``));
    assert.equal(result.pull?.number, 42);
    for (const request of api.requests) {
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.headers["x-github-api-version"], "2022-11-28");
      assert.ok(!request.url.includes(TOKEN));
    }
    assert.deepEqual(forbidden(port), [], "force, --no-verify, amend or deletes were used");
  });

  it("a pre-commit hook that refuses: nothing committed, files untouched, the remote untouched", async () => {
    const { sb, api, deps } = await setup();
    writeHook(path.join(sb.work, ".git"), "pre-commit", "echo 'lint failed' >&2\nexit 1");
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "changed\n");
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const state: RunState = {};
    const error = await flowError(runPlan(deps, buildPlan(ctx, files, report.fingerprints), state));
    assert.equal(error.kind, "commit_failed");
    assert.equal(fs.readFileSync(path.join(sb.work, "orders", "totals.py"), "utf8"), "changed\n");
    assert.equal(remoteRef(sb, "refs/heads/andromity/round-totals"), "");
    assert.equal(api.requests.filter((r) => r.method === "POST").length, 0);
    assert.equal(gitOk(sb.work, sb.env, ["rev-parse", "--abbrev-ref", "HEAD"]), "andromity/round-totals");
    assert.equal(state.originalBranch, "main", "the form can offer Switch back to main");
    await deps.git.checkout("main");
    assert.match(gitOk(sb.work, sb.env, ["status", "--porcelain"]), /orders\/totals\.py/, "switching back keeps the uncommitted change");
  });

  it("push rejected because the remote branch has other commits: never forced, then pushed as -2 (5)", async () => {
    const { sb, api, port, deps } = await setup();
    const other = otherClone(sb);
    gitOk(other, sb.env, ["checkout", "-q", "-b", "andromity/round-totals"]);
    fs.writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
    gitOk(other, sb.env, ["add", "-A"]);
    gitOk(other, sb.env, ["commit", "-q", "-m", "theirs"]);
    gitOk(other, sb.env, ["push", "-q", "origin", "andromity/round-totals"]);
    const theirs = remoteRef(sb, "refs/heads/andromity/round-totals");

    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "mine\n");
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const plan = buildPlan(ctx, files, report.fingerprints);
    const state: RunState = {};
    const error = await flowError(runPlan(deps, plan, state));
    assert.equal(error.kind, "push_rejected");
    assert.equal(remoteRef(sb, "refs/heads/andromity/round-totals"), theirs, "the remote branch was overwritten");
    assert.ok(state.commit && gitOk(sb.work, sb.env, ["rev-parse", "HEAD"]) === state.commit, "the commit is safe locally");

    plan.branch = await moveToFreshBranch(deps, ctx, plan);
    assert.equal(plan.branch, "andromity/round-totals-2");
    state.pushed = false;
    state.branchReady = true;
    const result = await runPlan(deps, plan, state);
    assert.equal(remoteRef(sb, "refs/heads/andromity/round-totals-2"), state.commit);
    assert.equal(result.commit, state.commit, "no second commit");
    assert.equal(api.requests.find((r) => r.method === "POST" && r.url.endsWith("/pulls"))!.body.head, "andromity/round-totals-2");
    assert.deepEqual(forbidden(port), []);
  });

  it("a protected-branch rejection (server hook with GitHub's GH006 text) is told apart from 'other commits'", async () => {
    const { sb, deps } = await setup();
    writeHook(sb.bare, "pre-receive", "echo 'error: GH006: Protected branch update failed for refs/heads/andromity/round-totals.' >&2\nexit 1");
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "x\n");
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const error = await flowError(runPlan(deps, buildPlan(ctx, files, report.fingerprints), {}));
    assert.equal(error.kind, "protected");
  });

  it("a server-side pre-receive hook (policy) refusal is reported as a hook, not as 'already has this branch' (5)", async () => {
    const { sb, deps } = await setup();
    writeHook(sb.bare, "pre-receive", "echo 'policy: commits must reference a ticket' >&2\nexit 1");
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "x\n");
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const error = await flowError(runPlan(deps, buildPlan(ctx, files, report.fingerprints), {}));
    assert.equal(error.kind, "push_hook", `a hook refusal was classified as ${error.kind}`);
  });

  it("the user's own pre-push hook refusing is reported as 'Your pre-push hook stopped the push' (5)", async () => {
    const { sb, deps } = await setup();
    writeHook(path.join(sb.work, ".git"), "pre-push", "echo 'tests failed' >&2\nexit 1");
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "x\n");
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const error = await flowError(runPlan(deps, buildPlan(ctx, files, report.fingerprints), {}));
    assert.equal(error.kind, "push_hook", `a pre-push hook refusal was classified as ${error.kind}`);
  });

  it("remote unreachable: network error, then a retry resumes at the push with no second commit", async () => {
    const { sb, deps } = await setup();
    const realTarget = gitOk(sb.work, sb.env, ["config", "--get-regexp", "^url\\..*\\.insteadof$"]).split(" ")[0];
    gitOk(sb.work, sb.env, ["config", "--unset", realTarget]);
    gitOk(sb.work, sb.env, ["config", `url.${path.join(sb.dir, "missing.git").replace(/\\/g, "/")}.insteadOf`, sb.remoteUrl]);
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "x\n");
    const ctx = await prepareContext(deps);
    assert.equal(ctx.fetchFailed, true, "a failed fetch is only a note");
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const plan = buildPlan(ctx, files, report.fingerprints);
    const state: RunState = {};
    const error = await flowError(runPlan(deps, plan, state));
    assert.equal(error.step, "push");
    assert.equal(error.kind, "network");
    gitOk(sb.work, sb.env, ["config", "--unset", `url.${path.join(sb.dir, "missing.git").replace(/\\/g, "/")}.insteadof`]);
    gitOk(sb.work, sb.env, ["config", `url.${sb.bare.replace(/\\/g, "/")}.insteadOf`, sb.remoteUrl]);
    const commits = gitOk(sb.work, sb.env, ["rev-list", "--count", "HEAD"]);
    const result = await runPlan(deps, plan, state);
    assert.equal(gitOk(sb.work, sb.env, ["rev-list", "--count", "HEAD"]), commits);
    assert.equal(remoteRef(sb, "refs/heads/andromity/round-totals"), result.commit);
  });

  it("start from the latest main: the branch starts at origin/main and carries the uncommitted change (3.1)", async () => {
    const { sb, api, deps } = await setup();
    const other = otherClone(sb);
    fs.writeFileSync(path.join(other, "other.txt"), "new upstream file\n");
    gitOk(other, sb.env, ["add", "-A"]);
    gitOk(other, sb.env, ["commit", "-q", "-m", "upstream work"]);
    gitOk(other, sb.env, ["push", "-q", "origin", "main"]);
    const upstream = remoteRef(sb, "refs/heads/main");
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "mine\n");
    const ctx = await prepareContext(deps);
    assert.equal(ctx.behind, 1);
    assert.deepEqual(ctx.changedOnBase, ["other.txt"]);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const result = await runPlan(deps, buildPlan(ctx, files, report.fingerprints, { startFrom: "origin/main" }), {});
    assert.equal(gitOk(sb.work, sb.env, ["rev-parse", `${result.commit}^`]), upstream);
    assert.equal(remoteRef(sb, "refs/heads/main"), upstream);
    assert.ok(api.requests.some((r) => r.method === "POST" && r.url.endsWith("/pulls")));
    assert.notEqual(gitOk(sb.work, sb.env, ["rev-parse", "main"]), upstream, "local main is never moved");
  });

  it("start from the latest main when the same file changed there: git refuses, nothing created, change kept (3.1, 4.2)", async () => {
    const { sb, deps } = await setup();
    const other = otherClone(sb);
    fs.writeFileSync(path.join(other, "orders", "totals.py"), "theirs\n");
    gitOk(other, sb.env, ["commit", "-q", "-am", "upstream change to totals"]);
    gitOk(other, sb.env, ["push", "-q", "origin", "main"]);
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "mine\n");
    const ctx = await prepareContext(deps);
    assert.deepEqual(ctx.changedOnBase, ["orders/totals.py"], "overlap detected so the form can turn the option off");
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const error = await flowError(runPlan(deps, buildPlan(ctx, files, report.fingerprints, { startFrom: "origin/main" }), {}));
    assert.equal(error.kind, "would_overwrite");
    assert.equal(gitOk(sb.work, sb.env, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(gitSync(sb.work, sb.env, ["show-ref", "--verify", "--quiet", "refs/heads/andromity/round-totals"]).status, 1, "the branch was left behind");
    assert.equal(fs.readFileSync(path.join(sb.work, "orders", "totals.py"), "utf8"), "mine\n");
  });

  it("a file edited after review is refused before anything is staged or committed (4.1)", async () => {
    const { sb, api, deps } = await setup();
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "reviewed\n");
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "reviewed\nsneaky = 1\n");
    const error = await flowError(runPlan(deps, buildPlan(ctx, files, report.fingerprints), {}));
    assert.equal(error.kind, "changed_after_review");
    assert.equal(gitOk(sb.work, sb.env, ["diff", "--cached", "--name-only"]), "");
    assert.equal(gitOk(sb.work, sb.env, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(api.requests.filter((r) => r.method === "POST").length, 0);
  });

  it("another file already staged: found, unstaged when the user chooses, never committed", async () => {
    const { sb, deps } = await setup();
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "mine\n");
    fs.writeFileSync(path.join(sb.work, "notes.txt"), "someone staged this\n");
    gitOk(sb.work, sb.env, ["add", "notes.txt"]);
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    assert.deepEqual(report.stagedOutside, ["notes.txt"]);
    const result = await runPlan(deps, buildPlan(ctx, files, report.fingerprints, { unstageFirst: report.stagedOutside }), {});
    assert.deepEqual(gitOk(sb.work, sb.env, ["show", "--name-only", "--format=", result.commit]).split("\n"), ["orders/totals.py"]);
    assert.equal(gitOk(sb.work, sb.env, ["status", "--porcelain"]), "M notes.txt");
  });

  it("another file staged and the user didn't choose: the flow refuses to commit it", async () => {
    const { sb, deps } = await setup();
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "mine\n");
    fs.writeFileSync(path.join(sb.work, "notes.txt"), "staged\n");
    gitOk(sb.work, sb.env, ["add", "notes.txt"]);
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const error = await flowError(runPlan(deps, buildPlan(ctx, files, report.fingerprints), {}));
    assert.equal(error.kind, "other_staged");
    assert.equal(gitOk(sb.work, sb.env, ["rev-list", "--count", "HEAD"]), "1");
  });

  it("a rename stages both sides; a deletion is committed as a deletion", async () => {
    const { sb, deps } = await setup();
    gitOk(sb.work, sb.env, ["mv", "README.md", "docs.md"]);
    gitOk(sb.work, sb.env, ["reset", "-q"]);
    fs.rmSync(path.join(sb.work, "notes.txt"));
    const ctx = await prepareContext(deps);
    const files: PrFile[] = [
      { path: "docs.md", status: "R", additions: 0, deletions: 0, originalPath: "README.md" },
      { path: "notes.txt", status: "D", additions: 0, deletions: 1 },
    ];
    const report = await evaluateSelection(deps, files);
    const result = await runPlan(deps, buildPlan(ctx, files, report.fingerprints), {});
    const names = gitOk(sb.work, sb.env, ["show", "--name-status", "--format=", "-M", result.commit]);
    assert.match(names, /R\d*\tREADME\.md\tdocs\.md/);
    assert.match(names, /D\tnotes\.txt/);
  });

  it("detached HEAD: goes on a new branch from that commit", async () => {
    const { sb, deps } = await setup();
    gitOk(sb.work, sb.env, ["checkout", "-q", "--detach"]);
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "detached\n");
    const ctx = await prepareContext(deps);
    assert.equal(ctx.head.branch, null);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const state: RunState = {};
    const result = await runPlan(deps, buildPlan(ctx, files, report.fingerprints), state);
    assert.equal(state.originalBranch, null);
    assert.equal(remoteRef(sb, "refs/heads/andromity/round-totals"), result.commit);
  });

  it("branch with an open pull request: commits onto it and comments the receipt, no new pull request", async () => {
    const { sb, api, deps } = await setup();
    gitOk(sb.work, sb.env, ["checkout", "-q", "-b", "feature/x"]);
    gitOk(sb.work, sb.env, ["push", "-q", "-u", "origin", "feature/x"]);
    api.openPulls.push({ number: 7, head: "feature/x", title: "Existing" });
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "update\n");
    const ctx = await prepareContext(deps);
    assert.equal(ctx.existingPull?.number, 7);
    const files = [prFile(sb, "orders/totals.py")];
    const report = await evaluateSelection(deps, files);
    const result = await runPlan(deps, buildPlan(ctx, files, report.fingerprints, {
      mode: "update", branch: "feature/x", createBranch: false, existingPull: ctx.existingPull, commentFor: (c) => `receipt ${c}`,
    }), {});
    assert.equal(remoteRef(sb, "refs/heads/feature/x"), result.commit);
    assert.equal(api.requests.filter((r) => r.method === "POST" && r.url.endsWith("/pulls")).length, 0);
    const comment = api.requests.find((r) => r.url.endsWith("/issues/7/comments"))!;
    assert.equal(comment.body.body, `receipt ${result.commit}`);
  });

  it("a secret added in the change is found with its line, and only new lines count", async () => {
    const { sb, deps } = await setup();
    const key = "AKIA" + "ZXCVBNMASDFGHJKL";
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), `def total(x):\n    return x\nKEY = "${key}"\n`);
    const report = await evaluateSelection(deps, [prFile(sb, "orders/totals.py")]);
    assert.deepEqual(report.secrets.map((s) => [s.path, s.line, s.kind]), [["orders/totals.py", 3, "AWS access key"]]);
    gitOk(sb.work, sb.env, ["commit", "-qam", "key already in HEAD"]);
    fs.appendFileSync(path.join(sb.work, "orders", "totals.py"), "# unrelated\n");
    const again = await evaluateSelection(deps, [prFile(sb, "orders/totals.py")]);
    assert.deepEqual(again.secrets, [], "a key already in HEAD is not new");
  });

  it("nothing here ever reached a real host: every API call went to 127.0.0.1", async () => {
    const { sb, api, deps } = await setup();
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "z\n");
    const ctx = await prepareContext(deps);
    const files = [prFile(sb, "orders/totals.py")];
    await runPlan(deps, buildPlan(ctx, files, (await evaluateSelection(deps, files)).fingerprints), {});
    assert.ok(api.requests.length > 0);
    assert.ok(api.base.startsWith("http://127.0.0.1:"));
    assert.equal(sb.env.GIT_ALLOW_PROTOCOL, "file");
  });
});
