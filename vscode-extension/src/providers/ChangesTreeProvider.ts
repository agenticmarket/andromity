import * as path from "path";
import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";

interface GitStatusInfo {
  is_git: boolean;
  branch: string | null;
  dirty: boolean;
  untracked_files: string[];
  modified_files: string[];
}

export class ChangeTreeItem extends vscode.TreeItem {
  public readonly filePath: string;
  public readonly isUntracked: boolean;

  constructor(
    filePath: string,
    isUntracked: boolean,
    workspaceRoot: string
  ) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    this.filePath = filePath;
    this.isUntracked = isUntracked;

    this.description = isUntracked
      ? "Untracked"
      : vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false);
    this.contextValue = isUntracked ? "untrackedChange" : "modifiedChange";
    this.iconPath = new vscode.ThemeIcon(isUntracked ? "diff-added" : "diff-modified");
    this.tooltip = new vscode.MarkdownString(
      isUntracked
        ? `**${filePath}**\n\nNew file not yet tracked by git.`
        : `**${filePath}**\n\nModified vs. HEAD. Click to open diff editor.`
    );
    this.command = {
      command: "andromity.openFileDiff",
      title: "Open Diff",
      arguments: [filePath, isUntracked],
    };
  }
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ChangeTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _rpcClient: RpcClient | null = null;

  constructor() {}

  public setRpcClient(client: RpcClient) {
    this._rpcClient = client;
    this.refresh();
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ChangeTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ChangeTreeItem): Promise<ChangeTreeItem[]> {
    if (element || !this._rpcClient) return [];

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return [];

    try {
      const status = await this._rpcClient.call<GitStatusInfo>("git.status", {
        project_path: ws.uri.fsPath,
      });
      if (!status?.is_git) return [];

      const items = [
        ...status.modified_files.map((f) => new ChangeTreeItem(path.join(ws.uri.fsPath, f), false, ws.uri.fsPath)),
        ...status.untracked_files.map((f) => new ChangeTreeItem(path.join(ws.uri.fsPath, f), true, ws.uri.fsPath)),
      ];
      return items;
    } catch (e) {
      return [];
    }
  }

  /** Branch label shown as the tree's root message via view/title tooltip. */
  public async getBranchLabel(): Promise<string> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws || !this._rpcClient) return "";
    try {
      const status = await this._rpcClient.call<GitStatusInfo>("git.status", {
        project_path: ws.uri.fsPath,
      });
      if (!status?.is_git) return "";
      return `${status.branch || "HEAD"}${status.dirty ? " •" : ""}`;
    } catch (e) {
      return "";
    }
  }
}
