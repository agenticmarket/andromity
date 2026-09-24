import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { SessionInfo } from "../server/types.js";

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffSecs = Math.max(0, Math.floor(diffMs / 1000));
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1 || diffSecs < 60) return "now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return "1d ago";
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return `${weeks}w ago`;
    }
    if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      return `${months}mo ago`;
    }
    const years = Math.floor(diffDays / 365);
    return `${years}y ago`;
  } catch {
    return "";
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    public readonly isCurrent: boolean,
    public readonly hasChildren: boolean = false,
    public readonly isSubsession: boolean = false
  ) {
    super(
      session.name || session.id.slice(0, 8),
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    const statusBadge = session.status && session.status !== "idle" && session.status !== "running" ? `[${session.status}] ` : "";
    const prefix = isSubsession ? "Subagent • " : "";
    const timeAgo = formatRelativeTime(session.updated_at || session.created_at);
    const timePart = timeAgo ? `${timeAgo} • ` : "";
    this.description = `${prefix}${statusBadge}${timePart}${session.message_count || 0} msgs • $${(session.cost_usd || 0).toFixed(3)}`;
    this.tooltip = `Status: ${session.status || "idle"}\nID: ${session.id}\nUpdated: ${session.updated_at || "N/A"}\nTokens: ${session.token_total || 0}`;
    this.contextValue = isSubsession ? "subsessionItem" : "sessionItem";

    if (session.status === "running") {
      this.iconPath = new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.blue"));
    } else if (session.status === "error") {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    } else if (session.status === "approval_required") {
      this.iconPath = new vscode.ThemeIcon("shield", new vscode.ThemeColor("charts.orange"));
    } else if (isSubsession) {
      this.iconPath = new vscode.ThemeIcon("hubot", new vscode.ThemeColor("charts.purple"));
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

      // Map parent_session -> children
      const subagentMap = new Map<string, SessionInfo[]>();
      const mainSessions: SessionInfo[] = [];

      for (const s of allSessions) {
        if (s.parent_session) {
          if (!subagentMap.has(s.parent_session)) {
            subagentMap.set(s.parent_session, []);
          }
          subagentMap.get(s.parent_session)!.push(s);
        } else {
          mainSessions.push(s);
        }
      }

      if (!element) {
        // Root level: Return main sessions (and orphaned subs if any)
        const mainIds = new Set(mainSessions.map(s => s.id));
        const rootItems: vscode.TreeItem[] = mainSessions.map(s => {
          const subs = subagentMap.get(s.id) || [];
          return new SessionTreeItem(s, s.id === this._currentSessionId, subs.length > 0, false);
        });

        // Add orphaned subagents as root items
        for (const [pId, subs] of subagentMap.entries()) {
          if (!mainIds.has(pId)) {
            for (const orphan of subs) {
              rootItems.push(new SessionTreeItem(orphan, orphan.id === this._currentSessionId, false, true));
            }
          }
        }

        return rootItems;
      }

      if (element instanceof SessionTreeItem) {
        const subs = subagentMap.get(element.session.id) || [];
        return subs.map(s => new SessionTreeItem(s, s.id === this._currentSessionId, false, true));
      }

      return [];
    } catch (e) {
      return [];
    }
  }
}
