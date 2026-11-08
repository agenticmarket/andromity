import { ssoUrlFromHeader } from "./remotes.js";

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<HttpResponse>;

export type GitHubErrorKind =
  | "unauthorized" | "sso" | "forbidden" | "not_found" | "rate_limited" | "exists" | "no_commits"
  | "draft_unsupported" | "invalid" | "server" | "network" | "timeout";

export class GitHubError extends Error {
  constructor(
    public readonly kind: GitHubErrorKind,
    public readonly status = 0,
    public readonly ssoUrl: string | null = null,
    public readonly resetAt: number | null = null,
  ) {
    super(`GitHub request failed (${kind})`);
    this.name = "GitHubError";
  }
}

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  isPrivate: boolean;
  canPush: boolean;
  parent?: { owner: string; repo: string; defaultBranch: string };
}

export interface PullInfo {
  number: number;
  htmlUrl: string;
  title: string;
}

export const GITHUB_API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function seg(value: string): string {
  return encodeURIComponent(value);
}

function str(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readRepo(raw: unknown): RepoInfo | null {
  const value = obj(raw);
  const owner = str(obj(value?.owner)?.login, 100);
  const repo = str(value?.name, 100);
  const defaultBranch = str(value?.default_branch, 255);
  if (!value || !owner || !repo || !defaultBranch || !LOGIN.test(owner) || !NAME.test(repo)) return null;
  const permissions = obj(value.permissions);
  const parentValue = obj(value.parent);
  const parentOwner = str(obj(parentValue?.owner)?.login, 100);
  const parentRepo = str(parentValue?.name, 100);
  const parentBranch = str(parentValue?.default_branch, 255);
  const parent = value.fork === true && parentOwner && parentRepo && parentBranch && LOGIN.test(parentOwner) && NAME.test(parentRepo)
    ? { owner: parentOwner, repo: parentRepo, defaultBranch: parentBranch }
    : undefined;
  return {
    owner,
    repo,
    defaultBranch,
    isPrivate: value.private === true,
    canPush: permissions?.push === true,
    parent,
  };
}

function readPull(raw: unknown): PullInfo | null {
  const value = obj(raw);
  const number = value?.number;
  const htmlUrl = str(value?.html_url, 2048);
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || !htmlUrl) return null;
  return { number, htmlUrl, title: str(value?.title, 1024) || "" };
}

/** A small GitHub REST client. The token is only ever placed in the Authorization header. */
export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
    private readonly apiBase = GITHUB_API,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: HttpResponse;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Andromity-VSCode",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      throw new GitHubError(controller.signal.aborted ? "timeout" : "network");
    }
    let text = "";
    try {
      text = await Promise.race([
        response.text(),
        new Promise<string>((_, reject) => {
          if (controller.signal.aborted) reject(new Error("timeout"));
          controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        }),
      ]);
    } catch {
      if (controller.signal.aborted) throw new GitHubError("timeout");
      text = "";
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (response.status >= 200 && response.status < 300) return { status: response.status, data };
    throw this.errorFor(response, data);
  }

  private errorFor(response: HttpResponse, data: unknown): GitHubError {
    const status = response.status;
    const message = (str(obj(data)?.message, 2000) || "").toLowerCase();
    const errors = Array.isArray(obj(data)?.errors) ? (obj(data)?.errors as unknown[]) : [];
    const details = errors.map((entry) => (str(obj(entry)?.message, 2000) || "").toLowerCase()).join(" ");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
    if (status === 401) return new GitHubError("unauthorized", status);
    if (status === 403 && response.headers.get("x-github-sso")) {
      return new GitHubError("sso", status, ssoUrlFromHeader(response.headers.get("x-github-sso")));
    }
    if (status === 429 || status === 403 && (remaining === "0" || response.headers.get("retry-after") || message.includes("rate limit"))) {
      const retry = Number(response.headers.get("retry-after"));
      return new GitHubError("rate_limited", status, null, resetAt ?? (Number.isFinite(retry) && retry > 0 ? Date.now() + retry * 1000 : null));
    }
    if (status === 403) return new GitHubError("forbidden", status);
    if (status === 404) return new GitHubError("not_found", status);
    if (status === 422) {
      const all = `${message} ${details}`;
      if (all.includes("already exists")) return new GitHubError("exists", status);
      if (all.includes("no commits between")) return new GitHubError("no_commits", status);
      if (all.includes("draft")) return new GitHubError("draft_unsupported", status);
      return new GitHubError("invalid", status);
    }
    return new GitHubError(status >= 500 ? "server" : "invalid", status);
  }

  async viewer(): Promise<string | null> {
    const { data } = await this.request("GET", "/user");
    const login = str(obj(data)?.login, 100);
    return login && LOGIN.test(login) ? login : null;
  }

  async repository(owner: string, repo: string): Promise<RepoInfo> {
    const { data } = await this.request("GET", `/repos/${seg(owner)}/${seg(repo)}`);
    const info = readRepo(data);
    if (!info) throw new GitHubError("server");
    return info;
  }

  async branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      await this.request("GET", `/repos/${seg(owner)}/${seg(repo)}/branches/${seg(branch)}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubError && error.kind === "not_found") return false;
      throw error;
    }
  }

  async branches(owner: string, repo: string): Promise<string[]> {
    const { data } = await this.request("GET", `/repos/${seg(owner)}/${seg(repo)}/branches?per_page=100`);
    if (!Array.isArray(data)) return [];
    return data.map((entry) => str(obj(entry)?.name, 255)).filter((name): name is string => !!name).slice(0, 100);
  }

  async assignees(owner: string, repo: string): Promise<string[]> {
    const { data } = await this.request("GET", `/repos/${seg(owner)}/${seg(repo)}/assignees?per_page=100`);
    if (!Array.isArray(data)) return [];
    return data.map((entry) => str(obj(entry)?.login, 100)).filter((login): login is string => !!login && LOGIN.test(login)).slice(0, 100);
  }

  async openPullFor(owner: string, repo: string, headOwner: string, branch: string): Promise<PullInfo | null> {
    const head = encodeURIComponent(`${headOwner}:${branch}`);
    const { data } = await this.request("GET", `/repos/${seg(owner)}/${seg(repo)}/pulls?state=open&per_page=5&head=${head}`);
    if (!Array.isArray(data)) return null;
    for (const entry of data) {
      const pull = readPull(entry);
      if (pull) return pull;
    }
    return null;
  }

  async createPull(owner: string, repo: string, input: { title: string; head: string; base: string; body: string; draft: boolean }): Promise<PullInfo> {
    const { data } = await this.request("POST", `/repos/${seg(owner)}/${seg(repo)}/pulls`, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft,
      maintainer_can_modify: true,
    });
    const pull = readPull(data);
    if (!pull) throw new GitHubError("server");
    return pull;
  }

  async requestReviewers(owner: string, repo: string, number: number, reviewers: string[], teams: string[]): Promise<void> {
    await this.request("POST", `/repos/${seg(owner)}/${seg(repo)}/pulls/${number}/requested_reviewers`, {
      reviewers,
      team_reviewers: teams,
    });
  }

  async comment(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${seg(owner)}/${seg(repo)}/issues/${number}/comments`, { body });
  }
}
