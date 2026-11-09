/* The Pull Requests and Issues view's logic, kept free of VS Code so it can be driven directly in tests.
   It only ever reads from GitHub; the actions it offers start read-only chats through the review host. */

import { GitHubClient, GitHubError } from "../../integrations/pullRequest/github.js";
import type { ReviewHost } from "../../integrations/pullRequest/reviewPullRequest.js";
import {
  ASK_SUGGESTIONS, BRANCH_QUERY, COUNT_QUERY, readBranchPulls, ISSUE_DETAIL_QUERY, PR_DETAIL_QUERY, SEARCH_QUERY, PAGE_SIZE,
  askPrompt, httpsUrl, issueMaterial, line, prMaterial, readFiles, readIssueDetail, readPrDetail, readSearch, searchQuery,
  type ChangedFile, type IssueDetail, type ItemKind, type ListItem, type PrDetail, type RepoRef, type SortOrder,
} from "../../integrations/pullRequest/repoViewData.js";

export type EmptyKind = "airgap" | "nogit" | "norepo" | "noremote" | "otherhost" | "signedout" | "notfound" | "sso" | "oauth" | "ratelimit" | "offline" | "error";

export interface EmptyState {
  kind: EmptyKind;
  title: string;
  text: string;
  /** What GitHub or the error said, shown as a detail line so a failure can be reported. */
  detail?: string;
  actions: { id: string; label: string; primary?: boolean }[];
}

/** A repository the view can show: from a workspace folder's remote, or a fork's parent. */
export interface RepoChoice extends RepoRef {
  label: string;
  /** The workspace repository it came from, for the current-branch banner. */
  root: string | null;
  branch: string | null;
  /** Owner of the local remote, to tell "your branch" from someone else's branch of the same name. */
  localOwner: string | null;
}

export interface RepoViewDeps {
  post(message: unknown): void;
  /** A GitHub client; `choose` asks for another account. Null when sign-in didn't finish. */
  github(mode: "silent" | "ask" | "choose"): Promise<GitHubClient | null>;
  /** The workspace's GitHub repositories, or why there is none. */
  repositories(): Promise<RepoChoice[] | { problem: EmptyKind; host?: string }>;
  /** The parent of a fork, if GitHub says the repository is one. */
  pickRepository(choices: RepoChoice[], current: RepoChoice): Promise<RepoChoice | null>;
  host: ReviewHost;
  startReview(client: GitHubClient, repo: RepoRef, number: number, focus: string, projectPath?: string): Promise<void>;
  errorText(error: unknown): string;
  airGap(): boolean;
  openExternal(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  notify(text: string): void;
  track(name: string): void;
  now(): number;
  /** Diagnostics for the extension's output; never contains tokens. */
  log?(text: string): void;
}

interface ListKey {
  kind: ItemKind;
  filter: string;
  sort: SortOrder;
  text: string;
}

export interface RepoViewState {
  status: "loading" | "ready" | "empty";
  empty: EmptyState | null;
  repo: { owner: string; repo: string; label: string; switchable: boolean } | null;
  account: string | null;
  kind: ItemKind;
  filter: string;
  sort: SortOrder;
  text: string;
  totals: { pr: number | null; issue: number | null };
  chips: { id: string; label: string; count: number | null }[];
  groups: { title: string; items: ListItem[] }[];
  more: boolean;
  loadingList: boolean;
  loadingMore: boolean;
  selected: number | null;
  detail: PrDetail | IssueDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  files: ChangedFile[] | null;
  filesMore: boolean;
  filesLoading: boolean;
  filesError: string | null;
  branch: { name: string; number: number | null } | null;
  notice: string | null;
  updatedAt: number | null;
  model: string;
  suggestions: Record<ItemKind, string[]>;
}

const REFRESH_AFTER_MS = 60_000;
const QUESTION_MAX = 4000;

function errorKind(error: unknown): EmptyKind {
  if (!(error instanceof GitHubError)) return "error";
  switch (error.kind) {
    case "unauthorized": return "signedout";
    case "not_found": case "forbidden": return "notfound";
    case "sso": return "sso";
    case "oauth_restricted": return "oauth";
    case "rate_limited": return "ratelimit";
    case "network": case "timeout": return "offline";
    default: return "error";
  }
}

/** A short, safe description of a failure for the error screen: GitHub's own message, or the error's name. */
export function errorDetail(error: unknown): string {
  if (error instanceof GitHubError) {
    const said = line(error.detail ?? "", 300);
    return `${error.status ? `HTTP ${error.status}` : error.kind}${said ? `: ${said}` : ` (${error.kind})`}`;
  }
  if (error instanceof Error) return line(`${error.name}: ${error.message}`, 300);
  return "";
}

function resetText(error: unknown): string {
  if (error instanceof GitHubError && error.resetAt) {
    const at = new Date(error.resetAt);
    return ` It works again at ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}.`;
  }
  return " Try again in a few minutes.";
}

export class RepoViewController {
  private client: GitHubClient | null = null;
  private choices: RepoChoice[] = [];
  private current: RepoChoice | null = null;
  private account: string | null = null;
  private kind: ItemKind = "pr";
  private filter: Record<ItemKind, string> = { pr: "foryou", issue: "assigned" };
  private sort: SortOrder = "updated";
  private text = "";
  private totals: { pr: number | null; issue: number | null } = { pr: null, issue: null };
  private chipCounts: Record<string, number | null> = {};
  private groups: { title: string; items: ListItem[] }[] = [];
  private cursor: string | null = null;
  private more = false;
  private selected: Record<ItemKind, number | null> = { pr: null, issue: null };
  private detail: PrDetail | IssueDetail | null = null;
  private detailError: string | null = null;
  private files: { owner: string; repo: string; number: number; list: ChangedFile[]; more: boolean } | null = null;
  private filesError: string | null = null;
  private branch: { name: string; number: number | null } | null = null;
  private empty: EmptyState | null = null;
  private notice: string | null = null;
  private status: RepoViewState["status"] = "loading";
  private loadingList = false;
  private loadingMore = false;
  private detailLoading = false;
  private filesLoading = false;
  private updatedAt: number | null = null;
  private listSeq = 0;
  private detailSeq = 0;
  private busy = new Set<string>();
  private disposed = false;
  private detailRepo: RepoRef | null = null;
  private loadedKey: ListKey | null = null;
  private forYouOverlap = 0;
  private starting: Promise<void> | null = null;

  constructor(private readonly deps: RepoViewDeps) {}

  dispose(): void {
    this.disposed = true;
  }

  state(): RepoViewState {
    const repo = this.current;
    return {
      status: this.status,
      empty: this.empty,
      repo: repo ? { owner: repo.owner, repo: repo.repo, label: repo.label, switchable: this.choices.length > 1 } : null,
      account: this.account,
      kind: this.kind,
      filter: this.filter[this.kind],
      sort: this.sort,
      text: this.text,
      totals: this.totals,
      chips: this.chips(),
      groups: this.groups,
      more: this.more,
      loadingList: this.loadingList,
      loadingMore: this.loadingMore,
      selected: this.selected[this.kind],
      detail: this.currentDetail(),
      detailLoading: this.detailLoading,
      detailError: this.detailError,
      files: this.files && this.sameRepo(this.files) && this.files.number === this.selected.pr && this.kind === "pr" ? this.files.list : null,
      filesMore: !!this.files?.more,
      filesLoading: this.filesLoading,
      filesError: this.filesError,
      branch: this.branch,
      notice: this.notice,
      updatedAt: this.updatedAt,
      model: this.deps.host.modelLabel?.() || "the chat's model",
      suggestions: ASK_SUGGESTIONS,
    };
  }

  private sameRepo(ref: RepoRef | null): boolean {
    return !!ref && !!this.current && ref.owner === this.current.owner && ref.repo === this.current.repo;
  }

  private currentDetail(): PrDetail | IssueDetail | null {
    const detail = this.detail;
    return detail && this.sameRepo(this.detailRepo) && detail.kind === this.kind && detail.number === this.selected[this.kind] ? detail : null;
  }

  /** Air-gap can be turned on while the view is open; every GitHub request checks it. */
  private airGapped(): boolean {
    if (!this.deps.airGap()) return false;
    this.loadingList = this.loadingMore = this.detailLoading = this.filesLoading = false;
    this.setEmpty("airgap");
    return true;
  }

  private publish(): void {
    if (!this.disposed) this.deps.post({ type: "state", state: this.state() });
  }

  private chips(): { id: string; label: string; count: number | null }[] {
    if (this.kind === "pr") {
      return [
        { id: "foryou", label: "For you", count: this.chipCounts.foryou === undefined || this.chipCounts.foryou === null ? null : Math.max(0, this.chipCounts.foryou - this.forYouOverlap) },
        { id: "all", label: "All open", count: this.totals.pr },
      ];
    }
    return [
      { id: "assigned", label: "Assigned to you", count: this.chipCounts.assigned ?? null },
      { id: "all", label: "All open", count: this.totals.issue },
    ];
  }

  private setEmpty(kind: EmptyKind, extra = "", error?: unknown): void {
    this.status = "empty";
    this.empty = this.emptyFor(kind, extra);
    const detail = errorDetail(error);
    if (detail && (kind === "error" || kind === "notfound")) this.empty = { ...this.empty, detail };
    this.deps.track(`prv_fail_${kind}`);
    this.publish();
  }

  private emptyFor(kind: EmptyKind, extra: string): EmptyState {
    const repo = this.current ? `${this.current.owner}/${this.current.repo}` : "this repository";
    switch (kind) {
      case "airgap": return { kind, title: "Off in air-gap mode", text: "This view needs GitHub, so it's off while air-gap mode is on. Nothing is requested.", actions: [] };
      case "nogit": return { kind, title: "Git isn't available", text: "Turn on VS Code's Git extension to see pull requests and issues.", actions: [] };
      case "norepo": return { kind, title: "No git repository open", text: "Open a folder that is a git repository with a GitHub remote.", actions: [] };
      case "noremote": return { kind, title: "This repository has no GitHub remote", text: "Add a GitHub remote to see its pull requests and issues.", actions: [] };
      case "otherhost": return { kind, title: `This repository is on ${extra || "another host"}`, text: "This view works with github.com in this version. Open its merge requests or pull requests in your browser.", actions: [] };
      case "signedout": return { kind, title: "Sign in to GitHub to see pull requests and issues", text: "Andromity uses VS Code's GitHub sign-in, which asks for the repo permission (read and write to your repositories). This view only reads. The token stays in VS Code and is only sent to api.github.com.", actions: [{ id: "signin", label: "Sign in to GitHub", primary: true }] };
      case "notfound": return { kind, title: `${this.account || "This account"} can't see ${repo}`, text: "The repository belongs to an account or organisation this sign-in can't read. Choose the GitHub account that has access.", actions: [{ id: "another", label: "Use another account", primary: true }, { id: "github", label: "Open on GitHub" }] };
      case "sso": return { kind, title: "This organisation requires single sign-on", text: "Your sign-in works, but the organisation needs you to authorize it for SSO before GitHub shares its pull requests.", actions: [{ id: "github", label: "Authorize on GitHub", primary: true }, { id: "retry", label: "Try again" }] };
      case "oauth": return { kind, title: "This organisation hasn't approved VS Code's GitHub access", text: "The organisation restricts which apps can read its repositories. An owner has to approve Visual Studio Code once; you can request it on GitHub.", actions: [{ id: "oauth", label: "Request access on GitHub", primary: true }, { id: "retry", label: "Try again" }] };
      case "ratelimit": return { kind, title: "GitHub is limiting requests", text: `Too many requests in a short time.${extra}`, actions: [{ id: "retry", label: "Try again", primary: true }] };
      case "offline": return { kind, title: "Can't reach GitHub", text: "Check your connection, then try again.", actions: [{ id: "retry", label: "Try again", primary: true }] };
      default: return { kind: "error", title: "GitHub didn't answer as expected", text: "Try again. If it keeps happening, open the repository on GitHub.", actions: [{ id: "retry", label: "Try again", primary: true }, { id: "github", label: "Open on GitHub" }] };
    }
  }

  /** First load, and the "Try again" buttons. */
  async start(mode: "silent" | "ask" | "choose" = "silent"): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.run(mode).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async run(mode: "silent" | "ask" | "choose"): Promise<void> {
    if (this.deps.airGap()) return this.setEmpty("airgap");
    this.status = "loading";
    this.empty = null;
    this.publish();
    const repos = await this.deps.repositories();
    if (!Array.isArray(repos)) return this.setEmpty(repos.problem, repos.host);
    if (!repos.length) return this.setEmpty("noremote");
    this.choices = repos;
    if (!this.current || !repos.some((repo) => repo.owner === this.current?.owner && repo.repo === this.current?.repo)) this.current = repos[0];
    const client = await this.deps.github(mode);
    if (!client) return this.setEmpty("signedout");
    this.client = client;
    try {
      this.account = await client.viewer();
    } catch (error) {
      return this.setEmpty(errorKind(error), resetText(error), error);
    }
    const blocked = await this.useParentIfFork();
    if (blocked) return this.setEmpty("notfound", "", blocked);
    this.deps.track("prv_opened");
    await this.reload(true);
  }

  /** Switches to a fork's parent. Returns the error when this account can't see the repository at all. */
  private async useParentIfFork(): Promise<unknown> {
    const current = this.current;
    if (!current || !this.client || current.label.endsWith("(parent)")) return null;
    try {
      const info = await this.client.repository(current.owner, current.repo);
      if (info.parent && !this.choices.some((choice) => choice.owner === info.parent?.owner && choice.repo === info.parent?.repo)) {
        const parent: RepoChoice = { owner: info.parent.owner, repo: info.parent.repo, label: `${info.parent.owner}/${info.parent.repo} (parent)`, root: current.root, branch: current.branch, localOwner: current.localOwner };
        this.choices = [parent, ...this.choices];
        this.current = parent;
      }
    } catch (error) {
      if (errorKind(error) === "notfound") return error;
    }
    return null;
  }

  /** Reloads counts, the list and the open item, keeping the selection. */
  async reload(full = false): Promise<void> {
    const client = this.client;
    const repo = this.current;
    if (!client || !repo) return this.start();
    if (this.airGapped()) return;
    if (full) this.files = null;
    const seq = ++this.listSeq;
    this.loadingList = true;
    this.publish();
    try {
      if (full || this.totals.pr === null) {
        const [prs, issues, assigned, review, mine] = await Promise.all([
          this.count(`repo:${repo.owner}/${repo.repo} is:pr is:open`),
          this.count(`repo:${repo.owner}/${repo.repo} is:issue is:open`),
          this.count(`repo:${repo.owner}/${repo.repo} is:issue is:open assignee:@me`),
          this.count(`repo:${repo.owner}/${repo.repo} is:pr is:open review-requested:@me`),
          this.count(`repo:${repo.owner}/${repo.repo} is:pr is:open author:@me`),
        ]);
        if (seq !== this.listSeq) return;
        this.totals = { pr: prs, issue: issues };
        this.chipCounts = { assigned, foryou: review + mine };
      }
      await this.loadList(seq);
      if (seq !== this.listSeq) return;
      await this.loadBranch();
      this.status = "ready";
      this.empty = null;
      this.notice = null;
      this.updatedAt = this.deps.now();
    } catch (error) {
      if (seq !== this.listSeq) return;
      const kind = errorKind(error);
      if (this.status === "ready" && (kind === "ratelimit" || kind === "offline")) {
        this.notice = kind === "ratelimit" ? `GitHub is limiting requests. Showing earlier results.${resetText(error)}` : "Can't reach GitHub. Showing earlier results.";
        const shown = this.loadedKey;
        if (shown) {
          this.kind = shown.kind;
          this.filter[shown.kind] = shown.filter;
          this.sort = shown.sort;
          this.text = shown.text;
        }
        this.deps.track(`prv_fail_${kind}`);
      } else {
        this.loadingList = false;
        this.deps.log?.(`list failed: ${errorDetail(error)}`);
        return this.setEmpty(kind, resetText(error), error);
      }
    } finally {
      if (seq === this.listSeq) this.loadingList = false;
    }
    this.publish();
    const selected = this.selected[this.kind];
    const items = this.groups.flatMap((group) => group.items);
    if (selected !== null) await this.loadDetail(selected, true);
    else if (items.length) await this.select(items[0].number, false);
    else {
      this.selected[this.kind] = null;
      this.publish();
    }
  }

  private async count(q: string): Promise<number> {
    const data = await this.client!.graphql(COUNT_QUERY, { q });
    const value = (data.search as { issueCount?: unknown } | undefined)?.issueCount;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private key(): ListKey {
    return { kind: this.kind, filter: this.filter[this.kind], sort: this.sort, text: this.text };
  }

  private async loadList(seq: number): Promise<void> {
    const key = this.key();
    const repo = this.current!;
    const search = async (q: string, after: string | null = null) => readSearch(await this.client!.graphql(SEARCH_QUERY, { q, first: PAGE_SIZE, after }), repo, key.kind);
    if (key.kind === "pr" && key.filter === "foryou") {
      const [review, mine] = await Promise.all([
        search(searchQuery(repo, "pr", "foryou", key.sort, key.text, "review")),
        search(searchQuery(repo, "pr", "foryou", key.sort, key.text, "mine")),
      ]);
      if (seq !== this.listSeq) return;
      const overlap = mine.items.filter((item) => review.items.some((other) => other.number === item.number)).length;
      this.groups = [
        { title: "Review requested from you or your team", items: review.items },
        { title: "Your pull requests", items: mine.items.filter((item) => !review.items.some((other) => other.number === item.number)) },
      ];
      this.forYouOverlap = overlap;
      this.cursor = null;
      this.more = false;
      this.loadedKey = key;
      return;
    }
    const page = await search(searchQuery(repo, key.kind, key.filter, key.sort, key.text));
    if (seq !== this.listSeq) return;
    this.groups = [{ title: "", items: page.items }];
    this.cursor = page.cursor;
    this.more = page.more;
    this.loadedKey = key;
  }

  private async loadBranch(): Promise<void> {
    const repo = this.current;
    const name = repo?.branch;
    if (!repo || !name || !/^[A-Za-z0-9._/-]{1,200}$/.test(name)) {
      this.branch = null;
      return;
    }
    try {
      const pulls = readBranchPulls(await this.client!.graphql(BRANCH_QUERY, { owner: repo.owner, repo: repo.repo, head: name }), repo);
      const match = pulls.find((item) => item.headRef === name && (!item.crossRepository || !repo.localOwner || item.headOwner?.toLowerCase() === repo.localOwner.toLowerCase()));
      this.branch = { name, number: match?.number ?? null };
    } catch {
      this.branch = { name, number: null };
    }
  }

  private items(): ListItem[] {
    return this.groups.flatMap((group) => group.items);
  }

  async loadMore(): Promise<void> {
    if (!this.client || !this.current || !this.more || !this.cursor || this.loadingMore) return;
    if (this.airGapped()) return;
    const seq = this.listSeq;
    const key = this.key();
    this.loadingMore = true;
    this.publish();
    try {
      const page = readSearch(await this.client.graphql(SEARCH_QUERY, { q: searchQuery(this.current, key.kind, key.filter, key.sort, key.text), first: PAGE_SIZE, after: this.cursor }), this.current, key.kind);
      if (seq !== this.listSeq) return;
      const known = new Set(this.items().map((item) => item.number));
      this.groups = [{ title: "", items: [...this.items(), ...page.items.filter((item) => !known.has(item.number))] }];
      this.cursor = page.cursor;
      this.more = page.more;
      this.deps.track("prv_load_more");
    } catch (error) {
      this.notice = `More items couldn't be loaded. ${errorKind(error) === "ratelimit" ? "GitHub is limiting requests." : "Try again."}`;
    } finally {
      this.loadingMore = false;
      this.publish();
    }
  }

  async select(number: unknown, byUser = true): Promise<void> {
    if (typeof number !== "number" || !this.items().some((item) => item.number === number) && !(this.detail && this.detail.number === number) && number !== this.selected[this.kind]) return;
    if (byUser && this.selected[this.kind] !== number) this.deps.track("prv_open_item");
    this.selected[this.kind] = number;
    this.filesError = null;
    await this.loadDetail(number, false);
  }

  private async loadDetail(number: number, refresh: boolean): Promise<void> {
    if (!this.client || !this.current) return;
    if (this.airGapped()) return;
    const seq = ++this.detailSeq;
    const kind = this.kind;
    const repo = this.current;
    if (!refresh || !this.currentDetail() || this.detail?.number !== number) this.detail = null;
    this.detailLoading = true;
    this.detailError = null;
    this.publish();
    try {
      const data = await this.client.graphql(kind === "pr" ? PR_DETAIL_QUERY : ISSUE_DETAIL_QUERY, { owner: repo.owner, repo: repo.repo, number });
      if (seq !== this.detailSeq || repo !== this.current) return;
      this.detail = kind === "pr" ? readPrDetail(data, repo, number) : readIssueDetail(data, repo, number);
      this.detailRepo = repo;
    } catch (error) {
      if (seq !== this.detailSeq) return;
      const why = errorKind(error);
      this.deps.log?.(`detail failed: ${errorDetail(error)}`);
      this.detailError = why === "ratelimit" ? `GitHub is limiting requests.${resetText(error)}` : why === "offline" ? "Can't reach GitHub." : `#${number} couldn't be loaded. Try again, or open it on GitHub. (${errorDetail(error)})`;
    } finally {
      if (seq === this.detailSeq) this.detailLoading = false;
    }
    this.publish();
  }

  async loadFiles(): Promise<void> {
    const number = this.selected.pr;
    if (!this.client || !this.current || this.kind !== "pr" || number === null || this.filesLoading) return;
    if (this.files && this.sameRepo(this.files) && this.files.number === number) return this.publish();
    if (this.airGapped()) return;
    const repo = this.current;
    this.filesLoading = true;
    this.filesError = null;
    this.publish();
    try {
      const { files, more } = await this.client.pullFiles(repo.owner, repo.repo, number);
      if (this.selected.pr === number && repo === this.current) this.files = { owner: repo.owner, repo: repo.repo, number, list: readFiles(files), more };
      this.deps.track("prv_files");
    } catch (error) {
      this.filesError = errorKind(error) === "ratelimit" ? "GitHub is limiting requests. Try again later." : "The files couldn't be loaded. Try again.";
    } finally {
      this.filesLoading = false;
      this.publish();
    }
  }

  async setKind(kind: unknown): Promise<void> {
    if (kind !== "pr" && kind !== "issue" || kind === this.kind) return;
    this.kind = kind;
    this.detail = null;
    this.files = null;
    if (kind === "issue") this.deps.track("prv_tab_issues");
    await this.reload();
  }

  async setFilter(filter: unknown): Promise<void> {
    const allowed = this.kind === "pr" ? ["foryou", "all"] : ["assigned", "all"];
    if (typeof filter !== "string" || !allowed.includes(filter) || filter === this.filter[this.kind]) return;
    this.filter[this.kind] = filter;
    this.deps.track(`prv_filter_${filter}`);
    await this.reload();
  }

  async setSort(sort: unknown): Promise<void> {
    if (sort !== "updated" && sort !== "created" && sort !== "stale" || sort === this.sort) return;
    this.sort = sort;
    this.deps.track("prv_sort");
    await this.reload();
  }

  async setText(text: unknown): Promise<void> {
    const next = typeof text === "string" ? text.slice(0, 200) : "";
    if (next === this.text) return;
    this.text = next;
    await this.reload();
  }

  /** Called when the view becomes visible again; reloads only when the data is a minute old. */
  async returned(): Promise<void> {
    if (this.status === "ready" && this.updatedAt !== null && this.deps.now() - this.updatedAt >= REFRESH_AFTER_MS) await this.reload(true);
  }

  async chooseRepository(): Promise<void> {
    if (!this.current || this.choices.length < 2) return;
    const pick = await this.deps.pickRepository(this.choices, this.current);
    if (!pick || pick === this.current) return;
    this.current = pick;
    this.selected = { pr: null, issue: null };
    this.detail = null;
    this.detailRepo = null;
    this.files = null;
    this.detailSeq++;
    await this.reload(true);
  }

  async emptyAction(id: unknown): Promise<void> {
    if (id === "signin") return this.start("ask");
    if (id === "another") return this.start("choose");
    if (id === "retry") return this.start("silent");
    if (id === "github" || id === "oauth") {
      const repo = this.current;
      if (repo) await this.deps.openExternal(id === "oauth" ? "https://github.com/settings/connections/applications" : `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`);
    }
  }

  private item(number: unknown): ListItem | PrDetail | IssueDetail | null {
    if (typeof number !== "number") return null;
    const detail = this.currentDetail();
    if (detail && detail.number === number) return detail;
    return this.items().find((item) => item.number === number) ?? null;
  }

  async open(number: unknown): Promise<void> {
    const item = this.item(number);
    if (!item?.url) return;
    this.deps.track("prv_open_github");
    await this.deps.openExternal(item.url);
  }

  async copyLink(number: unknown): Promise<void> {
    const item = this.item(number);
    if (!item?.url) return;
    await this.deps.copy(item.url);
    this.deps.notify(`Link to #${item.number} copied.`);
  }

  /** Links inside GitHub text: https only, opened through VS Code, which asks before leaving unless the site is trusted. */
  async openLink(url: unknown): Promise<void> {
    const safe = httpsUrl(url);
    if (safe) await this.deps.openExternal(safe);
  }

  async openCheck(number: unknown, index: unknown): Promise<void> {
    const detail = this.item(number);
    if (!detail || !("checkList" in detail) || typeof index !== "number") return;
    const url = detail.checkList[index]?.url;
    if (url) await this.deps.openExternal(url);
  }

  async review(number: unknown, focus: unknown): Promise<void> {
    const item = this.item(number);
    const repo = this.current;
    if (!item || item.kind !== "pr" || !this.client || !repo || this.busy.has(`review:${item.number}`)) return;
    if (this.deps.airGap()) return this.deps.notify("Reviews need GitHub, so they're off in air-gap mode.");
    this.busy.add(`review:${item.number}`);
    try {
      await this.deps.startReview(this.client, repo, item.number, typeof focus === "string" ? focus : "", repo.root ?? undefined);
      this.deps.track("prv_review");
      this.deps.post({ type: "done", text: `A read-only review chat started for #${item.number}.` });
    } catch (error) {
      this.deps.track("prv_fail_review");
      const why = error instanceof GitHubError ? this.deps.errorText(error) : "The review couldn't start. Check that Andromity's engine is running.";
      this.deps.post({ type: "failed", text: why });
      this.deps.notify(why);
    } finally {
      this.busy.delete(`review:${item.number}`);
    }
  }

  async ask(number: unknown, question: unknown): Promise<void> {
    const item = this.item(number);
    const repo = this.current;
    const text = typeof question === "string" ? question.replace(/\r\n?/g, "\n").trim().slice(0, QUESTION_MAX) : "";
    if (!item || !this.client || !repo || !text || this.busy.has(`ask:${item.kind}:${item.number}`)) return;
    if (this.deps.airGap()) return this.deps.notify("Questions about GitHub items need GitHub, so they're off in air-gap mode.");
    const key = `ask:${item.kind}:${item.number}`;
    this.busy.add(key);
    try {
      let material: string;
      if (item.kind === "pr") {
        const detail = "checkList" in item ? item as PrDetail : readPrDetail(await this.client.graphql(PR_DETAIL_QUERY, { owner: repo.owner, repo: repo.repo, number: item.number }), repo, item.number);
        const { diff, cut } = await this.client.pullDiff(repo.owner, repo.repo, item.number);
        material = prMaterial(repo, detail, diff, cut);
      } else {
        const detail = "conversation" in item ? item as IssueDetail : readIssueDetail(await this.client.graphql(ISSUE_DETAIL_QUERY, { owner: repo.owner, repo: repo.repo, number: item.number }), repo, item.number);
        material = issueMaterial(repo, detail);
      }
      await this.deps.host.startExternalTask(
        askPrompt(repo, item.kind, item.number, text),
        { source: `github:${repo.owner}/${repo.repo}/${item.kind === "pr" ? "pull" : "issue"}-question#${item.number}`, text: material },
        `Ask about #${item.number}`,
        null,
        repo.root ?? undefined,
      );
      this.deps.track("prv_ask");
      this.deps.post({ type: "done", text: `A read-only chat opened with #${item.number} attached.` });
    } catch (error) {
      this.deps.track("prv_fail_ask");
      const why = error instanceof GitHubError ? this.deps.errorText(error) : "The question couldn't be sent. Check that Andromity's engine is running.";
      this.deps.post({ type: "failed", text: why });
      this.deps.notify(why);
    } finally {
      this.busy.delete(key);
    }
  }

  /** Opens the view on one item, from GitHub Pull Requests' own tree or a link. */
  async focus(target: RepoRef & { kind: ItemKind; number: number }): Promise<boolean> {
    const choice = this.choices.find((repo) => repo.owner.toLowerCase() === target.owner.toLowerCase() && repo.repo.toLowerCase() === target.repo.toLowerCase());
    if (!choice || !this.client) return false;
    if (choice !== this.current) {
      this.detail = null;
      this.detailRepo = null;
      this.files = null;
    }
    this.detailSeq++;
    this.current = choice;
    this.kind = target.kind;
    this.filter[target.kind] = "all";
    this.selected[target.kind] = target.number;
    await this.reload(true);
    if (this.selected[target.kind] !== target.number) {
      this.selected[target.kind] = target.number;
      await this.loadDetail(target.number, false);
    }
    return !!this.detail && this.detail.number === target.number;
  }
}
