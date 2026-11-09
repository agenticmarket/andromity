// Independent adversarial tests for the Create pull request flow with fakes (git port, GitHub API).
// Spec: private/design/create-pr/DESIGN.md 4.1, 4.2, 5 (failure table + resume), 7.2 rules 1, 3, 6.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FlowDeps, FlowError, RunPlan, RunState, classifyGitError, evaluateSelection, fingerprintOf, freeBranchName, moveToFreshBranch,
  pathsToStage, prepareContext, runPlan, stepsFor,
} from "../src/integrations/pullRequest/flow.js";
import { parseRemoteUrl } from "../src/integrations/pullRequest/remotes.js";
import { FakeGit, FakeGitHub } from "./helpers/prFakes.js";
import { installVscodeStub } from "./helpers/prVscodeStub.js";

installVscodeStub();
const { VscodeGitPort } = require("../src/integrations/pullRequest/vscodeGit.js") as typeof import("../src/integrations/pullRequest/vscodeGit.js");

const AWS = "AKIA" + "QWERTYUIOPASDFGH";

function files(map: Record<string, string | Uint8Array | null>) {
  return async (rel: string) => {
    const value = map[rel];
    if (value === undefined || value === null) return null;
    return typeof value === "string" ? Buffer.from(value) : value;
  };
}

function deps(git: FakeGit, gh: FakeGitHub | null, content: Record<string, string | Uint8Array | null> = {}, diffs: Record<string, { diff: string; omitted: boolean }> = {}): FlowDeps {
  return {
    git,
    github: gh ? gh.client() : null,
    readFile: files(content),
    fileDiff: async (rel) => diffs[rel] ?? null,
    airGap: { enabled: false, allowedHosts: [] },
    enterpriseHosts: [],
  };
}

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    mode: "pull_request",
    remote: "origin",
    parsed: parseRemoteUrl("https://github.com/acme/orders.git"),
    target: { owner: "acme", repo: "orders" },
    headOwner: "acme",
    base: "main",
    branch: "andromity/round-totals",
    createBranch: true,
    files: ["orders/totals.py"],
    unstageFirst: [],
    fingerprints: { "orders/totals.py": fingerprintOf(Buffer.from("v1")) },
    commitMessage: "fix(orders): round totals\n\nCo-authored-by: Andromity <x@y>",
    signoff: false,
    title: "fix(orders): round totals",
    bodyFor: (commit) => `Body for ${commit}`,
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
    assert.ok(error instanceof FlowError, `expected FlowError, got ${error}`);
    return error as FlowError;
  }
  assert.fail("expected the flow to fail");
}

let git: FakeGit;
let gh: FakeGitHub;
beforeEach(() => {
  git = new FakeGit();
  gh = new FakeGitHub();
});

describe("prepareContext: reads only, plus the base fetch (4.1, 3.1)", () => {
  it("touches nothing but a fetch of the base branch, and reads GitHub", async () => {
    git.behind = 6;
    git.changedOnBase = ["orders/totals.py"];
    const ctx = await prepareContext(deps(git, gh));
    assert.deepEqual(git.mutating(), ["fetch"]);
    assert.deepEqual(git.calls.find((c) => c.name === "fetch")!.args, ["origin", "main"]);
    assert.equal(ctx.behind, 6);
    assert.deepEqual(ctx.changedOnBase, ["orders/totals.py"]);
    assert.equal(ctx.github.viewer, "ada");
    assert.equal(ctx.remote?.parsed?.display, "github.com/acme/orders");
    assert.ok(gh.calls.every((c) => c.method === "GET"), "no writes to GitHub while preparing");
  });

  it("never shows or keeps a token from the remote URL", async () => {
    git.remoteList = [{ name: "origin", fetchUrl: "https://x-access-token:ghs_SECRETSECRETSECRET@github.com/acme/orders.git" }];
    const ctx = await prepareContext(deps(git, gh));
    assert.ok(!JSON.stringify(ctx).includes("ghs_SECRET"));
  });

  it("signed out: no API calls, problem is signed_out", async () => {
    const ctx = await prepareContext(deps(git, null));
    assert.equal(ctx.github.problem, "signed_out");
  });

  it("SSO and expired sign-in are reported, not thrown", async () => {
    gh.routes["GET /repos/acme/orders"] = { status: 403, body: {}, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=Z" } };
    const ctx = await prepareContext(deps(git, gh));
    assert.equal(ctx.github.problem, "sso");
    assert.equal(ctx.github.ssoUrl, "https://github.com/orgs/acme/sso?authorization_request=Z");
    const gh2 = new FakeGitHub();
    gh2.routes["GET /user"] = { status: 401, body: {} };
    assert.equal((await prepareContext(deps(new FakeGit(), gh2))).github.problem, "unauthorized");
  });

  it("air-gap: GitHub never called; push and fetch only to allowed hosts (6)", async () => {
    const d = { ...deps(git, gh), airGap: { enabled: true, allowedHosts: [] } };
    const ctx = await prepareContext(d);
    assert.equal(ctx.canReachRemote, false);
    assert.equal(gh.calls.length, 0);
    assert.deepEqual(git.mutating(), [], "fetched from a host that isn't allowed in air-gap mode");
    const allowedGit = new FakeGit();
    allowedGit.remoteList = [{ name: "origin", fetchUrl: "https://git.corp.local/team/orders.git" }];
    const allowed = await prepareContext({ ...deps(allowedGit, gh), airGap: { enabled: true, allowedHosts: ["git.corp.local"] } });
    assert.equal(allowed.canReachRemote, true);
    assert.equal(gh.calls.length, 0);
  });

  it("air-gap: the fetch goes to the fetch URL, so the fetch URL's host must be allowed too", async () => {
    git.remoteList = [{ name: "origin", fetchUrl: "https://github.com/acme/orders.git", pushUrl: "https://git.corp.local/acme/orders.git" }];
    await prepareContext({ ...deps(git, null), airGap: { enabled: true, allowedHosts: ["git.corp.local"] } });
    assert.deepEqual(git.mutating(), [], "air-gap: fetched from github.com because only the push URL was checked");
  });

  it("fetch failure is a note, not a failure (3.1)", async () => {
    git.failures.fetch = [Object.assign(new Error("Could not resolve host"), { gitErrorCode: "RemoteConnectionError" })];
    const ctx = await prepareContext(deps(git, gh));
    assert.equal(ctx.fetchFailed, true);
  });

  it("fork: target is the parent, head owner is the fork, base fetched from the parent's remote", async () => {
    gh = new FakeGitHub("me", "orders", { fork: true, parent: { name: "orders", owner: { login: "acme" }, default_branch: "trunk" } });
    gh.routes["GET /repos/acme/orders/branches"] = { status: 200, body: [{ name: "trunk" }] };
    git.remoteList = [
      { name: "origin", fetchUrl: "git@github.com:me/orders.git" },
      { name: "upstream", fetchUrl: "https://github.com/acme/orders.git" },
    ];
    git.remoteHead = {};
    const ctx = await prepareContext(deps(git, gh));
    assert.deepEqual(ctx.github.target, { owner: "acme", repo: "orders" });
    assert.equal(ctx.github.headOwner, "me");
    assert.equal(ctx.base, "trunk");
    assert.equal(ctx.baseRemote, "upstream");
    assert.deepEqual(git.calls.find((c) => c.name === "fetch")!.args, ["upstream", "trunk"]);
  });

  it("existing open pull request for the current branch is found; on the base branch it isn't looked up", async () => {
    git.branch = "feature/x";
    gh.routes["GET /repos/acme/orders/pulls"] = { status: 200, body: [{ number: 41, html_url: "https://github.com/acme/orders/pull/41", title: "Old" }] };
    const ctx = await prepareContext(deps(git, gh));
    assert.equal(ctx.existingPull?.number, 41);
    assert.ok(gh.calls.some((c) => c.path.includes("head=acme%3Afeature%2Fx")));
    const onMain = await prepareContext(deps(new FakeGit(), gh));
    assert.equal(onMain.existingPull, null);
  });

  it("detached HEAD and an operation in progress are reported", async () => {
    git.branch = null;
    git.inProg = "rebase";
    const ctx = await prepareContext(deps(git, gh));
    assert.equal(ctx.head.branch, null);
    assert.equal(ctx.inProgress, "rebase");
  });

  it("no remote: nothing fetched, nothing asked of GitHub", async () => {
    git.remoteList = [];
    const ctx = await prepareContext(deps(git, gh));
    assert.equal(ctx.remote, null);
    assert.deepEqual(git.mutating(), []);
    assert.equal(gh.calls.length, 0);
  });
});

describe("evaluateSelection: reads only (3.2, 3.6, 4.1)", () => {
  it("fingerprints, secrets on added lines, staged outsiders, nothing mutated", async () => {
    git.staged = new Set(["other.ts", "orders/totals.py"]);
    const diff = `--- a/orders/totals.py\n+++ b/orders/totals.py\n@@ -1,2 +1,3 @@\n a\n+key = "${AWS}"\n b`;
    const report = await evaluateSelection(deps(git, gh, { "orders/totals.py": "a\nkey\nb" }, { "orders/totals.py": { diff, omitted: false } }),
      [{ path: "orders/totals.py", status: "M", additions: 1, deletions: 0 }]);
    assert.deepEqual(git.mutating(), []);
    assert.deepEqual(report.secrets.map((s) => [s.path, s.line, s.kind]), [["orders/totals.py", 2, "AWS access key"]]);
    assert.deepEqual(report.stagedOutside, ["other.ts"]);
    assert.equal(report.fingerprints["orders/totals.py"], fingerprintOf(Buffer.from("a\nkey\nb")));
    assert.ok(!JSON.stringify(report).includes(AWS.slice(4)));
  });

  it("too-large diff: scans the file itself; over 5 MB or binary: names it as not scanned", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 0x61);
    const report = await evaluateSelection(deps(git, gh, { "a.txt": `x\n${AWS}\n`, "big.txt": big, "img.png": new Uint8Array([0x89, 0, 1]) },
      { "a.txt": { diff: "", omitted: true }, "big.txt": { diff: "", omitted: true } }), [
      { path: "a.txt", status: "M", additions: 1, deletions: 0 }, { path: "big.txt", status: "M", additions: 1, deletions: 0 },
      { path: "img.png", status: "A", additions: 0, deletions: 0, binary: true },
    ]);
    assert.deepEqual(report.secrets.map((s) => [s.path, s.line]), [["a.txt", 2]]);
    assert.deepEqual(report.notScanned.sort(), ["big.txt", "img.png"]);
  });

  it("a deleted file fingerprints as deleted; renames stage both sides", async () => {
    const report = await evaluateSelection(deps(git, gh, {}), [{ path: "gone.ts", status: "D", additions: 0, deletions: 3 }]);
    assert.equal(report.fingerprints["gone.ts"], "deleted");
    assert.deepEqual(pathsToStage([{ path: "new.ts", status: "R", additions: 0, deletions: 0, originalPath: "old.ts" }]).sort(), ["new.ts", "old.ts"]);
  });

  it("a renamed file's old side counts as wanted, not as 'other staged'", async () => {
    git.staged = new Set(["old.ts", "new.ts"]);
    const report = await evaluateSelection(deps(git, gh, { "new.ts": "x" }), [{ path: "new.ts", status: "R", additions: 0, deletions: 0, originalPath: "old.ts" }]);
    assert.deepEqual(report.stagedOutside, []);
  });
});

describe("runPlan: the steps (4.2) and the never-list (7.2 rule 6)", () => {
  it("happy path: branch, stage, commit, push, pull request, in order", async () => {
    const steps: string[] = [];
    const state: RunState = {};
    const result = await runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan(), state, (id, status) => steps.push(`${id}:${status}`));
    assert.deepEqual(git.mutating(), ["createBranch", "stage", "commit", "push"]);
    assert.deepEqual(git.calls.find((c) => c.name === "createBranch")!.args, ["andromity/round-totals", undefined]);
    assert.deepEqual(git.calls.find((c) => c.name === "push")!.args, ["origin", "andromity/round-totals"]);
    const create = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
    assert.deepEqual(create.body, { title: "fix(orders): round totals", head: "andromity/round-totals", base: "main", body: `Body for ${result.commit}`, draft: false, maintainer_can_modify: true });
    assert.equal(result.pull?.number, 42);
    assert.equal(git.localBranches.has("main"), true);
    assert.deepEqual(steps.filter((s) => s.endsWith(":done")), ["branch:done", "stage:done", "commit:done", "push:done", "pull:done"]);
    assert.deepEqual(stepsFor(plan()), ["branch", "stage", "commit", "push", "pull"]);
  });

  it("refuses bad plans before touching anything", async () => {
    const bad: Partial<RunPlan>[] = [
      { branch: "-f" }, { branch: "x..y" }, { branch: "main@{1}" }, { base: "--upload-pack=x" }, { files: [] }, { commitMessage: "  \n " },
      { startFrom: "--orphan/x" }, { startFrom: "-c/x" }, { startFrom: "origin/../x" }, { mode: "pull_request", target: null }, { mode: "push", remote: null },
    ];
    const accepted: string[] = [];
    for (const overrides of bad) {
      const g = new FakeGit();
      const ran = await runPlan(deps(g, gh, { "orders/totals.py": "v1" }), plan(overrides), {}).then(() => true, () => false);
      if (ran || g.mutating().length) accepted.push(`${JSON.stringify(overrides)} -> ${g.mutating().join(",")}`);
    }
    assert.deepEqual(accepted, [], "plans the flow should refuse before touching git (option-like start points reach git checkout)");
  });

  it("files changed after review: stops before staging and nothing is touched, not even a new branch (5)", async () => {
    const error = await flowError(runPlan(deps(git, gh, { "orders/totals.py": "v2 changed by a formatter" }), plan(), {}));
    assert.equal(error.kind, "changed_after_review");
    assert.deepEqual(error.paths, ["orders/totals.py"]);
    assert.ok(!git.mutating().includes("stage") && !git.mutating().includes("commit"));
    assert.deepEqual(git.mutating(), [], "a branch was created and checked out although the files changed after review");
  });

  it("a file deleted after review is caught too", async () => {
    const error = await flowError(runPlan(deps(git, gh, {}), plan(), {}));
    assert.equal(error.kind, "changed_after_review");
  });

  it("something else staged at the last moment: no commit", async () => {
    git.afterStage = () => git.staged.add("sneaky.sh");
    const error = await flowError(runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan(), {}));
    assert.equal(error.kind, "other_staged");
    assert.deepEqual(error.paths, ["sneaky.sh"]);
    assert.equal(git.count("commit"), 0);
  });

  it("other staged files the user chose to unstage are unstaged first, only those", async () => {
    git.staged = new Set(["mine.txt"]);
    await runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan({ unstageFirst: ["mine.txt"] }), {});
    assert.deepEqual(git.calls.find((c) => c.name === "unstage")!.args, [["mine.txt"]]);
  });

  it("cancel works until the push starts, and never after (4.2)", async () => {
    let stop = false;
    const listener = (id: string, status: string) => { if (id === "commit" && status === "done") stop = true; };
    const error = await flowError(runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan(), {}, listener, () => stop));
    assert.equal(error.kind, "cancelled");
    assert.equal(error.step, "push");
    assert.equal(git.count("push"), 0);
    const g2 = new FakeGit();
    await flowError(runPlan(deps(g2, gh, { "orders/totals.py": "v1" }), plan(), {}, () => {}, () => true));
    assert.deepEqual(g2.mutating(), []);
    let late = false;
    const g3 = new FakeGit();
    const result = await runPlan(deps(g3, gh, { "orders/totals.py": "v1" }), plan(), {}, (id, status) => { if (id === "push" && status === "running") late = true; }, () => late);
    assert.ok(result.pull, "a cancel after the push started must not stop the pull request");
  });

  it("resume after a push failure: no second commit (5 retry)", async () => {
    git.failures.push = [Object.assign(new Error("x"), { gitErrorCode: "RemoteConnectionError", stderr: "fatal: unable to access 'https://github.com/acme/orders.git/': Could not resolve host: github.com" })];
    const state: RunState = {};
    const d = deps(git, gh, { "orders/totals.py": "v1" });
    const error = await flowError(runPlan(d, plan(), state));
    assert.equal(error.kind, "network");
    assert.equal(error.step, "push");
    const result = await runPlan(d, plan(), state);
    assert.equal(git.count("commit"), 1);
    assert.equal(git.count("createBranch"), 1);
    assert.equal(git.count("push"), 2);
    assert.ok(result.pull);
  });

  it("resume after the pull request call failed: no second push, one pull request", async () => {
    gh.routes["POST /repos/acme/orders/pulls"] = [{ status: 502, body: "" }, { status: 201, body: { number: 50, html_url: "https://github.com/acme/orders/pull/50", title: "t" } }];
    const state: RunState = {};
    const d = deps(git, gh, { "orders/totals.py": "v1" });
    assert.equal((await flowError(runPlan(d, plan(), state))).kind, "gh_unavailable");
    const result = await runPlan(d, plan(), state);
    assert.equal(git.count("push"), 1);
    assert.equal(result.pull?.number, 50);
  });

  it("resume when the first create actually succeeded (lost answer): finds the open pull request instead of a duplicate", async () => {
    gh.routes["POST /repos/acme/orders/pulls"] = [{ status: 504, body: "" }];
    const state: RunState = {};
    const d = deps(git, gh, { "orders/totals.py": "v1" });
    await flowError(runPlan(d, plan(), state));
    gh.routes["GET /repos/acme/orders/pulls"] = { status: 200, body: [{ number: 77, html_url: "https://github.com/acme/orders/pull/77", title: "t" }] };
    const result = await runPlan(d, plan(), state);
    assert.equal(result.pull?.number, 77);
    assert.equal(gh.count("POST", "/pulls"), 1);
  });

  it("resume after a hook stopped the commit: branch kept, commit retried", async () => {
    git.failures.commit = [Object.assign(new Error("Failed to execute git"), { stderr: "pre-commit: lint failed" })];
    const state: RunState = {};
    const d = deps(git, gh, { "orders/totals.py": "v1" });
    const error = await flowError(runPlan(d, plan(), state));
    assert.equal(error.kind, "commit_failed");
    assert.equal(state.branchReady, true);
    await runPlan(d, plan(), state);
    assert.equal(git.count("createBranch"), 1);
    assert.equal(git.count("commit"), 2);
  });

  it("the branch moved under us between attempts: refuses instead of committing elsewhere", async () => {
    const state: RunState = {};
    const d = deps(git, gh, { "orders/totals.py": "v1" });
    git.failures.commit = [new Error("hook")];
    await flowError(runPlan(d, plan(), state));
    git.branch = "main";
    const error = await flowError(runPlan(d, plan(), state));
    assert.equal(error.kind, "branch_moved");
    assert.equal(git.count("commit"), 1);
  });

  it("a reviewer GitHub refuses leaves the pull request open (5)", async () => {
    gh.routes["POST /repos/acme/orders/pulls/42/requested_reviewers"] = { status: 422, body: { message: "Reviews may only be requested from collaborators." } };
    const result = await runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan({ reviewers: ["sam-old"], teams: ["backend"] }), {});
    assert.equal(result.pull?.number, 42);
    assert.equal(result.reviewerProblem?.kind, "invalid");
    const req = gh.calls.find((c) => c.path.endsWith("/requested_reviewers"))!;
    assert.deepEqual(req.body, { reviewers: ["sam-old"], team_reviewers: ["backend"] });
  });

  it("fork: head is owner:branch and the pull request goes to the parent", async () => {
    await runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan({ headOwner: "me", target: { owner: "acme", repo: "orders" } }), {});
    const create = gh.calls.find((c) => c.method === "POST" && c.path === "/repos/acme/orders/pulls")!;
    assert.equal(create.body.head, "me:andromity/round-totals");
    assert.ok(gh.calls.some((c) => c.path.includes("head=me%3Aandromity%2Fround-totals")));
  });

  it("update an existing pull request: commit, push, receipt comment; no new pull request", async () => {
    git.branch = "feature/x";
    const existing = { number: 41, htmlUrl: "https://github.com/acme/orders/pull/41", title: "Old" };
    const result = await runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan({
      mode: "update", branch: "feature/x", createBranch: false, existingPull: existing, commentFor: (c) => `receipt for ${c}`,
    }), {});
    assert.equal(gh.count("POST", "/pulls"), 0);
    const comment = gh.calls.find((c) => c.path === "/repos/acme/orders/issues/41/comments")!;
    assert.equal(comment.body.body, `receipt for ${result.commit}`);
    assert.equal(git.count("createBranch"), 0);
  });

  it("host page: push then the page URL, no GitHub API", async () => {
    const parsed = parseRemoteUrl("https://gitlab.com/group/orders.git")!;
    const result = await runPlan(deps(git, null, { "orders/totals.py": "v1" }), plan({ mode: "host_page", parsed, target: null }), {});
    assert.equal(result.pageUrl, "https://gitlab.com/group/orders/-/merge_requests/new?merge_request%5Bsource_branch%5D=andromity%2Fround-totals&merge_request%5Btarget_branch%5D=main");
    assert.equal(git.count("push"), 1);
  });

  it("commit only: nothing leaves the machine", async () => {
    await runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan({ mode: "commit" }), {});
    assert.equal(git.count("push"), 0);
    assert.equal(gh.calls.length, 0);
  });

  it("start from the latest main: created at origin/main; git refusing to move the changes leaves no branch", async () => {
    git.failures.createBranch = [Object.assign(new Error("Failed to execute git"), { stderr: "error: Your local changes to the following files would be overwritten by checkout:\n\torders/totals.py\nPlease commit your changes or stash them before you switch branches.\nAborting" })];
    const error = await flowError(runPlan(deps(git, gh, { "orders/totals.py": "v1" }), plan({ startFrom: "origin/main" }), {}));
    assert.equal(error.kind, "would_overwrite");
    assert.equal(git.branch, "main");
    assert.deepEqual(git.calls.find((c) => c.name === "createBranch")!.args, ["andromity/round-totals", "origin/main"]);
  });

  it("push rejected: a fresh -N name at the same commit, never a force push", async () => {
    git.localBranches.add("andromity/round-totals-2");
    const ctx = await prepareContext(deps(git, gh));
    const name = await moveToFreshBranch(deps(git, gh), ctx, plan());
    assert.equal(name, "andromity/round-totals-3");
    assert.deepEqual(git.calls.filter((c) => c.name === "createBranch").map((c) => c.args), [["andromity/round-totals-3", undefined]]);
  });

  it("freeBranchName treats a remote-tracking ref and a GitHub branch as taken", async () => {
    git.remoteRefs.add("origin/andromity/x");
    gh.routes["GET /repos/acme/orders/branches/andromity%2Fx-2"] = { status: 200, body: {} };
    const ctx = await prepareContext(deps(git, gh));
    assert.equal(await freeBranchName(deps(git, gh), ctx, "andromity/x"), "andromity/x-3");
  });
});

describe("classifying vscode.git errors (5) — shapes as vscode.git 1.145 produces them", () => {
  // vscode.git sets gitErrorCode PushRejected for ANY "error: failed to push some refs", whatever the reason.
  const failedRefs = "error: failed to push some refs to 'https://github.com/acme/orders.git'";
  const cases: [string, unknown, string][] = [
    ["non-fast-forward", { gitErrorCode: "PushRejected", stderr: `To https://github.com/acme/orders.git\n ! [rejected]        x -> x (fetch first)\n${failedRefs}\nhint: Updates were rejected because the remote contains work` }, "push_rejected"],
    ["protected branch (GH006)", { gitErrorCode: "PushRejected", stderr: `remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)\n${failedRefs}` }, "protected"],
    ["server pre-receive hook", { gitErrorCode: "PushRejected", stderr: `remote: policy: commits must be signed\nTo https://github.com/acme/orders.git\n ! [remote rejected] x -> x (pre-receive hook declined)\n${failedRefs}` }, "push_hook"],
    ["local pre-push hook", { gitErrorCode: "PushRejected", stderr: `pre-push: tests failed\n${failedRefs}` }, "push_hook"],
    ["large file (GH001)", { gitErrorCode: "PushRejected", stderr: `remote: error: GH001: Large files detected.\n ! [remote rejected] x -> x (pre-receive hook declined)\n${failedRefs}` }, "too_large"],
    ["workflow scope", { gitErrorCode: "PushRejected", stderr: ` ! [remote rejected] x -> x (refusing to allow an OAuth App to create or update workflow \`.github/workflows/ci.yml\` without \`workflow\` scope)\n${failedRefs}` }, "workflow_scope"],
    ["https no access", { gitErrorCode: "PermissionDenied", stderr: "remote: Permission to acme/orders.git denied to bob.\nfatal: unable to access 'https://github.com/acme/orders.git/': The requested URL returned error: 403" }, "no_access"],
    ["ssh key not accepted", { gitErrorCode: "PermissionDenied", stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights" }, "auth"],
    ["https auth", { gitErrorCode: "AuthenticationFailed", stderr: "fatal: Authentication failed for 'https://github.com/acme/orders.git/'" }, "auth"],
    ["offline", { gitErrorCode: "RemoteConnectionError", stderr: "fatal: unable to access 'https://github.com/acme/orders.git/': Could not resolve host: github.com" }, "network"],
  ];
  for (const [name, error, kind] of cases) it(name, () => assert.equal(classifyGitError("push", error), kind));

  it("commit-step errors", () => {
    assert.equal(classifyGitError("commit", { stderr: "*** Please tell me who you are." }), "identity");
    assert.equal(classifyGitError("commit", { stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object" }), "signing");
    assert.equal(classifyGitError("commit", { stderr: "pre-commit hook failed" }), "commit_failed");
    assert.equal(classifyGitError("branch", { gitErrorCode: "BranchAlreadyExists" }), "branch_exists");
    assert.equal(classifyGitError("push", null), "git_failed");
  });
});

describe("VscodeGitPort over a fake vscode.git repository (4.2 'how')", () => {
  function fakeRepo(root: string) {
    const calls: { name: string; args: unknown[] }[] = [];
    const repo: any = {
      rootUri: { fsPath: root },
      state: {
        HEAD: { type: 0, name: "main", commit: "abc1234" },
        remotes: [{ name: "origin", fetchUrl: "https://github.com/acme/orders.git" }],
        indexChanges: [
          { uri: { fsPath: path.join(root, "a.ts") } },
          { uri: { fsPath: path.join(root, "new.ts") }, originalUri: { fsPath: path.join(root, "old.ts") }, renameUri: { fsPath: path.join(root, "new.ts") } },
          { uri: { fsPath: path.join(root, "..", "outside.ts") } },
        ],
        refs: [],
      },
      status: async () => {},
      getConfig: async (key: string) => (key === "user.name" ? " Ada " : ""),
      getRefs: async (q: { pattern: string }) => {
        calls.push({ name: "getRefs", args: [q] });
        return [
          { type: 0, name: "main", commit: "1" }, { type: 0, name: "main/sub", commit: "1" },
          { type: 1, name: "origin/HEAD", commit: "2", remote: "origin" }, { type: 1, name: "origin/develop", commit: "2", remote: "origin" },
          { type: 1, name: "origin/main", commit: "2", remote: "origin" },
        ].filter((r) => (r.type === 0 ? `refs/heads/${r.name}` : `refs/remotes/${r.name}`).startsWith(q.pattern));
      },
    };
    for (const name of ["fetch", "log", "diffBetween", "createBranch", "checkout", "add", "revert", "commit", "push"]) {
      repo[name] = async (...args: unknown[]) => {
        calls.push({ name, args });
        return name === "log" ? [{ hash: "1" }, { hash: "2" }] : name === "diffBetween" ? [{ uri: { fsPath: path.join(root, "x.ts") } }] : undefined;
      };
    }
    return { repo, calls };
  }

  it("pushes with set-upstream and never a force mode; commits with only signoff; stages absolute paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-pr-port-"));
    try {
      const { repo, calls } = fakeRepo(root);
      const port = new VscodeGitPort(repo, root);
      await port.push("origin", "andromity/x");
      await port.commit("msg", true);
      await port.stage(["dir/a.ts"]);
      await port.createBranch("andromity/x", "origin/main");
      const push = calls.find((c) => c.name === "push")!;
      assert.deepEqual(push.args, ["origin", "andromity/x", true], "push must be (remote, branch, setUpstream) with no force mode");
      assert.deepEqual(calls.find((c) => c.name === "commit")!.args, ["msg", { signoff: true }]);
      assert.deepEqual(calls.find((c) => c.name === "add")!.args, [[path.join(root, "dir", "a.ts")]]);
      assert.deepEqual(calls.find((c) => c.name === "createBranch")!.args, ["andromity/x", true, "origin/main"]);
      assert.deepEqual((await port.stagedPaths()).sort(), ["a.ts", "new.ts", "old.ts"], "paths outside the repository must never be reported");
      assert.equal(await port.config("user.name"), "Ada");
      assert.equal(await port.config("user.email"), undefined);
      assert.equal(await port.localBranchExists("main"), true);
      assert.equal(await port.localBranchExists("mai"), false);
      assert.equal(await port.remoteBranchKnown("origin", "main"), true);
      assert.equal(await port.countCommits("HEAD..origin/main"), 2);
      assert.deepEqual(await port.changedSince("HEAD", "origin/main"), ["x.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("remotes are read after a status refresh: a repository vscode.git has only just opened still shows its origin (found in the real VS Code run)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-pr-port-"));
    try {
      const { repo } = fakeRepo(root);
      const remotes = repo.state.remotes;
      repo.state.remotes = [];
      // vscode.git fills state.remotes on its first status run, which may still be in flight when the form opens.
      repo.status = async () => { await new Promise((r) => setTimeout(r, 20)); repo.state.remotes = remotes; };
      const port = new VscodeGitPort(repo, root);
      const ctx = await prepareContext({ git: port, github: null, readFile: async () => null, fileDiff: async () => null, airGap: { enabled: false, allowedHosts: [] }, enterpriseHosts: [] });
      assert.equal(ctx.remote?.name, "origin", "prepareContext saw no remote, so the form would offer Commit / Publish to GitHub only");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("origin/HEAD is followed: when it points at develop, develop is the base even if main has the same commit (3.1)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-pr-port-"));
    try {
      const { repo } = fakeRepo(root);
      // origin/HEAD, origin/develop and origin/main all at commit 2: from commits alone this is ambiguous, so the
      // port must not guess main. (Fixture corrected after review: the first version gave no symbolic ref at all.)
      assert.equal(await new VscodeGitPort(repo, root).remoteHeadBranch("origin"), undefined, "guessed a base from an ambiguous origin/HEAD");
      // git's symbolic ref says origin/HEAD -> develop.
      fs.mkdirSync(path.join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/develop\n");
      assert.equal(await new VscodeGitPort(repo, root).remoteHeadBranch("origin"), "develop");
      // A worktree: .git is a file pointing at a git dir whose commondir holds the shared refs.
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-pr-wt-"));
      try {
        const gitDir = path.join(root, ".git", "worktrees", "wt");
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
        fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitDir}\n`);
        assert.equal(await new VscodeGitPort(repo, wt).remoteHeadBranch("origin"), "develop");
      } finally {
        fs.rmSync(wt, { recursive: true, force: true });
      }
      // A hostile remote name or pointer never escapes refs/remotes or yields an unusable base.
      fs.writeFileSync(path.join(root, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/../../heads/evil\n");
      const ctx = await prepareContext({ git: new VscodeGitPort(repo, root), github: null, readFile: async () => null, fileDiff: async () => null, airGap: { enabled: false, allowedHosts: [] }, enterpriseHosts: [] });
      assert.ok(!ctx.base.includes(".."), ctx.base);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("merge, rebase, cherry-pick and revert in progress are read from the git directory, also for a worktree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "andromity-pr-port-"));
    try {
      const { repo } = fakeRepo(root);
      const port = new VscodeGitPort(repo, root);
      const gitDir = path.join(root, "real-git-dir");
      fs.mkdirSync(gitDir);
      fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDir}\n`);
      assert.equal(await port.inProgress(), null);
      for (const [file, kind] of [["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]]) {
        fs.writeFileSync(path.join(gitDir, file), "x");
        assert.equal(await port.inProgress(), kind);
        fs.rmSync(path.join(gitDir, file));
      }
      fs.mkdirSync(path.join(gitDir, "rebase-merge"));
      assert.equal(await port.inProgress(), "rebase");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
