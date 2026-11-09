import * as vscode from "vscode";
import { currentAirGap } from "../../airgapState.js";
import { airGapOffMessage } from "../../airgap.js";
import { recordFeatureUse } from "../../telemetry/featureUsage.js";
import { findSecrets } from "../../secretScan.js";
import { FetchLike, GitHubClient, GitHubError, HttpResponse, PullDetail } from "./github.js";
import { parseRemoteUrl } from "./remotes.js";
import { loadGitApi } from "./vscodeGit.js";
import { GITHUB_BODY_LIMIT, plainText } from "./body.js";

export interface ReviewTarget {
  owner: string;
  repo: string;
  number: number;
  title: string;
}

/** What the review commands need from the chat. */
export interface ReviewHost {
  /** Starts a new chat turn whose GitHub text the engine wraps as untrusted and keeps read-only.
   *  A target marks the chat as a review that can be posted; questions pass null. */
  startExternalTask(prompt: string, external: { source: string; text: string }, taskName: string, target: ReviewTarget | null, projectPath?: string): Promise<void>;
  /** The review a chat holds (the current chat when no id is given), if it is one. */
  reviewIn(sessionId?: string): Promise<{ sessionId: string; target: ReviewTarget } | null>;
  /** The last answer of a chat, as plain text. */
  lastAnswer(sessionId: string): Promise<string | null>;
  /** The chat model new chats use, for telling the user where GitHub text is sent. */
  modelLabel?(): string;
}

const fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<HttpResponse>;
const REVIEW_FOOTER = "<sub>Drafted with Andromity from this pull request's description and diff. Read-only review: no code from the pull request was run.</sub>";
const reviewDocuments = new Map<string, ReviewTarget>();

function track(name: string): void {
  recordFeatureUse(name);
}

export async function signIn(choose: boolean): Promise<GitHubClient | null> {
  try {
    const session = await vscode.authentication.getSession("github", ["repo"], choose ? { createIfNone: true, clearSessionPreference: true } : { createIfNone: true });
    return session?.accessToken ? new GitHubClient(session.accessToken, fetchImpl) : null;
  } catch {
    return null;
  }
}

/** The GitHub repository of the workspace's git repository: origin, else the first remote. Its parent for a fork. */
async function workspaceRepository(): Promise<{ owner: string; repo: string } | string> {
  const git = await loadGitApi();
  if ("problem" in git) return "Turn on VS Code's Git extension to review pull requests.";
  const repos = git.api.repositories;
  if (!repos.length) return "Open a folder that is a git repository first.";
  let repo = repos[0];
  if (repos.length > 1) {
    const pick = await vscode.window.showQuickPick(repos.map((r) => ({ label: r.rootUri.fsPath, repo: r })), { placeHolder: "Which repository?" });
    if (!pick) return "";
    repo = pick.repo;
  }
  const remotes = repo.state.remotes;
  const remote = remotes.find((r) => r.name === "upstream") ?? remotes.find((r) => r.name === "origin") ?? remotes[0];
  const parsed = parseRemoteUrl(remote?.fetchUrl || remote?.pushUrl);
  if (!parsed || parsed.kind !== "github") return "This repository's remote isn't on github.com, so there are no GitHub pull requests to review.";
  return { owner: parsed.owner, repo: parsed.repo };
}

export function errorText(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.kind === "not_found") return "GitHub can't find that with your sign-in. If the repository belongs to another of your GitHub accounts, run the command again and choose it.";
    if (error.kind === "unauthorized") return "GitHub sign-in expired. Run the command again to sign in.";
    if (error.kind === "sso") return "This organisation requires single sign-on for your GitHub sign-in. Authorize it on GitHub, then try again.";
    if (error.kind === "oauth_restricted") return "This organisation hasn't approved VS Code's GitHub access. Request access on GitHub, then try again.";
    if (error.kind === "rate_limited") return "GitHub is limiting requests right now. Try again in a few minutes.";
    if (error.kind === "timeout" || error.kind === "network") return "Couldn't reach GitHub. Check your connection and try again.";
  }
  return "GitHub didn't answer as expected. Try again.";
}

/** The text the model reviews: metadata, description and diff. All of it comes from GitHub and is untrusted. */
export function reviewMaterial(target: { owner: string; repo: string }, pull: PullDetail, diff: string, cut: boolean): string {
  const lines = [
    `Pull request #${pull.number} in ${target.owner}/${target.repo}: ${pull.title}`,
    `Author: @${pull.author}. From ${pull.headRef} into ${pull.baseRef}. ${pull.changedFiles} files, +${pull.additions} -${pull.deletions}.${pull.draft ? " Draft." : ""}`,
    "",
    "Description:",
    pull.body.trim() || "(none)",
    "",
    cut ? "Diff (cut: the full diff is longer than this review could read):" : "Diff:",
    diff,
  ];
  return lines.join("\n");
}

export function reviewPrompt(target: { owner: string; repo: string }, number: number, focus = ""): string {
  const extra = plainText(focus, 2000).replace(/\s+/g, " ").trim();
  return `Review pull request #${number} in ${target.owner}/${target.repo}. Look for bugs, security problems, missing tests, and changes that don't match the description. `
    + "My open folder is on my own branch, not the pull request, so read files here only for context. "
    + "Finish with a short summary, then a numbered list of findings, each with the file and line it refers to."
    + (extra ? ` Pay most attention to this: ${extra}` : "");
}

/** Starts a review of one known pull request in a new read-only chat. */
export async function startReview(host: ReviewHost, github: GitHubClient, target: { owner: string; repo: string }, number: number, focus = "", projectPath?: string): Promise<void> {
  const [detail, { diff, cut }] = await Promise.all([
    github.pullDetail(target.owner, target.repo, number),
    github.pullDiff(target.owner, target.repo, number),
  ]);
  track("pra_review_started");
  if (cut) track("pra_review_diff_cut");
  await host.startExternalTask(
    reviewPrompt(target, detail.number, focus),
    { source: `github:${target.owner}/${target.repo}#${detail.number}`, text: reviewMaterial(target, detail, diff, cut) },
    `Review PR #${detail.number}`,
    { owner: target.owner, repo: target.repo, number: detail.number, title: detail.title },
    projectPath,
  );
}

/** Andromity: Review Pull Request… */
export async function reviewPullRequest(host: ReviewHost): Promise<void> {
  if (currentAirGap().enabled) {
    void vscode.window.showInformationMessage(airGapOffMessage("reviewing pull requests"));
    return;
  }
  const where = await workspaceRepository();
  if (typeof where === "string") {
    if (where) void vscode.window.showInformationMessage(where);
    return;
  }
  let github = await signIn(false);
  if (!github) {
    void vscode.window.showInformationMessage("GitHub sign-in didn't finish, so pull requests can't be listed.");
    return;
  }
  let target = { owner: where.owner, repo: where.repo };
  try {
    let info;
    try {
      info = await github.repository(target.owner, target.repo);
    } catch (error) {
      if (!(error instanceof GitHubError) || error.kind !== "not_found") throw error;
      const choice = await vscode.window.showWarningMessage(`GitHub can't find ${target.owner}/${target.repo} with this sign-in.`, "Use another account");
      if (choice !== "Use another account") return;
      github = await signIn(true);
      if (!github) return;
      info = await github.repository(target.owner, target.repo);
    }
    if (info.parent) target = { owner: info.parent.owner, repo: info.parent.repo };
    const pulls = await github.openPulls(target.owner, target.repo);
    if (!pulls.length) {
      track("pra_review_no_prs");
      void vscode.window.showInformationMessage(`${target.owner}/${target.repo} has no open pull requests.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(pulls.map((pull) => ({
      label: `#${pull.number} ${pull.title}`,
      description: `@${pull.author} · ${pull.headRef} → ${pull.baseRef}${pull.draft ? " · draft" : ""}`,
      pull,
    })), { placeHolder: `Open pull requests in ${target.owner}/${target.repo}`, matchOnDescription: true });
    if (!pick) return;
    await startReview(host, github, target, pick.pull.number);
  } catch (error) {
    track("pra_review_failed");
    void vscode.window.showWarningMessage(errorText(error));
  }
}

/** Opens the current review chat's last answer as an editable document, ready to post. */
/** The pull request a chat reviews, from the engine's "github:owner/repo#N" label. */
export function reviewTargetFromLabel(label: unknown): ReviewTarget | null {
  if (typeof label !== "string") return null;
  const match = /^github:([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/.exec(label);
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]), title: "" } : null;
}

export async function openReviewForPosting(host: ReviewHost, sessionId?: string): Promise<void> {
  const review = await host.reviewIn(typeof sessionId === "string" ? sessionId : undefined);
  if (!review) {
    void vscode.window.showInformationMessage("Open the pull request's review chat first. Reviews start with Andromity: Review Pull Request.");
    return;
  }
  const answer = await host.lastAnswer(review.sessionId);
  if (!answer || !answer.trim()) {
    void vscode.window.showInformationMessage("The review has no answer yet.");
    return;
  }
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: `${answer.trim()}\n\n${REVIEW_FOOTER}\n` });
  reviewDocuments.set(document.uri.toString(), review.target);
  await vscode.window.showTextDocument(document, { preview: false });
  const { number, owner, repo } = review.target;
  const choice = await vscode.window.showInformationMessage(
    `Edit the review as you like, then post it to #${number} on ${owner}/${repo} as a comment. It won't approve or request changes.`,
    `Post to #${number}`,
  );
  if (choice) await postReviewDocument(document);
}

/** Andromity: Post Review to Pull Request (for the active review document). */
export async function postActiveReview(): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || !reviewDocuments.has(document.uri.toString())) {
    void vscode.window.showInformationMessage("Open a review document first: run Andromity: Edit Review to Post from the review chat.");
    return;
  }
  await postReviewDocument(document);
}

async function postReviewDocument(document: vscode.TextDocument): Promise<void> {
  const target = reviewDocuments.get(document.uri.toString());
  if (!target) return;
  if (document.isClosed) {
    void vscode.window.showInformationMessage("The review document was closed, so nothing was posted.");
    return;
  }
  const body = plainText(document.getText(), GITHUB_BODY_LIMIT + 1).trim();
  if (!body) return;
  if (body.length > GITHUB_BODY_LIMIT) {
    void vscode.window.showWarningMessage("The review is longer than GitHub allows. Shorten it, then post again.");
    return;
  }
  const secrets = findSecrets(body);
  if (secrets.length) {
    const go = await vscode.window.showWarningMessage(
      `The review contains what looks like ${/^[aeiou]/i.test(secrets[0].label) ? "an" : "a"} ${secrets[0].label}. Posting makes it visible to everyone who can see the pull request.`,
      { modal: true }, "Post anyway");
    if (go !== "Post anyway") return;
  }
  if (currentAirGap().enabled) {
    void vscode.window.showInformationMessage(airGapOffMessage("posting reviews"));
    return;
  }
  const github = await signIn(false);
  if (!github) return;
  try {
    await github.postReviewComment(target.owner, target.repo, target.number, body);
    reviewDocuments.delete(document.uri.toString());
    track("pra_review_posted");
    const url = `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pull/${target.number}`;
    const open = await vscode.window.showInformationMessage(`Review posted to #${target.number}.`, "Open on GitHub");
    if (open) void vscode.env.openExternal(vscode.Uri.parse(url, true));
  } catch (error) {
    track("pra_review_post_failed");
    void vscode.window.showWarningMessage(`The review wasn't posted. ${errorText(error)}`);
  }
}
