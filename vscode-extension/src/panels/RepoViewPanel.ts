import * as vscode from "vscode";
import { currentAirGap } from "../airgapState.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import { GitHubClient, type FetchLike, type HttpResponse } from "../integrations/pullRequest/github.js";
import { parseRemoteUrl } from "../integrations/pullRequest/remotes.js";
import { loadGitApi } from "../integrations/pullRequest/vscodeGit.js";
import { errorText, startReview, type ReviewHost } from "../integrations/pullRequest/reviewPullRequest.js";
import { itemFromUrl, type ItemKind, type RepoRef } from "../integrations/pullRequest/repoViewData.js";
import { RepoViewController, type RepoChoice, type EmptyKind } from "./repoView/repoViewController.js";
import { getRepoViewHtml } from "../providers/repoView/repoViewHtml.js";

const fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<HttpResponse>;

async function githubClient(mode: "silent" | "ask" | "choose"): Promise<GitHubClient | null> {
  try {
    const options: vscode.AuthenticationGetSessionOptions = mode === "silent" ? { silent: true } : mode === "ask" ? { createIfNone: true } : { createIfNone: true, clearSessionPreference: true };
    const session = await vscode.authentication.getSession("github", ["repo"], options);
    return session?.accessToken ? new GitHubClient(session.accessToken, fetchImpl) : null;
  } catch {
    return null;
  }
}

async function workspaceRepositories(): Promise<RepoChoice[] | { problem: EmptyKind; host?: string }> {
  const git = await loadGitApi();
  if ("problem" in git) return { problem: "nogit" };
  const repos = git.api.repositories;
  if (!repos.length) return { problem: "norepo" };
  const choices: RepoChoice[] = [];
  let otherHost: string | null = null;
  for (const repo of repos) {
    const remotes = repo.state.remotes;
    const ordered = [remotes.find((r) => r.name === "upstream"), remotes.find((r) => r.name === "origin"), ...remotes].filter((r): r is NonNullable<typeof r> => !!r);
    const origin = remotes.find((r) => r.name === "origin");
    const originParsed = parseRemoteUrl(origin?.fetchUrl || origin?.pushUrl);
    for (const remote of ordered) {
      const parsed = parseRemoteUrl(remote.fetchUrl || remote.pushUrl);
      if (!parsed) continue;
      if (parsed.kind !== "github") {
        otherHost = otherHost ?? parsed.host;
        continue;
      }
      if (choices.some((c) => c.owner === parsed.owner && c.repo === parsed.repo)) continue;
      choices.push({
        owner: parsed.owner, repo: parsed.repo, label: `${parsed.owner}/${parsed.repo}`,
        root: repo.rootUri.fsPath, branch: repo.state.HEAD?.name ?? null,
        localOwner: originParsed?.kind === "github" ? originParsed.owner : parsed.owner,
      });
    }
  }
  if (!choices.length) return otherHost ? { problem: "otherhost", host: otherHost } : { problem: "noremote" };
  return choices;
}

/** The Pull Requests and Issues tab. Read-only towards GitHub; its actions open read-only chats. */
export class RepoViewPanel {
  public static current: RepoViewPanel | undefined;
  public static readonly viewType = "andromity.repoView";
  private readonly controller: RepoViewController;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private queued: (() => Promise<void>) | null = null;

  static show(extensionUri: vscode.Uri, host: ReviewHost, focus?: RepoRef & { kind: ItemKind; number: number; sheet?: "review" | "ask" }): RepoViewPanel {
    const existing = RepoViewPanel.current;
    if (existing) {
      existing.panel.reveal();
      if (focus) void existing.focus(focus);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(RepoViewPanel.viewType, "Pull Requests and Issues", vscode.ViewColumn.Active, {
      enableScripts: true,
      enableCommandUris: false,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    try {
      panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    } catch {
      /* The icon is optional. */
    }
    RepoViewPanel.current = new RepoViewPanel(panel, extensionUri, host, focus);
    return RepoViewPanel.current;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri, host: ReviewHost, focus?: RepoRef & { kind: ItemKind; number: number; sheet?: "review" | "ask" }) {
    this.controller = new RepoViewController({
      post: (message) => { void this.panel.webview.postMessage(message); },
      github: githubClient,
      repositories: workspaceRepositories,
      pickRepository: async (choices, current) => {
        const pick = await vscode.window.showQuickPick(choices.map((choice) => ({ label: choice.label, description: choice === current ? "shown now" : choice.root ?? "", choice })), { placeHolder: "Which repository?" });
        return pick?.choice ?? null;
      },
      host,
      startReview: (client, repo, number, focusText) => startReview(host, client, repo, number, focusText),
      errorText,
      airGap: () => currentAirGap().enabled,
      openExternal: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url, true)); },
      copy: async (text) => { await vscode.env.clipboard.writeText(text); },
      notify: (text) => { void vscode.window.showInformationMessage(text); },
      track: (name) => recordFeatureUse(name),
      now: () => Date.now(),
    });
    panel.webview.html = getRepoViewHtml(panel.webview, extensionUri);
    if (focus) this.queued = () => this.focus(focus);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState((event) => { if (event.webviewPanel.visible) void this.controller.returned(); }, null, this.disposables);
    panel.webview.onDidReceiveMessage((message) => { void this.handle(message); }, null, this.disposables);
  }

  private async focus(target: RepoRef & { kind: ItemKind; number: number; sheet?: "review" | "ask" }): Promise<void> {
    if (!this.ready) {
      this.queued = () => this.focus(target);
      return;
    }
    const found = await this.controller.focus(target);
    if (!found) {
      void vscode.window.showInformationMessage(`#${target.number} isn't in a repository open in this window, or this GitHub sign-in can't see it.`);
      return;
    }
    if (target.sheet) void this.panel.webview.postMessage({ type: "open_sheet", sheet: target.sheet, number: target.number });
  }

  private async handle(message: any): Promise<void> {
    if (!message || typeof message.type !== "string") return;
    const c = this.controller;
    switch (message.type) {
      case "ready": {
        const first = !this.ready;
        this.ready = true;
        if (first) {
          await c.start();
          const queued = this.queued;
          this.queued = null;
          if (queued) await queued();
        } else {
          this.panel.webview.postMessage({ type: "state", state: c.state() });
        }
        return;
      }
      case "refresh": return c.reload(true);
      case "kind": return c.setKind(message.kind);
      case "filter": return c.setFilter(message.filter);
      case "sort": return c.setSort(message.sort);
      case "text": return c.setText(message.text);
      case "select": return c.select(message.number);
      case "more": return c.loadMore();
      case "files": return c.loadFiles();
      case "repo": return c.chooseRepository();
      case "empty_action": return c.emptyAction(message.id);
      case "open": return c.open(message.number);
      case "copy": return c.copyLink(message.number);
      case "open_link": return c.openLink(message.url);
      case "open_check": return c.openCheck(message.number, message.index);
      case "review": return c.review(message.number, message.focus);
      case "ask": return c.ask(message.number, message.question);
      default: return;
    }
  }

  private dispose(): void {
    RepoViewPanel.current = undefined;
    this.controller.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

/** The pull request or issue behind a GitHub Pull Requests tree item, read only from its github.com link. */
export function targetFromTreeItem(node: unknown): (RepoRef & { kind: ItemKind; number: number }) | null {
  const value = node && typeof node === "object" ? node as Record<string, any> : null;
  if (!value) return null;
  const candidates = [value.pullRequestModel?.html_url, value.issueModel?.html_url, value.issue?.html_url, value.html_url];
  for (const url of candidates) {
    const target = itemFromUrl(url);
    if (target) return target;
  }
  return null;
}
