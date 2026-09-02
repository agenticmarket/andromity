import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { SessionInfo } from "../server/types.js";

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    public readonly isCurrent: boolean
  ) {
    super(session.name || session.id.slice(0, 8), vscode.TreeItemCollapsibleState.None);

    const statusBadge = session.status && session.status !== "idle" ? `[${session.status}] ` : "";
    this.description = `${statusBadge}${session.message_count || 0} msgs • $${(session.cost_usd || 0).toFixed(3)}`;
    this.tooltip = `Status: ${session.status || "idle"}\nID: ${session.id}\nUpdated: ${session.updated_at || "N/A"}\nTokens: ${session.token_total || 0}`;
    this.contextValue = "sessionItem";

    if (session.status === "running") {
      this.iconPath = new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.yellow"));
    } else if (session.status === "error") {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    } else if (session.status === "approval_required") {
      this.iconPath = new vscode.ThemeIcon("shield", new vscode.ThemeColor("charts.orange"));
    } else {
      this.iconPath = new vscode.ThemeIcon(isCurrent ? "pass-filled" : "comment");
    }

    this.command = {
      command: "andromity.switchSessionById",
      title: "Switch Session",
      arguments: [session.id],
    };
  }
}

export class SessionGroupItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly groupType: "main" | "subagents",
    public readonly count: number
  ) {
    super(
      label,
      groupType === "main"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon(
      groupType === "main" ? "comment-discussion" : "hubot"
    );
    this.contextValue = "sessionGroup";
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
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

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this._rpcClient) {
      return [];
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const allSessions = await this._rpcClient.call<SessionInfo[]>("session.list", {
        project_path: workspaceFolder,
        include_subagents: true,
      }) || [];

      const mainSessions = allSessions.filter((s) => !s.parent_session);
      const subagentSessions = allSessions.filter((s) => !!s.parent_session);

      if (!element) {
        if (subagentSessions.length === 0) {
          return mainSessions.map((s) => new SessionTreeItem(s, s.id === this._currentSessionId));
        }
        return [
          new SessionGroupItem("Main Sessions", "main", mainSessions.length),
          new SessionGroupItem("Background & Subagents", "subagents", subagentSessions.length),
        ];
      }

      if (element instanceof SessionGroupItem) {
        const targetList = element.groupType === "main" ? mainSessions : subagentSessions;
        return targetList.map((s) => new SessionTreeItem(s, s.id === this._currentSessionId));
      }

      return [];
    } catch (e) {
      return [];
    }
  }
}
