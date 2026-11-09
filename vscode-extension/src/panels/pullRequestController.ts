import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { RpcClient } from "../server/RpcClient.js";
import { currentAirGap } from "../airgapState.js";
import { airGapOffMessage } from "../airgap.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import { appendCoAuthorTrailer, draftCommitAndDescription, DraftError } from "../integrations/GitCommit.js";
import { readResponse } from "../providers/receipt/receiptView.js";
import { findSecrets, redactSecrets } from "../secretScan.js";
import type { Receipt } from "../providers/receipt/types.js";
import { FetchLike, GitHubClient, GitHubError, HttpResponse } from "../integrations/pullRequest/github.js";
import { HostKind, enterpriseHostsFrom, newPullRequestUrl, requestNoun } from "../integrations/pullRequest/remotes.js";
import { branchPrefix, isValidBranchName, suggestBranchName } from "../integrations/pullRequest/branchName.js";
import { SecretHit, chooseReviewers, closedIssuesIn, isLockfile, looksSensitive, mentionsIn, secretsInText, sizeWarningLimit } from "../integrations/pullRequest/checks.js";
import { GITHUB_BODY_LIMIT, MAX_COMMIT_MESSAGE, MAX_DESCRIPTION, MAX_TITLE, ReceiptLink, cleanDraft, cleanTitle, closeOpenBlocks, composeBody, composeProvenance, composeReceiptComment, plainText, type Provenance, type ProvenanceRow } from "../integrations/pullRequest/body.js";
import {
  FlowDeps, FlowError, RepoContext, RunMode, RunPlan, RunResult, RunState, SelectionReport, StepId,
  branchTaken, evaluateSelection, freeBranchName, moveToFreshBranch, pathsToStage, prepareContext, pullUrl, runPlan, stepsFor,
} from "../integrations/pullRequest/flow.js";
import { VscodeGitPort, loadGitApi, repositoryAt } from "../integrations/pullRequest/vscodeGit.js";
import { PrFile } from "../integrations/pullRequest/types.js";
import { SNAPSHOT_BRANCH } from "../integrations/snapshotBranchWarning.js";
import {
  PrAction, PrCheckItem, PrDoneView, PrFailedView, PrFileRow, PrFormView, PrPhase, PrStep, PrTag, PrView,
} from "../providers/changesReview/prView.js";

export interface TurnRef {
  sessionId: string;
  turnIndex: number | null;
}

/** What the controller needs from Changes Review. */
export interface PrHost {
  post(message: unknown): void;
  rpc(): RpcClient | null;
  repositoryRoot(): string | undefined;
  projectPath(): string | undefined;
  files(): PrFile[];
  turnFiles(): string[] | null;
  turn(): TurnRef | null;
  /** The chat's current session, used to find the latest turn's receipt when no turn is known. */
  currentSession?(): string | null;
  scope(): "turn" | "all";
  agentRunning(): boolean;
  refresh(): Promise<void>;
  log(message: string): void;
}

interface FormState {
  scope: "turn" | "all";
  ticked: Set<string>;
  unticked: Set<string>;
  base: string;
  createBranch: boolean;
  branchName: string;
  branchEdited: boolean;
  branchTaken: boolean;
  fromLatest: boolean;
  commitMessage: string;
  commitEdited: boolean;
  title: string;
  titleEdited: boolean;
  description: string;
  descriptionEdited: boolean;
  descriptionSource: "ai" | "template" | "none";
  reviewers: string[];
  attachReceipt: boolean;
  draft: boolean;
  ack: string | null;
  stagedChoice: "unstage" | "include" | null;
  commentReceipt: boolean;
}

interface LoadedReceipt {
  receipt: Receipt;
  markdown: string;
  /** Repository-relative path to the turn's +/- counts. */
  files: Map<string, { added: number | null; deleted: number | null }>;
  sensitive: Set<string>;
  runsCode: Set<string>;
  high: { text: string; subject?: string; kind: string }[];
}

type PrimaryAction = "create" | "sign_in_then_create";

const STEP_NAMES: Record<StepId, string> = {
  branch: "branch", stage: "stage", commit: "commit", push: "push", pull: "pull", reviewers: "reviewers", comment: "comment",
};
const MAX_UPDATE_TEXT = MAX_DESCRIPTION + 1000;
const fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<HttpResponse>;

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

function shortSha(sha: string | undefined): string {
  return sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha.slice(0, 7) : "";
}

function hostName(kind: HostKind | undefined): string {
  switch (kind) {
    case "github":
    case "ghe": return "GitHub";
    case "gitlab": return "GitLab";
    case "bitbucket": return "Bitbucket";
    case "azure": return "Azure DevOps";
    case "gitea": return "the host";
    default: return "your host";
  }
}

function freshForm(): FormState {
  return {
    scope: "all", ticked: new Set(), unticked: new Set(), base: "main", createBranch: false, branchName: "", branchEdited: false,
    branchTaken: false, fromLatest: true, commitMessage: "", commitEdited: false, title: "", titleEdited: false,
    description: "", descriptionEdited: false, descriptionSource: "none", reviewers: [], attachReceipt: true, draft: false,
    ack: null, stagedChoice: null, commentReceipt: true,
  };
}

/** The Create pull request form inside Changes Review: state, checks, the flow and its telemetry. */
export class PullRequestController {
  private phase: PrPhase = "closed";
  private deps: FlowDeps | null = null;
  private context: RepoContext | null = null;
  private selection: SelectionReport | null = null;
  private receipt: LoadedReceipt | null = null;
  private receiptReason: string | null = "Loading the receipt…";
  private receiptLoading = false;
  /** The receipt was found as the chat's latest turn rather than handed over with the files. */
  private receiptRecovered = false;
  /** How a recovered receipt was matched: its line counts are still in these files, or only its file names. */
  private receiptMatch: "exact" | "names" | null = null;
  private branchRenamedFrom: string | null = null;
  private templateText: string | null = null;
  private form: FormState = freshForm();
  private opened = new Set<string>();
  private generation = 0;
  private evaluateSeq = 0;
  private branchSeq = 0;
  private drafting = false;
  private draftNote: string | null = null;
  private assignees: string[] = [];
  private blocked: { title: string; message: string; actions: PrAction[] } | null = null;
  private plan: RunPlan | null = null;
  private runState: RunState = {};
  private result: RunResult | null = null;
  private failure: FlowError | null = null;
  private steps: PrStep[] = [];
  private stopRequested = false;
  private running = false;
  private openedAt = 0;
  private publishedSection = false;
  private tracked = new Set<string>();
  private disposed = false;
  private evaluateTimer: ReturnType<typeof setTimeout> | undefined;
  private branchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: PrHost) {}

  // ── Telemetry: feature names only ───────────────────────────
  private track(name: string): void {
    recordFeatureUse(name, { sessionId: this.host.turn()?.sessionId });
  }

  private trackOnce(name: string): void {
    if (this.tracked.has(name)) return;
    this.tracked.add(name);
    this.track(name);
  }

  // ── Opening ─────────────────────────────────────────────────
  public isOpen(): boolean {
    return this.phase !== "closed";
  }

  public isRunning(): boolean {
    return this.running;
  }

  public refreshView(): void {
    if (this.phase !== "closed") this.postView();
  }

  public markOpened(filePath: string): void {
    this.opened.add(filePath);
    if (this.phase === "form") this.postView();
  }

  public async open(): Promise<void> {
    if (this.running) {
      this.postView();
      return;
    }
    if (this.phase === "form" || this.phase === "loading") {
      this.postView();
      return;
    }
    const generation = ++this.generation;
    this.reset();
    this.phase = "loading";
    this.openedAt = Date.now();
    this.postView();
    this.track("pr_form_opened");

    const root = this.host.repositoryRoot();
    const git = await loadGitApi();
    if (generation !== this.generation) return;
    if ("problem" in git) {
      this.block("VS Code's Git is off", "Turn on VS Code's Git extension (the git.enabled setting) to commit from here.", [{ id: "close", label: "Close" }]);
      this.track("pr_blocked_git_off");
      return;
    }
    const repo = root ? await repositoryAt(git.api, root) : null;
    if (generation !== this.generation) return;
    if (!repo || !root) {
      this.block("VS Code's Git doesn't see this repository", "Open it in Source Control, then try again.", [{ id: "close", label: "Close" }]);
      this.track("pr_blocked_no_repo");
      return;
    }
    const airGap = currentAirGap();
    const github = airGap.enabled ? null : await this.githubClient("silent");
    this.deps = {
      git: new VscodeGitPort(repo, root, typeof git.api.git?.path === "string" ? git.api.git.path : undefined),
      github,
      readFile: (rel) => this.readFile(root, rel),
      fileDiff: (rel) => this.fileDiff(rel),
      airGap: { enabled: airGap.enabled, allowedHosts: airGap.allowedHosts },
      enterpriseHosts: enterpriseHostsFrom(vscode.workspace.getConfiguration("github-enterprise").get("uri")),
    };
    let context: RepoContext;
    try {
      context = await prepareContext(this.deps);
    } catch (error) {
      if (generation !== this.generation) return;
      this.host.log(`[PullRequest] prepare failed: ${error instanceof Error ? error.message : String(error)}`);
      this.block("Couldn't read this repository", "Git didn't answer. Check the Git output, then try again.", [
        { id: "show_output", label: "Show Git output" }, { id: "close", label: "Close" }]);
      this.track("pr_blocked_prepare");
      return;
    }
    if (generation !== this.generation) return;
    this.context = context;
    if (context.head.branch?.toLowerCase() === SNAPSHOT_BRANCH) {
      this.block(`You're on ${SNAPSHOT_BRANCH}`, `That's where Andromity keeps undo snapshots, not a branch for your work, so nothing can be shipped from it. Switch to your own branch or main with VS Code's branch picker, then open this form again. Files the agent made there are kept in the snapshot commits.`, [
        { id: "switch_branch", label: "Switch branch", primary: true }, { id: "close", label: "Close" }]);
      this.track("pr_blocked_snapshot_branch");
      return;
    }
    if (context.inProgress) {
      this.block(`Finish the ${context.inProgress} first`, `A ${context.inProgress} is in progress in this repository. Finish or abort it in Source Control, then try again.`, [{ id: "close", label: "Close" }]);
      this.track("pr_blocked_in_progress");
      return;
    }
    this.initForm(context);
    this.phase = "form";
    this.trackOnce(`pr_host_${context.remote ? (context.remote.local ? "local" : context.remote.parsed?.kind ?? "unknown") : "none"}`);
    if (context.github.problem) this.trackOnce(`pr_github_${context.github.problem}`);
    this.postView();
    this.postField("branchName", this.form.branchName);
    if (this.form.descriptionSource === "template") this.postField("description", this.form.description);
    void this.loadAssignees(generation);
    if (this.form.createBranch) void this.ensureFreeBranch(generation);
    this.scheduleEvaluate(0);
    void this.loadReceipt(generation);
    void this.draft(generation, this.form.descriptionSource !== "template");
  }

  private reset(): void {
    this.form = freshForm();
    this.context = null;
    this.selection = null;
    this.receipt = null;
    this.receiptReason = "Loading the receipt…";
    this.receiptLoading = false;
    this.branchRenamedFrom = null;
    this.templateText = null;
    this.blocked = null;
    this.plan = null;
    this.runState = {};
    this.result = null;
    this.failure = null;
    this.steps = [];
    this.drafting = false;
    this.draftNote = null;
    this.assignees = [];
    this.stopRequested = false;
    this.tracked = new Set();
  }

  private block(title: string, message: string, actions: PrAction[]): void {
    this.phase = "blocked";
    this.blocked = { title, message, actions };
    this.postView();
  }

  private initForm(context: RepoContext): void {
    const settings = vscode.workspace.getConfiguration("andromity");
    const hasTurn = !!this.host.turnFiles();
    this.form.scope = hasTurn && this.host.scope() === "turn" ? "turn" : "all";
    this.form.base = context.base;
    this.form.createBranch = this.mustCreate();
    this.form.branchName = this.form.createBranch
      ? suggestBranchName(branchPrefix(settings.get("pullRequest.branchPrefix")), undefined, this.scopeFiles().map((file) => file.path))
      : context.head.branch ?? "";
    this.form.fromLatest = true;
    this.form.attachReceipt = settings.inspect<boolean>("pullRequest.attachReceipt")?.globalValue !== false;
    if (context.template) {
      this.form.description = plainText(context.template, MAX_DESCRIPTION);
      this.templateText = this.form.description;
      this.form.descriptionSource = "template";
    }
  }

  private mustCreate(): boolean {
    const head = this.context?.head;
    return !head?.branch || head.branch === this.form.base;
  }

  // ── Files, receipt and checks ───────────────────────────────
  private scopeFiles(): PrFile[] {
    const files = this.host.files();
    const turn = this.host.turnFiles();
    if (this.form.scope !== "turn" || !turn) return files;
    const set = new Set(turn);
    return files.filter((file) => set.has(file.path));
  }

  private isTicked(file: PrFile): boolean {
    if (this.form.ticked.has(file.path)) return true;
    if (this.form.unticked.has(file.path)) return false;
    return !this.isSensitive(file.path);
  }

  /** Flagged by the turn's receipt, or named like a secrets file by the same rule the engine uses. */
  private isSensitive(filePath: string): boolean {
    return !!this.receipt?.sensitive.has(filePath) || looksSensitive(filePath);
  }

  private tickedFiles(): PrFile[] {
    return this.scopeFiles().filter((file) => this.isTicked(file));
  }

  private toRepoPath(projectRelative: string): string | null {
    const root = this.host.repositoryRoot();
    const project = this.host.projectPath() || root;
    if (!root || !project || typeof projectRelative !== "string" || !projectRelative) return null;
    const abs = path.resolve(project, projectRelative);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  private async loadReceipt(generation: number): Promise<void> {
    const hadReceipt = !!this.receipt;
    this.receipt = null;
    if (hadReceipt) this.scheduleEvaluate(0);
    this.receiptRecovered = false;
    this.receiptMatch = null;
    const rpc = this.host.rpc();
    const known = this.host.turnFiles() ? this.host.turn() : null;
    const sessionId = known?.sessionId ?? this.host.currentSession?.() ?? null;
    const recovering = !known;
    if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      this.receiptReason = "There's no agent turn for these changes, so there's no receipt to attach.";
      this.postView();
      return;
    }
    if (known && known.turnIndex === null) {
      this.receiptReason = "This turn's receipt isn't ready yet. It appears a moment after the turn ends.";
      this.postView();
      return;
    }
    if (!rpc) {
      this.receiptReason = "Reconnect Andromity's engine to attach the receipt.";
      this.postView();
      return;
    }
    this.receiptLoading = true;
    this.receiptReason = "Loading the receipt…";
    this.postView();
    const fetchOne = async (turnIndex?: number) => {
      try {
        return readResponse(await rpc.call<unknown>("session.receipt", {
          session_id: sessionId,
          project_path: this.host.projectPath(),
          ...(turnIndex === undefined ? {} : { turn_index: turnIndex }),
        }));
      } catch {
        return readResponse(null);
      }
    };
    let response: ReturnType<typeof readResponse>;
    try {
      response = known ? await fetchOne(known.turnIndex as number) : await this.findMatchingReceipt(fetchOne, generation);
    } finally {
      if (generation === this.generation) this.receiptLoading = false;
    }
    if (generation !== this.generation) return;
    if (recovering && (!response.success || !response.receipt || !response.markdown)) {
      this.receiptReason = "No turn in this chat made these changes as they are now, so there's no receipt to attach.";
      this.postView();
      return;
    }
    if (!response.success || !response.receipt || !response.markdown || (known && response.receipt.turn_index !== known.turnIndex)) {
      this.receiptReason = "The receipt couldn't be loaded. You can still ship without it.";
      this.trackOnce("pr_receipt_unavailable");
      this.postView();
      return;
    }
    const receipt = response.receipt;
    const files = this.receiptFiles(receipt);
    const sensitive = new Set<string>();
    const runsCode = new Set<string>();
    const high: LoadedReceipt["high"] = [];
    for (const finding of receipt.needs_attention) {
      const rel = finding.subject ? this.toRepoPath(finding.subject) : null;
      if (finding.kind === "sensitive" && rel && files.has(rel)) sensitive.add(rel);
      if (finding.kind === "runs_code" && rel) runsCode.add(rel);
      if (finding.severity === "high") high.push({ text: finding.detail, subject: finding.subject, kind: finding.kind });
    }
    if (recovering) {
      this.receiptRecovered = true;
      this.trackOnce("pr_receipt_recovered");
    }
    this.receipt = { receipt, markdown: response.markdown, files, sensitive, runsCode, high };
    this.receiptReason = null;
    if (high.length) this.trackOnce("pr_check_high");
    if (sensitive.size) this.trackOnce("pr_check_sensitive_left_out");
    this.scheduleEvaluate(0);
    this.postView();
  }

  private receiptFiles(receipt: Receipt): Map<string, { added: number | null; deleted: number | null }> {
    const files = new Map<string, { added: number | null; deleted: number | null }>();
    for (const entry of receipt.files_changed) {
      const rel = this.toRepoPath(entry.path);
      if (rel) files.set(rel, { added: entry.added, deleted: entry.deleted });
    }
    return files;
  }

  /** A turn whose changes are still in these files exactly: some file changed by the turn shows the same
   *  added and deleted line counts now. A file with the same name but other changes doesn't count. */
  private matchesChanges(receipt: Receipt): "exact" | "names" | null {
    const now = new Map(this.host.files().map((file) => [file.path, file]));
    let names = false;
    for (const [path, counts] of this.receiptFiles(receipt)) {
      const file = now.get(path);
      if (!file) continue;
      if (counts.added !== null && counts.added === file.additions && counts.deleted === file.deletions) return "exact";
      names = true;
    }
    return names ? "names" : null;
  }

  /** With no turn handed over (after a restart): the newest of the chat's last ten turns whose changes these are. */
  private async findMatchingReceipt(
    fetchOne: (turnIndex?: number) => Promise<ReturnType<typeof readResponse>>,
    generation: number,
  ): Promise<ReturnType<typeof readResponse>> {
    const none = readResponse(null);
    const latest = await fetchOne();
    if (generation !== this.generation || !latest.success || !latest.receipt) return none;
    let byName: ReturnType<typeof readResponse> | null = null;
    const consider = (response: ReturnType<typeof readResponse>): boolean => {
      if (!response.success || !response.receipt || !response.markdown) return false;
      const match = this.matchesChanges(response.receipt);
      if (match === "exact") {
        this.receiptMatch = "exact";
        return true;
      }
      if (match === "names" && !byName) byName = response;
      return false;
    };
    if (consider(latest)) return latest;
    const tried = new Set([latest.receipt.turn_index]);
    const earlier = [...(latest.turns ?? [])].filter((turn) => !tried.has(turn)).sort((a, b) => b - a).slice(0, 9);
    for (const turn of earlier) {
      const response = await fetchOne(turn);
      if (generation !== this.generation) return none;
      if (response.success && response.receipt?.turn_index === turn && consider(response)) return response;
    }
    if (byName) {
      this.receiptMatch = "names";
      return byName;
    }
    return none;
  }

  public turnChanged(): void {
    if (this.phase !== "form") return;
    void this.loadReceipt(this.generation);
  }

  public filesChanged(): void {
    if (this.phase === "form") this.scheduleEvaluate(150);
  }

  private scheduleEvaluate(delay: number): void {
    if (this.evaluateTimer) clearTimeout(this.evaluateTimer);
    this.evaluateTimer = setTimeout(() => {
      this.evaluateTimer = undefined;
      void this.evaluate();
    }, delay);
  }

  private async evaluate(): Promise<void> {
    if (!this.deps || this.phase !== "form") return;
    const seq = ++this.evaluateSeq;
    const generation = this.generation;
    this.selection = null;
    this.postView();
    let report: SelectionReport;
    try {
      report = await evaluateSelection(this.deps, this.tickedFiles());
    } catch {
      return;
    }
    if (seq !== this.evaluateSeq || generation !== this.generation) return;
    this.selection = report;
    if (report.secrets.length) this.trackOnce("pr_check_secret");
    if (report.stagedOutside.length) this.trackOnce("pr_check_staged_others");
    const limit = sizeWarningLimit(vscode.workspace.getConfiguration("andromity").get("pullRequest.sizeWarningLines"));
    if (limit > 0 && report.size.lines > limit) this.trackOnce("pr_check_size");
    this.postView();
  }

  private textSecrets(): SecretHit[] {
    const hits = secretsInText("commit_message", this.form.commitMessage);
    if (this.showPullFields()) {
      hits.push(...secretsInText("title", this.form.title), ...secretsInText("description", this.form.description));
    }
    return hits;
  }

  private checkItems(): { items: PrCheckItem[]; notes: string[]; key: string } | null {
    const items: PrCheckItem[] = [];
    const notes: string[] = [];
    const ticked = new Set(this.tickedFiles().map((file) => file.path));
    for (const finding of this.receipt?.high ?? []) {
      items.push({ label: "High", text: finding.text, subject: finding.subject });
    }
    if (this.receipt?.high.some((finding) => finding.kind === "git_internals")) {
      notes.push("Committing and pushing will run this repository's git hooks.");
    }
    const flagged = new Set((this.receipt?.high ?? []).filter((finding) => finding.kind === "sensitive").map((finding) => finding.subject ? this.toRepoPath(finding.subject) : null));
    const tickedSensitive = [...ticked].filter((file) => this.isSensitive(file));
    for (const file of tickedSensitive) {
      if (!flagged.has(file)) items.push({ label: "High", text: "A sensitive file is ticked", subject: file });
    }
    if (tickedSensitive.length) notes.push("A sensitive file is ticked. Pushing it can publish secrets.");
    const placeText: Record<string, string> = { commit_message: "in the commit message", title: "in the title", description: "in the description" };
    for (const hit of [...(this.selection?.secrets ?? []), ...this.textSecrets()]) {
      items.push(hit.place === "file"
        ? { label: "Secret", text: `Looks like ${/^[aeiou]/i.test(hit.kind) ? "an" : "a"} ${hit.kind}`, path: hit.path, line: hit.line }
        : { label: "Secret", text: `Looks like ${/^[aeiou]/i.test(hit.kind) ? "an" : "a"} ${hit.kind} ${placeText[hit.place]}` });
    }
    if (items.some((item) => item.label === "Secret")) {
      notes.push("Remove the key and rotate it, untick the file, or tick below if it's a test value. The scan knows common key formats only; a plain password can slip past it.");
    }
    if (!items.length) return null;
    const key = createHash("sha256").update(JSON.stringify([items, notes])).digest("hex").slice(0, 16);
    return { items, notes, key };
  }

  // ── Where it goes ───────────────────────────────────────────
  private signedOutGitHub(): boolean {
    const ctx = this.context;
    return !!ctx && ctx.remote?.parsed?.kind === "github" && ctx.canReachRemote && !this.deps?.github && !currentAirGap().enabled;
  }

  private updating(): boolean {
    return !!this.context?.existingPull && !this.form.createBranch;
  }

  private showPullFields(): boolean {
    const mode = this.modeFor("primary");
    return mode === "pull_request" || mode === "host_page" || mode === "push" || this.signedOutGitHub();
  }

  private modeFor(action: "primary" | "commit_only" | "push_open_page"): RunMode {
    const ctx = this.context;
    if (action === "commit_only" || !ctx?.remote || !ctx.canReachRemote) return "commit";
    const parsed = ctx.remote.parsed;
    if (action === "push_open_page") return parsed && parsed.kind !== "other" ? "host_page" : "push";
    if (this.updating() && this.deps?.github) return "update";
    if (parsed?.kind === "github" && ctx.github.repo && this.deps?.github) return "pull_request";
    if (parsed && parsed.kind !== "other") return "host_page";
    return "push";
  }

  private primaryAction(): PrimaryAction {
    return this.signedOutGitHub() && !this.updating() ? "sign_in_then_create" : "create";
  }

  private latestInfo(): { available: boolean; overlap: string[] } {
    const ctx = this.context;
    if (!ctx || !ctx.behind || !ctx.baseRemote || !this.form.createBranch) return { available: false, overlap: [] };
    const dirty = new Set(this.host.files().flatMap((file) => [file.path, file.originalPath].filter((p): p is string => !!p)));
    const overlap = (ctx.changedOnBase ?? []).filter((file) => dirty.has(file));
    return { available: overlap.length === 0 && ctx.changedOnBase !== undefined, overlap };
  }

  private startsFromLatest(): boolean {
    return this.form.fromLatest && this.latestInfo().available;
  }

  // ── Problems that stop the main button ──────────────────────
  private problem(): string | null {
    const ctx = this.context;
    if (!ctx) return "Reading the repository…";
    if (this.host.agentRunning()) return "Wait for the turn to finish. Files are still changing.";
    if (this.receiptLoading) return "Loading the receipt…";
    if (!ctx.userConfigured) return "Set your git name and email first: git config --global user.name \"Your Name\" and git config --global user.email you@example.com, then reopen this form.";
    const ticked = this.tickedFiles();
    if (!ticked.length) return "Tick at least one file.";
    if (this.form.createBranch) {
      if (!isValidBranchName(this.form.branchName)) return "Choose a branch name with letters, numbers, dots, dashes, underscores and slashes.";
      if (this.form.branchName.toLowerCase() === SNAPSHOT_BRANCH) return `${SNAPSHOT_BRANCH} is reserved for Andromity's undo snapshots. Choose another name.`;
      if (this.form.branchTaken) return `A branch named ${this.form.branchName} already exists. Choose another name.`;
    } else if (this.mustCreate()) {
      return "This goes on a new branch. Name it above.";
    }
    const repo = ctx.github.repo;
    if (repo && !repo.parent && !repo.canPush && this.modeFor("primary") !== "commit") {
      return `You can't push to ${repo.owner}/${repo.repo}. Fork it on GitHub, add your fork as a remote, then try again.`;
    }
    if (this.drafting && !this.form.commitMessage.trim()) return "Drafting the commit message…";
    if (!this.form.commitMessage.trim()) return "Write a commit message.";
    if (this.showPullFields() && !this.updating() && !cleanTitle(this.form.title)) return "Write a title.";
    if (this.form.description.length > MAX_DESCRIPTION) return "The description is longer than GitHub allows.";
    if (!this.selection) return "Checking the files…";
    if (this.selection.stagedOutside.length && !this.form.stagedChoice) return "Choose what to do with the other staged files.";
    const reviewers = this.reviewerChoice();
    if (reviewers?.problems.length) return reviewers.problems[0];
    const checks = this.checkItems();
    if (checks && this.form.ack !== checks.key) return "Tick “I've checked these” to continue.";
    return null;
  }

  private reviewerChoice(): ReturnType<typeof chooseReviewers> | null {
    const target = this.context?.github.target;
    if (!target || this.modeFor("primary") !== "pull_request" || !this.form.reviewers.length) return null;
    return chooseReviewers(this.form.reviewers, target.owner, this.context?.github.viewer ?? undefined);
  }

  // ── View ────────────────────────────────────────────────────
  private postView(): void {
    if (this.disposed) return;
    this.host.post({ type: "pr_view", view: this.view() });
  }

  private postField(field: "branchName" | "commitMessage" | "title" | "description", value: string): void {
    if (!this.disposed) this.host.post({ type: "pr_field", field, value });
  }

  private view(): PrView {
    switch (this.phase) {
      case "closed": return { phase: "closed" };
      case "loading": return { phase: "loading" };
      case "blocked": return { phase: "blocked", blocked: this.blocked ?? undefined };
      case "form": return { phase: "form", form: this.formView() };
      case "running": return { phase: "running", run: { title: this.sheetTitle(), steps: this.steps, cancellable: this.cancellable(), note: this.cancellable() ? null : "The push has started, so it can't be cancelled. The rest follows right after it." } };
      case "done": return { phase: "done", done: this.doneView() };
      case "failed": return { phase: "failed", failed: this.failedView() };
    }
  }

  private sheetTitle(): string {
    if (this.updating() && this.context?.existingPull) return `Update pull request #${this.context.existingPull.number}`;
    const mode = this.context ? this.modeFor("primary") : "pull_request";
    if (mode === "commit") return "Commit";
    return `Create ${requestNoun(this.context?.remote?.parsed?.kind ?? "github")}`;
  }

  private cancellable(): boolean {
    return this.running && !this.steps.some((step) => (step.id === "push" || step.id === "pull" || step.id === "comment") && step.status !== "pending");
  }

  private formView(): PrFormView {
    const ctx = this.context as RepoContext;
    const settings = vscode.workspace.getConfiguration("andromity");
    const parsed = ctx.remote?.parsed ?? null;
    const mode = this.modeFor("primary");
    const primaryAction = this.primaryAction();
    const ticked = this.tickedFiles();
    const tickedSet = new Set(ticked.map((file) => file.path));
    const all = this.host.files();
    const turn = this.host.turnFiles();
    const secretsByPath = new Map<string, number[]>();
    for (const hit of this.selection?.secrets ?? []) {
      if (hit.path) secretsByPath.set(hit.path, [...(secretsByPath.get(hit.path) ?? []), hit.line ?? 0]);
    }
    const files: PrFileRow[] = this.scopeFiles().map((file) => {
      const tags: PrTag[] = [];
      const checked = tickedSet.has(file.path);
      if (this.isSensitive(file.path)) tags.push({ text: checked ? "sensitive" : "sensitive · left out", tone: "danger" });
      if (this.receipt?.runsCode.has(file.path)) tags.push({ text: "runs code", tone: "danger" });
      const lines = secretsByPath.get(file.path);
      if (lines?.length) tags.push({ text: lines[0] ? `secret · line ${lines[0]}` : "secret", tone: "danger" });
      const turnCounts = this.receipt?.files.get(file.path);
      if (turnCounts && turnCounts.added !== null && (turnCounts.added !== file.additions || turnCounts.deleted !== file.deletions)) {
        tags.push({ text: "also has changes from outside this turn", tone: "muted" });
      }
      if (isLockfile(file.path)) tags.push({ text: "lockfile · not counted", tone: "muted" });
      return {
        path: file.path, status: file.status, additions: file.additions, deletions: file.deletions, binary: !!file.binary,
        checked, tags, notOpened: checked && !this.opened.has(file.path),
      };
    });

    const size = this.selection?.size;
    const limit = sizeWarningLimit(settings.get("pullRequest.sizeWarningLines"));
    let sizeLine: PrTag = { text: "Counting lines…", tone: "muted" };
    if (size) {
      const lock = size.lockfiles.length ? ` (${size.lockfiles.length === 1 ? size.lockfiles[0] : plural(size.lockfiles.length, "lockfile")} not counted)` : "";
      const base = `${plural(size.lines, "line")} changed in ${plural(size.files, "file")}${lock}.`;
      sizeLine = limit > 0 && size.lines > limit
        ? { text: `${base} Reviewers often ask for pull requests under ${limit} lines. Tick fewer files to ship this in parts; the rest stays uncommitted for the next pull request.`, tone: "warn" }
        : { text: base, tone: "muted" };
    }
    const leftOver = all.length - ticked.length;
    const leftOverLine = leftOver > 0
      ? `${plural(leftOver, "other changed file")} ${leftOver === 1 ? "stays" : "stay"} uncommitted${this.form.createBranch ? " and come with you to the new branch" : ""}.`
      : null;

    const notes: PrTag[] = [];
    const airGap = currentAirGap();
    if (!ctx.remote) notes.push({ text: "This repository has no remote yet, so this commits on this computer only.", tone: "muted" });
    else if (!ctx.canReachRemote) notes.push({ text: airGapOffMessage("pushing and opening pull requests"), tone: "muted" });
    if (ctx.remote && ctx.canReachRemote && !parsed && !ctx.remote.local) notes.push({ text: `Andromity doesn't recognise ${ctx.remote.name}'s host, so it will push and leave the pull request to you.`, tone: "muted" });
    if (ctx.github.problem === "not_found") {
      const who = ctx.github.viewer ? `@${ctx.github.viewer}` : "your sign-in";
      notes.push({ text: `GitHub can't find ${parsed?.owner}/${parsed?.repo} with ${who}. If it belongs to another of your GitHub accounts, choose Use another account. You can still push and open GitHub's page.`, tone: "warn" });
    }
    if (ctx.github.problem === "rate_limited") notes.push({ text: "GitHub is limiting requests right now. Try again in a few minutes.", tone: "warn" });
    if (ctx.github.problem === "unavailable") notes.push({ text: "GitHub didn't answer. You can still push and open GitHub's page.", tone: "warn" });
    if (ctx.fetchFailed) notes.push({ text: `Couldn't check whether ${this.form.base} has moved.`, tone: "muted" });
    const latest = this.latestInfo();
    if (ctx.behind && !this.form.createBranch) {
      notes.push({ text: `${this.form.base} has ${plural(ctx.behind, "commit")} this branch doesn't have. ${hostName(parsed?.kind)} will show any conflicts.`, tone: "warn" });
    }
    if (ctx.unpushed && !this.startsFromLatest() && ctx.head.branch) {
      notes.push({ text: `${plural(ctx.unpushed, "earlier commit")} on ${ctx.head.branch} ${ctx.unpushed === 1 ? "isn't" : "aren't"} on ${ctx.baseRemote ?? "the remote"} yet. ${ctx.unpushed === 1 ? "It'll" : "They'll"} be in this ${requestNoun(parsed?.kind ?? "github")} too.`, tone: "warn" });
    }
    if (this.selection?.notScanned.length) {
      notes.push({ text: `Not scanned for secrets (binary or very large): ${this.selection.notScanned.slice(0, 5).join(", ")}${this.selection.notScanned.length > 5 ? "…" : ""}.`, tone: "muted" });
    }

    const head = ctx.head;
    const branchNote = !head.branch
      ? `You're on a detached commit (${shortSha(head.commit ?? undefined)}), not a branch. This goes on a new branch from here.`
      : head.branch === this.form.base
        ? `You're on ${head.branch}, so this goes on a new branch. ${head.branch} itself won't change.`
        : this.form.createBranch ? `A new branch from ${head.branch}.` : `Commits onto ${head.branch}, your current branch.`;
    const renamed = this.form.createBranch && this.branchRenamedFrom && this.branchRenamedFrom !== this.form.branchName && !this.form.branchEdited
      ? ` ${this.branchRenamedFrom} is taken, so this uses ${this.form.branchName}.` : "";

    let account: PrFormView["account"] = null;
    let accountNote: string | null = null;
    if (parsed?.kind === "github" && ctx.canReachRemote && !airGap.enabled) {
      if (this.deps?.github && ctx.github.viewer) account = { kind: "signed_in", login: ctx.github.viewer, switchable: true };
      else if (ctx.github.problem === "unauthorized") account = { kind: "sign_in", label: "Sign in again" };
      else if (!this.deps?.github) account = { kind: "sign_in", label: "Sign in to GitHub" };
      if (ctx.github.problem === "sso") accountNote = `${parsed.owner} requires single sign-on for this sign-in. Authorize it, then reopen this form.`;
    }

    const receiptShown = mode !== "commit" && (!this.updating() || !!ctx.existingPull);
    const matchesTurns = (mode === "pull_request" || mode === "update") && !!this.host.rpc();
    const r = this.receipt?.receipt;
    const findings = r?.needs_attention.length ?? 0;
    const receiptSummary = r
      ? `Receipt · turn ${r.turn_index + 1}${this.receiptRecovered ? (this.receiptMatch === "exact" ? " (found by matching these changes)" : " (found by file name; these files also have other changes)") : ""} · ${plural(r.summary.files_changed, "file")} changed · ${plural(r.summary.commands, "command")}${findings ? ` · ${findings} to check` : " · nothing flagged"}${r.sealed?.matches ? " · sealed" : ""}`
      : null;
    const isPublic = ctx.github.repo ? !ctx.github.repo.isPrivate : null;
    const publicNote = receiptShown && this.receipt && this.form.attachReceipt
      ? isPublic === true
        ? "This repository is public. The receipt shows file paths, commands, the model, the cost and approver names from git settings (never emails)."
        : isPublic === null ? "Anyone who can see this repository can read the receipt: file paths, commands, the model, the cost and approver names from git settings." : null
      : null;

    const showPull = this.showPullFields() && !this.updating();
    const description = this.form.description;
    const chips = showPull
      ? [...closedIssuesIn(description).map((ref) => `Merging will close ${ref}`), ...mentionsIn(description).map((who) => `This will notify ${who}`)]
      : [];
    const reviewerChoice = this.reviewerChoice();
    const checks = this.checkItems();
    const problem = this.problem();

    let primaryLabel: string;
    if (primaryAction === "sign_in_then_create") primaryLabel = "Sign in and create pull request";
    else if (mode === "update") primaryLabel = `Update pull request #${ctx.existingPull?.number}`;
    else if (mode === "pull_request") primaryLabel = "Create pull request";
    else if (mode === "host_page") primaryLabel = `Push and open ${requestNoun(parsed?.kind ?? "github")} page`;
    else if (mode === "push") primaryLabel = "Push";
    else primaryLabel = "Commit";
    const secondary: PrAction[] = [];
    if (primaryAction === "sign_in_then_create") secondary.push({ id: "push_open_page", label: "Push and open GitHub" });
    if (mode !== "commit") secondary.push({ id: "commit_only", label: "Commit only" });
    if (!ctx.remote) secondary.push({ id: "publish", label: "Publish to GitHub…" });

    return {
      title: this.sheetTitle(),
      repo: parsed ? { display: parsed.display, visibility: isPublic === null ? null : isPublic ? "public" : "private" } : ctx.remote ? { display: ctx.remote.name, visibility: null } : null,
      account,
      accountNote,
      update: this.updating() && ctx.existingPull ? { number: ctx.existingPull.number, title: ctx.existingPull.title } : null,
      base: this.form.base,
      baseOptions: ctx.baseOptions,
      branch: {
        current: head.branch,
        mustCreate: this.mustCreate(),
        create: this.form.createBranch,
        note: branchNote + renamed,
        nameProblem: this.form.createBranch && this.form.branchName && !isValidBranchName(this.form.branchName)
          ? "Use letters, numbers, dots, dashes, underscores and slashes."
          : this.form.branchTaken ? "That name is taken." : null,
      },
      latest: this.form.createBranch && ctx.behind
        ? {
          show: true,
          enabled: latest.available,
          on: this.startsFromLatest(),
          label: `Start the new branch from the latest ${this.form.base} (${plural(ctx.behind, "new commit")} on ${ctx.baseRemote})`,
          note: latest.overlap.length
            ? `${latest.overlap.slice(0, 3).join(", ")}${latest.overlap.length > 3 ? "…" : ""} also changed on ${ctx.baseRemote}/${this.form.base}, so the branch starts from your current commit. ${hostName(parsed?.kind)} will show any conflicts.`
            : this.startsFromLatest() && ctx.unpushed ? `Your ${plural(ctx.unpushed, "unpushed commit")} on ${head.branch} won't be in this pull request.` : null,
        }
        : null,
      notes,
      scope: this.form.scope,
      hasTurn: !!turn,
      turnCount: turn ? all.filter((file) => turn.includes(file.path)).length : 0,
      allCount: all.length,
      files,
      sizeLine,
      leftOverLine,
      stagedOutside: this.selection?.stagedOutside.length ? { paths: this.selection.stagedOutside.slice(0, 20), choice: this.form.stagedChoice } : null,
      drafting: this.drafting,
      draftNote: this.draftNote,
      commitAi: !this.form.commitEdited && !!this.form.commitMessage,
      coAuthor: settings.get<boolean>("includeCoAuthor", true) !== false,
      showPullFields: showPull,
      descriptionLabel: this.form.descriptionSource === "ai" && !this.form.descriptionEdited ? "Drafted by AI · edit before you send"
        : this.form.descriptionSource === "template" ? "From the repository's template" : "",
      descriptionHint: showPull ? "Say why this change is needed. Reviewers read that first." : null,
      chips,
      reviewers: { show: mode === "pull_request" && showPull, suggestions: this.assignees, problems: reviewerChoice?.problems ?? [] },
      receipt: {
        show: receiptShown,
        available: !!this.receipt,
        reason: this.receipt ? null : this.receiptReason,
        attach: !!this.receipt && (this.updating() ? this.form.commentReceipt : this.form.attachReceipt),
        label: matchesTurns && this.receipt
          ? (this.updating() && ctx.existingPull ? `Add the receipts of the turns in it to #${ctx.existingPull.number} as a comment` : "Attach the receipts of the turns in this pull request")
          : this.updating() && ctx.existingPull ? `Add this turn's receipt to #${ctx.existingPull.number} as a comment` : "Attach this turn's receipt",
        summary: matchesTurns && receiptSummary ? `${receiptSummary}. Other turns whose changes are in the pull request are matched after the push.` : receiptSummary,
        preview: this.receipt ? this.previewBody() : null,
      },
      publicNote,
      draft: { show: mode === "pull_request" && showPull, on: this.form.draft },
      checks: checks ? { ...checks, acked: this.form.ack === checks.key } : null,
      primary: { label: primaryLabel, enabled: !problem },
      secondary,
      disabledReason: problem,
      plan: this.planSentence(mode, primaryAction, ticked.length) + this.receiptSentence(mode),
    };
  }

  private planSentence(mode: RunMode, action: PrimaryAction, count: number): string {
    const ctx = this.context as RepoContext;
    const files = plural(count, "file");
    const branch = this.form.createBranch ? `the new branch ${this.form.branchName || "…"}` : this.form.branchName || ctx.head.branch || "this branch";
    const from = this.form.createBranch && this.startsFromLatest() ? `, starting from the latest ${this.form.base},` : "";
    const remote = ctx.remote?.name ?? "the remote";
    const where = ctx.github.target ? `${ctx.github.target.owner}/${ctx.github.target.repo}` : ctx.remote?.parsed?.display ?? remote;
    const parsed = ctx.remote?.parsed;
    if (action === "sign_in_then_create") {
      return `VS Code asks you to sign in to GitHub first; Andromity never sees your password. Then this commits ${files} to ${branch}${from} pushes it to ${remote} and opens a pull request into ${this.form.base}.`;
    }
    switch (mode) {
      case "pull_request":
        return `Commits ${files} to ${branch}${from} pushes it to ${remote} and opens a pull request into ${this.form.base} on ${where}.`;
      case "update": {
        const comment = this.receipt && this.form.commentReceipt ? ` and adds the receipts of the turns in it to #${ctx.existingPull?.number} as a comment` : "";
        return `Commits ${files} to ${branch} and pushes it to ${remote}${comment}.`;
      }
      case "host_page":
        return `Commits ${files} to ${branch}${from} pushes it to ${remote} and opens ${hostName(parsed?.kind)}'s page to create the ${requestNoun(parsed?.kind ?? "github")}. The title and description are copied for you to paste.`;
      case "push":
        return `Commits ${files} to ${branch}${from} and pushes it to ${remote}. Then create the pull request on your host; the description is copied for you.`;
      default:
        return `Commits ${files} to ${branch}${from} on this computer only. Nothing is pushed.`;
    }
  }

  private receiptSentence(mode: RunMode): string {
    if (mode === "commit") return "";
    if (mode === "update") {
      return this.receipt && this.form.commentReceipt ? "" : " No receipt is added.";
    }
    if (!this.receipt) return " No receipt is attached.";
    if (!this.form.attachReceipt) return " The receipt is not attached.";
    return mode === "pull_request"
      ? ` The receipt for turn ${this.receipt.receipt.turn_index + 1} is attached below the description, with the receipts of any other turns whose changes are in the pull request.`
      : ` The receipt for turn ${this.receipt.receipt.turn_index + 1} is attached below the description.`;
  }

  private receiptLink(commit?: string, committedPaths?: readonly string[]): ReceiptLink | null {
    if (!this.receipt) return null;
    const committed = new Set(committedPaths ?? pathsToStage(this.tickedFiles()));
    const turnFiles = [...this.receipt.files.keys()];
    return {
      turnIndex: this.receipt.receipt.turn_index,
      matched: this.receiptRecovered ? this.receiptMatch ?? "names" : undefined,
      commitSha: commit,
      leftOut: turnFiles.filter((file) => !committed.has(file)),
      extra: [...committed].filter((file) => !this.receipt?.files.has(file)),
    };
  }

  private bodyFor(commit: string | undefined, committedPaths?: readonly string[]): string {
    const link = this.receiptLink(commit, committedPaths);
    const attach = this.receipt && this.form.attachReceipt && link;
    return composeBody(this.form.description, attach ? { markdown: (this.receipt as LoadedReceipt).markdown, link } : undefined).body;
  }

  /** Every turn, in any chat of this project, whose changes are in the pushed pull request: a table of files and
   *  the turns that made them, then each turn's receipt. Null when receipts are off or the engine can't match them. */
  private async receiptsSection(budget: number): Promise<string | null> {
    if (!this.receipt || !(this.updating() ? this.form.commentReceipt : this.form.attachReceipt)) return null;
    const rpc = this.host.rpc();
    const ctx = this.context;
    if (!rpc || !ctx) return null;
    const baseRef = ctx.baseRemote ? `${ctx.baseRemote}/${this.form.base}` : this.form.base;
    let res: any;
    try {
      res = await rpc.call<unknown>("pr.provenance", { project_path: this.host.projectPath(), base_ref: baseRef });
    } catch {
      return null;
    }
    if (!res || res.success !== true || !Array.isArray(res.files)) return null;
    const ID = /^[A-Za-z0-9_-]{1,128}$/;
    const turnRef = (t: any) => (t && typeof t.session_id === "string" && ID.test(t.session_id) && Number.isSafeInteger(t.turn_index) && t.turn_index >= 0 ? t : null);
    const chats: string[] = [];
    for (const file of res.files) for (const t of Array.isArray(file?.turns) ? file.turns : []) if (turnRef(t) && !chats.includes(t.session_id)) chats.push(t.session_id);
    const label = (t: { session_id: string; turn_index: number }) => `turn ${t.turn_index + 1}${chats.length > 1 ? ` · chat ${chats.indexOf(t.session_id) + 1}` : ""}`;
    const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
    const rows: ProvenanceRow[] = res.files.slice(0, 3000).map((file: any) => ({
      path: plainText(file?.path, 1000),
      oldPath: typeof file?.old_path === "string" ? plainText(file.old_path, 1000) : null,
      additions: count(file?.additions),
      deletions: count(file?.deletions),
      binary: file?.binary === true,
      coverage: ["covered", "partial", "edited"].includes(file?.coverage) ? file.coverage : "none",
      turns: (Array.isArray(file?.turns) ? file.turns : []).map(turnRef).filter(Boolean).map(label),
    })).filter((row: ProvenanceRow) => row.path);
    const totals = {
      files: rows.length,
      covered: rows.filter((row) => row.coverage === "covered").length,
      partial: rows.filter((row) => row.coverage === "partial").length,
      edited: rows.filter((row) => row.coverage === "edited").length,
    };
    const turns = (Array.isArray(res.turns) ? res.turns : []).map(turnRef).filter(Boolean)
      .sort((a: any, b: any) => chats.indexOf(a.session_id) - chats.indexOf(b.session_id) || b.turn_index - a.turn_index);
    const receipts: Provenance["receipts"] = [];
    const missing: string[] = [];
    for (const turn of turns) {
      if (receipts.length >= 8) {
        missing.push(label(turn));
        continue;
      }
      let response: ReturnType<typeof readResponse>;
      try {
        response = readResponse(await rpc.call<unknown>("session.receipt", { session_id: turn.session_id, project_path: this.host.projectPath(), turn_index: turn.turn_index }));
      } catch {
        response = readResponse(null);
      }
      if (!response.success || !response.receipt || !response.markdown || response.receipt.turn_index !== turn.turn_index) {
        missing.push(label(turn));
        continue;
      }
      receipts.push({
        label: label(turn),
        files: response.receipt.files_changed.length,
        needsEyes: response.receipt.needs_attention.some((finding) => finding.severity === "high"),
        markdown: response.markdown,
      });
    }
    if (!totals.files) return null;
    const head = typeof res.head === "string" ? res.head : "";
    this.trackOnce(totals.covered === totals.files ? "pr_receipts_all_covered" : totals.covered ? "pr_receipts_some_covered" : "pr_receipts_none_covered");
    if (chats.length > 1) this.trackOnce("pr_receipts_many_chats");
    return composeProvenance({ rows, totals, receipts, missing, head, truncated: res.truncated === true }, budget).text;
  }

  /** The published body: the description, then the receipts of every turn in the pull request, or the one
   *  turn's receipt when the engine can't match the pushed files to turns. */
  private async publishedBody(commit: string, committedPaths?: readonly string[]): Promise<string> {
    const description = closeOpenBlocks(plainText(this.form.description, MAX_DESCRIPTION).trim());
    const section = await this.receiptsSection(GITHUB_BODY_LIMIT - 512 - description.length - 4);
    this.publishedSection = section !== null;
    if (section === null) return this.bodyFor(commit, committedPaths);
    return `${description ? description + "\n\n" : ""}${section}`;
  }

  private previewBody(): string {
    if (!this.receipt) return "";
    const link = this.receiptLink(undefined) as ReceiptLink;
    return this.updating()
      ? composeReceiptComment({ markdown: this.receipt.markdown, link }).body
      : composeBody("", { markdown: this.receipt.markdown, link }).body;
  }

  // ── Async helpers ───────────────────────────────────────────
  private async readFile(root: string, rel: string): Promise<Uint8Array | null> {
    if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
    const abs = path.resolve(root, ...rel.split("/"));
    const relative = path.relative(root, abs);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    try {
      const stat = await fs.promises.lstat(abs);
      if (stat.isSymbolicLink()) return Buffer.from(`symlink:${await fs.promises.readlink(abs)}`, "utf8");
      if (!stat.isFile()) return null;
      return await fs.promises.readFile(abs);
    } catch {
      return null;
    }
  }

  private async fileDiff(rel: string): Promise<{ diff: string; omitted: boolean } | null> {
    const rpc = this.host.rpc();
    if (!rpc) return null;
    try {
      const res = await rpc.call<{ diff?: string; notice?: string }>("git.file_diff", { project_path: this.host.projectPath(), path: rel });
      const diff = typeof res?.diff === "string" ? res.diff : "";
      return { diff, omitted: !!res?.notice || !diff };
    } catch {
      return null;
    }
  }

  private async githubClient(prompt: "silent" | "ask" | "renew" | "choose"): Promise<GitHubClient | null> {
    try {
      const session = prompt === "silent"
        ? await vscode.authentication.getSession("github", ["repo"], { createIfNone: false, silent: true })
        : prompt === "ask"
          ? await vscode.authentication.getSession("github", ["repo"], { createIfNone: true })
          : prompt === "choose"
            ? await vscode.authentication.getSession("github", ["repo"], { createIfNone: true, clearSessionPreference: true })
            : await vscode.authentication.getSession("github", ["repo"], { forceNewSession: { detail: "GitHub refused the saved sign-in. Sign in again to open the pull request." } });
      return session?.accessToken ? new GitHubClient(session.accessToken, fetchImpl) : null;
    } catch {
      return null;
    }
  }

  private async loadAssignees(generation: number): Promise<void> {
    const target = this.context?.github.target;
    if (!target || !this.deps?.github) return;
    const list = await this.deps.github.assignees(target.owner, target.repo).catch(() => [] as string[]);
    if (generation !== this.generation) return;
    const self = this.context?.github.viewer?.toLowerCase();
    this.assignees = list.filter((login) => login.toLowerCase() !== self);
    this.postView();
  }

  private async draft(generation: number, withDescription: boolean, descriptionOnly = false): Promise<void> {
    const rpc = this.host.rpc();
    const settings = vscode.workspace.getConfiguration("andromity");
    const describe = withDescription && (descriptionOnly || settings.get<boolean>("pullRequest.draftWithAI", true) !== false) && this.showPullFields() && !this.updating();
    if (!rpc) {
      this.draftNote = "Drafting needs Andromity's engine. Write the message yourself, or reconnect and press Draft again.";
      this.postView();
      return;
    }
    const files = this.tickedFiles().filter((file) => !file.binary);
    let diff = "";
    for (const file of files) {
      if (diff.length >= 8000) break;
      if (this.isSensitive(file.path)) continue;
      const res = await this.fileDiff(file.path);
      if (res?.diff) diff += res.diff.endsWith("\n") ? res.diff : res.diff + "\n";
    }
    diff = redactSecrets(diff, findSecrets(diff), "[secret removed]");
    if (generation !== this.generation) return;
    if (!diff.trim()) {
      this.draftNote = "Nothing to draft from: the ticked files have no text changes.";
      this.postView();
      return;
    }
    this.drafting = true;
    this.draftNote = null;
    this.postView();
    try {
      const draft = await draftCommitAndDescription(rpc, {
        diff, files: files.map((file) => file.path), projectPath: this.host.projectPath(), withDescription: describe,
      }, (msg) => this.host.log(msg));
      if (generation !== this.generation || this.phase !== "form") return;
      this.track("pr_draft_ok");
      const message = cleanDraft(draft.commitMessage, MAX_COMMIT_MESSAGE);
      if (descriptionOnly && !draft.description) {
        this.draftNote = "The model didn't write a description. Write one, or press Draft with AI again.";
      }
      if (!descriptionOnly && !this.form.commitEdited && message) {
        this.form.commitMessage = message;
        this.postField("commitMessage", message);
      }
      const subject = cleanTitle(message.split("\n", 1)[0]);
      if (!descriptionOnly && !this.form.titleEdited && subject) {
        this.form.title = subject;
        this.postField("title", subject);
      }
      if (describe && draft.description && !this.form.descriptionEdited) {
        const text = cleanDraft(draft.description);
        this.form.description = this.form.descriptionSource === "template" && this.templateText
          ? `${text}\n\n${this.templateText}` : text;
        this.form.descriptionSource = this.form.descriptionSource === "template" ? "template" : "ai";
        this.postField("description", this.form.description);
      }
      if (!descriptionOnly && this.form.createBranch && !this.form.branchEdited && subject) {
        const prefix = branchPrefix(settings.get("pullRequest.branchPrefix"));
        this.form.branchName = suggestBranchName(prefix, subject, files.map((file) => file.path));
        this.postField("branchName", this.form.branchName);
        await this.ensureFreeBranch(generation);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.track("pr_draft_failed");
      this.draftNote = `Couldn't draft a message: ${error instanceof DraftError ? error.message : "the model didn't answer."} Write one, or press Draft again.`;
    } finally {
      if (generation === this.generation) {
        this.drafting = false;
        this.postView();
      }
    }
  }

  private async ensureFreeBranch(generation: number): Promise<void> {
    if (!this.deps || !this.context || !isValidBranchName(this.form.branchName)) return;
    const seq = ++this.branchSeq;
    const wanted = this.form.branchName;
    if (this.form.branchEdited) {
      const taken = await branchTaken(this.deps, this.context, wanted).catch(() => false);
      if (seq !== this.branchSeq || generation !== this.generation) return;
      this.form.branchTaken = taken;
      this.postView();
      return;
    }
    const free = await freeBranchName(this.deps, this.context, wanted).catch(() => wanted);
    if (seq !== this.branchSeq || generation !== this.generation || this.form.branchEdited) return;
    this.form.branchTaken = false;
    if (free && free !== wanted) {
      this.branchRenamedFrom = wanted;
      this.form.branchName = free;
      this.postField("branchName", free);
    }
    this.postView();
  }

  // ── Messages from the webview ───────────────────────────────
  public async handle(message: any): Promise<void> {
    if (!message || typeof message.type !== "string") return;
    switch (message.type) {
      case "pr_open":
        await this.open();
        return;
      case "pr_close":
        this.close();
        return;
      case "pr_update":
        this.applyUpdate(message.changes);
        return;
      case "pr_redraft":
        if (this.phase === "form" && !this.drafting) {
          this.form.commitEdited = false;
          if (this.form.descriptionSource !== "template") this.form.descriptionEdited = false;
          void this.draft(this.generation, true);
        }
        return;
      case "pr_draft_description":
        if (this.phase === "form" && !this.drafting) {
          this.form.descriptionEdited = false;
          void this.draft(this.generation, true, true);
        }
        return;
      case "pr_sign_in":
        await this.signIn("ask");
        return;
      case "pr_switch_account":
        await this.signIn("choose");
        return;
      case "pr_submit":
        if (message.form) this.applyUpdate(message.form);
        await this.submit(message.action === "commit_only" ? "commit_only" : message.action === "push_open_page" ? "push_open_page" : "primary");
        return;
      case "pr_action":
        await this.action(typeof message.action === "string" ? message.action : "");
        return;
    }
  }

  private str(value: unknown, limit: number): string | null {
    return typeof value === "string" ? plainText(value, limit) : null;
  }

  private applyUpdate(changes: any): void {
    if (this.phase !== "form" || !changes || typeof changes !== "object") return;
    const known = new Set(this.host.files().map((file) => file.path));
    let reevaluate = false;
    let rebranch = false;
    if (changes.scope === "turn" || changes.scope === "all") {
      if (changes.scope !== this.form.scope && (changes.scope === "all" || this.host.turnFiles())) {
        this.form.scope = changes.scope;
        reevaluate = true;
      }
    }
    if (changes.file && typeof changes.file.path === "string" && known.has(changes.file.path)) {
      const p = changes.file.path as string;
      if (changes.file.checked === true) {
        this.form.ticked.add(p);
        this.form.unticked.delete(p);
      } else if (changes.file.checked === false) {
        this.form.unticked.add(p);
        this.form.ticked.delete(p);
      }
      reevaluate = true;
    }
    if (typeof changes.base === "string" && isValidBranchName(changes.base) && changes.base !== this.form.base
      && (this.context?.baseOptions ?? []).includes(changes.base)) {
      this.form.base = changes.base;
      if (this.mustCreate() && !this.form.createBranch) {
        this.form.createBranch = true;
        rebranch = true;
      }
      void this.refreshBase();
    }
    if (typeof changes.createBranch === "boolean") {
      const next = changes.createBranch || this.mustCreate();
      if (next !== this.form.createBranch) {
        this.form.createBranch = next;
        if (next && !this.form.branchEdited) {
          const prefix = branchPrefix(vscode.workspace.getConfiguration("andromity").get("pullRequest.branchPrefix"));
          this.form.branchName = suggestBranchName(prefix, this.form.commitMessage || undefined, this.tickedFiles().map((file) => file.path));
          this.postField("branchName", this.form.branchName);
          rebranch = true;
        } else if (!next) {
          this.form.branchName = this.context?.head.branch ?? "";
          this.form.branchTaken = false;
        }
      }
    }
    const branchName = this.str(changes.branchName, 200);
    if (branchName !== null && this.form.createBranch && branchName.trim() !== this.form.branchName) {
      this.form.branchName = branchName.trim();
      this.form.branchEdited = true;
      this.form.branchTaken = false;
      rebranch = true;
    }
    if (typeof changes.fromLatest === "boolean") this.form.fromLatest = changes.fromLatest;
    const commit = this.str(changes.commitMessage, MAX_COMMIT_MESSAGE);
    if (commit !== null && commit !== this.form.commitMessage) {
      this.form.commitMessage = commit;
      this.form.commitEdited = true;
      const subject = cleanTitle(commit.split("\n", 1)[0]);
      if (!this.form.titleEdited && subject && subject !== this.form.title) {
        this.form.title = subject;
        this.postField("title", subject);
      }
    }
    const title = this.str(changes.title, MAX_TITLE * 2);
    if (title !== null && title !== this.form.title) {
      this.form.title = title;
      this.form.titleEdited = true;
    }
    const description = this.str(changes.description, MAX_UPDATE_TEXT);
    if (description !== null && description !== this.form.description) {
      this.form.description = description;
      this.form.descriptionEdited = true;
    }
    if (Array.isArray(changes.reviewers)) {
      this.form.reviewers = changes.reviewers.filter((entry: unknown) => typeof entry === "string").slice(0, 30).map((entry: string) => entry.slice(0, 120));
    }
    if (typeof changes.attachReceipt === "boolean") this.form.attachReceipt = changes.attachReceipt;
    if (typeof changes.commentReceipt === "boolean") this.form.commentReceipt = changes.commentReceipt;
    if (typeof changes.draft === "boolean") this.form.draft = changes.draft;
    if (changes.ack === null || typeof changes.ack === "string") this.form.ack = changes.ack;
    if (changes.stagedChoice === "unstage" || changes.stagedChoice === "include") {
      this.form.stagedChoice = changes.stagedChoice;
      if (changes.stagedChoice === "include") {
        for (const p of this.selection?.stagedOutside ?? []) {
          if (known.has(p)) {
            this.form.ticked.add(p);
            this.form.unticked.delete(p);
          }
        }
        if (this.form.scope === "turn" && (this.selection?.stagedOutside ?? []).some((p) => !this.scopeFiles().some((file) => file.path === p))) {
          this.form.scope = "all";
        }
        reevaluate = true;
      }
    }
    if (reevaluate) this.scheduleEvaluate(120);
    if (rebranch) {
      if (this.branchTimer) clearTimeout(this.branchTimer);
      const generation = this.generation;
      this.branchTimer = setTimeout(() => void this.ensureFreeBranch(generation), 300);
    }
    this.postView();
  }

  private async refreshBase(): Promise<void> {
    const ctx = this.context;
    const deps = this.deps;
    if (!ctx || !deps || !ctx.baseRemote || !ctx.canReachRemote) return;
    const generation = this.generation;
    const base = this.form.base;
    const ref = `${ctx.baseRemote}/${base}`;
    try {
      await deps.git.fetch(ctx.baseRemote, base);
      const known = await deps.git.remoteBranchKnown(ctx.baseRemote, base);
      const behind = known ? await deps.git.countCommits(`HEAD..${ref}`) : undefined;
      const unpushed = known ? await deps.git.countCommits(`${ref}..HEAD`) : undefined;
      const changed = known && behind ? await deps.git.changedSince("HEAD", ref) : [];
      if (generation !== this.generation || base !== this.form.base) return;
      ctx.behind = behind;
      ctx.unpushed = unpushed;
      ctx.changedOnBase = changed;
      ctx.fetchFailed = false;
    } catch {
      if (generation !== this.generation) return;
      ctx.fetchFailed = true;
    }
    this.postView();
  }

  private async signIn(kind: "ask" | "renew" | "choose"): Promise<boolean> {
    if (!this.deps || currentAirGap().enabled || this.running) return false;
    if (kind !== "renew" && this.phase !== "form") return false;
    this.track(kind === "ask" ? "pr_sign_in" : kind === "choose" ? "pr_switch_account" : "pr_sign_in_again");
    const client = await this.githubClient(kind);
    if (!client) {
      this.track("pr_sign_in_declined");
      void vscode.window.showInformationMessage("GitHub sign-in didn't finish. You can still push and open GitHub's page.");
      return false;
    }
    this.deps.github = client;
    if (this.phase === "form" && this.context) {
      const generation = this.generation;
      try {
        const fresh = await prepareContext(this.deps);
        if (generation !== this.generation) return true;
        this.context = fresh;
        void this.loadAssignees(generation);
      } catch {
        return true;
      }
      this.postView();
    }
    return true;
  }

  // ── Submitting ──────────────────────────────────────────────
  private async submit(action: "primary" | "commit_only" | "push_open_page"): Promise<void> {
    if (this.phase !== "form" || this.running || !this.deps || !this.context) return;
    if (action === "primary" && this.primaryAction() === "sign_in_then_create") {
      const signed = await this.signIn("ask");
      if (!signed || this.phase !== "form") return;
      if (this.modeFor("primary") !== "pull_request" && !this.updating()) {
        this.postView();
        return;
      }
    }
    const problem = this.problem();
    if (problem) {
      this.postView();
      return;
    }
    if (this.form.createBranch && this.deps && this.context) {
      const taken = await branchTaken(this.deps, this.context, this.form.branchName).catch(() => false);
      if (taken) {
        this.form.branchTaken = true;
        this.postView();
        return;
      }
    }
    const selection = await evaluateSelection(this.deps, this.tickedFiles()).catch(() => null);
    if (!selection) return;
    this.selection = selection;
    const checks = this.checkItems();
    if (checks && this.form.ack !== checks.key) {
      this.track("pr_checks_changed");
      this.postView();
      return;
    }
    if (selection.stagedOutside.length && !this.form.stagedChoice) {
      this.postView();
      return;
    }
    const mode = this.modeFor(action);
    this.plan = this.buildPlan(mode, selection);
    this.track("pr_submitted");
    this.trackOptions(mode);
    await this.run();
  }

  private trackOptions(mode: RunMode): void {
    const ctx = this.context as RepoContext;
    this.track(`pr_mode_${mode}`);
    this.track(`pr_scope_${this.form.scope}`);
    if (this.form.createBranch) this.track("pr_opt_new_branch");
    if (this.form.createBranch && this.startsFromLatest()) this.track("pr_opt_from_latest");
    if (this.scopeFiles().length > this.tickedFiles().length) this.track("pr_opt_files_unticked");
    if (this.form.commitEdited) this.track("pr_opt_commit_edited");
    if (mode === "pull_request" || mode === "host_page" || mode === "push") {
      if (this.receipt && this.form.attachReceipt) this.track("pr_opt_receipt");
      else if (this.receipt) this.track("pr_opt_no_receipt");
      if (this.form.descriptionSource === "template") this.track("pr_opt_template");
      if (this.form.descriptionSource === "ai") this.track(this.form.descriptionEdited ? "pr_opt_desc_ai_edited" : "pr_opt_desc_ai_as_is");
    }
    if (mode === "pull_request") {
      if (this.form.draft) this.track("pr_opt_draft");
      if (this.form.reviewers.length) this.track("pr_opt_reviewers");
      if (ctx.github.repo?.parent) this.track("pr_opt_fork");
    }
    if (mode === "update" && this.receipt && this.form.commentReceipt) this.track("pr_opt_receipt_comment");
  }

  private buildPlan(mode: RunMode, selection: SelectionReport): RunPlan {
    const ctx = this.context as RepoContext;
    const ticked = this.tickedFiles();
    const coAuthor = vscode.workspace.getConfiguration("andromity").get<boolean>("includeCoAuthor", true) !== false;
    const message = plainText(this.form.commitMessage, MAX_COMMIT_MESSAGE).trim();
    const reviewers = mode === "pull_request" ? this.reviewerChoice() : null;
    const receipt = this.receipt;
    const committedPaths = pathsToStage(ticked);
    return {
      mode,
      remote: ctx.remote?.name ?? null,
      parsed: ctx.remote?.parsed ?? null,
      target: ctx.github.target,
      headOwner: ctx.github.headOwner ?? ctx.remote?.parsed?.owner ?? null,
      base: this.form.base,
      branch: this.form.createBranch ? this.form.branchName : ctx.head.branch ?? this.form.branchName,
      createBranch: this.form.createBranch,
      startFrom: this.form.createBranch && this.startsFromLatest() && ctx.baseRemote ? `${ctx.baseRemote}/${this.form.base}` : undefined,
      files: pathsToStage(ticked),
      unstageFirst: this.form.stagedChoice === "unstage" ? selection.stagedOutside : [],
      fingerprints: selection.fingerprints,
      commitMessage: coAuthor ? appendCoAuthorTrailer(message) : message,
      signoff: vscode.workspace.getConfiguration("git").get<boolean>("alwaysSignOff", false) === true,
      title: cleanTitle(this.form.title) || cleanTitle(message.split("\n", 1)[0]),
      bodyFor: (commit) => (mode === "pull_request" ? this.publishedBody(commit, committedPaths) : this.bodyFor(commit, committedPaths)),
      existingPullComment: (commit) => (mode === "pull_request" ? this.publishedBody(commit, committedPaths) : ""),
      draft: this.form.draft,
      reviewers: reviewers?.reviewers ?? [],
      teams: reviewers?.teams ?? [],
      existingPull: ctx.existingPull,
      commentFor: mode === "update" && receipt && this.form.commentReceipt
        ? async (commit) => (await this.receiptsSection(GITHUB_BODY_LIMIT - 512))
          ?? (receipt ? composeReceiptComment({ markdown: receipt.markdown, link: this.receiptLink(commit, committedPaths) as ReceiptLink }).body : "")
        : null,
    };
  }

  private stepLabel(id: StepId, status: PrStep["status"]): string {
    const plan = this.plan as RunPlan;
    const files = plural(plan.files.length, "file");
    const done = status === "done";
    switch (id) {
      case "branch":
        return plan.createBranch ? `${done ? "Created" : "Create"} branch ${plan.branch}${plan.startFrom ? ` from ${plan.startFrom}` : ""}` : `Use branch ${plan.branch}`;
      case "stage": return `${done ? "Staged" : "Stage"} ${files}`;
      case "commit": return done && this.runState.commit ? `Committed ${shortSha(this.runState.commit)}` : "Commit";
      case "push": return `${done ? "Pushed" : status === "running" ? "Pushing" : "Push"} to ${plan.remote}${status === "running" ? "…" : ""}`;
      case "pull": return done && this.runState.pull ? `Opened pull request #${this.runState.pull.number} into ${plan.base}` : `Open the pull request into ${plan.base}`;
      case "reviewers": return status === "failed" ? "Couldn't ask everyone for a review" : `${done ? "Asked" : "Ask"} for reviews`;
      case "comment": return `${done ? "Added" : "Add"} this turn's receipt to #${plan.existingPull?.number}`;
    }
  }

  private setStep(id: StepId, status: PrStep["status"]): void {
    this.steps = this.steps.map((step) => step.id === id ? { id, status, label: this.stepLabel(id, status) } : step);
    this.postView();
  }

  private async run(): Promise<void> {
    if (!this.deps || !this.plan || this.running) return;
    const plan = this.plan;
    const deps = this.deps;
    this.running = true;
    this.stopRequested = false;
    this.failure = null;
    this.phase = "running";
    this.steps = stepsFor(plan).map((id) => ({ id, status: "pending", label: this.stepLabel(id, "pending") }));
    for (const step of this.steps) {
      if ((step.id === "branch" && this.runState.branchReady) || (step.id === "push" && this.runState.pushed)) {
        step.status = "done";
        step.label = this.stepLabel(step.id as StepId, "done");
      }
    }
    this.postView();
    try {
      this.result = await runPlan(deps, plan, this.runState, (id, status) => this.setStep(id, status), () => this.stopRequested);
      this.phase = "done";
      this.trackDone(this.result);
      await this.afterDone(this.result);
    } catch (error) {
      const failure = error instanceof FlowError ? error : new FlowError("stage", "git_failed");
      this.failure = failure;
      this.phase = "failed";
      this.track(failure.kind === "cancelled" ? "pr_cancelled_running" : `pr_fail_${STEP_NAMES[failure.step]}`);
      if (failure.kind !== "cancelled") this.track(`pr_err_${failure.kind}`.slice(0, 31));
      this.host.log(`[PullRequest] ${failure.step} failed: ${failure.kind}`);
      if (this.disposed) void vscode.window.showWarningMessage(`${this.failedView().heading}. Open Changes Review to see what happened.`);
    } finally {
      this.running = false;
      this.postView();
      void this.host.refresh();
    }
  }

  private trackDone(result: RunResult): void {
    const name = { pull_request: "pr_created", update: "pr_updated", host_page: "pr_host_page_opened", push: "pr_pushed", commit: "pr_committed_only" }[result.mode];
    this.track(name);
    if (result.reviewerProblem) this.track("pr_reviewers_failed");
    if (result.mode === "pull_request" || result.mode === "update") {
      const minutes = (Date.now() - this.openedAt) / 60000;
      this.track(minutes < 1 ? "pr_time_under_1m" : minutes < 5 ? "pr_time_1_to_5m" : "pr_time_over_5m");
    }
  }

  private async clipboardText(result: RunResult): Promise<string> {
    const plan = this.plan as RunPlan;
    return `${plan.title}\n\n${await plan.bodyFor(result.commit)}`.trim();
  }

  private async afterDone(result: RunResult): Promise<void> {
    if (result.mode === "host_page" || result.mode === "push") {
      await vscode.env.clipboard.writeText(await this.clipboardText(result));
      if (result.pageUrl) await vscode.env.openExternal(vscode.Uri.parse(result.pageUrl, true));
    }
    if (result.pull && this.plan?.target && (result.mode === "pull_request" || result.mode === "update")) {
      const url = pullUrl(this.plan.target, result.pull.number);
      const verb = result.mode === "update" || result.joinedExisting ? "updated" : "opened";
      void vscode.window.showInformationMessage(`Pull request #${result.pull.number} ${verb}.`, "Open").then((choice) => {
        if (choice === "Open") void vscode.env.openExternal(vscode.Uri.parse(url, true));
      });
    }
  }

  private doneView(): PrDoneView {
    const result = this.result as RunResult;
    const plan = this.plan as RunPlan;
    const ctx = this.context as RepoContext;
    const noun = requestNoun(plan.parsed?.kind ?? "github");
    const lines: string[] = [];
    const actions: PrAction[] = [];
    let heading: string;
    let url: string | null = null;
    if (result.mode === "pull_request" && result.pull && plan.target && result.joinedExisting) {
      heading = `Added to pull request #${result.pull.number}`;
      url = pullUrl(plan.target, result.pull.number);
      lines.push(`A pull request for ${plan.branch} was already open, so the commit was added to it and its title and description were left as they were.`);
      if (result.existingComment === "posted") lines.push(`Your description${this.receipt && this.form.attachReceipt ? " and the receipts" : ""} were added as a comment.`);
      else if (result.existingComment === "failed") lines.push(`GitHub refused the comment, so your description${this.receipt && this.form.attachReceipt ? " and the receipts were" : " was"} not added. Copy them and add them on GitHub.`);
      else lines.push("No receipt was attached.");
      actions.push({ id: "open_link", label: "Open on GitHub", primary: true }, { id: "copy_link", label: "Copy link" });
      if (result.existingComment === "failed") actions.push({ id: "copy_description", label: "Copy description" });
    } else if (result.mode === "pull_request" && result.pull && plan.target) {
      heading = `Pull request #${result.pull.number} opened`;
      url = pullUrl(plan.target, result.pull.number);
      lines.push(!(this.receipt && this.form.attachReceipt) ? "No receipt was attached."
        : this.publishedSection ? "The receipts of the turns whose changes are in this pull request are at the end of the description."
        : `The receipt for turn ${this.receipt.receipt.turn_index + 1} is at the end of the description.`);
      actions.push({ id: "open_link", label: "Open on GitHub", primary: true }, { id: "copy_link", label: "Copy link" });
      if (result.reviewerProblem) {
        lines.push(result.reviewerProblem.kind === "invalid"
          ? "Couldn't ask everyone for a review: someone can't access this repository, or a team doesn't exist."
          : "Couldn't ask for reviews. Add reviewers on GitHub.");
      } else if (plan.reviewers.length || plan.teams.length) {
        lines.push(`Asked ${[...plan.reviewers.map((r) => "@" + r), ...plan.teams.map((t) => `${plan.target?.owner}/${t}`)].join(", ")} for a review.`);
      }
    } else if (result.mode === "update" && result.pull && plan.target) {
      heading = `Pull request #${result.pull.number} updated`;
      url = pullUrl(plan.target, result.pull.number);
      actions.push({ id: "open_link", label: "Open on GitHub", primary: true }, { id: "copy_link", label: "Copy link" });
      if (this.runState.commented) lines.push("Added this turn's receipt as a comment.");
    } else if (result.mode === "host_page") {
      heading = `Pushed to ${plan.remote}`;
      lines.push(`${hostName(plan.parsed?.kind)} ${noun}s are created on ${hostName(plan.parsed?.kind)}'s page. The title and description${this.receipt && this.form.attachReceipt ? ", with the receipt," : ""} are on your clipboard: paste them there.`);
      actions.push({ id: "open_page", label: `Open ${noun} page`, primary: true }, { id: "copy_description", label: "Copy description again" });
    } else if (result.mode === "push") {
      heading = `Pushed ${plan.branch} to ${plan.remote}`;
      lines.push("Create the pull request on your host. The title and description are on your clipboard.");
      actions.push({ id: "copy_description", label: "Copy description again", primary: true });
    } else {
      heading = `Committed ${shortSha(result.commit)} on ${plan.branch}`;
      lines.push("Nothing was pushed.");
    }
    const left = this.host.files().filter((file) => !plan.files.includes(file.path)).length;
    if (plan.createBranch) {
      lines.push(`You're on ${plan.branch}.${left ? ` ${plural(left, "other changed file")} ${left === 1 ? "is" : "are"} still uncommitted.` : ""}`);
      if (this.runState.originalBranch) {
        actions.push({ id: "switch_back", label: `Switch back to ${this.runState.originalBranch}` });
      }
    }
    return {
      title: this.sheetTitle(),
      heading,
      url,
      lines,
      actions,
      steps: this.steps,
      footnote: plan.createBranch && this.runState.originalBranch
        ? `Switching back puts ${this.runState.originalBranch}'s versions of the committed files back in your folder. Your changes live on the branch.`
        : ctx.remote ? null : "This repository has no remote, so nothing left this computer.",
    };
  }

  private failedView(): PrFailedView {
    const failure = this.failure as FlowError;
    const plan = this.plan;
    const remote = plan?.remote ?? "the remote";
    const sha = shortSha(this.runState.commit);
    const local = sha ? ` Your commit ${sha} is safe on your local branch ${plan?.branch}.` : "";
    const createdBranch = plan?.createBranch && this.runState.branchReady && !this.runState.commit && this.runState.originalBranch;
    const back: PrAction = { id: "back", label: "Back to the form" };
    const retry: PrAction = { id: "retry", label: "Try again", primary: true };
    const output: PrAction = { id: "show_output", label: "Show Git output" };
    const switchBack: PrAction[] = createdBranch ? [{ id: "switch_back", label: `Switch back to ${this.runState.originalBranch}` }] : [];
    const onBranch = createdBranch ? ` You're on the new branch ${plan?.branch} with nothing committed.` : "";
    const target = plan?.target ? `${plan.target.owner}/${plan.target.repo}` : "this repository";
    const pagePossible = !!plan?.parsed && plan.parsed.kind !== "other";
    const page: PrAction[] = pagePossible ? [{ id: "open_page", label: `Open ${hostName(plan?.parsed?.kind)}'s page` }] : [];
    const list = failure.paths.slice(0, 8).join(", ") + (failure.paths.length > 8 ? "…" : "");
    const out = (heading: string, message: string, actions: PrAction[]): PrFailedView => ({ title: this.sheetTitle(), heading, message, actions, steps: this.steps });
    switch (failure.kind) {
      case "cancelled": return out("Cancelled", `Stopped before ${failure.step === "push" ? "pushing" : "the next step"}.${local}${onBranch}`, [back, ...switchBack]);
      case "changed_after_review": return out("Files changed after you opened this form", `${list} changed since you reviewed ${failure.paths.length === 1 ? "it" : "them"}. Nothing was committed. Look again, then press Create.`, [{ ...back, primary: true }, ...switchBack]);
      case "other_staged": return out("Other files got staged", `${list} ${failure.paths.length === 1 ? "is" : "are"} staged too and would go into the commit. Nothing was committed.`, [{ ...back, primary: true }, ...switchBack]);
      case "branch_exists": return out(`A branch named ${plan?.branch} already exists`, "Choose another name. Nothing was changed.", [{ ...back, primary: true }]);
      case "branch_moved": return out("The branch changed since you opened this form", "Nothing was committed. Open the form again to see where things stand.", [{ ...back, primary: true }]);
      case "would_overwrite": return out(`Your changes can't move onto the latest ${plan?.base}`, `Some of these files also changed on ${plan?.startFrom}. Nothing was created.`, [{ id: "start_from_current", label: "Start from my current commit", primary: true }, back]);
      case "identity": return out("Set your git name and email first", "Run git config --global user.name \"Your Name\" and git config --global user.email you@example.com, then try again." + onBranch, [retry, ...switchBack]);
      case "nothing_committed": return out("Nothing to commit", "The ticked files have no changes git can commit." + onBranch, [{ ...back, primary: true }, ...switchBack]);
      case "commit_failed": return out("Git couldn't commit", "A pre-commit or commit-msg hook may have stopped it. Your files are untouched." + onBranch, [{ ...output, primary: true }, { ...retry, primary: false }, ...switchBack]);
      case "signing": return out("Commit signing failed", "Git couldn't sign the commit. Check your signing key, then try again." + onBranch, [{ ...output, primary: true }, { ...retry, primary: false }, ...switchBack]);
      case "push_rejected": return out(`${remote} already has this branch, with other commits`, `Nothing was force-pushed.${local}`, [{ id: "push_new_name", label: "Push under a new name", primary: true }, output]);
      case "protected": return out(`${remote} protects this branch`, `Pushing straight to it isn't allowed.${local}`, [{ id: "push_new_name", label: "Push to a new branch", primary: true }, output]);
      case "too_large": return out("A file is too large for the host", `The host refuses very large files. Untick it or use Git LFS.${local}`, [{ ...output, primary: true }]);
      case "workflow_scope": return out("Git's sign-in can't change workflow files", `Pushing changes to .github/workflows needs the workflow permission. Sign in to GitHub again in VS Code, or use a token with that permission.${local}`, [{ ...output, primary: true }, { ...retry, primary: false }]);
      case "push_hook": return out("A hook refused the push", `Your pre-push hook or a rule on ${remote} stopped it; Show Git output says which. Nothing was pushed.${local}`, [{ ...output, primary: true }, { ...retry, primary: false }]);
      case "no_access": return out(`You can't push to ${target}`, `Fork it on GitHub, add your fork as a remote, then try again.${local}`, [{ ...output, primary: true }]);
      case "auth": return out(`Git couldn't sign in to ${remote}`, `Check your git credentials, then try again.${local}`, [retry, output]);
      case "network": return out(`Couldn't reach ${remote}`, `Check your connection, then try again.${local}`, [retry, output]);
      case "gh_unauthorized": return out("GitHub sign-in expired", "The branch is pushed. Sign in again to open the pull request.", [{ id: "sign_in_again", label: "Sign in again", primary: true }, ...page]);
      case "gh_sso": return out(`${plan?.target?.owner ?? "This organisation"} requires single sign-on`, "Authorize this sign-in for the organisation, then try again. The branch is pushed.", [...(failure.ssoUrl ? [{ id: "authorize_sso", label: "Authorize", primary: true }] : []), retry, ...page]);
      case "gh_forbidden": return out("GitHub refused the request", "Your account may not be allowed to open pull requests here. The branch is pushed.", [...page, retry]);
      case "gh_not_found": return out(`GitHub can't find ${target}`, "Your sign-in may not have access to it. The branch is pushed.", [...page, retry]);
      case "gh_rate_limited": {
        const when = failure.resetAt ? new Date(failure.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
        return out(`GitHub is limiting requests${when ? ` until ${when}` : ""}`, "The branch is pushed. Try again later; only the pull request step will run.", [retry, ...page]);
      }
      case "gh_exists": return out("A pull request for this branch already exists", "The branch is pushed.", [...page]);
      case "gh_no_commits": return out(`No changes between ${plan?.base} and this branch`, "GitHub sees nothing to merge. The branch is pushed.", [...page]);
      case "gh_draft_unsupported": return out("Drafts aren't available for this repository", "The branch is pushed.", [{ id: "open_normal", label: "Open as a normal pull request", primary: true }, ...page]);
      case "gh_invalid":
      case "gh_unavailable": return out("GitHub didn't accept the pull request", "The branch is pushed. Try again, or finish on GitHub's page.", [retry, ...page]);
      default: return out("Git couldn't finish this step", `${sha ? local.trim() : "Nothing was committed."}${onBranch}`, [{ ...output, primary: true }, { ...retry, primary: false }, ...switchBack]);
    }
  }

  // ── Actions after a run ─────────────────────────────────────
  private async action(id: string): Promise<void> {
    const plan = this.plan;
    switch (id) {
      case "close":
        this.close();
        return;
      case "show_output":
        void vscode.commands.executeCommand("git.showOutput");
        return;
      case "switch_branch":
        if (this.phase === "blocked") void vscode.commands.executeCommand("git.checkout");
        return;
      case "publish":
        this.track("pr_publish");
        void vscode.commands.executeCommand("git.publish");
        return;
      case "cancel":
        if (this.running && this.cancellable()) this.stopRequested = true;
        return;
      case "retry":
        if (this.phase === "failed" && plan) {
          this.track("pr_retry");
          await this.run();
        }
        return;
      case "back":
        if (this.phase === "failed") {
          this.phase = "closed";
          await this.open();
        }
        return;
      case "start_from_current":
        if (this.phase === "failed" && plan) {
          plan.startFrom = undefined;
          await this.run();
        }
        return;
      case "open_normal":
        if (this.phase === "failed" && plan) {
          plan.draft = false;
          await this.run();
        }
        return;
      case "push_new_name":
        if (this.phase === "failed" && plan && this.deps && this.context) {
          this.track("pr_push_new_name");
          try {
            plan.branch = await moveToFreshBranch(this.deps, this.context, plan);
            plan.createBranch = true;
            this.runState.pushed = false;
            this.runState.branchReady = true;
          } catch {
            this.failure = new FlowError("push", "branch_exists");
            this.postView();
            return;
          }
          await this.run();
        }
        return;
      case "sign_in_again":
        if (this.phase === "failed" && await this.signIn("renew")) await this.run();
        return;
      case "authorize_sso":
        if (this.failure?.ssoUrl) await vscode.env.openExternal(vscode.Uri.parse(this.failure.ssoUrl, true));
        return;
      case "open_link":
      case "copy_link": {
        const pull = this.result?.pull;
        if (!pull || !plan?.target) return;
        const url = pullUrl(plan.target, pull.number);
        this.track(id === "open_link" ? "pr_open_link" : "pr_copy_link");
        if (id === "open_link") await vscode.env.openExternal(vscode.Uri.parse(url, true));
        else await vscode.env.clipboard.writeText(url);
        return;
      }
      case "open_page": {
        if (!plan?.parsed) return;
        const url = newPullRequestUrl(plan.parsed, plan.base, plan.branch, plan.headOwner ?? undefined);
        if (!url) return;
        this.track("pr_open_page");
        if (this.runState.commit) await vscode.env.clipboard.writeText(`${plan.title}\n\n${await plan.bodyFor(this.runState.commit)}`.trim());
        await vscode.env.openExternal(vscode.Uri.parse(url, true));
        return;
      }
      case "copy_description":
        if (plan && this.runState.commit) await vscode.env.clipboard.writeText(`${plan.title}\n\n${await plan.bodyFor(this.runState.commit)}`.trim());
        return;
      case "switch_back": {
        const original = this.runState.originalBranch;
        if (!original || !this.deps || this.running) return;
        try {
          await this.deps.git.checkout(original);
          this.track("pr_switch_back");
          this.runState.originalBranch = undefined;
          void vscode.window.showInformationMessage(`Switched back to ${original}.`);
        } catch {
          void vscode.window.showWarningMessage(`Couldn't switch back to ${original}: git refused because some files would be overwritten. Use Source Control to switch.`);
        }
        await this.host.refresh();
        if (this.phase === "failed") {
          this.phase = "closed";
          this.postView();
        } else {
          this.postView();
        }
        return;
      }
    }
  }

  public close(): void {
    if (this.running) {
      this.postView();
      return;
    }
    if (this.phase === "form" || this.phase === "loading" || this.phase === "blocked") this.track("pr_form_closed");
    this.generation++;
    this.phase = "closed";
    this.postView();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.evaluateTimer) clearTimeout(this.evaluateTimer);
    if (this.branchTimer) clearTimeout(this.branchTimer);
  }
}
