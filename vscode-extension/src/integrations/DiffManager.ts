import * as path from "path";
import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { ChangesReviewPanel } from "../panels/ChangesReviewPanel.js";

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
    if (ref === "EMPTY") {
      return Promise.resolve("");
    }
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
  private _context: vscode.ExtensionContext;
  private _provider: GitRefContentProvider;
  private _providerRegistration: vscode.Disposable;

  constructor(rpcClient: RpcClient, context: vscode.ExtensionContext) {
    this._rpcClient = rpcClient;
    this._context = context;
    this._provider = new GitRefContentProvider(rpcClient);
    this._providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
      HEAD_SCHEME,
      this._provider
    );
    context.subscriptions.push(this._providerRegistration);
  }

  /** Open the dedicated Changes Review Webview tab. */
  public openReviewWebview(filePath?: string, turnFiles?: string[]): void {
    ChangesReviewPanel.createOrShow(this._context.extensionUri, this._rpcClient, filePath, turnFiles);
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

  /** Open a native two-way diff editor for a single file. */
  public async showFileDiff(filePath: string, isUntracked: boolean = false): Promise<void> {
    const ws = this._workspaceFolder();
    if (!ws) return;

    const absPath = path.isAbsolute(filePath) ? filePath : path.join(ws.uri.fsPath, filePath);
    const rightUri = vscode.Uri.file(absPath);
    const fileName = path.basename(absPath);

    const leftUri = vscode.Uri.from({
      scheme: HEAD_SCHEME,
      path: absPath,
      query: isUntracked ? "ref=SNAPSHOT" : "ref=HEAD",
      fragment: ws.uri.fsPath,
    });

    try {
      const headContent = await this._provider.provideTextDocumentContent(leftUri);
      if (isUntracked && !headContent) {
        const emptyLeftUri = vscode.Uri.from({
          scheme: HEAD_SCHEME,
          path: absPath,
          query: "ref=EMPTY",
          fragment: ws.uri.fsPath,
        });
        await vscode.commands.executeCommand(
          "vscode.diff",
          emptyLeftUri,
          rightUri,
          `${fileName} (New File ↔ Working Tree)`,
          { preview: true }
        );
        return;
      }

      if (!isUntracked) {
        try {
          await vscode.commands.executeCommand("git.openChange", rightUri);
          return;
        } catch {
          // fall through to custom diff provider
        }
      }

      await vscode.commands.executeCommand(
        "vscode.diff",
        leftUri,
        rightUri,
        `${fileName} (HEAD ↔ Working Tree)`,
        { preview: true }
      );
    } catch {
      await vscode.commands.executeCommand("vscode.open", rightUri);
      vscode.window.showInformationMessage(
        `Could not compute diff for '${fileName}'. Opened file directly.`
      );
    }
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

  public async undoLastTurn(sessionId: string, turnIndex?: number, turnsToUndo?: number): Promise<boolean> {
    const numTurns = turnsToUndo && turnsToUndo > 1 ? turnsToUndo : 1;
    const promptText = numTurns > 1
      ? `Undo ${numTurns} turns (rollback all file modifications made in those turns)?`
      : "Undo last turn and rollback all file modifications made in that turn?";
    const confirm = await vscode.window.showWarningMessage(
      promptText,
      { modal: true },
      "Yes, Rollback"
    );

    if (confirm !== "Yes, Rollback") return false;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    try {
      const res = await this._rpcClient.call<{
        success: boolean;
        popped_messages: number;
        turns_undone?: number;
        target_turn_index?: number;
        git_status: string;
      }>(
        "session.undo",
        {
          session_id: sessionId,
          project_path: workspaceFolder,
          turn_index: turnIndex,
          turns_to_undo: turnsToUndo,
        }
      );

      if (res.success) {
        try {
          vscode.commands.executeCommand("git.refresh");
          vscode.commands.executeCommand("andromity.refreshChanges");
        } catch {}
        const countMsg = (res.turns_undone && res.turns_undone > 1)
          ? `${res.turns_undone} turns undone`
          : "Turn undone";
        vscode.window.showInformationMessage(
          `${countMsg} successfully. (${res.popped_messages} messages removed. ${res.git_status})`
        );
        return true;
      }
      return false;
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to undo turn: ${e.message}`);
      return false;
    }
  }
}
