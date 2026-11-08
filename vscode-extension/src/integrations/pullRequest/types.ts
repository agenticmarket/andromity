export interface HeadInfo {
  /** Null on a detached commit. */
  branch: string | null;
  commit: string | null;
  upstream?: { remote: string; name: string };
}

export interface RemoteEntry {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export type OperationInProgress = "merge" | "rebase" | "cherry-pick" | "revert";

/** The git operations the flow needs. Paths are relative to `root` with forward slashes.
 *  In VS Code this is backed by the built-in Git extension; tests can back it with real git. */
export interface GitPort {
  readonly root: string;
  head(): Promise<HeadInfo>;
  remotes(): Promise<RemoteEntry[]>;
  stagedPaths(): Promise<string[]>;
  inProgress(): Promise<OperationInProgress | null>;
  config(key: string): Promise<string | undefined>;
  localBranchExists(name: string): Promise<boolean>;
  remoteBranchKnown(remote: string, name: string): Promise<boolean>;
  /** The branch `refs/remotes/<remote>/HEAD` points at, when git knows it. */
  remoteHeadBranch(remote: string): Promise<string | undefined>;
  fetch(remote: string, ref: string): Promise<void>;
  /** How many commits `range` (for example `HEAD..origin/main`) holds, or undefined when git can't say. */
  countCommits(range: string): Promise<number | undefined>;
  /** Files changed on `to` since it split from `from`. */
  changedSince(from: string, to: string): Promise<string[] | undefined>;
  createBranch(name: string, from?: string): Promise<void>;
  checkout(name: string): Promise<void>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  commit(message: string, signoff: boolean): Promise<void>;
  push(remote: string, branch: string): Promise<void>;
}

export interface AirGapView {
  enabled: boolean;
  allowedHosts: string[];
}

/** One changed file as Changes Review lists it. */
export interface PrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  omitted?: boolean;
  originalPath?: string;
}
