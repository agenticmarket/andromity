// In-memory fakes for the Create pull request flow: a GitPort that records every call and a scriptable
// GitHub API behind GitHubClient's injectable fetch.
import { GitPort, HeadInfo, OperationInProgress, RemoteEntry } from "../../src/integrations/pullRequest/types.js";
import { FetchLike, GitHubClient, HttpResponse } from "../../src/integrations/pullRequest/github.js";

export const MUTATING = new Set(["fetch", "createBranch", "checkout", "stage", "unstage", "commit", "push"]);

export class FakeGit implements GitPort {
  readonly root = "/repo";
  calls: { name: string; args: unknown[] }[] = [];
  branch: string | null = "main";
  commitSha: string | null = "c000000000000000000000000000000000000000";
  upstream: { remote: string; name: string } | undefined;
  localBranches = new Set<string>(["main"]);
  remoteRefs = new Set<string>(["origin/main"]);
  remoteHead: Record<string, string> = { origin: "main" };
  remoteList: RemoteEntry[] = [{ name: "origin", fetchUrl: "https://github.com/acme/orders.git", pushUrl: "https://github.com/acme/orders.git" }];
  staged = new Set<string>();
  cfg: Record<string, string> = { "user.name": "Ada", "user.email": "ada@example.com" };
  inProg: OperationInProgress | null = null;
  behind = 0;
  unpushed = 0;
  changedOnBase: string[] = [];
  /** Errors to throw, by method, once each (shift). */
  failures: Record<string, unknown[]> = {};
  /** Called after stage(), to simulate something else staging files at the same moment. */
  afterStage: (() => void) | null = null;
  private counter = 0;

  private log(name: string, args: unknown[]) {
    this.calls.push({ name, args });
    const queue = this.failures[name];
    if (queue && queue.length) throw queue.shift();
  }

  mutating(): string[] {
    return this.calls.filter((c) => MUTATING.has(c.name)).map((c) => c.name);
  }

  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  async head(): Promise<HeadInfo> {
    this.log("head", []);
    return { branch: this.branch, commit: this.commitSha, upstream: this.upstream };
  }
  async remotes() { this.log("remotes", []); return this.remoteList.map((r) => ({ ...r })); }
  async stagedPaths() { this.log("stagedPaths", []); return [...this.staged]; }
  async inProgress() { this.log("inProgress", []); return this.inProg; }
  async config(key: string) { this.log("config", [key]); return this.cfg[key]; }
  async localBranchExists(name: string) { this.log("localBranchExists", [name]); return this.localBranches.has(name); }
  async remoteBranchKnown(remote: string, name: string) { this.log("remoteBranchKnown", [remote, name]); return this.remoteRefs.has(`${remote}/${name}`); }
  async remoteHeadBranch(remote: string) { this.log("remoteHeadBranch", [remote]); return this.remoteHead[remote]; }
  async fetch(remote: string, ref: string) { this.log("fetch", [remote, ref]); }
  async countCommits(range: string) {
    this.log("countCommits", [range]);
    return range.startsWith("HEAD..") ? this.behind : this.unpushed;
  }
  async changedSince(from: string, to: string) { this.log("changedSince", [from, to]); return this.changedOnBase; }
  async createBranch(name: string, from?: string) {
    this.log("createBranch", [name, from]);
    if (this.localBranches.has(name)) throw Object.assign(new Error("exists"), { gitErrorCode: "BranchAlreadyExists" });
    this.localBranches.add(name);
    this.branch = name;
  }
  async checkout(name: string) { this.log("checkout", [name]); this.branch = name; }
  async stage(paths: string[]) {
    this.log("stage", [paths]);
    for (const p of paths) this.staged.add(p);
    this.afterStage?.();
  }
  async unstage(paths: string[]) { this.log("unstage", [paths]); for (const p of paths) this.staged.delete(p); }
  async commit(message: string, signoff: boolean) {
    this.log("commit", [message, signoff]);
    if (!this.staged.size) throw Object.assign(new Error("nothing to commit"), { stderr: "nothing to commit" });
    this.counter++;
    this.commitSha = (this.counter.toString(16) + "abcdef").padEnd(40, "0");
    this.staged.clear();
  }
  async push(remote: string, branch: string) {
    this.log("push", [remote, branch]);
    this.remoteRefs.add(`${remote}/${branch}`);
  }
}

export interface ApiCall {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

export interface Route {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A scriptable GitHub API. `routes` maps "METHOD /path" (path without query) to a response or a queue of responses. */
export class FakeGitHub {
  calls: ApiCall[] = [];
  routes: Record<string, Route | Route[]> = {};
  pullNumber = 41;

  constructor(owner = "acme", repo = "orders", extra: Partial<Record<string, unknown>> = {}) {
    this.routes[`GET /user`] = { status: 200, body: { login: "ada" } };
    this.routes[`GET /repos/${owner}/${repo}`] = {
      status: 200,
      body: { name: repo, owner: { login: owner }, default_branch: "main", private: false, permissions: { push: true }, ...extra },
    };
    this.routes[`GET /repos/${owner}/${repo}/branches`] = { status: 200, body: [{ name: "main" }, { name: "develop" }] };
    this.routes[`GET /repos/${owner}/${repo}/pulls`] = { status: 200, body: [] };
    this.routes[`GET /repos/${owner}/${repo}/assignees`] = { status: 200, body: [{ login: "priya" }, { login: "ada" }] };
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    this.calls.push({ method: init.method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    let route = this.routes[key];
    if (Array.isArray(route)) route = route.length > 1 ? route.shift()! : route[0];
    if (!route) {
      if (init.method === "POST" && /\/pulls$/.test(u.pathname)) {
        const n = ++this.pullNumber;
        const [, , owner, repo] = u.pathname.split("/");
        route = { status: 201, body: { number: n, html_url: `https://github.com/${owner}/${repo}/pull/${n}`, title: "t" } };
      } else if (init.method === "GET" && /\/branches\/.+/.test(u.pathname)) {
        route = { status: 404, body: { message: "Branch not found" } };
      } else if (init.method === "POST") {
        route = { status: 201, body: {} };
      } else {
        route = { status: 404, body: { message: "Not Found" } };
      }
    }
    const r = route as Route;
    const headers = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const response: HttpResponse = {
      status: r.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => (r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
    return response;
  };

  client(token = "gho_faketoken_for_tests_only"): GitHubClient {
    return new GitHubClient(token, this.fetch, "https://api.github.com", 2000);
  }

  count(method: string, pathPart: string): number {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart)).length;
  }
}
