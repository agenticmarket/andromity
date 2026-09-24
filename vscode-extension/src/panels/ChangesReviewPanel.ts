import * as vscode from "vscode";
import * as path from "path";
import { RpcClient } from "../server/RpcClient.js";
import { HEAD_SCHEME } from "../integrations/DiffManager.js";
import { getReviewHtml } from "../providers/changesReview/reviewHtml.js";

interface GitStatusResult {
  is_git: boolean;
  branch: string | null;
  dirty: boolean;
  untracked_files: string[];
  modified_files: string[];
}

interface DiffNumstatResult {
  files: Record<string, { additions: number; deletions: number }>;
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

  public setTurnFiles(files?: string[]) {
    this._turnFiles = files && files.length > 0 ? files : undefined;
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
      if (turnFiles !== undefined) {
        ChangesReviewPanel.currentPanel._turnFiles = turnFiles;
      }
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
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !this._rpcClient) {
      this._postMessage({
        type: "set_changes",
        branch: "detached",
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      });
      return;
    }

    try {
      const [statusRes, numstatRes] = await Promise.all([
        this._rpcClient.call<GitStatusResult>("git.status", { project_path: ws }),
        this._rpcClient.call<DiffNumstatResult>("git.diff_numstat", { project_path: ws }).catch(() => ({ files: {} })),
      ]);

      if (this._isDisposed) return;

      if (!statusRes?.is_git) {
        this._postMessage({
          type: "set_changes",
          branch: "Not a git repo",
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
        });
        return;
      }

      const filesMap = new Map<
        string,
        { path: string; name: string; status: "M" | "A" | "D" | "U"; additions: number; deletions: number }
      >();

      const numstats: Record<string, { additions: number; deletions: number }> =
        numstatRes?.files || {};

      // Process modified files
      for (const m of statusRes.modified_files || []) {
        const norm = m.replace(/\\/g, "/");
        const stats = numstats[norm] || { additions: 0, deletions: 0 };
        filesMap.set(norm, {
          path: norm,
          name: path.basename(norm),
          status: "M",
          additions: stats.additions,
          deletions: stats.deletions,
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
        });
      }

      // Any files in numstat that might not be in status
      for (const [norm, stats] of Object.entries(numstats)) {
        if (!filesMap.has(norm)) {
          filesMap.set(norm, {
            path: norm,
            name: path.basename(norm),
            status: "M",
            additions: stats.additions,
            deletions: stats.deletions,
          });
        }
      }

      const files = Array.from(filesMap.values()).sort((a, b) => a.path.localeCompare(b.path));

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
        turnFiles: this._turnFiles,
      });
    } catch (e: any) {
      if (this._isDisposed) return;
      vscode.window.showErrorMessage(`Failed to load git changes: ${e.message}`);
      this._postMessage({ type: "refresh_done" });
    }
  }

  public async loadFileDiff(filePath: string) {
    if (this._isDisposed) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws || !this._rpcClient) return;

    try {
      const res = await this._rpcClient.call<{ diff: string }>("git.file_diff", {
        project_path: ws,
        path: filePath,
      });

      let diffText = res?.diff || "";

      // If diff is empty, check if it's an untracked new file or deleted file
      if (!diffText) {
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(ws, filePath);
        try {
          const fileUri = vscode.Uri.file(absPath);
          const stat = await vscode.workspace.fs.stat(fileUri);
          if (stat && stat.type === vscode.FileType.File) {
            // Guard against massive files freezing the webview
            if (stat.size > 1_000_000) {
              diffText = `@@ -0,0 +1,1 @@\n+ [Large file (${Math.round(stat.size / 1024)} KB) - text diff omitted for performance]`;
            } else {
              const bytes = await vscode.workspace.fs.readFile(fileUri);
              let isBinary = false;
              for (let i = 0; i < Math.min(bytes.length, 4096); i++) {
                if (bytes[i] === 0) { isBinary = true; break; }
              }
              if (isBinary) {
                diffText = `@@ -0,0 +1,1 @@\n+ [Binary file - text diff omitted]`;
              } else {
                const text = new TextDecoder("utf-8").decode(bytes);
                const lines = text.split(/\r?\n/);
                const previewLines = lines.slice(0, 5000);
                diffText = `@@ -0,0 +1,${previewLines.length} @@\n` + previewLines.map((l) => `+${l}`).join("\n");
                if (lines.length > 5000) {
                  diffText += `\n+ ... [${lines.length - 5000} more lines omitted for performance]`;
                }
              }
            }
          }
        } catch {
          // File might be deleted or unreadable
        }
      }

      this._postMessage({
        type: "set_file_diff",
        filePath,
        diff: diffText,
      });
    } catch (e: any) {
      this._postMessage({
        type: "set_file_diff",
        filePath,
        diff: `Error loading diff: ${e.message}`,
      });
    }
  }

  private async _openFileInEditor(filePath: string) {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    try {
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(ws, filePath);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Could not open file: ${e.message}`);
    }
  }

  private async _openNativeDiff(filePath: string, isUntracked: boolean) {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(ws, filePath);
    const fileUri = vscode.Uri.file(absPath);
    const fileName = path.basename(filePath);

    if (isUntracked) {
      await vscode.window.showTextDocument(fileUri, { preview: true });
      return;
    }

    try {
      const posixPath = absPath.replace(/\\/g, "/");
      const uriPath = posixPath.startsWith("/") ? posixPath : "/" + posixPath;
      const headUri = vscode.Uri.from({
        scheme: HEAD_SCHEME,
        path: uriPath,
        query: `ref=HEAD`,
        fragment: ws,
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        headUri,
        fileUri,
        `${fileName} (Working Tree Diff)`
      );
    } catch {
      await vscode.window.showTextDocument(fileUri, { preview: true });
    }
  }

  private async _revertFile(filePath: string) {
    const confirm = await vscode.window.showWarningMessage(
      `Revert all local changes in "${path.basename(filePath)}"? This cannot be undone.`,
      { modal: true },
      "Revert Changes"
    );
    if (confirm !== "Revert Changes") return;

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;

    try {
      if (this._rpcClient) {
        const res = await this._rpcClient.call<{ success: boolean; action: string }>("git.revert_file", {
          project_path: ws,
          path: filePath,
        });
        if (res?.success) {
          vscode.window.showInformationMessage(`Reverted ${path.basename(filePath)}`);
          await this.loadChanges();
          return;
        }
      }

      // Fallback
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(ws, filePath);
      const uri = vscode.Uri.file(absPath);
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      vscode.window.showInformationMessage(`Reverted ${path.basename(filePath)}`);
      await this.loadChanges();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to revert file: ${e.message}`);
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
