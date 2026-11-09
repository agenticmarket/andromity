import * as vscode from "vscode";
import * as path from "path";
import { RpcClient } from "../server/RpcClient.js";
import { HEAD_SCHEME } from "../integrations/DiffManager.js";
import { getReviewHtml } from "../providers/changesReview/reviewHtml.js";
import { currentAirGap } from "../airgapState.js";
import { loadGitApi } from "../integrations/pullRequest/vscodeGit.js";
import { SNAPSHOT_BRANCH, warnIfOnSnapshotBranch } from "../integrations/snapshotBranchWarning.js";
import { PullRequestController, TurnRef } from "./pullRequestController.js";

import { GitStatusResult, DiffNumstatResult, ReviewFile } from "../providers/changesReview/types.js";

interface TurnViewFile {
  path: string;
  name: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  now: "uncommitted" | "committed" | "changed" | "unknown";
}

function readTurnFiles(value: unknown): TurnViewFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: TurnViewFile[] = [];
  for (const entry of value.slice(0, 500)) {
    const p = entry?.path;
    if (typeof p !== "string" || !p || p.length > 4096 || p.includes("\0") || p.includes("\\") || p.startsWith("/")
      || /^[A-Za-z]:/.test(p) || p.split("/").some((part) => part === ".." || part === ".")) continue;
    const count = (n: unknown) => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0);
    const now = ["uncommitted", "committed", "changed"].includes(entry?.now) ? entry.now : "unknown";
    files.push({
      path: p, name: path.posix.basename(p), status: typeof entry?.status === "string" ? entry.status.slice(0, 1) || "M" : "M",
      additions: count(entry?.additions), deletions: count(entry?.deletions), binary: entry?.binary === true, now,
    });
  }
  return files;
}

function readTurnRef(value: unknown): TurnRef | null {
  const ref = value as { sessionId?: unknown; turnIndex?: unknown } | null;
  if (!ref || typeof ref.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.sessionId)) return null;
  const index = ref.turnIndex;
  return { sessionId: ref.sessionId, turnIndex: typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : null };
}

/** Waits for a burst of file events (an agent writing many files, an install) to settle. */
export const AUTO_REFRESH_DELAY_MS = 500;

/** File events that can change what git reports. node_modules is noise; inside
 *  .git only the branch, index and branch refs matter (commits, checkouts, staging). */
export function isReviewRelevantChange(fsPath: string): boolean {
  const p = fsPath.replace(/\\/g, "/");
  if (p.includes("/node_modules/")) return false;
  const git = p.indexOf("/.git/");
  if (git < 0) return !p.endsWith("/.git");
  const inner = p.slice(git + "/.git/".length);
  return inner === "HEAD" || inner === "index" || inner.startsWith("refs/heads/");
}

export class ChangesReviewPanel {
  public static currentPanel: ChangesReviewPanel | undefined;
  public static readonly viewType = "andromity.changesReviewPanel";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _rpcClient: RpcClient | null = null;
  private _disposables: vscode.Disposable[] = [];
  private _initialFilePath?: string;
  private _turnFiles?: string[];
  private _repositoryRoot?: string;
  private _projectPath?: string;
  private _refreshVersion = 0;
  private _diffVersion = 0;
  private _knownFiles = new Set<string>();
  private _deletedFiles = new Set<string>();
  private _autoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Files changed while the panel was hidden; refresh once it is shown again. */
  private _stale = false;
  private _files: ReviewFile[] = [];
  private _turnFilesRel: string[] | null = null;
  private _turn: TurnRef | null = null;
  private _scope: "turn" | "all" = "turn";
  private _isGit = false;
  private _gitAvailable: boolean | undefined;
  private _openPullRequestWhenReady = false;
  /** What the panel's turn changed, from its own snapshots; null when unknown. */
  private _turnView: { turnIndex: number; files: TurnViewFile[] } | null = null;
  private _turnSeq = 0;
  private readonly _pr: PullRequestController;
  private static _agentRunning = false;
  private static _sessionLookup: () => string | null = () => null;

  public static setSessionLookup(lookup: () => string | null) {
    ChangesReviewPanel._sessionLookup = lookup;
  }

  public setTurnFiles(files?: string[], turn?: TurnRef | null) {
    this._turnFiles = files;
    if (turn !== undefined) this._turn = readTurnRef(turn);
    this._pr?.turnChanged();
    void this._loadTurnChanges();
  }

  /** The latest turn's number arrives with its receipt, just after the turn ends. */
  public updateTurnIndex(sessionId: string, turnIndex: number) {
    if (this._turn && this._turn.sessionId === sessionId && this._turn.turnIndex === null && Number.isSafeInteger(turnIndex) && turnIndex >= 0) {
      this._turn = { sessionId, turnIndex };
      this._pr.turnChanged();
      void this._loadTurnChanges();
    }
  }

  public static setAgentRunning(running: boolean) {
    ChangesReviewPanel._agentRunning = running;
    const panel = ChangesReviewPanel.currentPanel;
    if (panel) {
      panel._postButton();
      panel._pr.refreshView();
    }
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    rpcClient: RpcClient | null,
    initialFilePath?: string,
    turnFiles?: string[],
    turn?: TurnRef | null,
    openPullRequest = false
  ): ChangesReviewPanel {
    const column = vscode.window.activeTextEditor
      ? (vscode.window.activeTextEditor.viewColumn || vscode.ViewColumn.Active)
      : vscode.ViewColumn.One;

    if (ChangesReviewPanel.currentPanel) {
      const current = ChangesReviewPanel.currentPanel;
      current._panel.reveal(column);
      current._rpcClient = rpcClient;
      if (!current._pr.isRunning()) {
        const next = readTurnRef(turn);
        const changed = next?.sessionId !== current._turn?.sessionId || next?.turnIndex !== current._turn?.turnIndex
          || JSON.stringify(turnFiles ?? null) !== JSON.stringify(current._turnFiles ?? null);
        current._turnFiles = turnFiles;
        current._turn = next;
        if (changed) current._pr.turnChanged();
      }
      if (openPullRequest) current._openPullRequestWhenReady = true;
      if (initialFilePath) {
        ChangesReviewPanel.currentPanel.selectFile(initialFilePath);
      } else {
        ChangesReviewPanel.currentPanel.loadChanges();
      }
      return ChangesReviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ChangesReviewPanel.viewType,
      "Changes Review",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    try {
      panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    } catch {}

    ChangesReviewPanel.currentPanel = new ChangesReviewPanel(
      panel,
      extensionUri,
      rpcClient,
      initialFilePath,
      turnFiles
    );
    ChangesReviewPanel.currentPanel._turn = readTurnRef(turn);
    ChangesReviewPanel.currentPanel._openPullRequestWhenReady = openPullRequest;

    return ChangesReviewPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    rpcClient: RpcClient | null,
    initialFilePath?: string,
    turnFiles?: string[]
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._rpcClient = rpcClient;
    this._initialFilePath = initialFilePath;
    this._turnFiles = turnFiles;
    this._projectPath = initialFilePath && path.isAbsolute(initialFilePath)
      ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(initialFilePath))?.uri.fsPath
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    this._pr = new PullRequestController({
      post: (msg) => this._postMessage(msg),
      rpc: () => this._rpcClient,
      repositoryRoot: () => this._repositoryRoot,
      projectPath: () => this._projectPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      files: () => this._files.map((file) => ({
        path: file.path, status: file.status, additions: file.additions, deletions: file.deletions,
        binary: file.binary, omitted: file.omitted, originalPath: file.originalPath,
      })),
      turnFiles: () => this._turnFilesRel,
      turn: () => this._turn,
      currentSession: () => ChangesReviewPanel._sessionLookup(),
      scope: () => this._scope,
      agentRunning: () => ChangesReviewPanel._agentRunning,
      refresh: () => this.loadChanges(undefined, true),
      log: () => {},
    });

    this._panel.webview.html = getReviewHtml(this._panel.webview, this._extensionUri);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        if (typeof message?.type === "string" && message.type.startsWith("pr_")) {
          if (message.type === "pr_open" && (message.scope === "turn" || message.scope === "all")) this._scope = message.scope;
          await this._pr.handle(message);
          return;
        }
        switch (message.type) {
          case "webview_ready":
            await this.loadChanges(this._initialFilePath);
            break;

          case "revert_turn_file":
            if (typeof message.filePath === "string") await this._revertTurnFile(message.filePath);
            break;

          case "get_turn_file_diff":
            if (typeof message.filePath === "string") await this._loadTurnFileDiff(message.filePath);
            break;

          case "open_repo_view":
            void vscode.commands.executeCommand("andromity.openPullRequestsView");
            break;

          case "get_file_diff":
            if (message.filePath) {
              if (this._knownFiles.has(message.filePath)) this._pr.markOpened(message.filePath);
              await this.loadFileDiff(message.filePath);
            }
            break;

          case "open_file":
            if (message.filePath) {
              await this._openFileInEditor(message.filePath);
            }
            break;

          case "open_native_diff":
            if (message.filePath) {
              await this._openNativeDiff(message.filePath, !!message.isUntracked);
            }
            break;

          case "revert_file":
            if (message.filePath) {
              await this._revertFile(message.filePath);
            }
            break;

          case "refresh":
            await this.loadChanges();
            break;
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const onFileEvent = (uri: vscode.Uri) => {
      if (isReviewRelevantChange(uri.fsPath)) this._scheduleAutoRefresh();
    };
    watcher.onDidChange(onFileEvent, null, this._disposables);
    watcher.onDidCreate(onFileEvent, null, this._disposables);
    watcher.onDidDelete(onFileEvent, null, this._disposables);
    this._disposables.push(watcher);
    this._panel.onDidChangeViewState(() => {
      if (this._panel.visible && this._stale) {
        this._stale = false;
        void this.loadChanges(undefined, true);
      }
    }, null, this._disposables);
  }

  private _scheduleAutoRefresh() {
    if (this._isDisposed) return;
    if (this._autoRefreshTimer) clearTimeout(this._autoRefreshTimer);
    this._autoRefreshTimer = setTimeout(() => {
      this._autoRefreshTimer = undefined;
      if (this._isDisposed) return;
      if (!this._panel.visible) {
        this._stale = true;
        return;
      }
      void this.loadChanges(undefined, true);
    }, AUTO_REFRESH_DELAY_MS);
  }

  public setRpcClient(client: RpcClient | null) {
    this._rpcClient = client;
    this.loadChanges();
  }

  public selectFile(filePath: string) {
    this._initialFilePath = filePath;
    this.loadChanges(filePath);
  }

  private _isDisposed = false;

  /** auto: a background refresh, so the view keeps its place instead of jumping. */
  public async loadChanges(selectFilePath?: string, auto = false) {
    if (this._isDisposed) return;
    const version = ++this._refreshVersion;
    ++this._diffVersion;
    const ws = this._projectPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !this._rpcClient) {
      this._isGit = false;
      this._files = [];
      this._postButton();
      this._postMessage({
        type: "set_changes",
        branch: "Offline",
        turnFiles: null,
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      });
      return;
    }

    try {
      const [statusRes, numstatRes] = await Promise.all([
        this._rpcClient.call<GitStatusResult>("git.status", { project_path: ws }),
        this._rpcClient.call<DiffNumstatResult>("git.diff_numstat", { project_path: ws }),
      ]);

      if (this._isDisposed || version !== this._refreshVersion) return;
      this._repositoryRoot = statusRes?.repository_root || ws;

      if (!statusRes?.is_git) {
        this._isGit = false;
        this._files = [];
        this._postButton();
        this._postMessage({
          type: "set_changes",
          branch: "Not a Git repository",
          turnFiles: null,
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
        });
        return;
      }

      const filesMap = new Map<string, ReviewFile>();
      const numstats = numstatRes.files;

      // Process modified files
      for (const m of statusRes.modified_files || []) {
        const norm = m.replace(/\\/g, "/");
        const stats = numstats[norm] || { additions: 0, deletions: 0 };
        const entry = statusRes.files?.find(file => file.path === norm);
        const original = typeof entry?.original_path === "string" ? entry.original_path.replace(/\\/g, "/") : undefined;
        filesMap.set(norm, {
          path: norm,
          name: path.basename(norm),
          status: entry?.status || "M",
          additions: stats.additions,
          deletions: stats.deletions,
          binary: stats.binary,
          omitted: stats.omitted,
          originalPath: original && original !== norm ? original : undefined,
        });
      }

      // Process untracked files
      for (const u of statusRes.untracked_files || []) {
        const norm = u.replace(/\\/g, "/");
        const stats = numstats[norm] || { additions: 0, deletions: 0 };
        filesMap.set(norm, {
          path: norm,
          name: path.basename(norm),
          status: "U",
          additions: stats.additions,
          deletions: stats.deletions,
          binary: stats.binary,
          omitted: stats.omitted,
        });
      }

      // Any files in numstat that might not be in status
      for (const [norm, stats] of Object.entries(numstats)) {
        if (!filesMap.has(norm)) {
          filesMap.set(norm, {
            path: norm,
            name: path.basename(norm),
            status: "D",
            additions: stats.additions,
            deletions: stats.deletions,
            binary: stats.binary,
            omitted: stats.omitted,
          });
        }
      }

      const files = Array.from(filesMap.values()).sort((a, b) => a.path.localeCompare(b.path));

      this._knownFiles = new Set(files.map(file => file.path));
      this._deletedFiles = new Set(files.filter(file => file.status === "D").map(file => file.path));
      let totalAdditions = 0;
      let totalDeletions = 0;
      for (const f of files) {
        totalAdditions += f.additions;
        totalDeletions += f.deletions;
      }

      const turnFiles = this._turnFiles?.map(file => path.relative(this._repositoryRoot || ws,
        path.isAbsolute(file) ? file : path.join(ws, file)).replace(/\\/g, "/")) || null;
      this._files = files;
      this._turnFilesRel = turnFiles;
      this._isGit = true;
      if (statusRes.branch?.toLowerCase() === SNAPSHOT_BRANCH) void warnIfOnSnapshotBranch();
      this._postMessage({
        type: "set_changes",
        branch: statusRes.branch || "HEAD",
        files,
        totalAdditions,
        totalDeletions,
        selectFile: selectFilePath,
        auto,
        turnFiles,
      });
      await this._postButton();
      this._pr.filesChanged();
      void this._loadTurnChanges();
      if (this._openPullRequestWhenReady && files.length) {
        this._openPullRequestWhenReady = false;
        this._postMessage({ type: "pr_request_open" });
      }
    } catch (e: any) {
      if (this._isDisposed) return;
      if (version !== this._refreshVersion) return;
      this._postMessage({ type: "review_error", error: "Unable to load changes. Check workspace trust and the daemon connection, then refresh." });
    }
  }

  public async loadFileDiff(filePath: string) {
    if (this._isDisposed || !this._knownFiles.has(filePath)) return;
    const version = ++this._diffVersion;
    const ws = this._repositoryRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !this._rpcClient) {
      this._postMessage({ type: "set_file_diff", filePath, notice: "Reconnect the daemon to view this diff.", diff: "" });
      return;
    }
    try {
      const res = await this._rpcClient.call<{ diff: string; notice?: string }>("git.file_diff", {
        project_path: this._projectPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, path: filePath,
      });
      if (version !== this._diffVersion || this._isDisposed) return;
      this._postMessage({ type: "set_file_diff", filePath, diff: res.diff || "", notice: res.notice || "" });
    } catch {
      if (version !== this._diffVersion) return;
      this._postMessage({ type: "set_file_diff", filePath, diff: "", notice: "Unable to load this diff. Refresh and try again." });
    }
  }

  /** The turn's own file list, read from its before and after snapshots, so it outlives commits and pushes. */
  private async _loadTurnChanges() {
    const seq = ++this._turnSeq;
    const turn = this._turn;
    const rpc = this._rpcClient;
    if (!turn || turn.turnIndex === null || !rpc || this._isDisposed) {
      if (this._turnView) {
        this._turnView = null;
        this._postMessage({ type: "set_turn_changes", turnView: null });
      }
      return;
    }
    let files: TurnViewFile[] | null = null;
    try {
      const res = await rpc.call<{ success?: boolean; files?: unknown }>("git.turn_changes", {
        session_id: turn.sessionId, project_path: this._projectPath, turn_index: turn.turnIndex,
      });
      files = res?.success ? readTurnFiles(res.files) : null;
    } catch {
      files = null;
    }
    if (seq !== this._turnSeq || this._isDisposed) return;
    this._turnView = files ? { turnIndex: turn.turnIndex, files } : null;
    this._postMessage({ type: "set_turn_changes", turnView: this._turnView });
  }

  /** Puts one file back to how it was before the turn, keeping edits made before it. */
  private async _revertTurnFile(filePath: string) {
    const view = this._turnView;
    const turn = this._turn;
    const file = view?.files.find((entry) => entry.path === filePath);
    if (!view || !turn || turn.turnIndex !== view.turnIndex || !file || file.now !== "uncommitted") return;
    if (!this._rpcClient) {
      vscode.window.showErrorMessage("Reconnect the daemon before undoing changes.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Undo turn ${view.turnIndex + 1}'s change to "${filePath}"? The file goes back to how it was before that turn; your own edits from before it stay.`,
      { modal: true }, "Undo Turn's Change");
    if (confirm !== "Undo Turn's Change") return;
    try {
      const res = await this._rpcClient.call<{ success?: boolean; error?: string }>("git.turn_revert_file", {
        session_id: turn.sessionId, project_path: this._projectPath, turn_index: view.turnIndex, path: filePath,
      });
      if (!res?.success) {
        vscode.window.showWarningMessage(typeof res?.error === "string" ? res.error : "The turn's change couldn't be undone.");
      }
      void vscode.commands.executeCommand("git.refresh");
    } catch {
      vscode.window.showErrorMessage("The turn's change couldn't be undone. Check workspace trust and wait for agent turns to finish.");
    }
    await this.loadChanges();
  }

  private async _loadTurnFileDiff(filePath: string) {
    const view = this._turnView;
    const turn = this._turn;
    if (!view || !turn || turn.turnIndex !== view.turnIndex || !view.files.some((file) => file.path === filePath) || !this._rpcClient) return;
    this._pr.markOpened(filePath);
    let res: { diff?: unknown; notice?: unknown } | null = null;
    try {
      res = await this._rpcClient.call<{ diff?: unknown; notice?: unknown }>("git.turn_file_diff", {
        session_id: turn.sessionId, project_path: this._projectPath, turn_index: view.turnIndex, path: filePath,
      });
    } catch {
      res = { diff: "", notice: "This turn's diff couldn't be read. Try again." };
    }
    if (this._isDisposed || this._turnView !== view) return;
    this._postMessage({
      type: "set_turn_file_diff", filePath,
      diff: typeof res?.diff === "string" ? res.diff : "",
      notice: typeof res?.notice === "string" ? res.notice : "",
    });
  }

  private async _openFileInEditor(filePath: string) {
    const ws = this._repositoryRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !(this._knownFiles.has(filePath) || this._turnView?.files.some((file) => file.path === filePath))) return;
    try {
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(ws, filePath);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Could not open file: ${e.message}`);
    }
  }

  private async _openNativeDiff(filePath: string, isUntracked: boolean) {
    const ws = this._repositoryRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !this._knownFiles.has(filePath)) return;
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(ws, filePath);
    const fileUri = vscode.Uri.file(absPath);
    const fileName = path.basename(filePath);

    try {
      const posixPath = absPath.replace(/\\/g, "/");
      const uriPath = posixPath.startsWith("/") ? posixPath : "/" + posixPath;
      const headUri = vscode.Uri.from({
        scheme: HEAD_SCHEME,
        path: uriPath,
        query: "ref=" + (isUntracked ? "EMPTY" : "HEAD") + "&v=" + Date.now(),
        fragment: this._projectPath || ws,
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        headUri,
        this._deletedFiles.has(filePath) ? vscode.Uri.from({ scheme: HEAD_SCHEME, path: uriPath, query: "ref=EMPTY", fragment: ws }) : fileUri,
        `${fileName} (Working Tree Diff)`
      );
    } catch {
      await vscode.window.showTextDocument(fileUri, { preview: true });
    }
  }

  private async _revertFile(filePath: string) {
    if (!this._knownFiles.has(filePath)) return;
    if (!this._rpcClient) {
      vscode.window.showErrorMessage("Reconnect the daemon before discarding changes.");
      return;
    }
    const absPath = path.join(this._repositoryRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "", filePath);
    const dirty = vscode.workspace.textDocuments?.find(doc => doc.uri.fsPath === absPath && doc.isDirty);
    if (dirty) {
      vscode.window.showWarningMessage("Save or close the unsaved editor before discarding this file's changes.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Discard all staged and unstaged changes in "${filePath}"? New files will be deleted.`,
      { modal: true }, "Discard Changes");
    if (confirm !== "Discard Changes") return;
    try {
      const res = await this._rpcClient.call<{ success: boolean }>("git.revert_file", {
        project_path: this._projectPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, path: filePath,
      });
      if (!res.success) throw new Error("discard failed");
      void vscode.commands.executeCommand("git.refresh");
      await this.loadChanges();
    } catch {
      vscode.window.showErrorMessage("Could not discard changes. Check workspace trust and wait for agent turns to finish.");
    }
  }

  private async _postButton() {
    if (this._gitAvailable === undefined && this._isGit) {
      this._gitAvailable = !("problem" in await loadGitApi());
    }
    const running = ChangesReviewPanel._agentRunning;
    this._postMessage({
      type: "pr_button",
      state: {
        visible: this._isGit && this._files.length > 0 && this._gitAvailable !== false,
        enabled: !running,
        label: currentAirGap().enabled ? "Commit" : "Create pull request",
        reason: running ? "Wait for the turn to finish. Files are still changing." : null,
      },
    });
  }

  private _postMessage(message: any) {
    if (this._isDisposed) return;
    try {
      if (this._panel) {
        this._panel.webview.postMessage(message);
      }
    } catch {}
  }

  public dispose() {
    this._isDisposed = true;
    this._pr.dispose();
    if (this._autoRefreshTimer) clearTimeout(this._autoRefreshTimer);
    ChangesReviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }
}
