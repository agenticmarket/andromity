export type HostKind = "github" | "ghe" | "gitlab" | "bitbucket" | "azure" | "gitea" | "other";

export interface ParsedRemote {
  /** Lower-case host name without port or credentials. */
  host: string;
  port?: string;
  /** Owner path: a user or organisation, a GitLab group path, or "org/project" on Azure DevOps. */
  owner: string;
  repo: string;
  kind: HostKind;
  /** https://host[:port], or http:// when the remote itself uses plain http. */
  webBase: string;
  /** host/owner/repo, safe to show: never contains credentials. */
  display: string;
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const MAX_URL = 2048;

function hostKind(host: string, enterpriseHosts: readonly string[]): HostKind {
  if (host === "github.com" || host === "www.github.com" || host === "ssh.github.com") return "github";
  if (enterpriseHosts.includes(host)) return "ghe";
  if (host === "gitlab.com" || host.startsWith("gitlab.")) return "gitlab";
  if (host === "bitbucket.org") return "bitbucket";
  if (host === "dev.azure.com" || host === "ssh.dev.azure.com" || host.endsWith(".visualstudio.com")) return "azure";
  if (host === "codeberg.org" || host === "gitea.com" || host.startsWith("gitea.") || host.startsWith("forgejo.")) return "gitea";
  return "other";
}

/** Host names from VS Code's `github-enterprise.uri`, lower case, without scheme or port. */
export function enterpriseHostsFrom(uri: unknown): string[] {
  if (typeof uri !== "string" || !uri.trim()) return [];
  try {
    const parsed = new URL(uri.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? [parsed.hostname.toLowerCase()] : [];
  } catch {
    return [];
  }
}

function toUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text || text.length > MAX_URL || /[\s\\]/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      return new URL(text);
    } catch {
      return null;
    }
  }
  const scp = /^(?:([^@/:]+)@)?([^@/:]+):(?!\/\/)(.+)$/.exec(text);
  if (!scp || scp[2].length < 2) return null;
  try {
    return new URL(`ssh://${scp[1] ? encodeURIComponent(scp[1]) + "@" : ""}${scp[2]}/${scp[3].replace(/^\/+/, "")}`);
  } catch {
    return null;
  }
}

/** Parses a git remote URL (https, http, ssh, git, or scp-like) into host, owner and repository.
 *  Returns null for local paths, file URLs and anything it can't read with confidence. */
export function parseRemoteUrl(raw: unknown, enterpriseHosts: readonly string[] = []): ParsedRemote | null {
  if (typeof raw !== "string") return null;
  const url = toUrl(raw);
  if (!url) return null;
  const protocol = url.protocol.toLowerCase();
  if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.startsWith("-") || host.startsWith(".")) return null;
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (segments.length && segments[segments.length - 1].toLowerCase().endsWith(".git")) {
    segments[segments.length - 1] = segments[segments.length - 1].slice(0, -4);
  }
  segments = segments.filter(Boolean);
  const kind = hostKind(host, enterpriseHosts);

  if (kind === "azure") {
    if (host === "ssh.dev.azure.com") {
      if (segments[0] !== "v3" || segments.length !== 4) return null;
      segments = [segments[1], segments[2], segments[3]];
    } else if (host === "dev.azure.com") {
      if (segments.indexOf("_git") !== 2 || segments.length !== 4) return null;
      segments = [segments[0], segments[1], segments[3]];
    } else {
      const at = segments.indexOf("_git");
      const org = host.slice(0, -".visualstudio.com".length);
      if (at < 0 || segments.length !== at + 2) return null;
      const project = at === 1 ? segments[0] : at === 2 ? segments[1] : null;
      if (!project || !org) return null;
      segments = [org, project, segments[at + 1]];
    }
  }

  if (segments.length < 2 || segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) {
    return null;
  }
  if ((kind === "github" || kind === "ghe" || kind === "bitbucket" || kind === "gitea") && segments.length !== 2) return null;
  const repo = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join("/");
  const sshLike = protocol !== "https:" && protocol !== "http:";
  const port = !sshLike && url.port ? url.port : undefined;
  const webHost = kind === "azure" ? "dev.azure.com" : kind === "github" ? "github.com" : host;
  const scheme = protocol === "http:" ? "http" : "https";
  const webBase = `${scheme}://${webHost}${port ? ":" + port : ""}`;
  return { host: webHost, port, owner, repo, kind, webBase, display: `${webHost}/${owner}/${repo}` };
}

function pathOf(parts: string[]): string {
  return parts.map((part) => part.split("/").map(encodeURIComponent).join("/")).join("/");
}

/** The host's page for opening a pull (or merge) request from `head` into `base`, or null when unknown. */
export function newPullRequestUrl(remote: ParsedRemote, base: string, head: string, headOwner?: string): string | null {
  const repoPath = pathOf([remote.owner, remote.repo]);
  const q = encodeURIComponent;
  switch (remote.kind) {
    case "github":
    case "ghe": {
      const crossRepo = headOwner && headOwner.toLowerCase() !== remote.owner.toLowerCase();
      return `${remote.webBase}/${repoPath}/compare/${pathOf([base])}...${crossRepo ? q(headOwner) + ":" : ""}${pathOf([head])}?expand=1`;
    }
    case "gitlab":
      return `${remote.webBase}/${repoPath}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${q(head)}&merge_request%5Btarget_branch%5D=${q(base)}`;
    case "bitbucket":
      return `${remote.webBase}/${repoPath}/pull-requests/new?source=${q(head)}&dest=${q(base)}`;
    case "azure": {
      const [org, project] = remote.owner.split("/");
      return `https://dev.azure.com/${q(org)}/${q(project)}/_git/${q(remote.repo)}/pullrequestcreate?sourceRef=${q(head)}&targetRef=${q(base)}`;
    }
    case "gitea":
      return `${remote.webBase}/${repoPath}/compare/${pathOf([base])}...${pathOf([head])}`;
    default:
      return null;
  }
}

/** What the host calls the request, for buttons and messages. */
export function requestNoun(kind: HostKind): string {
  return kind === "gitlab" ? "merge request" : "pull request";
}

/** The pull request number when `url` is exactly https://github.com/{owner}/{repo}/pull/{n} for this repository. */
export function pullRequestNumberFromUrl(url: unknown, owner: string, repo: string): number | null {
  if (typeof url !== "string" || url.length > MAX_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.port || parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull" || !/^[1-9][0-9]{0,9}$/.test(parts[3])) return null;
  if (parts[0].toLowerCase() !== owner.toLowerCase() || parts[1].toLowerCase() !== repo.toLowerCase()) return null;
  return Number(parts[3]);
}

/** GitHub's organisation single sign-on page from an `X-GitHub-SSO` header, only if it is on github.com over https. */
export function ssoUrlFromHeader(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /url=([^\s;,]+)/i.exec(header);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
