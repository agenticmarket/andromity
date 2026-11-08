// Real-git sandbox for the Create pull request end-to-end tests.
// - Every repository lives under the OS temp folder and is created with `git init` (the user's home folder is
//   itself a git repository, so nothing may inherit from it).
// - `origin` says https://github.com/test/<name>.git; git's url.<bare>.insteadOf sends it to a local bare repo.
// - GIT_ALLOW_PROTOCOL=file makes git refuse any network transport, so a broken redirect can never reach GitHub.
// - The user's global and system git config are ignored (GIT_CONFIG_GLOBAL points at an empty file).
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { GitPort, HeadInfo, OperationInProgress, RemoteEntry } from "../../src/integrations/pullRequest/types.js";

export interface Sandbox {
  dir: string;
  bare: string;
  work: string;
  name: string;
  remoteUrl: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

const slash = (p: string) => p.replace(/\\/g, "/");

export function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const globalConfig = path.join(dir, "global.gitconfig");
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, "");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    HOME: dir,
    USERPROFILE: dir,
    LANG: "C",
    LC_ALL: "C",
  };
}

export function gitSync(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, env, input, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function gitOk(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string): string {
  const r = gitSync(cwd, env, args, input);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A work repository on `main` with one commit, pushed to a bare repository that origin is redirected to. */
export function makeSandbox(name = "orders"): Sandbox {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "andromity-pr-e2e-")));
  const env = isolatedEnv(dir);
  const bare = path.join(dir, "remote", `${name}.git`);
  const work = path.join(dir, "work");
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  fs.mkdirSync(work);
  gitOk(dir, env, ["init", "-q", "--bare", "-b", "main", bare]);
  gitOk(work, env, ["init", "-q", "-b", "main"]);
  const remoteUrl = `https://github.com/test/${name}.git`;
  for (const [k, v] of [
    ["user.name", "Ada Tester"], ["user.email", "ada@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"],
    ["credential.helper", ""], [`url.${slash(bare)}.insteadOf`, remoteUrl],
  ]) gitOk(work, env, ["config", "--local", k, v]);
  gitOk(work, env, ["remote", "add", "origin", remoteUrl]);
  fs.mkdirSync(path.join(work, "orders"));
  fs.writeFileSync(path.join(work, "orders", "totals.py"), "def total(x):\n    return x\n");
  fs.writeFileSync(path.join(work, "notes.txt"), "notes\n");
  fs.writeFileSync(path.join(work, "README.md"), "# orders\n");
  gitOk(work, env, ["add", "-A"]);
  gitOk(work, env, ["commit", "-q", "-m", "initial"]);
  gitOk(work, env, ["push", "-q", "-u", "origin", "main"]);
  gitOk(work, env, ["remote", "set-head", "origin", "main"]);
  return {
    dir, bare, work, name, remoteUrl, env,
    cleanup: () => {
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          const until = Date.now() + 200;
          while (Date.now() < until) { /* wait for Windows to release handles */ }
        }
      }
    },
  };
}

/** A second clone that can move the remote (other people's commits). */
export function otherClone(sb: Sandbox): string {
  const other = path.join(sb.dir, `other-${Math.random().toString(36).slice(2, 8)}`);
  gitOk(sb.dir, sb.env, ["clone", "-q", sb.bare, other]);
  gitOk(other, sb.env, ["config", "user.name", "Other Person"]);
  gitOk(other, sb.env, ["config", "user.email", "other@example.invalid"]);
  return other;
}

export function writeHook(gitDir: string, name: string, body: string): void {
  const hooks = path.join(gitDir, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const file = path.join(hooks, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** vscode.git's error codes for the git output it recognises (from vscode.git 1.145, extensions/git/dist/main.js). */
function vscodeGitErrorCode(args: string[], stderr: string): string | undefined {
  if (args[0] === "push" || args.includes("push")) {
    if (/^error: failed to push some refs to\b/m.test(stderr)) return "PushRejected";
    if (/Permission.*denied/.test(stderr)) return "PermissionDenied";
    if (/Could not read from remote repository/.test(stderr)) return "RemoteConnectionError";
  }
  if (/Authentication failed/i.test(stderr)) return "AuthenticationFailed";
  if (/Your local changes to the following files would be overwritten/.test(stderr)) return "DirtyWorkTree";
  if (/A branch named '.+' already exists/.test(stderr)) return "BranchAlreadyExists";
  if (/Please,? tell me who you are/.test(stderr)) return "NoUserNameConfigured";
  return undefined;
}

export class GitError extends Error {
  constructor(public readonly args: string[], public readonly stderr: string, public readonly exitCode: number, public readonly gitErrorCode?: string) {
    super("Failed to execute git");
  }
}

/** A GitPort on the git CLI that runs the same commands vscode.git v1 runs for each API call. */
export class GitCliPort implements GitPort {
  readonly log: string[][] = [];
  constructor(public readonly root: string, private readonly env: NodeJS.ProcessEnv) {}

  private run(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
    this.log.push(args);
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd: this.root, env: this.env, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), 30_000);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new GitError(args, stderr, code ?? 1, vscodeGitErrorCode(args, stderr)));
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  private async tryRun(args: string[]): Promise<string | null> {
    try {
      return (await this.run(args)).stdout;
    } catch {
      return null;
    }
  }

  async head(): Promise<HeadInfo> {
    const branch = (await this.tryRun(["symbolic-ref", "-q", "--short", "HEAD"]))?.trim() || null;
    const commit = (await this.tryRun(["rev-parse", "-q", "--verify", "HEAD"]))?.trim() || null;
    let upstream: HeadInfo["upstream"];
    if (branch) {
      const remote = (await this.tryRun(["config", "--get", `branch.${branch}.remote`]))?.trim();
      const merge = (await this.tryRun(["config", "--get", `branch.${branch}.merge`]))?.trim();
      if (remote && merge) upstream = { remote, name: merge.replace(/^refs\/heads\//, "") };
    }
    return { branch, commit, upstream };
  }

  async remotes(): Promise<RemoteEntry[]> {
    // vscode.git reads remotes from the config file, so URLs are the configured ones (before insteadOf).
    const out = (await this.tryRun(["config", "--local", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"])) || "";
    const map = new Map<string, RemoteEntry>();
    for (const line of out.split("\n").filter(Boolean)) {
      const m = /^remote\.(.+)\.(url|pushurl) (.*)$/.exec(line);
      if (!m) continue;
      const entry = map.get(m[1]) || { name: m[1] };
      if (m[2] === "url") { entry.fetchUrl = m[3]; entry.pushUrl = entry.pushUrl ?? m[3]; } else entry.pushUrl = m[3];
      map.set(m[1], entry);
    }
    return [...map.values()];
  }

  async stagedPaths(): Promise<string[]> {
    const out = (await this.run(["status", "--porcelain=v1", "-z", "-uall"])).stdout;
    const parts = out.split("\0");
    const paths = new Set<string>();
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const x = entry[0];
      const file = entry.slice(3);
      if (x === "R" || x === "C") {
        const original = parts[++i];
        if (x === "R") paths.add(original);
      }
      if (x !== " " && x !== "?" && x !== "!") paths.add(file);
    }
    return [...paths];
  }

  async inProgress(): Promise<OperationInProgress | null> {
    const gitDir = path.resolve(this.root, (await this.run(["rev-parse", "--git-dir"])).stdout.trim());
    const has = (n: string) => fs.existsSync(path.join(gitDir, n));
    if (has("rebase-merge") || has("rebase-apply")) return "rebase";
    if (has("MERGE_HEAD")) return "merge";
    if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
    if (has("REVERT_HEAD")) return "revert";
    return null;
  }

  async config(key: string): Promise<string | undefined> {
    return (await this.tryRun(["config", "--get", key]))?.trim() || undefined;
  }

  async localBranchExists(name: string): Promise<boolean> {
    return (await this.tryRun(["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) !== null;
  }

  async remoteBranchKnown(remote: string, name: string): Promise<boolean> {
    return (await this.tryRun(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${name}`])) !== null;
  }

  async remoteHeadBranch(remote: string): Promise<string | undefined> {
    const ref = (await this.tryRun(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`]))?.trim();
    return ref && ref.startsWith(remote + "/") ? ref.slice(remote.length + 1) : undefined;
  }

  async fetch(remote: string, ref: string): Promise<void> {
    await this.run(["fetch", remote, ref]);
  }

  async countCommits(range: string): Promise<number | undefined> {
    const out = await this.tryRun(["rev-list", "--count", range]);
    return out === null ? undefined : Number(out.trim());
  }

  async changedSince(from: string, to: string): Promise<string[] | undefined> {
    const out = await this.tryRun(["diff", "--name-only", "-z", `${from}...${to}`]);
    return out === null ? undefined : out.split("\0").filter(Boolean);
  }

  async createBranch(name: string, from?: string): Promise<void> {
    await this.run(["checkout", "-q", "-b", name, "--no-track", ...(from ? [from] : [])]);
  }

  async checkout(name: string): Promise<void> {
    await this.run(["checkout", "-q", name]);
  }

  async stage(paths: string[]): Promise<void> {
    await this.run(["add", "-A", "--", ...paths]);
  }

  async unstage(paths: string[]): Promise<void> {
    await this.run(["reset", "-q", "HEAD", "--", ...paths]);
  }

  async commit(message: string, signoff: boolean): Promise<void> {
    await this.run(["-c", "user.useConfigOnly=true", "commit", "--quiet", ...(signoff ? ["--signoff"] : []), "-F", "-"], message);
  }

  async push(remote: string, branch: string): Promise<void> {
    await this.run(["push", "-u", remote, branch]);
  }
}

export interface ApiRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface FakeApi {
  base: string;
  requests: ApiRequest[];
  /** Override a route: return a response, or undefined to fall through to the default. */
  override: ((req: ApiRequest) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined) | null;
  openPulls: { number: number; head: string; title: string }[];
  close(): Promise<void>;
}

/** A local stand-in for api.github.com on 127.0.0.1 that checks pull request heads against the bare repository. */
export async function startFakeGitHub(sb: Sandbox, owner = "test", opts: { private?: boolean; push?: boolean } = {}): Promise<FakeApi> {
  const api: FakeApi = { base: "", requests: [], override: null, openPulls: [], close: async () => {} };
  let next = 41;
  const branchOnRemote = (name: string) => gitSync(sb.dir, sb.env, ["--git-dir", sb.bare, "rev-parse", "-q", "--verify", `refs/heads/${name}`]).status === 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const request: ApiRequest = { method: req.method || "", url: req.url || "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      api.requests.push(request);
      const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const custom = api.override?.(request);
      if (custom) return send(custom.status, custom.body, custom.headers);
      const u = new URL(request.url, "http://127.0.0.1");
      const repoPath = `/repos/${owner}/${sb.name}`;
      if (request.method === "GET" && u.pathname === "/user") return send(200, { login: "ada-tester" });
      if (request.method === "GET" && u.pathname === repoPath) {
        return send(200, { name: sb.name, owner: { login: owner }, default_branch: "main", private: !!opts.private, permissions: { push: opts.push !== false } });
      }
      if (request.method === "GET" && u.pathname === `${repoPath}/branches`) return send(200, [{ name: "main" }]);
      if (request.method === "GET" && u.pathname.startsWith(`${repoPath}/branches/`)) {
        const name = decodeURIComponent(u.pathname.slice(`${repoPath}/branches/`.length));
        return branchOnRemote(name) ? send(200, { name }) : send(404, { message: "Branch not found" });
      }
      if (request.method === "GET" && u.pathname === `${repoPath}/assignees`) return send(200, [{ login: "priya" }]);
      if (request.method === "GET" && u.pathname === `${repoPath}/pulls`) {
        const head = u.searchParams.get("head") || "";
        const branch = head.includes(":") ? head.split(":")[1] : head;
        return send(200, api.openPulls.filter((p) => p.head === branch).map((p) => ({ number: p.number, html_url: `https://github.com/${owner}/${sb.name}/pull/${p.number}`, title: p.title })));
      }
      if (request.method === "POST" && u.pathname === `${repoPath}/pulls`) {
        const { head, base, title } = request.body || {};
        const branch = String(head).includes(":") ? String(head).split(":")[1] : String(head);
        if (!branchOnRemote(branch)) return send(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] });
        if (!branchOnRemote(base)) return send(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "base", code: "invalid" }] });
        if (api.openPulls.some((p) => p.head === branch)) return send(422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for ${owner}:${branch}.` }] });
        const number = ++next;
        api.openPulls.push({ number, head: branch, title });
        return send(201, { number, html_url: `https://github.com/${owner}/${sb.name}/pull/${number}`, title });
      }
      if (request.method === "POST" && /\/pulls\/\d+\/requested_reviewers$/.test(u.pathname)) return send(201, {});
      if (request.method === "POST" && /\/issues\/\d+\/comments$/.test(u.pathname)) return send(201, { id: 1 });
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  api.base = `http://127.0.0.1:${port}`;
  api.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return api;
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Runs git like vscode.git does (same error codes), outside any GitPort. */
export function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new GitError(args, stderr, code ?? 1, vscodeGitErrorCode(args, stderr)));
    });
    child.stdin.end(input ?? "");
  });
}

/** A stand-in for vscode.git's API Repository (v1), backed by the git CLI with the commands vscode.git runs.
 *  Lets the real VscodeGitPort and PullRequestController run against a real repository in a plain Node test. */
export class CliApiRepository {
  readonly rootUri: { fsPath: string; scheme: string };
  readonly calls: { name: string; args: unknown[] }[] = [];
  state: {
    HEAD?: { type: number; name?: string; commit?: string; upstream?: { remote: string; name: string } };
    remotes: { name: string; fetchUrl?: string; pushUrl?: string }[];
    indexChanges: { uri: { fsPath: string }; originalUri?: { fsPath: string }; renameUri?: { fsPath: string } }[];
    mergeChanges: unknown[];
    refs: unknown[];
    rebaseCommit?: unknown;
  } = { remotes: [], indexChanges: [], mergeChanges: [], refs: [] };
  private readonly port: GitCliPort;

  constructor(public readonly root: string, private readonly env: NodeJS.ProcessEnv) {
    this.rootUri = { fsPath: root, scheme: "file" };
    this.port = new GitCliPort(root, env);
  }

  private git(args: string[], input?: string) {
    return runGit(this.root, this.env, args, input);
  }

  private rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  async status(): Promise<void> {
    const head = await this.port.head();
    this.state.HEAD = { type: 0, name: head.branch ?? undefined, commit: head.commit ?? undefined, upstream: head.upstream };
    this.state.remotes = await this.port.remotes();
    const out = (await this.git(["status", "--porcelain=v1", "-z", "-uall"])).stdout.split("\0");
    const changes: CliApiRepository["state"]["indexChanges"] = [];
    for (let i = 0; i < out.length; i++) {
      const entry = out[i];
      if (entry.length < 4) continue;
      const x = entry[0];
      const file = path.join(this.root, ...entry.slice(3).split("/"));
      if (x === "R" || x === "C") {
        const original = path.join(this.root, ...out[++i].split("/"));
        changes.push({ uri: { fsPath: file }, originalUri: { fsPath: original }, renameUri: { fsPath: file } });
      } else if (x !== " " && x !== "?" && x !== "!") {
        changes.push({ uri: { fsPath: file } });
      }
    }
    this.state.indexChanges = changes;
  }

  /** Like vscode.git 1.145: `git config --get --local <key>`, "" when unset (includes are not followed). */
  async getConfig(key: string): Promise<string> {
    this.calls.push({ name: "getConfig", args: [key] });
    try {
      return (await this.git(["config", "--get", "--local", key])).stdout.trim();
    } catch {
      return "";
    }
  }

  /** Like vscode.git 1.145: `git config --get --global <key>`. */
  async getGlobalConfig(key: string): Promise<string> {
    this.calls.push({ name: "getGlobalConfig", args: [key] });
    try {
      return (await this.git(["config", "--get", "--global", key])).stdout.trim();
    } catch {
      return "";
    }
  }

  async getRefs(query: { pattern?: string }): Promise<{ type: number; name: string; commit: string; remote?: string }[]> {
    const args = ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)"];
    if (query.pattern) args.push(query.pattern.startsWith("refs/") ? query.pattern : `refs/${query.pattern}`);
    const out = (await this.git(args)).stdout;
    const refs: { type: number; name: string; commit: string; remote?: string }[] = [];
    for (const line of out.split("\n").filter(Boolean)) {
      const [ref, commit, peeled] = line.split("\0");
      if (ref.startsWith("refs/heads/")) refs.push({ type: 0, name: ref.slice(11), commit });
      else if (ref.startsWith("refs/remotes/")) {
        const name = ref.slice(13);
        refs.push({ type: 1, name, commit, remote: name.split("/")[0] });
      } else if (ref.startsWith("refs/tags/")) refs.push({ type: 2, name: ref.slice(10), commit: peeled || commit });
    }
    return refs;
  }

  async fetch(options: { remote?: string; ref?: string }): Promise<void> {
    this.calls.push({ name: "fetch", args: [options] });
    await this.git(["fetch", ...(options.remote ? [options.remote] : []), ...(options.ref ? [options.ref] : [])]);
  }

  async log(options: { range?: string; maxEntries?: number }): Promise<{ hash: string }[]> {
    const out = (await this.git(["log", "--format=%H", options.range ? options.range : `-n${options.maxEntries ?? 32}`])).stdout;
    return out.split("\n").filter(Boolean).map((hash) => ({ hash }));
  }

  async diffBetween(ref1: string, ref2: string): Promise<{ uri: { fsPath: string } }[]> {
    const out = (await this.git(["diff", "--name-only", "-z", `${ref1}...${ref2}`])).stdout;
    return out.split("\0").filter(Boolean).map((rel) => ({ uri: { fsPath: path.join(this.root, ...rel.split("/")) } }));
  }

  async createBranch(name: string, checkout: boolean, ref?: string): Promise<void> {
    this.calls.push({ name: "createBranch", args: [name, checkout, ref] });
    await this.git(checkout ? ["checkout", "-q", "-b", name, "--no-track", ...(ref ? [ref] : [])] : ["branch", "-q", name, ...(ref ? [ref] : [])]);
  }

  async checkout(treeish: string): Promise<void> {
    this.calls.push({ name: "checkout", args: [treeish] });
    await this.git(["checkout", "-q", treeish]);
  }

  async add(paths: string[]): Promise<void> {
    this.calls.push({ name: "add", args: [paths] });
    await this.git(["add", "-A", "--", ...paths.map((p) => this.rel(p))]);
  }

  async revert(paths: string[]): Promise<void> {
    this.calls.push({ name: "revert", args: [paths] });
    await this.git(["reset", "-q", "HEAD", "--", ...paths.map((p) => this.rel(p))]);
  }

  async commit(message: string, options?: { signoff?: boolean }): Promise<void> {
    this.calls.push({ name: "commit", args: [message, options] });
    await this.git(["-c", "user.useConfigOnly=true", "commit", "--quiet", ...(options?.signoff ? ["--signoff"] : []), "-F", "-"], message);
  }

  async push(remoteName?: string, branchName?: string, setUpstream?: boolean, ...rest: unknown[]): Promise<void> {
    this.calls.push({ name: "push", args: [remoteName, branchName, setUpstream, ...rest] });
    await this.git(["push", ...(setUpstream ? ["-u"] : []), ...(remoteName ? [remoteName] : []), ...(branchName ? [branchName] : [])]);
  }
}
