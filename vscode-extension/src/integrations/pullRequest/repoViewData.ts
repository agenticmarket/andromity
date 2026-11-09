/* Data for the Pull Requests and Issues view: GitHub search and detail queries, and strict readers that turn
   GitHub's answers into plain values. Everything read here was written by someone on GitHub and stays untrusted. */

export type ItemKind = "pr" | "issue";
export type ItemState = "open" | "draft" | "merged" | "closed";
export type CheckState = "pass" | "fail" | "pending" | "neutral" | "skipped";
export type PrFilter = "foryou" | "all";
export type IssueFilter = "assigned" | "all";
export type SortOrder = "updated" | "created" | "stale";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface Label {
  name: string;
  color: string | null;
}

export interface ListItem {
  kind: ItemKind;
  number: number;
  title: string;
  state: ItemState;
  stateReason: "completed" | "not_planned" | null;
  author: string;
  association: string;
  updatedAt: string;
  labels: Label[];
  comments: number;
  url: string;
  headRef?: string;
  baseRef?: string;
  headOwner?: string | null;
  crossRepository?: boolean;
  checks?: "success" | "failure" | "pending" | null;
  review?: "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED" | null;
  requestedUsers?: string[];
  /** Teams asked to review. GitHub only shares team names with the read:org permission, which VS Code's sign-in doesn't ask for, so only the count is known. */
  requestedTeams?: number;
  assignees?: string[];
  linked?: number[];
}

export interface Comment {
  author: string;
  association: string;
  body: string;
  createdAt: string;
}

export interface Thread {
  path: string;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  comments: Comment[];
}

export interface Check {
  name: string;
  state: CheckState;
  required: boolean;
  app: string | null;
  url: string | null;
}

export interface LinkedItem {
  number: number;
  title: string;
}

export interface PrDetail extends ListItem {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  mergeState: MergeState;
  closes: LinkedItem[];
  reviews: { author: string; state: string }[];
  conversation: Comment[];
  threads: Thread[];
  checkList: Check[];
}

export interface IssueDetail extends ListItem {
  body: string;
  conversation: Comment[];
  closedBy: LinkedItem[];
}

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch: string | null;
}

export type MergeState = "CLEAN" | "BLOCKED" | "BEHIND" | "DIRTY" | "UNSTABLE" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "MERGED" | "CLOSED";

export interface SearchPage {
  count: number;
  items: ListItem[];
  cursor: string | null;
  more: boolean;
}

export const PAGE_SIZE = 50;
export const MAX_BODY = 60_000;
export const MAX_COMMENT = 20_000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(\[bot\])?$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const COLOR = /^[0-9a-fA-F]{6}$/;
const HIDDEN = /[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u115f-\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffb]/g;
const ASSOCIATIONS: Record<string, string> = {
  OWNER: "Owner", MEMBER: "Member", COLLABORATOR: "Collaborator", CONTRIBUTOR: "Contributor",
  FIRST_TIME_CONTRIBUTOR: "First-time contributor", FIRST_TIMER: "First-time contributor", MANNEQUIN: "Mannequin", NONE: "None",
};
const MERGE_STATES = new Set<MergeState>(["CLEAN", "BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "DRAFT", "HAS_HOOKS", "UNKNOWN"]);

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function list(value: unknown, max: number): unknown[] {
  const nodes = obj(value)?.nodes;
  return Array.isArray(nodes) ? nodes.slice(0, max) : [];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Hidden and direction-changing characters shown as visible marks, so a spoofed name can't look like a real one. */
export function visible(value: string): string {
  return value.replace(HIDDEN, (ch) => {
    if (ch === "\t") return ch;
    return `⟨U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
  });
}

/** One line of untrusted text: newlines become spaces, hidden characters become visible, then it's cut. */
export function line(value: unknown, max = 300): string {
  if (typeof value !== "string") return "";
  return visible(value.slice(0, max * 2).replace(/\r\n?|\n/g, " ")).slice(0, max);
}

/** A block of untrusted text: newlines kept, hidden characters made visible, cut at the limit. */
export function block(value: unknown, max: number): { text: string; cut: boolean } {
  if (typeof value !== "string") return { text: "", cut: false };
  const cut = value.length > max;
  return { text: visible(value.slice(0, max).replace(/\r\n?/g, "\n")), cut };
}

function login(value: unknown): string {
  const raw = obj(value)?.login;
  return typeof raw === "string" && BOT_LOGIN.test(raw) ? raw : "ghost";
}

function association(value: unknown): string {
  return typeof value === "string" && ASSOCIATIONS[value] ? ASSOCIATIONS[value] : "None";
}

function date(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) ? value : "";
}

/** Only https links on github.com are kept for items; anything else is dropped. */
export function githubUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

/** Any https link (check details can point at other CI hosts); other schemes are dropped. */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function labels(value: unknown): Label[] {
  return list(value, 10).map((node) => {
    const entry = obj(node);
    const color = typeof entry?.color === "string" && COLOR.test(entry.color) ? `#${entry.color.toLowerCase()}` : null;
    return { name: line(entry?.name, 50), color };
  }).filter((entry) => entry.name);
}

function requested(value: unknown): { users: string[]; teams: number } {
  const users: string[] = [];
  let teams = 0;
  for (const node of list(value, 15)) {
    const reviewer = obj(obj(node)?.requestedReviewer);
    if (reviewer?.__typename === "User" && typeof reviewer.login === "string" && LOGIN.test(reviewer.login)) users.push(reviewer.login);
    if (reviewer?.__typename === "Team") teams++;
  }
  return { users, teams };
}

function rollup(value: unknown): "success" | "failure" | "pending" | null {
  const commit = obj(obj(list(obj(value)?.lastCommit ?? value, 1)[0])?.commit);
  const state = obj(commit?.statusCheckRollup)?.state;
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return null;
}

function prState(entry: Record<string, unknown>): ItemState {
  if (entry.state === "MERGED") return "merged";
  if (entry.state === "CLOSED") return "closed";
  return entry.isDraft === true ? "draft" : "open";
}

function review(value: unknown): ListItem["review"] {
  return value === "REVIEW_REQUIRED" || value === "CHANGES_REQUESTED" || value === "APPROVED" ? value : null;
}

/** One search result, or null when it isn't a pull request or issue of the expected repository. */
export function readItem(raw: unknown, repo: RepoRef): ListItem | null {
  const entry = obj(raw);
  const number = positive(entry?.number);
  const url = githubUrl(entry?.url);
  if (!entry || !number || !url) return null;
  const expected = `https://github.com/${repo.owner}/${repo.repo}/`.toLowerCase();
  if (!url.toLowerCase().startsWith(expected)) return null;
  const base = {
    number,
    title: line(entry.title, 300) || "(no title)",
    author: login(entry.author),
    association: association(entry.authorAssociation),
    updatedAt: date(entry.updatedAt),
    labels: labels(entry.labels),
    comments: num(obj(entry.comments)?.totalCount),
    url,
  };
  if (entry.__typename === "PullRequest") {
    const reviewers = requested(entry.reviewRequests);
    const headOwner = obj(entry.headRepositoryOwner)?.login;
    return {
      ...base,
      kind: "pr",
      state: prState(entry),
      stateReason: null,
      headRef: line(entry.headRefName, 255),
      baseRef: line(entry.baseRefName, 255),
      headOwner: typeof headOwner === "string" && LOGIN.test(headOwner) ? headOwner : null,
      crossRepository: entry.isCrossRepository === true,
      checks: rollup(entry.lastCommit),
      review: review(entry.reviewDecision),
      requestedUsers: reviewers.users,
      requestedTeams: reviewers.teams,
    };
  }
  if (entry.__typename === "Issue") {
    const assignees = list(entry.assignees, 10).map((node) => obj(node)?.login).filter((value): value is string => typeof value === "string" && LOGIN.test(value));
    const linked = list(entry.closedByPullRequestsReferences, 5).map((node) => positive(obj(node)?.number)).filter((value): value is number => value !== null);
    return {
      ...base,
      kind: "issue",
      state: entry.state === "CLOSED" ? "closed" : "open",
      stateReason: entry.stateReason === "NOT_PLANNED" ? "not_planned" : entry.stateReason === "COMPLETED" ? "completed" : null,
      assignees,
      linked,
    };
  }
  return null;
}

export function readSearch(data: Record<string, unknown>, repo: RepoRef, kind: ItemKind): SearchPage {
  const search = obj(data.search);
  if (!search) throw new Error("no search result");
  const info = obj(search.pageInfo);
  const items = list(search, PAGE_SIZE).map((node) => readItem(node, repo)).filter((item): item is ListItem => !!item && item.kind === kind);
  const cursor = typeof info?.endCursor === "string" && info.endCursor.length <= 200 ? info.endCursor : null;
  return { count: num(search.issueCount), items, cursor, more: info?.hasNextPage === true && !!cursor };
}

function comment(raw: unknown): Comment | null {
  const entry = obj(raw);
  if (!entry) return null;
  return { author: login(entry.author), association: association(entry.authorAssociation), body: block(entry.body, MAX_COMMENT).text, createdAt: date(entry.createdAt) };
}

function comments(value: unknown, max: number): Comment[] {
  return list(value, max).map(comment).filter((entry): entry is Comment => !!entry);
}

function linkedItems(value: unknown): LinkedItem[] {
  return list(value, 10).map((node) => {
    const entry = obj(node);
    const number = positive(entry?.number);
    return number ? { number, title: line(entry?.title, 200) } : null;
  }).filter((entry): entry is LinkedItem => !!entry);
}

function checkState(entry: Record<string, unknown>): CheckState {
  if (entry.__typename === "StatusContext") {
    if (entry.state === "SUCCESS") return "pass";
    if (entry.state === "FAILURE" || entry.state === "ERROR") return "fail";
    return "pending";
  }
  if (entry.status !== "COMPLETED") return "pending";
  switch (entry.conclusion) {
    case "SUCCESS": return "pass";
    case "NEUTRAL": return "neutral";
    case "SKIPPED": return "skipped";
    case "FAILURE": case "TIMED_OUT": case "CANCELLED": case "ACTION_REQUIRED": case "STARTUP_FAILURE": case "STALE": return "fail";
    default: return "pending";
  }
}

function checks(value: unknown): Check[] {
  const commit = obj(obj(list(value, 1)[0])?.commit);
  const contexts = obj(obj(commit?.statusCheckRollup)?.contexts);
  return list(contexts, 100).map((node) => {
    const entry = obj(node);
    if (!entry) return null;
    const isRun = entry.__typename === "CheckRun";
    const name = line(isRun ? entry.name : entry.context, 120);
    if (!name) return null;
    const app = isRun ? line(obj(obj(obj(entry.checkSuite)?.app))?.name, 60) || null : null;
    return { name, state: checkState(entry), required: entry.isRequired === true, app, url: httpsUrl(isRun ? entry.detailsUrl : entry.targetUrl) };
  }).filter((entry): entry is Check => !!entry);
}

export function readPrDetail(data: Record<string, unknown>, repo: RepoRef, number: number): PrDetail {
  const pull = obj(obj(data.repository)?.pullRequest);
  const item = readItem(pull ? { ...pull, __typename: "PullRequest" } : null, repo);
  if (!pull || !item || item.number !== number) throw new Error("not this pull request");
  const state = pull.state === "MERGED" ? "MERGED" : pull.state === "CLOSED" ? "CLOSED" : item.state === "draft" ? "DRAFT" : typeof pull.mergeStateStatus === "string" && MERGE_STATES.has(pull.mergeStateStatus as MergeState) ? pull.mergeStateStatus as MergeState : "UNKNOWN";
  const threads = list(pull.reviewThreads, 100).map((node) => {
    const entry = obj(node);
    if (!entry) return null;
    const line = positive(entry.line) ?? positive(entry.originalLine);
    return {
      path: visible(typeof entry.path === "string" ? entry.path.slice(0, 1000) : ""),
      line,
      resolved: entry.isResolved === true,
      outdated: entry.isOutdated === true,
      comments: comments(entry.comments, 20),
    };
  }).filter((entry): entry is Thread => !!entry && entry.comments.length > 0);
  const reviews = list(pull.latestReviews, 20).map((node) => {
    const entry = obj(node);
    const reviewState = typeof entry?.state === "string" && /^[A-Z_]{1,30}$/.test(entry.state) ? entry.state : "";
    return reviewState ? { author: login(entry?.author), state: reviewState } : null;
  }).filter((entry): entry is { author: string; state: string } => !!entry);
  return {
    ...item,
    body: block(pull.body, MAX_BODY).text,
    additions: num(pull.additions),
    deletions: num(pull.deletions),
    changedFiles: num(pull.changedFiles),
    commits: num(obj(pull.commitCount)?.totalCount),
    mergeState: state,
    closes: linkedItems(pull.closingIssuesReferences),
    reviews,
    conversation: comments(pull.comments, 50),
    threads,
    checkList: checks(pull.lastCommit),
  };
}

export function readIssueDetail(data: Record<string, unknown>, repo: RepoRef, number: number): IssueDetail {
  const issue = obj(obj(data.repository)?.issue);
  const item = readItem(issue ? { ...issue, __typename: "Issue" } : null, repo);
  if (!issue || !item || item.number !== number) throw new Error("not this issue");
  return {
    ...item,
    body: block(issue.body, MAX_BODY).text,
    conversation: comments(issue.comments, 50),
    closedBy: linkedItems(issue.closedByPullRequestsReferences),
  };
}

const FILE_STATUS = new Set(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);

export function readFiles(raw: unknown[]): ChangedFile[] {
  return raw.slice(0, 300).map((entry) => {
    const value = obj(entry);
    if (!value || typeof value.filename !== "string" || !value.filename) return null;
    const status = typeof value.status === "string" && FILE_STATUS.has(value.status) ? value.status as ChangedFile["status"] : "changed";
    return {
      path: visible(value.filename.slice(0, 1000)),
      previousPath: typeof value.previous_filename === "string" ? visible(value.previous_filename.slice(0, 1000)) : null,
      status,
      additions: num(value.additions),
      deletions: num(value.deletions),
      patch: typeof value.patch === "string" ? block(value.patch, 200_000).text : null,
    };
  }).filter((entry): entry is ChangedFile => !!entry);
}

/** Free text from the filter box, kept to this repository: qualifiers that would widen the search are removed. */
export function cleanFilter(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !/^-?(repo|org|user|owner|type|is|in|archived|sort):/i.test(word))
    .join(" ")
    .slice(0, 200);
}

const SORTS: Record<SortOrder, string> = { updated: "sort:updated-desc", created: "sort:created-desc", stale: "sort:updated-asc" };

/** The GitHub search for one list. `part` picks the half of "For you". */
export function searchQuery(repo: RepoRef, kind: ItemKind, filter: string, sort: SortOrder, text: string, part?: "review" | "mine"): string {
  const words = [`repo:${repo.owner}/${repo.repo}`, kind === "pr" ? "is:pr" : "is:issue", "is:open"];
  if (kind === "pr" && filter === "foryou") words.push(part === "mine" ? "author:@me" : "review-requested:@me");
  if (kind === "issue" && filter === "assigned") words.push("assignee:@me");
  words.push(SORTS[sort] ?? SORTS.updated);
  const extra = cleanFilter(text);
  if (extra) words.push(extra);
  return words.join(" ");
}

const ITEM_FIELDS = `
  __typename
  ... on PullRequest {
    number title state isDraft url updatedAt authorAssociation
    author { login }
    headRefName baseRefName isCrossRepository
    headRepositoryOwner { login }
    comments { totalCount }
    labels(first: 10) { nodes { name color } }
    reviewDecision
    reviewRequests(first: 15) { nodes { requestedReviewer { __typename ... on User { login } } } }
    lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }
  ... on Issue {
    number title state stateReason url updatedAt authorAssociation
    author { login }
    comments { totalCount }
    labels(first: 10) { nodes { name color } }
    assignees(first: 10) { nodes { login } }
    closedByPullRequestsReferences(first: 5) { nodes { number } }
  }`;

export const SEARCH_QUERY = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${ITEM_FIELDS} }
  }
}`;

export const COUNT_QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 1) { issueCount } }`;

const COMMENT_FIELDS = "author { login } authorAssociation body createdAt";

export const PR_DETAIL_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title body state isDraft url updatedAt authorAssociation
      author { login }
      headRefName baseRefName isCrossRepository
      headRepositoryOwner { login }
      additions deletions changedFiles
      commitCount: commits { totalCount }
      mergeStateStatus reviewDecision
      comments(last: 50) { totalCount nodes { ${COMMENT_FIELDS} } }
      labels(first: 10) { nodes { name color } }
      reviewRequests(first: 15) { nodes { requestedReviewer { __typename ... on User { login } } } }
      latestReviews(first: 20) { nodes { author { login } state } }
      closingIssuesReferences(first: 10) { nodes { number title } }
      reviewThreads(first: 100) { nodes { path line originalLine isResolved isOutdated comments(first: 20) { nodes { ${COMMENT_FIELDS} } } } }
      lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { app { name } } }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;

export const ISSUE_DETAIL_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number title body state stateReason url updatedAt authorAssociation
      author { login }
      comments(last: 50) { totalCount nodes { ${COMMENT_FIELDS} } }
      labels(first: 10) { nodes { name color } }
      assignees(first: 10) { nodes { login } }
      closedByPullRequestsReferences(first: 10) { nodes { number title } }
    }
  }
}`;

/** owner, repo and number from a github.com pull request or issue link, checked strictly. */
export function itemFromUrl(value: unknown): (RepoRef & { kind: ItemKind; number: number }) | null {
  const url = githubUrl(value);
  if (!url) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9][0-9]{0,9})\/?$/.exec(url);
  if (!match || !LOGIN.test(match[1]) || !NAME.test(match[2])) return null;
  return { owner: match[1], repo: match[2], kind: match[3] === "pull" ? "pr" : "issue", number: Number(match[4]) };
}

/** Text the model reads for a question about a pull request. All of it comes from GitHub and is untrusted. */
export function prMaterial(repo: RepoRef, pull: PrDetail, diff: string, cut: boolean): string {
  const parts = [
    `Pull request #${pull.number} in ${repo.owner}/${repo.repo}: ${pull.title}`,
    `Author: @${pull.author} (${pull.association}). From ${pull.headOwner && pull.crossRepository ? `${pull.headOwner}:` : ""}${pull.headRef} into ${pull.baseRef}. ${pull.changedFiles} files, +${pull.additions} -${pull.deletions}. State: ${pull.state}.`,
    `Checks: ${pull.checkList.length ? pull.checkList.map((check) => `${check.name} ${check.state}${check.required ? " (required)" : ""}`).join("; ") : "none"}.`,
    "",
    "Description:",
    pull.body.trim() || "(none)",
  ];
  if (pull.conversation.length) {
    parts.push("", "Comments:");
    for (const entry of pull.conversation) parts.push(`@${entry.author} (${entry.association}): ${entry.body}`);
  }
  const open = pull.threads.filter((thread) => !thread.resolved);
  if (open.length) {
    parts.push("", "Open review threads:");
    for (const thread of open) {
      parts.push(`${thread.path}${thread.line ? `:${thread.line}` : ""}${thread.outdated ? " (outdated)" : ""}`);
      for (const entry of thread.comments) parts.push(`  @${entry.author} (${entry.association}): ${entry.body}`);
    }
  }
  parts.push("", cut ? "Diff (cut: the full diff is longer than this could read):" : "Diff:", diff);
  return parts.join("\n");
}

export function issueMaterial(repo: RepoRef, issue: IssueDetail): string {
  const parts = [
    `Issue #${issue.number} in ${repo.owner}/${repo.repo}: ${issue.title}`,
    `Author: @${issue.author} (${issue.association}). State: ${issue.state}${issue.stateReason ? ` (${issue.stateReason})` : ""}. Labels: ${issue.labels.map((entry) => entry.name).join(", ") || "none"}.`,
    "",
    "Text:",
    issue.body.trim() || "(none)",
  ];
  if (issue.conversation.length) {
    parts.push("", "Comments:");
    for (const entry of issue.conversation) parts.push(`@${entry.author} (${entry.association}): ${entry.body}`);
  }
  return parts.join("\n");
}

/** The question the user asked, wrapped in fixed words; GitHub text never goes here. */
export function askPrompt(repo: RepoRef, kind: ItemKind, number: number, question: string): string {
  const noun = kind === "pr" ? "pull request" : "issue";
  return `About ${noun} #${number} in ${repo.owner}/${repo.repo} (attached): ${question}\n\n`
    + "My open folder may be on another branch, so read files here only for context. Don't change anything.";
}

export const ASK_SUGGESTIONS: Record<ItemKind, string[]> = {
  pr: ["Summarize what this changes", "What could this break?", "Are the risky parts tested?", "How does this differ from main today?"],
  issue: ["Explain this issue in plain words", "Find where this comes from in the code", "Which files are involved?", "Is it already fixed on main?"],
};
