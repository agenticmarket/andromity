// Runs INSIDE a real VS Code extension host (launched by vscodePullRequest.e2e.ts with --extensionTestsPath).
// Drives the product's Create pull request flow (prepareContext / evaluateSelection / runPlan) through the product's
// VscodeGitPort on the REAL built-in vscode.git API, against a temp repository whose origin says
// https://github.com/test/orders.git but is redirected by url.<bare>.insteadOf to a local bare repository, and a
// fake GitHub API on 127.0.0.1. Results are written to a JSON file for the launcher to check; nothing is asserted
// here so VS Code always exits cleanly.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { repositoryAt, VscodeGitPort, GitApi } from "../../src/integrations/pullRequest/vscodeGit.js";
import {
  FlowDeps, FlowError, RunPlan, RunState, evaluateSelection, moveToFreshBranch, pathsToStage, prepareContext, runPlan,
} from "../../src/integrations/pullRequest/flow.js";
import { FetchLike, GitHubClient, HttpResponse } from "../../src/integrations/pullRequest/github.js";
import { PrFile } from "../../src/integrations/pullRequest/types.js";
import { Sandbox, gitOk, gitSync, otherClone, startFakeGitHub, writeHook } from "../helpers/prRealGit.js";

interface Config {
  dir: string;
  bare: string;
  work: string;
  name: string;
  remoteUrl: string;
  resultFile: string;
}

interface Outcome {
  name: string;
  ok: boolean;
  details: Record<string, unknown>;
}

const TOKEN = "gho_vscode_e2e_fake_token";

export async function run(): Promise<void> {
  const cfg = JSON.parse(process.env.ANDROMITY_PR_E2E || "{}") as Config;
  const outcomes: Outcome[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };
  const sb: Sandbox = { ...cfg, env, cleanup: () => {} };
  const record = (name: string, ok: boolean, details: Record<string, unknown>) => outcomes.push({ name, ok, details });
  const write = () => fs.writeFileSync(cfg.resultFile, JSON.stringify({ vscodeVersion: vscode.version, outcomes }, null, 2));
  let api: Awaited<ReturnType<typeof startFakeGitHub>> | null = null;
  try {
    const extension = vscode.extensions.getExtension<{ enabled: boolean; getAPI(v: 1): GitApi }>("vscode.git");
    if (!extension) throw new Error("vscode.git missing");
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const gitApi = exports.getAPI(1);
    let repo = null;
    for (let i = 0; i < 100 && !repo; i++) {
      repo = await repositoryAt(gitApi, cfg.work);
      if (!repo) await new Promise((r) => setTimeout(r, 200));
    }
    if (!repo) throw new Error(`vscode.git never opened ${cfg.work}; it has ${gitApi.repositories.map((r) => r.rootUri.fsPath).join(", ")}`);
    record("vscode.git found the repository", true, { root: repo.rootUri.fsPath, viaProductRepositoryAt: true });

    api = await startFakeGitHub(sb);
    const port = new VscodeGitPort(repo, cfg.work);
    const realFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<HttpResponse>;
    const deps: FlowDeps = {
      git: port,
      github: new GitHubClient(TOKEN, realFetch, api.base, 5000),
      readFile: async (rel) => {
        try {
          return fs.readFileSync(path.join(cfg.work, ...rel.split("/")));
        } catch {
          return null;
        }
      },
      fileDiff: async (rel) => {
        const r = gitSync(cfg.work, env, ["diff", "--no-ext-diff", "HEAD", "--", rel]);
        return { diff: r.stdout, omitted: !r.stdout };
      },
      airGap: { enabled: false, allowedHosts: [] },
      enterpriseHosts: [],
    };
    const prFile = (rel: string): PrFile => {
      const stat = gitSync(cfg.work, env, ["diff", "--numstat", "HEAD", "--", rel]).stdout.trim().split("\t");
      return { path: rel, status: "M", additions: Number(stat[0]) || 0, deletions: Number(stat[1]) || 0 };
    };
    const remoteRef = (ref: string) => gitSync(cfg.dir, env, ["--git-dir", cfg.bare, "rev-parse", "-q", "--verify", ref]).stdout.trim();
    // 0. The very first prepareContext on a repository vscode.git has just opened: are the remotes there?
    {
      const remotesInStateBefore = repo.state.remotes.length;
      const first = await prepareContext(deps);
      const remotesInStateAfter = repo.state.remotes.length;
      record("first prepareContext sees origin (VscodeGitPort.remotes reads fresh state)", !!first.remote, {
        remotesInStateBefore, remotesInStateAfter, remote: first.remote?.name ?? null, display: first.remote?.parsed?.display ?? null,
      });
      await repo.status();
    }
    const attempt = async (branch: string, file: string, content: string, overrides: Partial<RunPlan> = {}, state: RunState = {}) => {
      fs.writeFileSync(path.join(cfg.work, ...file.split("/")), content);
      const ctx = await prepareContext(deps);
      if (!ctx.remote) throw new Error(`prepareContext found no remote (vscode.git state.remotes has ${repo!.state.remotes.length})`);
      const files = [prFile(file)];
      const report = await evaluateSelection(deps, files);
      const plan: RunPlan = {
        mode: "pull_request", remote: ctx.remote!.name, parsed: ctx.remote!.parsed, target: ctx.github.target, headOwner: ctx.github.headOwner,
        base: ctx.base, branch, createBranch: true, files: pathsToStage(files), unstageFirst: [], fingerprints: report.fingerprints,
        commitMessage: `fix: ${branch}`, signoff: false, title: `fix: ${branch}`, bodyFor: (c) => `Body ${c}`, draft: false, reviewers: [], teams: [],
        existingPull: null, commentFor: null, ...overrides,
      };
      try {
        const result = await runPlan(deps, plan, state);
        return { ctx, plan, state, result, error: null as FlowError | null, raw: null as unknown };
      } catch (error) {
        return { ctx, plan, state, result: null, error: error instanceof FlowError ? error : null, raw: String(error) };
      }
    };
    const backToMain = async () => {
      await port.checkout("main").catch(() => gitOk(cfg.work, env, ["checkout", "-q", "main"]));
    };

    // A. Happy path with real hooks and an unrelated dirty file.
    {
      const marker = path.join(cfg.dir, "hook-ran.txt").replace(/\\/g, "/");
      writeHook(path.join(cfg.work, ".git"), "pre-commit", `echo pre-commit >> "${marker}"`);
      fs.writeFileSync(path.join(cfg.work, "notes.txt"), "notes\nunrelated dirty edit\n");
      const mainBefore = remoteRef("refs/heads/main");
      const a = await attempt("andromity/vscode-happy", "orders/totals.py", "def total(x):\n    return round(x, 2)\n");
      const create = api.requests.find((r) => r.method === "POST" && r.url.endsWith("/pulls"));
      const status = gitOk(cfg.work, env, ["status", "--porcelain"]);
      const upstream = gitSync(cfg.work, env, ["rev-parse", "--abbrev-ref", "@{u}"]).stdout.trim();
      record("happy path: branch, stage, commit (hook), push via vscode.git, pull request", !!a.result
        && remoteRef("refs/heads/andromity/vscode-happy") === a.result.commit && remoteRef("refs/heads/main") === mainBefore
        && fs.existsSync(marker) && status === "M notes.txt" && upstream === "origin/andromity/vscode-happy" && create?.body?.head === "andromity/vscode-happy", {
        error: a.error?.kind ?? a.raw, commit: a.result?.commit, remoteBranch: remoteRef("refs/heads/andromity/vscode-happy"), hookRan: fs.existsSync(marker),
        status, upstream, pull: a.result?.pull, createHead: create?.body?.head, parsed: a.ctx.remote?.parsed?.display, viewer: a.ctx.github.viewer,
      });
      fs.rmSync(path.join(cfg.work, ".git", "hooks", "pre-commit"), { force: true });
      await backToMain();
    }

    // B. Push rejected (the remote already has the branch with other commits), then -2.
    {
      const other = otherClone(sb);
      gitOk(other, env, ["checkout", "-q", "-b", "andromity/vscode-taken"]);
      fs.writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
      gitOk(other, env, ["add", "-A"]);
      gitOk(other, env, ["commit", "-q", "-m", "theirs"]);
      gitOk(other, env, ["push", "-q", "origin", "andromity/vscode-taken"]);
      const theirs = remoteRef("refs/heads/andromity/vscode-taken");
      const b = await attempt("andromity/vscode-taken", "orders/totals.py", "mine B\n");
      let retried: unknown = null;
      if (b.error?.kind === "push_rejected") {
        b.plan.branch = await moveToFreshBranch(deps, b.ctx, b.plan);
        b.state.pushed = false;
        b.state.branchReady = true;
        retried = await runPlan(deps, b.plan, b.state).then((r) => r.commit, (e) => String(e));
      }
      record("push rejected: classified, never forced, pushed as -2", b.error?.kind === "push_rejected" && remoteRef("refs/heads/andromity/vscode-taken") === theirs
        && retried === b.state.commit && remoteRef("refs/heads/andromity/vscode-taken-2") === b.state.commit, {
        kind: b.error?.kind ?? b.raw, theirsKept: remoteRef("refs/heads/andromity/vscode-taken") === theirs, newName: b.plan.branch, retried,
      });
      await backToMain();
    }

    // C. Server-side pre-receive hook refusing (policy): what does the real vscode.git error classify as?
    {
      writeHook(cfg.bare, "pre-receive", "echo 'policy: commits must reference a ticket' >&2\nexit 1");
      const c = await attempt("andromity/vscode-policy", "orders/totals.py", "mine C\n");
      record("server pre-receive hook refusal is reported as a hook (DESIGN 5)", c.error?.kind === "push_hook", { kind: c.error?.kind ?? c.raw });
      fs.rmSync(path.join(cfg.bare, "hooks", "pre-receive"), { force: true });
      await backToMain();
    }

    // D. Protected-branch style refusal with GitHub's GH006 text.
    {
      writeHook(cfg.bare, "pre-receive", "echo 'error: GH006: Protected branch update failed for refs/heads/x.' >&2\nexit 1");
      const d = await attempt("andromity/vscode-protected", "orders/totals.py", "mine D\n");
      record("protected-branch refusal (GH006) is reported as protected", d.error?.kind === "protected", { kind: d.error?.kind ?? d.raw });
      fs.rmSync(path.join(cfg.bare, "hooks", "pre-receive"), { force: true });
      await backToMain();
    }

    // E. The user's own pre-push hook refusing.
    {
      writeHook(path.join(cfg.work, ".git"), "pre-push", "echo 'tests failed' >&2\nexit 1");
      const e = await attempt("andromity/vscode-prepush", "orders/totals.py", "mine E\n");
      record("local pre-push hook refusal is reported as a hook (DESIGN 5)", e.error?.kind === "push_hook", { kind: e.error?.kind ?? e.raw });
      fs.rmSync(path.join(cfg.work, ".git", "hooks", "pre-push"), { force: true });
      await backToMain();
    }

    // F. A pre-commit hook refusing: nothing committed, nothing pushed.
    {
      writeHook(path.join(cfg.work, ".git"), "pre-commit", "echo 'lint failed' >&2\nexit 1");
      const f = await attempt("andromity/vscode-precommit", "orders/totals.py", "mine F\n");
      record("pre-commit hook refusal: commit_failed, nothing pushed", f.error?.kind === "commit_failed" && remoteRef("refs/heads/andromity/vscode-precommit") === "", {
        kind: f.error?.kind ?? f.raw, originalBranch: f.state.originalBranch,
      });
      fs.rmSync(path.join(cfg.work, ".git", "hooks", "pre-commit"), { force: true });
      gitSync(cfg.work, env, ["reset", "-q"]);
      await backToMain();
    }

    // G. Start from the latest main when the same file changed there: git refuses, nothing left behind.
    {
      const other = otherClone(sb);
      fs.writeFileSync(path.join(other, "orders", "totals.py"), "theirs on main\n");
      gitOk(other, env, ["commit", "-q", "-am", "upstream totals"]);
      gitOk(other, env, ["push", "-q", "origin", "main"]);
      const g = await attempt("andromity/vscode-latest", "orders/totals.py", "mine G\n", { startFrom: "origin/main" });
      const head = gitOk(cfg.work, env, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const leftBehind = gitSync(cfg.work, env, ["show-ref", "--verify", "--quiet", "refs/heads/andromity/vscode-latest"]).status === 0;
      record("start from latest main with an overlapping file: would_overwrite, nothing created", g.error?.kind === "would_overwrite" && head === "main" && !leftBehind, {
        kind: g.error?.kind ?? g.raw, head, leftBehind, changedOnBase: g.ctx.changedOnBase,
      });
    }

    // H. Rejected for other commits on a branch whose name mentions a hook (slug of "fix: pre-push hook").
    {
      const other = otherClone(sb);
      gitOk(other, env, ["checkout", "-q", "-b", "andromity/fix-pre-push-hook"]);
      fs.writeFileSync(path.join(other, "theirs-h.txt"), "theirs\n");
      gitOk(other, env, ["add", "-A"]);
      gitOk(other, env, ["commit", "-q", "-m", "theirs"]);
      gitOk(other, env, ["push", "-q", "origin", "andromity/fix-pre-push-hook"]);
      const h = await attempt("andromity/fix-pre-push-hook", "orders/totals.py", "mine H\n");
      record("rejection on a branch named …pre-push… is still 'other commits' (Push under a new name offered)", h.error?.kind === "push_rejected", { kind: h.error?.kind ?? h.raw });
      await backToMain();
    }

    // I. Identity in the global config only (the founder's setup), read through the real vscode.git getConfig/getGlobalConfig.
    {
      const local = { name: await port.config("user.name"), email: await port.config("user.email") };
      gitOk(cfg.work, env, ["config", "--local", "--unset", "user.name"]);
      gitOk(cfg.work, env, ["config", "--local", "--unset", "user.email"]);
      gitOk(cfg.work, env, ["config", "--global", "user.name", "Global Ada"]);
      gitOk(cfg.work, env, ["config", "--global", "user.email", "global@example.invalid"]);
      const rawLocal = await repo.getConfig("user.name").catch((e: unknown) => `threw ${e}`);
      const rawGlobal = typeof repo.getGlobalConfig === "function" ? await repo.getGlobalConfig("user.name").catch((e: unknown) => `threw ${e}`) : "missing";
      const seen = { name: await port.config("user.name"), email: await port.config("user.email") };
      const ctx = await prepareContext(deps);
      record("global-only identity is seen through vscode.git (getConfig is local-only, getGlobalConfig global)", seen.name === "Global Ada"
        && seen.email === "global@example.invalid" && ctx.userConfigured && rawLocal === "" && rawGlobal === "Global Ada", { local, rawLocal, rawGlobal, seen, userConfigured: ctx.userConfigured });
      const j = await attempt("andromity/vscode-global-identity", "orders/totals.py", "mine J\n");
      const author = j.result ? gitOk(cfg.work, env, ["log", "-1", "--format=%an <%ae>", j.result.commit]) : null;
      record("commit through vscode.git with the global identity", author === "Global Ada <global@example.invalid>", { kind: j.error?.kind ?? j.raw, author });
      await backToMain();
    }

    const tokenOutsideAuth = api.requests.some((r) => r.url.includes(TOKEN) || JSON.stringify({ ...r.headers, authorization: "" }).includes(TOKEN));
    record("token only in the Authorization header, only to 127.0.0.1", !tokenOutsideAuth && api.base.startsWith("http://127.0.0.1:"), { requests: api.requests.length });
  } catch (error) {
    record("runner", false, { error: error instanceof Error ? error.stack : String(error) });
  } finally {
    await api?.close().catch(() => {});
    write();
  }
}
