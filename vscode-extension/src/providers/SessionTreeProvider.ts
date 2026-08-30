import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { SessionInfo } from "../server/types.js";

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    public readonly isCurrent: boolean
  ) {
    super(session.name || session.id.slice(0, 8), vscode.TreeItemCollapsibleState.None);

    this.description = `${session.message_count || 0} msgs • $${(session.cost_usd || 0).toFixed(3)}`;
    this.tooltip = `ID: ${session.id}\nUpdated: ${session.updated_at || "N/A"}\nTokens: ${session.token_total || 0}`;
    this.contextValue = "sessionItem";
    this.iconPath = new vscode.ThemeIcon(isCurrent ? "pass-filled" : "comment");
    this.command = {
      command: "andromity.switchSessionById",
      title: "Switch Session",
      arguments: [session.id],
    };
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _rpcClient: RpcClient | null = null;
  private _currentSessionId: string = "";

  constructor() {}

  public setRpcClient(client: RpcClient) {
    this._rpcClient = client;
    this.refresh();
  }

  public setCurrentSessionId(sessionId: string) {
    this._currentSessionId = sessionId;
    this.refresh();
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    if (element || !this._rpcClient) {
      return [];
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const sessions = await this._rpcClient.call<SessionInfo[]>("session.list", {
        project_path: workspaceFolder,
      });

      return sessions.map((s) => new SessionTreeItem(s, s.id === this._currentSessionId));
    } catch (e) {
      return [];
    }
  }
}
