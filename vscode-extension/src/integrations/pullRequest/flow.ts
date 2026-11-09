import { createHash } from "node:crypto";
import { GitHubClient, GitHubError, PullInfo, RepoInfo } from "./github.js";
import { ParsedRemote, newPullRequestUrl, parseRemoteUrl } from "./remotes.js";
import { SNAPSHOT_BRANCH, isValidBranchName, firstFreeName } from "./branchName.js";
import { MAX_SCAN_BYTES, SecretHit, SizeSummary, looksBinary, secretsInDiff, secretsInFile, sizeOf } from "./checks.js";
import { AirGapView, GitPort, HeadInfo, OperationInProgress, PrFile } from "./types.js";

export interface FlowDeps {
  git: GitPort;
  /** Signed-in client for github.com, or null. */
  github: GitHubClient | null;
  /** File bytes by repository-relative path, or null when the file doesn't exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** The file's diff against HEAD, as Changes Review shows it. */
  fileDiff(path: string): Promise<{ diff: string; omitted: boolean } | null>;
  airGap: AirGapView;
  enterpriseHosts: string[];
}

export type GitHubProblem = "signed_out" | "sso" | "unauthorized" | "not_found" | "rate_limited" | "unavailable";

export interface RepoContext {
  head: HeadInfo;
  inProgress: OperationInProgress | null;
  remoteNames: string[];
  remote: { name: string; parsed: ParsedRemote | null; local: boolean } | null;
  /** False in air-gap mode when the remote's host isn't on the allowed list. */
  canReachRemote: boolean;
  github: {
    viewer: string | null;
    repo: RepoInfo | null;
    target: { owner: string; repo: string } | null;
    headOwner: string | null;
    problem: GitHubProblem | null;
    ssoUrl: string | null;
  };
  base: string;
  baseOptions: string[];
  /** The remote that holds the base branch: the push remote, or for a fork the remote pointing at its parent. */
  baseRemote: string | null;
  /** Commits on the remote base that HEAD doesn't have, after fetching it. */
  behind?: number;
  /** Commits on HEAD that the remote base doesn't have. */
  unpushed?: number;
  /** Files changed on the remote base since HEAD split from it. */
  changedOnBase?: string[];
  fetchFailed: boolean;
  existingPull: PullInfo | null;
  userConfigured: boolean;
  template: string | null;
}

const TEMPLATE_PATHS = [
  ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md",
];
const MAX_TEMPLATE_BYTES = 20_000;

/** A local path or file URL rather than a network remote. */
export function isLocalRemote(url: string | undefined): boolean {
  if (!url) return false;
  const text = url.trim();
  return /^file:\/\//i.test(text) || text.startsWith("/") || text.startsWith("./") || text.startsWith("../")
    || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
}

/** The host name of a remote URL Andromity can't classify, for the air-gap check. */
function hostOfUrl(raw: string): string | null {
  const text = raw.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return new URL(text).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
  const scp = /^(?:[^@/:]+@)?([^@/:]+):/.exec(text);
  return scp && scp[1].length > 1 ? scp[1].toLowerCase() : null;
}

function chooseRemote(head: HeadInfo, names: string[]): string | null {
  if (head.upstream && names.includes(head.upstream.remote)) return head.upstream.remote;
  if (names.includes("origin")) return "origin";
  return names[0] ?? null;
}

function githubProblemOf(error: unknown): GitHubProblem {
  if (!(error instanceof GitHubError)) return "unavailable";
  if (error.kind === "sso") return "sso";
  if (error.kind === "unauthorized") return "unauthorized";
  if (error.kind === "not_found") return "not_found";
  if (error.kind === "rate_limited") return "rate_limited";
  return "unavailable";
}

async function readTemplate(deps: FlowDeps): Promise<string | null> {
  for (const candidate of TEMPLATE_PATHS) {
    try {
      const bytes = await deps.readFile(candidate);
      if (!bytes || bytes.length > MAX_TEMPLATE_BYTES || looksBinary(bytes)) continue;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
      if (text) return text;
    } catch {
      continue;
    }
  }
  return null;
}

async function pickBase(deps: FlowDeps, remote: string | null): Promise<string> {
  const { git } = deps;
  if (remote) {
    const head = await git.remoteHeadBranch(remote).catch(() => undefined);
    if (head && isValidBranchName(head)) return head;
    const configured = await git.config("init.defaultBranch").catch(() => undefined);
    for (const name of [configured, "main", "master"]) {
      if (name && isValidBranchName(name) && await git.remoteBranchKnown(remote, name).catch(() => false)) return name;
    }
  }
  const configured = await git.config("init.defaultBranch").catch(() => undefined);
  return configured && isValidBranchName(configured) ? configured : "main";
}

/** Everything the form needs to know about where the change goes. Its only side effect is fetching the base branch. */
export async function prepareContext(deps: FlowDeps): Promise<RepoContext> {
  const { git } = deps;
  const [head, inProgress, remotes] = await Promise.all([git.head(), git.inProgress(), git.remotes()]);
  const remoteNames = remotes.map((remote) => remote.name);
  const remoteName = chooseRemote(head, remoteNames);
  const entry = remotes.find((remote) => remote.name === remoteName);
  const url = entry?.pushUrl || entry?.fetchUrl;
  const parsed = parseRemoteUrl(url, deps.enterpriseHosts);
  const local = isLocalRemote(url);
  const reachable = (raw: string | undefined) => {
    if (!raw || isLocalRemote(raw)) return true;
    const other = parseRemoteUrl(raw, deps.enterpriseHosts);
    const host = other ? other.host : hostOfUrl(raw);
    return !!host && deps.airGap.allowedHosts.some((allowed) => allowed.toLowerCase() === host);
  };
  const canReachRemote = !!entry && (!deps.airGap.enabled || (reachable(entry.fetchUrl) && reachable(entry.pushUrl)));

  const context: RepoContext = {
    head,
    inProgress,
    remoteNames,
    remote: entry ? { name: entry.name, parsed, local } : null,
    canReachRemote,
    github: { viewer: null, repo: null, target: null, headOwner: null, problem: null, ssoUrl: null },
    base: "main",
    baseOptions: [],
    baseRemote: entry?.name ?? null,
    fetchFailed: false,
    existingPull: null,
    userConfigured: false,
    template: null,
  };

  const [name, email] = await Promise.all([git.config("user.name").catch(() => undefined), git.config("user.email").catch(() => undefined)]);
  context.userConfigured = !!(name && name.trim() && email && email.trim());
  context.template = await readTemplate(deps);

  const githubRemote = parsed?.kind === "github" && canReachRemote && !deps.airGap.enabled;
  if (githubRemote && parsed) {
    if (!deps.github) {
      context.github.problem = "signed_out";
    } else {
      try {
        const github = deps.github;
        const [viewer, repo] = await Promise.all([
          github.viewer().then((login) => { context.github.viewer = login; return login; }),
          github.repository(parsed.owner, parsed.repo),
        ]);
        context.github.viewer = viewer;
        context.github.repo = repo;
        context.github.headOwner = repo.owner;
        context.github.target = repo.parent ? { owner: repo.parent.owner, repo: repo.parent.repo } : { owner: repo.owner, repo: repo.repo };
        context.base = repo.parent ? repo.parent.defaultBranch : repo.defaultBranch;
        context.baseOptions = (await deps.github.branches(context.github.target.owner, context.github.target.repo).catch(() => [] as string[]))
          .filter((name) => name.toLowerCase() !== SNAPSHOT_BRANCH);
      } catch (error) {
        context.github.problem = githubProblemOf(error);
        context.github.ssoUrl = error instanceof GitHubError ? error.ssoUrl : null;
      }
    }
  }
  if (!context.github.repo) context.base = await pickBase(deps, entry?.name ?? null);
  if (!context.baseOptions.includes(context.base)) context.baseOptions.unshift(context.base);

  const parent = context.github.repo?.parent;
  if (parent) {
    context.baseRemote = null;
    for (const remote of remotes) {
      const other = parseRemoteUrl(remote.fetchUrl || remote.pushUrl, deps.enterpriseHosts);
      if (other?.kind === "github" && other.owner.toLowerCase() === parent.owner.toLowerCase() && other.repo.toLowerCase() === parent.repo.toLowerCase()) {
        context.baseRemote = remote.name;
        break;
      }
    }
  }
  const baseRemote = context.baseRemote;
  if (baseRemote && canReachRemote) {
    try {
      await git.fetch(baseRemote, context.base);
      const ref = `${baseRemote}/${context.base}`;
      if (await git.remoteBranchKnown(baseRemote, context.base)) {
        context.behind = await git.countCommits(`HEAD..${ref}`);
        context.unpushed = await git.countCommits(`${ref}..HEAD`);
        context.changedOnBase = context.behind ? await git.changedSince("HEAD", ref) : [];
      }
    } catch {
      context.fetchFailed = true;
    }
  }

  const needsNewBranch = !head.branch || head.branch === context.base;
  if (!needsNewBranch && head.branch && deps.github && context.github.target && context.github.headOwner) {
    context.existingPull = await deps.github
      .openPullFor(context.github.target.owner, context.github.target.repo, context.github.headOwner, head.branch)
      .catch(() => null);
  }
  return context;
}

/** Whether a branch name is already used locally, on the remote-tracking refs, or on GitHub. */
export async function branchTaken(deps: FlowDeps, context: RepoContext, name: string): Promise<boolean> {
  if (await deps.git.localBranchExists(name)) return true;
  if (context.remote && await deps.git.remoteBranchKnown(context.remote.name, name)) return true;
  const repo = context.github.repo;
  if (deps.github && repo) return deps.github.branchExists(repo.owner, repo.repo, name).catch(() => false);
  return false;
}

export async function freeBranchName(deps: FlowDeps, context: RepoContext, name: string): Promise<string | null> {
  return firstFreeName(name, (candidate) => branchTaken(deps, context, candidate));
}

export interface SelectionReport {
  fingerprints: Record<string, string>;
  size: SizeSummary;
  secrets: SecretHit[];
  /** Files the secret scan could not read (binary or larger than the limit). */
  notScanned: string[];
  /** Files already staged that are not ticked. */
  stagedOutside: string[];
}

export function fingerprintOf(bytes: Uint8Array | null): string {
  return bytes ? createHash("sha256").update(bytes).digest("hex") : "deleted";
}

/** Paths whose ticked versions include both sides of a rename. */
export function pathsToStage(files: readonly PrFile[]): string[] {
  const out = new Set<string>();
  for (const file of files) {
    out.add(file.path);
    if (file.originalPath) out.add(file.originalPath);
  }
  return [...out];
}

/** Fingerprints, size, secret scan and staged files for the ticked files. Reads only. */
export async function evaluateSelection(deps: FlowDeps, files: readonly PrFile[]): Promise<SelectionReport> {
  const fingerprints: Record<string, string> = {};
  const secrets: SecretHit[] = [];
  const notScanned: string[] = [];
  for (const file of files) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await deps.readFile(file.path);
    } catch {
      bytes = null;
    }
    fingerprints[file.path] = fingerprintOf(bytes);
    if (!bytes) continue;
    if (file.binary || looksBinary(bytes)) {
      notScanned.push(file.path);
      continue;
    }
    const diff = await deps.fileDiff(file.path).catch(() => null);
    if (diff && !diff.omitted && diff.diff) {
      secrets.push(...secretsInDiff(file.path, diff.diff));
    } else if (bytes.length <= MAX_SCAN_BYTES) {
      secrets.push(...secretsInFile(file.path, new TextDecoder("utf-8", { fatal: false }).decode(bytes)));
    } else {
      notScanned.push(file.path);
    }
  }
  const wanted = new Set(pathsToStage(files));
  const staged = await deps.git.stagedPaths().catch(() => [] as string[]);
  return {
    fingerprints,
    size: sizeOf(files),
    secrets,
    notScanned,
    stagedOutside: staged.filter((path) => !wanted.has(path)),
  };
}

export type RunMode = "pull_request" | "update" | "host_page" | "push" | "commit";
export type StepId = "branch" | "stage" | "commit" | "push" | "pull" | "reviewers" | "comment";
export type StepStatus = "running" | "done" | "failed";

export interface RunPlan {
  mode: RunMode;
  remote: string | null;
  parsed: ParsedRemote | null;
  target: { owner: string; repo: string } | null;
  headOwner: string | null;
  base: string;
  branch: string;
  createBranch: boolean;
  /** Start the new branch here (for example origin/main) instead of the current commit. */
  startFrom?: string;
  files: string[];
  unstageFirst: string[];
  fingerprints: Record<string, string>;
  commitMessage: string;
  signoff: boolean;
  title: string;
  /** The pull request body, built once the commit is pushed, so its receipts can be matched to the pushed files. */
  bodyFor(commit: string): string | Promise<string>;
  /** The receipts section alone, for a pull request that already exists; null when there is nothing to add. */
  receiptsFor?(commit: string): Promise<string | null>;
  draft: boolean;
  reviewers: string[];
  teams: string[];
  existingPull: PullInfo | null;
  /** A comment for an existing pull request, built once the commit exists; null for none. */
  commentFor: ((commit: string) => string | Promise<string>) | null;
}

/** What has already happened, so a retry picks up where the last attempt stopped. */
export interface RunState {
  originalBranch?: string | null;
  branchReady?: boolean;
  commit?: string;
  pushed?: boolean;
  pull?: PullInfo;
  reviewers?: "done" | "failed";
  commented?: boolean;
}

export interface RunResult {
  mode: RunMode;
  branch: string;
  commit: string;
  pull: PullInfo | null;
  pageUrl: string | null;
  reviewerProblem: GitHubError | null;
  /** A pull request for this branch already existed, so the receipts were added as a comment instead of a new description. */
  joinedExisting?: boolean;
  receiptCommentFailed?: boolean;
}

export type FlowErrorKind =
  | "changed_after_review" | "other_staged" | "branch_exists" | "branch_moved" | "would_overwrite" | "identity"
  | "nothing_committed" | "commit_failed" | "signing" | "push_rejected" | "protected" | "too_large" | "workflow_scope"
  | "push_hook" | "no_access" | "auth" | "network" | "git_failed"
  | "gh_unauthorized" | "gh_sso" | "gh_forbidden" | "gh_not_found" | "gh_rate_limited" | "gh_exists" | "gh_no_commits"
  | "gh_draft_unsupported" | "gh_invalid" | "gh_unavailable" | "cancelled";

export class FlowError extends Error {
  constructor(
    public readonly step: StepId,
    public readonly kind: FlowErrorKind,
    public readonly paths: string[] = [],
    public readonly ssoUrl: string | null = null,
    public readonly resetAt: number | null = null,
  ) {
    super(`${step}: ${kind}`);
    this.name = "FlowError";
  }
}

function gitText(error: unknown): { code: string; text: string } {
  const value = error as { gitErrorCode?: unknown; stderr?: unknown; message?: unknown } | null;
  const code = typeof value?.gitErrorCode === "string" ? value.gitErrorCode : "";
  const text = [value?.stderr, value?.message].filter((part) => typeof part === "string").join("\n");
  return { code, text };
}

/** Maps a git failure to a kind the form can explain. Git's own words never reach the form. */
export function classifyGitError(step: StepId, error: unknown): FlowErrorKind {
  const { code, text } = gitText(error);
  if (code === "NoUserNameConfigured" || code === "NoUserEmailConfigured" || /please tell me who you are|user\.useConfigOnly/i.test(text)) return "identity";
  if (/gpg failed to sign|cannot run gpg|error: cannot sign|ssh-keygen.*sign|signing failed/i.test(text)) return "signing";
  if (code === "DirtyWorkTree" || /would be overwritten by checkout|Please commit your changes or stash them/i.test(text)) return "would_overwrite";
  if (code === "BranchAlreadyExists" || /already exists/i.test(text) && step === "branch") return "branch_exists";
  if (step === "push") {
    if (/\bGH006:|Protected branch update failed/i.test(text)) return "protected";
    if (/\bGH001:|Large files detected|exceeds GitHub's file size limit/i.test(text)) return "too_large";
    if (/refusing to allow an? (OAuth App|GitHub App|Personal Access Token) to create or update workflow/i.test(text)) return "workflow_scope";
    if (/^\s*!\s*\[remote rejected\]/m.test(text)) return "push_hook";
    if (/^\s*!\s*\[rejected\]/m.test(text) || /\((?:non-fast-forward|fetch first|stale info)\)/.test(text)) return "push_rejected";
    if (/Permission denied \(publickey|Host key verification failed/i.test(text)) return "auth";
    if (code === "PermissionDenied" || /^remote: Permission to \S+ denied|returned error: 403/im.test(text)) return "no_access";
    if (code === "AuthenticationFailed" || /Authentication failed for|could not read Username|terminal prompts disabled/i.test(text)) return "auth";
    if (code === "PushRejected") return /failed to push some refs/i.test(text) ? "push_hook" : "push_rejected";
    if (code === "RemoteConnectionError" || /Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable|Could not read from remote/i.test(text)) return "network";
  }
  if (step === "commit") return "commit_failed";
  return "git_failed";
}

function githubKind(error: unknown): FlowErrorKind {
  if (!(error instanceof GitHubError)) return "gh_unavailable";
  const map: Record<string, FlowErrorKind> = {
    unauthorized: "gh_unauthorized", sso: "gh_sso", forbidden: "gh_forbidden", not_found: "gh_not_found",
    rate_limited: "gh_rate_limited", exists: "gh_exists", no_commits: "gh_no_commits",
    draft_unsupported: "gh_draft_unsupported", invalid: "gh_invalid",
  };
  return map[error.kind] ?? "gh_unavailable";
}

function toFlowError(step: StepId, error: unknown): FlowError {
  if (error instanceof FlowError) return error;
  if (error instanceof GitHubError) return new FlowError(step, githubKind(error), [], error.ssoUrl, error.resetAt);
  return new FlowError(step, classifyGitError(step, error));
}

export type StepListener = (step: StepId, status: StepStatus) => void;

/** Steps the plan will run, in order, for the progress list. */
export function stepsFor(plan: RunPlan): StepId[] {
  const steps: StepId[] = ["branch", "stage", "commit"];
  if (plan.mode === "commit") return steps;
  steps.push("push");
  if (plan.mode === "pull_request") {
    steps.push("pull");
    if (plan.reviewers.length || plan.teams.length) steps.push("reviewers");
  }
  if (plan.mode === "update" && plan.commentFor) steps.push("comment");
  return steps;
}

async function verifyReviewed(deps: FlowDeps, plan: RunPlan): Promise<void> {
  const changed: string[] = [];
  for (const [path, expected] of Object.entries(plan.fingerprints)) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await deps.readFile(path);
    } catch {
      bytes = null;
    }
    if (fingerprintOf(bytes) !== expected) changed.push(path);
  }
  if (changed.length) throw new FlowError("stage", "changed_after_review", changed);
}

function checkPlan(plan: RunPlan): void {
  if (!isValidBranchName(plan.branch) || !isValidBranchName(plan.base)) throw new FlowError("branch", "git_failed");
  if ([plan.branch, plan.base].some((name) => name.toLowerCase() === SNAPSHOT_BRANCH)) throw new FlowError("branch", "git_failed");
  if (plan.startFrom !== undefined) {
    const at = plan.startFrom.indexOf("/");
    const remote = at > 0 ? plan.startFrom.slice(0, at) : "";
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(remote) || remote.includes("..") || !isValidBranchName(plan.startFrom.slice(at + 1))) {
      throw new FlowError("branch", "git_failed");
    }
  }
  if (!plan.files.length) throw new FlowError("stage", "nothing_committed");
  if (!plan.commitMessage.trim()) throw new FlowError("commit", "commit_failed");
  if (plan.mode !== "commit" && !plan.remote) throw new FlowError("push", "git_failed");
  if ((plan.mode === "pull_request" || plan.mode === "update") && !plan.target) throw new FlowError("pull", "gh_unavailable");
}

/** Runs the plan, skipping steps `state` says are done. Never force-pushes, never skips hooks,
 *  never moves the base branch. Throws FlowError naming the step that failed. */
export async function runPlan(
  deps: FlowDeps,
  plan: RunPlan,
  state: RunState,
  onStep: StepListener = () => {},
  shouldStop: () => boolean = () => false,
): Promise<RunResult> {
  checkPlan(plan);
  const { git } = deps;
  const step = async (id: StepId, work: () => Promise<void>) => {
    if ((id === "branch" || id === "stage" || id === "commit" || id === "push") && shouldStop()) {
      throw new FlowError(id, "cancelled");
    }
    onStep(id, "running");
    try {
      await work();
      onStep(id, "done");
    } catch (error) {
      onStep(id, "failed");
      throw toFlowError(id, error);
    }
  };

  await step("branch", async () => {
    const head = await git.head();
    if (state.originalBranch === undefined) state.originalBranch = head.branch;
    if (head.branch === plan.branch) {
      state.branchReady = true;
      return;
    }
    if (!plan.createBranch || state.branchReady) throw new FlowError("branch", "branch_moved");
    await verifyReviewed(deps, plan);
    if (await git.localBranchExists(plan.branch)) throw new FlowError("branch", "branch_exists");
    await git.createBranch(plan.branch, plan.startFrom);
    const after = await git.head();
    if (after.branch !== plan.branch) throw new FlowError("branch", "git_failed");
    state.branchReady = true;
  });

  const headNow = await git.head();
  const committed = !!state.commit && headNow.commit === state.commit;
  if (!committed) {
    await step("stage", async () => {
      await verifyReviewed(deps, plan);
      if (plan.unstageFirst.length) await git.unstage(plan.unstageFirst);
      await git.stage(plan.files);
      const allowed = new Set(plan.files);
      const staged = await git.stagedPaths();
      const others = staged.filter((path) => !allowed.has(path));
      if (others.length) throw new FlowError("stage", "other_staged", others);
      if (!staged.length) throw new FlowError("stage", "nothing_committed");
    });
    await step("commit", async () => {
      const before = (await git.head()).commit;
      await git.commit(plan.commitMessage, plan.signoff);
      const after = await git.head();
      if (!after.commit || after.commit === before) throw new FlowError("commit", "nothing_committed");
      if (after.branch !== plan.branch) throw new FlowError("commit", "branch_moved");
      state.commit = after.commit;
    });
  } else {
    onStep("stage", "done");
    onStep("commit", "done");
  }
  const commit = state.commit as string;
  const result: RunResult = { mode: plan.mode, branch: plan.branch, commit, pull: null, pageUrl: null, reviewerProblem: null };
  if (plan.mode === "commit") return result;

  await step("push", async () => {
    if (state.pushed) return;
    await git.push(plan.remote as string, plan.branch);
    state.pushed = true;
  });

  if (plan.mode === "host_page" || plan.mode === "push") {
    result.pageUrl = plan.mode === "host_page" && plan.parsed
      ? newPullRequestUrl(plan.parsed, plan.base, plan.branch, plan.headOwner ?? undefined)
      : null;
    return result;
  }

  const github = deps.github;
  const target = plan.target as { owner: string; repo: string };
  if (!github) throw new FlowError(plan.mode === "update" ? "comment" : "pull", "gh_unauthorized");

  if (plan.mode === "update") {
    result.pull = plan.existingPull;
    if (plan.commentFor && plan.existingPull) {
      await step("comment", async () => {
        if (state.commented) return;
        const text = await (plan.commentFor as (commit: string) => string | Promise<string>)(commit);
        if (text.trim()) await github.comment(target.owner, target.repo, (plan.existingPull as PullInfo).number, text);
        state.commented = true;
      });
    }
    return result;
  }

  await step("pull", async () => {
    if (state.pull) return;
    const head = plan.headOwner && plan.headOwner.toLowerCase() !== target.owner.toLowerCase() ? `${plan.headOwner}:${plan.branch}` : plan.branch;
    const existing = await github.openPullFor(target.owner, target.repo, plan.headOwner || target.owner, plan.branch).catch(() => null);
    if (existing) {
      state.pull = existing;
      result.joinedExisting = true;
      const section = plan.receiptsFor ? await plan.receiptsFor(commit).catch(() => null) : null;
      if (section && section.trim()) await github.comment(target.owner, target.repo, existing.number, section).catch(() => { result.receiptCommentFailed = true; });
      return;
    }
    state.pull = await github.createPull(target.owner, target.repo, {
      title: plan.title, head, base: plan.base, body: await plan.bodyFor(commit), draft: plan.draft,
    });
  });
  result.pull = state.pull ?? null;

  if ((plan.reviewers.length || plan.teams.length) && state.pull && state.reviewers !== "done") {
    onStep("reviewers", "running");
    try {
      await github.requestReviewers(target.owner, target.repo, state.pull.number, plan.reviewers, plan.teams);
      state.reviewers = "done";
      onStep("reviewers", "done");
    } catch (error) {
      state.reviewers = "failed";
      result.reviewerProblem = error instanceof GitHubError ? error : new GitHubError("server");
      onStep("reviewers", "failed");
    }
  }
  return result;
}

/** After a push was rejected: the same commit under the first free `<branch>-N` name, checked out. */
export async function moveToFreshBranch(deps: FlowDeps, context: RepoContext, plan: RunPlan): Promise<string> {
  const name = await firstFreeName(plan.branch, (candidate) => branchTaken(deps, context, candidate), 2);
  if (!name) throw new FlowError("push", "branch_exists");
  await deps.git.createBranch(name);
  return name;
}

export function pullUrl(target: { owner: string; repo: string }, number: number): string {
  return `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pull/${number}`;
}
