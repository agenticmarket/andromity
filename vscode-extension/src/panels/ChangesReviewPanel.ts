import * as vscode from "vscode";
import * as path from "path";
import { RpcClient } from "../server/RpcClient.js";
import { HEAD_SCHEME } from "../integrations/DiffManager.js";
import { getReviewHtml } from "../providers/changesReview/reviewHtml.js";

import { GitStatusResult, DiffNumstatResult, ReviewFile } from "../providers/changesReview/types.js";

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

  public setTurnFiles(files?: string[]) {
    this._turnFiles = files;
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    rpcClient: RpcClient | null,
    initialFilePath?: string,
    turnFiles?: string[]
  ): ChangesReviewPanel {
    const column = vscode.window.activeTextEditor
      ? (vscode.window.activeTextEditor.viewColumn || vscode.ViewColumn.Active)
      : vscode.ViewColumn.One;

    if (ChangesReviewPanel.currentPanel) {
      ChangesReviewPanel.currentPanel._panel.reveal(column);
      ChangesReviewPanel.currentPanel._rpcClient = rpcClient;
      ChangesReviewPanel.currentPanel._turnFiles = turnFiles;
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
        localResourceRoots: [
          extensionUri,
          ...(vscode.workspace.workspaceFolders?.map((ws) => ws.uri) || []),
        ],
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

    this._panel.webview.html = getReviewHtml(this._panel.webview, this._extensionUri);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case "webview_ready":
            await this.loadChanges(this._initialFilePath);
            break;

          case "get_file_diff":
            if (message.filePath) {
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

  public async loadChanges(selectFilePath?: string) {
    if (this._isDisposed) return;
    const version = ++this._refreshVersion;
    ++this._diffVersion;
    const ws = this._projectPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !this._rpcClient) {
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
        filesMap.set(norm, {
          path: norm,
          name: path.basename(norm),
          status: statusRes.files?.find(file => file.path === norm)?.status || "M",
          additions: stats.additions,
          deletions: stats.deletions,
          binary: stats.binary,
          omitted: stats.omitted,
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

      this._postMessage({
        type: "set_changes",
        branch: statusRes.branch || "HEAD",
        files,
        totalAdditions,
        totalDeletions,
        selectFile: selectFilePath,
        turnFiles: this._turnFiles?.map(file => path.relative(this._repositoryRoot || ws,
          path.isAbsolute(file) ? file : path.join(ws, file)).replace(/\\/g, "/")) || null,
      });
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

  private async _openFileInEditor(filePath: string) {
    const ws = this._repositoryRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !this._knownFiles.has(filePath)) return;
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
    ChangesReviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }
}
