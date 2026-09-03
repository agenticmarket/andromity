import * as path from "path";
import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";

export const HEAD_SCHEME = "andromity-head";

/**
 * Serves file contents from an arbitrary git ref through the Andromity daemon.
 * Used as the "left" side of vscode.diff editors (GitLens-style).
 */
export class GitRefContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private _rpcClient: RpcClient) {}

  /** Swap the daemon client without re-registering the provider (reconnect-safe). */
  public setRpcClient(rpcClient: RpcClient): void {
    this._rpcClient = rpcClient;
  }

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // uri: andromity-head:/abs/path/to/file?ref=HEAD#projectPath
    const filePath = uri.fsPath || uri.path;
    const ref = uri.query.replace(/^ref=/, "") || "HEAD";
    const projectPath = uri.fragment || undefined;
    return this._rpcClient
      .call<{ content: string }>("git.show_file", {
        path: filePath,
        ref,
        project_path: projectPath,
      })
      .then((res) => res.content || "")
      .catch(() => "");
  }
}

interface GitStatusInfo {
  is_git: boolean;
  branch: string | null;
  dirty: boolean;
  untracked_files: string[];
  modified_files: string[];
}

export class DiffManager {
  private _rpcClient: RpcClient;
  private _provider: GitRefContentProvider;
  private _providerRegistration: vscode.Disposable;

  constructor(rpcClient: RpcClient, context: vscode.ExtensionContext) {
    this._rpcClient = rpcClient;
    this._provider = new GitRefContentProvider(rpcClient);
    this._providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
      HEAD_SCHEME,
      this._provider
    );
    context.subscriptions.push(this._providerRegistration);
  }

  /** Update to a freshly connected daemon client without registering a new
   *  content provider (each registration leaks — old ones are never disposed). */
  public setRpcClient(rpcClient: RpcClient): void {
    this._rpcClient = rpcClient;
    this._provider.setRpcClient(rpcClient);
  }

  private _workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  /** Full working-tree diff as a read-only document. */
  public async showGitDiff(): Promise<void> {
    const ws = this._workspaceFolder();
    if (!ws) {
      vscode.window.showInformationMessage("Open a workspace folder to view git diffs.");
      return;
    }

    try {
      const res = await this._rpcClient.call<{ diff: string }>("git.diff", {
        project_path: ws.uri.fsPath,
      });

      if (!res.diff) {
        vscode.window.showInformationMessage("No changes detected in the working tree.");
        return;
      }

      const doc = await vscode.workspace.openTextDocument({
        content: res.diff,
        language: "diff",
      });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to get git diff: ${e.message}`);
    }
  }

  /** Open a native two-way diff editor for a single file vs. HEAD. */
  public async showFileDiff(filePath: string, isUntracked: boolean = false): Promise<void> {
    const ws = this._workspaceFolder();
    if (!ws) return;

    const rightUri = vscode.Uri.file(filePath);
    const fileName = path.basename(filePath);

    if (isUntracked) {
      // No HEAD version exists — show empty file vs. working copy.
      const leftUri = vscode.Uri.from({
        scheme: HEAD_SCHEME,
        path: filePath,
        query: "ref=EMPTY",
        fragment: ws.uri.fsPath,
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        leftUri,
        rightUri,
        `${fileName} (Untracked) ↔ Working Copy`,
        { preview: true }
      );
      return;
    }

    const leftUri = vscode.Uri.from({
      scheme: HEAD_SCHEME,
      path: filePath,
      query: "ref=HEAD",
      fragment: ws.uri.fsPath,
    });
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (HEAD) ↔ Working Copy`,
      { preview: true }
    );
  }

  /** QuickPick letting the user choose a changed file to diff. */
  public async pickAndShowFileDiff(): Promise<void> {
    const ws = this._workspaceFolder();
    if (!ws) return;

    try {
      const status = await this._rpcClient.call<GitStatusInfo>("git.status", {
        project_path: ws.uri.fsPath,
      });
      if (!status?.is_git) {
        vscode.window.showInformationMessage("This workspace is not a git repository.");
        return;
      }

      const items = [
        ...status.modified_files.map((f) => ({ label: `$(diff-multiple) ${f}`, file: f, untracked: false })),
        ...status.untracked_files.map((f) => ({ label: `$(diff-added) ${f}`, file: f, untracked: true })),
      ];
      if (items.length === 0) {
        vscode.window.showInformationMessage("No file changes detected.");
        return;
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a changed file to view its diff",
      });
      if (picked) {
        await this.showFileDiff(path.join(ws.uri.fsPath, picked.file), picked.untracked);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to list changes: ${e.message}`);
    }
  }

  public async undoLastTurn(sessionId: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      "Undo last turn and rollback all file modifications made in that turn?",
      { modal: true },
      "Yes, Rollback",
      "Cancel"
    );

    if (confirm !== "Yes, Rollback") return;

    try {
      const res = await this._rpcClient.call<{ success: boolean; popped_messages: number; git_status: string }>(
        "session.undo",
        { session_id: sessionId }
      );

      if (res.success) {
        vscode.window.showInformationMessage(
          `Turn undone successfully. (${res.popped_messages} messages removed. ${res.git_status})`
        );
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to undo turn: ${e.message}`);
    }
  }
}
