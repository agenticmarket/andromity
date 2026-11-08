import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { GitPort, HeadInfo, OperationInProgress, RemoteEntry } from "./types.js";

interface ApiUri {
  fsPath: string;
}

interface ApiChange {
  uri: ApiUri;
  originalUri?: ApiUri;
  renameUri?: ApiUri;
}

interface ApiRef {
  type?: number;
  name?: string;
  commit?: string;
  remote?: string;
}

interface ApiBranch extends ApiRef {
  upstream?: { remote: string; name: string };
}

/** The part of the built-in Git extension's API (v1) used here. */
export interface ApiRepository {
  rootUri: ApiUri;
  state: {
    HEAD?: ApiBranch;
    remotes: { name: string; fetchUrl?: string; pushUrl?: string }[];
    indexChanges: ApiChange[];
    mergeChanges?: ApiChange[];
    rebaseCommit?: unknown;
    refs?: ApiRef[];
  };
  status(): Promise<void>;
  getConfig(key: string): Promise<string>;
  getRefs?(query: { pattern?: string; count?: number }): Promise<ApiRef[]>;
  fetch(options: { remote?: string; ref?: string }): Promise<void>;
  log(options: { range?: string; maxEntries?: number }): Promise<{ hash: string }[]>;
  diffBetween(ref1: string, ref2: string): Promise<ApiChange[]>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  checkout(treeish: string): Promise<void>;
  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
  commit(message: string, options?: { signoff?: boolean }): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

export interface GitApi {
  repositories: ApiRepository[];
  openRepository?(root: vscode.Uri): Promise<ApiRepository | null>;
}

const REF_HEAD = 0;
const REF_REMOTE_HEAD = 1;

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {}
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** VS Code's Git API, or a reason it can't be used. */
export async function loadGitApi(): Promise<{ api: GitApi } | { problem: "missing" | "disabled" }> {
  const extension = vscode.extensions.getExtension<{ enabled?: boolean; getAPI(version: 1): GitApi }>("vscode.git");
  if (!extension) return { problem: "missing" };
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    if (!exports || exports.enabled === false) return { problem: "disabled" };
    return { api: exports.getAPI(1) };
  } catch {
    return { problem: "disabled" };
  }
}

/** The Git extension's repository whose root is exactly `root`. Never a guess from the active editor. */
export async function repositoryAt(api: GitApi, root: string): Promise<ApiRepository | null> {
  const found = api.repositories.find((repo) => samePath(repo.rootUri.fsPath, root));
  if (found) return found;
  if (typeof api.openRepository === "function") {
    try {
      const opened = await api.openRepository(vscode.Uri.file(root));
      if (opened && samePath(opened.rootUri.fsPath, root)) return opened;
    } catch {}
  }
  return null;
}

function gitDirOf(root: string): string | null {
  const dotGit = path.join(root, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    return pointer ? path.resolve(root, pointer[1].trim()) : null;
  } catch {
    return null;
  }
}

/** GitPort over the built-in Git extension, so the user's credentials, hooks and signing apply. */
export class VscodeGitPort implements GitPort {
  constructor(private readonly repo: ApiRepository, public readonly root: string) {}

  private abs(rel: string): string {
    return path.join(this.root, ...rel.split("/"));
  }

  private rel(fsPath: string): string | null {
    const relative = path.relative(this.root, fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join("/");
  }

  private async refs(pattern: string): Promise<ApiRef[]> {
    if (typeof this.repo.getRefs === "function") return this.repo.getRefs({ pattern });
    await this.repo.status();
    return this.repo.state.refs ?? [];
  }

  async head(): Promise<HeadInfo> {
    await this.repo.status();
    const head = this.repo.state.HEAD;
    const branch = head && head.type === REF_HEAD && head.name ? head.name : null;
    const upstream = head?.upstream && head.upstream.remote && head.upstream.name ? { remote: head.upstream.remote, name: head.upstream.name } : undefined;
    return { branch, commit: head?.commit ?? null, upstream };
  }

  async remotes(): Promise<RemoteEntry[]> {
    return this.repo.state.remotes.map((remote) => ({ name: remote.name, fetchUrl: remote.fetchUrl, pushUrl: remote.pushUrl }));
  }

  async stagedPaths(): Promise<string[]> {
    await this.repo.status();
    const out = new Set<string>();
    for (const change of this.repo.state.indexChanges) {
      for (const uri of [change.uri, change.originalUri, change.renameUri]) {
        const rel = uri ? this.rel(uri.fsPath) : null;
        if (rel) out.add(rel);
      }
    }
    return [...out];
  }

  async inProgress(): Promise<OperationInProgress | null> {
    if (this.repo.state.rebaseCommit) return "rebase";
    const dir = gitDirOf(this.root);
    if (dir) {
      const has = (name: string) => fs.existsSync(path.join(dir, name));
      if (has("rebase-merge") || has("rebase-apply")) return "rebase";
      if (has("MERGE_HEAD")) return "merge";
      if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
      if (has("REVERT_HEAD")) return "revert";
    }
    return (this.repo.state.mergeChanges?.length ?? 0) > 0 ? "merge" : null;
  }

  async config(key: string): Promise<string | undefined> {
    try {
      const value = (await this.repo.getConfig(key)).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  async localBranchExists(name: string): Promise<boolean> {
    const refs = await this.refs(`refs/heads/${name}`);
    return refs.some((ref) => ref.type === REF_HEAD && ref.name === name);
  }

  async remoteBranchKnown(remote: string, name: string): Promise<boolean> {
    const refs = await this.refs(`refs/remotes/${remote}/${name}`);
    return refs.some((ref) => ref.type === REF_REMOTE_HEAD && ref.name === `${remote}/${name}`);
  }

  async remoteHeadBranch(remote: string): Promise<string | undefined> {
    const refs = (await this.refs(`refs/remotes/${remote}`)).filter((ref) => ref.type === REF_REMOTE_HEAD && ref.name);
    const head = refs.find((ref) => ref.name === `${remote}/HEAD`);
    if (!head?.commit) return undefined;
    const names = refs
      .filter((ref) => ref.name !== `${remote}/HEAD` && ref.commit === head.commit)
      .map((ref) => (ref.name as string).slice(remote.length + 1));
    return names.find((name) => name === "main") ?? names.find((name) => name === "master") ?? (names.length === 1 ? names[0] : undefined);
  }

  async fetch(remote: string, ref: string): Promise<void> {
    await this.repo.fetch({ remote, ref });
  }

  async countCommits(range: string): Promise<number | undefined> {
    try {
      return (await this.repo.log({ range })).length;
    } catch {
      return undefined;
    }
  }

  async changedSince(from: string, to: string): Promise<string[] | undefined> {
    try {
      const changes = await this.repo.diffBetween(from, to);
      const out = new Set<string>();
      for (const change of changes) {
        for (const uri of [change.uri, change.originalUri, change.renameUri]) {
          const rel = uri ? this.rel(uri.fsPath) : null;
          if (rel) out.add(rel);
        }
      }
      return [...out];
    } catch {
      return undefined;
    }
  }

  async createBranch(name: string, from?: string): Promise<void> {
    await this.repo.createBranch(name, true, from);
  }

  async checkout(name: string): Promise<void> {
    await this.repo.checkout(name);
  }

  async stage(paths: string[]): Promise<void> {
    await this.repo.add(paths.map((rel) => this.abs(rel)));
  }

  async unstage(paths: string[]): Promise<void> {
    await this.repo.revert(paths.map((rel) => this.abs(rel)));
  }

  async commit(message: string, signoff: boolean): Promise<void> {
    await this.repo.commit(message, { signoff });
  }

  async push(remote: string, branch: string): Promise<void> {
    await this.repo.push(remote, branch, true);
  }
}
