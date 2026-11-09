// Adversarial tests aimed at the fixes in commit 2358148 (Create pull request): the new push-error classifier,
// closeOpenBlocks, looksSensitive, the GitHub timeout, the air-gap reachability check and the Azure project rule.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyGitError, evaluateSelection, pathsToStage, prepareContext, runPlan, FlowError, FlowDeps, RunPlan } from "../src/integrations/pullRequest/flow.js";
import { composeBody, closeOpenBlocks } from "../src/integrations/pullRequest/body.js";
import { looksSensitive } from "../src/integrations/pullRequest/checks.js";
import { GitHubClient, GitHubError } from "../src/integrations/pullRequest/github.js";
import { parseRemoteUrl } from "../src/integrations/pullRequest/remotes.js";
import { FakeGit } from "./helpers/prFakes.js";
import { GitCliPort, gitOk, makeSandbox, otherClone } from "./helpers/prRealGit.js";

const failedRefs = "error: failed to push some refs to 'https://github.com/acme/orders.git'";

describe("classifyGitError after the reorder: names in the output must not change the verdict (5)", () => {
  const nonFastForward = (branch: string, repo = "orders") =>
    ({ gitErrorCode: "PushRejected", stderr: `To https://github.com/acme/${repo}.git\n ! [rejected]        ${branch} -> ${branch} (fetch first)\n${failedRefs.replace("orders", repo)}\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally.` });

  it("a branch named after the change (andromity/fix-pre-push-hook) rejected for other commits is still 'other commits'", () => {
    assert.equal(classifyGitError("push", nonFastForward("andromity/fix-pre-push-hook")), "push_rejected");
  });

  it("a repository called pre-push-tools rejected for other commits is still 'other commits'", () => {
    assert.equal(classifyGitError("push", nonFastForward("andromity/x", "pre-push-tools")), "push_rejected");
  });

  it("a branch named …remote-rejected… is still 'other commits'", () => {
    assert.equal(classifyGitError("push", nonFastForward("andromity/handle-remote-rejected-pushes")), "push_rejected");
  });

  it("the real hook cases stay hooks; GH006 stays protected", () => {
    assert.equal(classifyGitError("push", { gitErrorCode: "PushRejected", stderr: ` ! [remote rejected] x -> x (pre-receive hook declined)\n${failedRefs}` }), "push_hook");
    assert.equal(classifyGitError("push", { gitErrorCode: "PushRejected", stderr: `tests failed\n${failedRefs}` }), "push_hook");
    assert.equal(classifyGitError("push", { gitErrorCode: "PushRejected", stderr: `remote: error: GH006: Protected branch update failed\n ! [remote rejected] main -> main (protected branch hook declined)\n${failedRefs}` }), "protected");
    assert.equal(classifyGitError("push", { gitErrorCode: "PermissionDenied", stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository." }), "auth");
  });
});

describe("real git: a non-fast-forward rejection on a branch whose name mentions a hook", { timeout: 60_000 }, () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

  it("andromity/fix-pre-push-hook taken on the remote: offered 'Push under a new name', not 'a hook refused'", async () => {
    const sb = makeSandbox("orders");
    cleanups.push(() => sb.cleanup());
    const branch = "andromity/fix-pre-push-hook";
    const other = otherClone(sb);
    gitOk(other, sb.env, ["checkout", "-q", "-b", branch]);
    fs.writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
    gitOk(other, sb.env, ["add", "-A"]);
    gitOk(other, sb.env, ["commit", "-q", "-m", "theirs"]);
    gitOk(other, sb.env, ["push", "-q", "origin", branch]);
    fs.writeFileSync(path.join(sb.work, "orders", "totals.py"), "mine\n");
    const deps: FlowDeps = {
      git: new GitCliPort(sb.work, sb.env), github: null,
      readFile: async (rel) => fs.readFileSync(path.join(sb.work, ...rel.split("/"))), fileDiff: async () => null,
      airGap: { enabled: false, allowedHosts: [] }, enterpriseHosts: [],
    };
    const ctx = await prepareContext(deps);
    const files = [{ path: "orders/totals.py", status: "M", additions: 1, deletions: 2 }];
    const report = await evaluateSelection(deps, files);
    const plan: RunPlan = {
      mode: "push", remote: "origin", parsed: ctx.remote!.parsed, target: null, headOwner: null, base: "main", branch, createBranch: true,
      files: pathsToStage(files), unstageFirst: [], fingerprints: report.fingerprints, commitMessage: "fix: pre-push hook", signoff: false,
      title: "t", bodyFor: () => "", draft: false, reviewers: [], teams: [], existingPull: null, commentFor: null,
    };
    let kind = "";
    try {
      await runPlan(deps, plan, {});
    } catch (error) {
      kind = error instanceof FlowError ? error.kind : String(error);
    }
    assert.equal(kind, "push_rejected", `classified as ${kind}: the form would say a hook refused and drop "Push under a new name"`);
  });
});

/** Where a CommonMark reader is when it reaches `marker`: inside an open fenced code block or not. */
function insideFence(body: string, marker: string): boolean {
  let open: { ch: string; len: number } | null = null;
  for (const line of body.split("\n")) {
    if (line.includes(marker) && !open) return false;
    if (line.includes(marker) && open) return true;
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const run = m[1];
    if (!open) {
      if (run[0] === "`" && m[2].includes("`")) continue;
      open = { ch: run[0], len: run.length };
    } else if (run[0] === open.ch && run.length >= open.len && !m[2].trim()) {
      open = null;
    }
  }
  return !!open;
}

describe("closeOpenBlocks: the receipt must still render after any description (3.5, 7.2 rule 9)", () => {
  const link = { turnIndex: 0, commitSha: "abcdef1", leftOut: [], extra: [] };
  const cases = [
    "Looks fine.\n```", "Looks fine.\n````", "````\n```\n````", "Looks fine.\n~~~~", "```js\ncode\n``", "````md\n```\nnested\n```",
    "   ```\nindented fence", "~~~\n```\n", "```\n~~~\n",
  ];
  for (const description of cases) {
    it(JSON.stringify(description), () => {
      const { body } = composeBody(description, { markdown: "### Receipt\nNeeds your eyes", link });
      assert.equal(insideFence(body, "<sub>Receipt for Andromity"), false, `the receipt line renders inside a code block:\n${body}`);
      assert.equal(insideFence(body, "### Receipt"), false, "the receipt renders inside a code block");
    });
  }

  it("a balanced description is left exactly as written", () => {
    for (const text of ["plain", "```\ncode\n```", "<details><summary>x</summary>y</details>", "<!-- note -->", "a `inline` b"]) {
      assert.equal(closeOpenBlocks(text), text);
    }
  });

  it("still closes an unclosed comment, details and pre", () => {
    const { body } = composeBody("x <!-- hidden\n<details>\n<pre>", { markdown: "### Receipt", link });
    const before = body.slice(0, body.indexOf("<sub>Receipt for"));
    assert.ok(before.lastIndexOf("-->") > before.lastIndexOf("<!--"));
    assert.ok(/<\/details>/.test(before) && /<\/pre>/.test(before));
  });
});

describe("looksSensitive matches the engine's security.is_sensitive_path (values computed from the engine)", () => {
  // From src/andromity/core/security.py is_sensitive_path, run on 2026-11-08.
  const engine: Record<string, boolean> = {
    ".env": true, ".ENV": true, ".env.local": true, ".env ": true, ".env.": true, ".env::$DATA": true, " .env": true, "dir/.env": true,
    "config.toml": true, "app/config.toml": true, "id_rsa": true, "id_rsa.pub": false, ".ssh/config": true, ".git/config": true,
    ".github/workflows/ci.yml": false, ".aws/credentials": true, "secrets.yaml": true, "secret.py": true, "x.secret.ts": false, "token.ts": false,
    "tokens.md": true, "password-reset.md": true, "api_token.txt": true, "credentials.json": true, ".git-credentials": true, ".npmrc": false,
    ".netrc": false, "server.key": false, "cert.pem": false, "notes/my-secret-plan.md": true, "src/tokenizer.ts": false, ".gnupg/x": true,
    "Secrets/readme.md": false, "a/b/.Env.Production": true, "passwords.PY": true, "x.envrc": false, ".envrc": false,
  };
  for (const [name, expected] of Object.entries(engine)) {
    it(JSON.stringify(name), () => assert.equal(looksSensitive(name), expected));
  }
});

describe("GitHub timeout after the fix", () => {
  it("a body that arrives in time is read normally; a stalled body times out; no stray timer keeps the process alive", async () => {
    const ok = new GitHubClient("t", async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ login: "octo" }) }), "https://api.github.com", 200);
    assert.equal(await ok.viewer(), "octo");
    const slowButOk = new GitHubClient("t", async () => ({ status: 200, headers: { get: () => null }, text: () => new Promise((r) => setTimeout(() => r(JSON.stringify({ login: "late" })), 50)) }), "https://api.github.com", 500);
    assert.equal(await slowButOk.viewer(), "late");
    const stalled = new GitHubClient("t", async () => ({ status: 500, headers: { get: () => null }, text: () => new Promise<string>(() => {}) }), "https://api.github.com", 100);
    await assert.rejects(stalled.viewer(), (e: unknown) => e instanceof GitHubError && e.kind === "timeout");
    const throws = new GitHubClient("t", async () => ({ status: 404, headers: { get: () => null }, text: async () => { throw new Error("reset"); } }), "https://api.github.com", 1000);
    await assert.rejects(throws.viewer(), (e: unknown) => e instanceof GitHubError && e.kind === "not_found");
  });
});

describe("air-gap reachability after the fix (6)", () => {
  const deps = (git: FakeGit, allowed: string[]): FlowDeps => ({
    git, github: null, readFile: async () => null, fileDiff: async () => null, airGap: { enabled: true, allowedHosts: allowed }, enterpriseHosts: [],
  });
  it("both URLs must be on the list; scp-style and unknown hosts are read by host name", async () => {
    const cases: [{ fetchUrl?: string; pushUrl?: string }, string[], boolean][] = [
      [{ fetchUrl: "https://git.corp.local/a/b.git", pushUrl: "https://git.corp.local/a/b.git" }, ["git.corp.local"], true],
      [{ fetchUrl: "https://github.com/a/b.git", pushUrl: "https://git.corp.local/a/b.git" }, ["git.corp.local"], false],
      [{ fetchUrl: "git@git.corp.local:a/b.git", pushUrl: "git@git.corp.local:a/b.git" }, ["git.corp.local"], true],
      [{ fetchUrl: "https://git.corp.local.evil.io/a/b.git" }, ["git.corp.local"], false],
      [{ fetchUrl: "https://user:pw@git.corp.local:8443/a/b/c/d.git" }, ["git.corp.local"], true],
      [{ fetchUrl: "/srv/git/b.git" }, [], true],
    ];
    for (const [remote, allowed, expected] of cases) {
      const git = new FakeGit();
      git.remoteList = [{ name: "origin", ...remote }];
      const ctx = await prepareContext(deps(git, allowed));
      assert.equal(ctx.canReachRemote, expected, JSON.stringify(remote));
      if (!expected) assert.ok(!git.calls.some((c) => c.name === "fetch"), "fetched in air-gap mode");
    }
  });
});

describe("Azure project names with spaces (fix) don't open new injection room", () => {
  it("spaces only inside the project segment, escaped in page URLs; never leading/trailing or in other parts", () => {
    const ok = parseRemoteUrl("https://dev.azure.com/contoso/My%20Big%20Project/_git/orders")!;
    assert.equal(ok.owner, "contoso/My Big Project");
    for (const bad of [
      "https://dev.azure.com/contoso/%20Proj/_git/orders", "https://dev.azure.com/contoso/Proj%20/_git/orders",
      "https://dev.azure.com/con%20toso/Proj/_git/orders", "https://dev.azure.com/contoso/Proj/_git/or%20ders",
      "https://dev.azure.com/contoso/a%0Ab/_git/orders", "https://dev.azure.com/contoso/a%E2%80%AEb/_git/orders",
      "https://github.com/acme/my%20repo", "https://gitlab.com/group/my%20sub/orders",
    ]) {
      assert.equal(parseRemoteUrl(bad), null, bad);
    }
  });
});
