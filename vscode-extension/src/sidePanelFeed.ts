import * as vscode from "vscode";
import { RpcClient } from "./server/RpcClient.js";
import { loadSidePanelData, mcpTooltip, SidePanelPart } from "./sidePanelData.js";

/** Commands the session panel's Environment card may run. Anything else from a webview is ignored. */
export const SIDE_PANEL_COMMANDS: ReadonlySet<string> = new Set(["git.checkout", "workbench.view.explorer", "andromity.toggleAirGap"]);

export function runSidePanelCommand(command: unknown): boolean {
  if (typeof command !== "string" || !SIDE_PANEL_COMMANDS.has(command)) return false;
  void vscode.commands.executeCommand(command);
  return true;
}

/** Sends MCP status and uncommitted changes to one chat webview (the sidebar or a pop-out tab), debounced. */
export class SidePanelFeed {
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private readonly _parts = new Set<SidePanelPart>();

  constructor(
    private readonly _rpc: () => RpcClient | null | undefined,
    private readonly _post: (message: unknown) => void,
  ) {}

  refresh(parts: SidePanelPart[] = ["mcp", "changes"]): void {
    for (const part of parts) this._parts.add(part);
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => void this._send(), 300);
  }

  dispose(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = undefined;
  }

  private async _send(): Promise<void> {
    this._timer = undefined;
    const wanted = [...this._parts];
    this._parts.clear();
    const rpc = this._rpc();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!rpc || !folder) return;
    const data = await loadSidePanelData(rpc, folder.uri.fsPath, wanted);
    this._post({
      type: "side_panel_data", ...data, folder: folder.name,
      mcpTooltip: data.mcp ? mcpTooltip(data.mcp) : undefined,
    });
  }
}
