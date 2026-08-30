import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";

export class CronTreeItem extends vscode.TreeItem {
  constructor(public readonly job: any) {
    super(job.name || job.schedule || "Scheduled Task", vscode.TreeItemCollapsibleState.None);

    const isEnabled = job.enabled !== false;
    this.description = `${job.schedule || "cron"} • ${isEnabled ? "active" : "paused"}`;
    this.tooltip = `Prompt: ${job.prompt || ""}\nSchedule: ${job.schedule || ""}`;
    this.iconPath = new vscode.ThemeIcon(isEnabled ? "clock" : "debug-pause");
    this.contextValue = "cronJobItem";
  }
}

export class CronTreeProvider implements vscode.TreeDataProvider<CronTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CronTreeItem | undefined | null | void>();
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

  getTreeItem(element: CronTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CronTreeItem): Promise<CronTreeItem[]> {
    if (element || !this._rpcClient) {
      return [];
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const jobs = await this._rpcClient.call<any[]>("cron.list", {
        project_path: workspaceFolder,
      });

      return (jobs || []).map((j) => new CronTreeItem(j));
    } catch (e) {
      return [];
    }
  }
}
