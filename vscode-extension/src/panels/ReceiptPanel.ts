import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "../server/RpcClient.js";
import { allowOpenPath } from "../server/securityPolicy.js";
import { getReceiptHtml, readResponse } from "../providers/receipt/receiptView.js";
import type { ReceiptReadyEvent, ReceiptResponse } from "../providers/receipt/types.js";

const RENDER_FAILED = "This receipt could not be shown. Try again, or open the latest turn.";

export class ReceiptPanel {
  public static readonly viewType = "andromity.receipt";
  private static _panels = new Map<string, ReceiptPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _sessionId: string;
  private _sessionName: string;
  private _rpcClient: RpcClient | null;
  /** The turn shown; null follows the latest finished turn. */
  private _turn: number | null;
  private _response: ReceiptResponse | null = null;
  private _turns: number[] = [];
  private _loading = false;
  private _loadSeq = 0;
  private _disposed = false;
  private _disposables: vscode.Disposable[] = [];
  private _rpcDisposables: Array<() => void> = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    sessionId: string,
    sessionName: string,
    rpcClient: RpcClient | null,
    turnIndex: number | null = null,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active
  ): ReceiptPanel {
    const existing = ReceiptPanel._panels.get(sessionId);
    if (existing) {
      if (rpcClient && existing._rpcClient !== rpcClient) existing._setRpcClient(rpcClient);
      if (sessionName) {
        existing._sessionName = sessionName;
        existing._panel.title = `Receipt: ${sessionName}`;
      }
      existing._panel.reveal(viewColumn);
      existing._turn = turnIndex;
      void existing._load();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      ReceiptPanel.viewType,
      `Receipt: ${sessionName || "Session"}`,
      viewColumn,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [extensionUri] }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "sidebar-icon.svg");
    const instance = new ReceiptPanel(panel, sessionId, sessionName, rpcClient, turnIndex);
    ReceiptPanel._panels.set(sessionId, instance);
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    sessionId: string,
    sessionName: string,
    rpcClient: RpcClient | null,
    turnIndex: number | null
  ) {
    this._panel = panel;
    this._sessionId = sessionId;
    this._sessionName = sessionName || "Session";
    this._rpcClient = rpcClient;
    this._turn = turnIndex;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage((message) => this._handleMessage(message), null, this._disposables);
    this._bindRpcEvents();
    void this._load();
  }

  private _setRpcClient(client: RpcClient) {
    this._disposeRpcEvents();
    this._rpcClient = client;
    this._bindRpcEvents();
  }

  private _bindRpcEvents() {
    if (!this._rpcClient) return;
    const client = this._rpcClient;
    const handler = (params: ReceiptReadyEvent) => {
      if (params?.session_id !== this._sessionId) return;
      if (this._turn === null || this._turn === params.turn_index) void this._load();
    };
    client.on("receipt/ready", handler);
    this._rpcDisposables.push(() => client.off("receipt/ready", handler));
  }

  private _disposeRpcEvents() {
    for (const dispose of this._rpcDisposables) {
      try { dispose(); } catch {}
    }
    this._rpcDisposables = [];
  }

  private _render() {
    if (this._disposed) return;
    const state = () => ({
      sessionName: this._sessionName,
      response: this._response,
      loading: this._loading,
      turns: this._turns,
      pinned: this._turn !== null,
    });
    try {
      this._panel.webview.html = getReceiptHtml(this._panel.webview, state());
    } catch {
      this._response = { success: false, error: RENDER_FAILED };
      this._panel.webview.html = getReceiptHtml(this._panel.webview, state());
    }
  }

  /** The receipt on screen, only when it is the one asked for and nothing newer is loading. */
  private _shownReceipt() {
    const receipt = this._response?.success ? this._response.receipt : undefined;
    if (!receipt || this._loading) return undefined;
    return this._turn === null || receipt.turn_index === this._turn ? receipt : undefined;
  }

  private async _load(): Promise<void> {
    if (this._disposed) return;
    const seq = ++this._loadSeq;
    const shown = this._response?.success ? this._response.receipt?.turn_index : undefined;
    if (this._turn !== null && shown !== this._turn) this._response = null;
    this._loading = true;
    this._render();
    let raw: unknown;
    if (!this._rpcClient) {
      raw = { success: false, error: "Andromity's engine is not running. Restart it, then try again." };
    } else {
      try {
        const params: Record<string, unknown> = {
          session_id: this._sessionId,
          project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        };
        if (this._turn !== null) params.turn_index = this._turn;
        raw = await this._rpcClient.call<unknown>("session.receipt", params);
      } catch {
        raw = { success: false, error: "The receipt could not be loaded. Try again." };
      }
    }
    if (seq !== this._loadSeq) return;
    this._response = readResponse(raw);
    if (this._response.success && this._response.turns?.length) this._turns = this._response.turns;
    this._loading = false;
    this._render();
  }

  private async _handleMessage(message: any) {
    switch (message?.type) {
      case "turn": {
        const turn = message.turnIndex;
        if (Number.isSafeInteger(turn) && turn >= 0) {
          this._turn = turn;
          await this._load();
        }
        break;
      }
      case "latest":
        this._turn = null;
        await this._load();
        break;
      case "refresh":
        await this._load();
        break;
      case "open_file":
        await this._openFile(message.path);
        break;
      case "copy_text":
      case "copy_markdown": {
        const markdown = message.type === "copy_markdown";
        const text = this._shownReceipt() ? (markdown ? this._response?.markdown : this._response?.text) : undefined;
        if (typeof text === "string" && text) {
          await vscode.env.clipboard.writeText(text);
          void vscode.window.showInformationMessage(markdown ? "Receipt copied as Markdown." : "Receipt copied as text.");
        }
        break;
      }
      case "export_json":
        await this._exportJson();
        break;
    }
  }

  /** Open a file named in the receipt by its real path, so links and junctions can't skip the workspace check. */
  private async _openFile(requested: unknown) {
    if (typeof requested !== "string" || !requested || requested.includes("\0") || requested.length > 4096) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!path.isAbsolute(requested) && !root) return;
    const candidate = path.isAbsolute(requested) ? requested : path.resolve(root as string, requested);
    let real: string;
    let realRoot: string | undefined;
    try {
      real = await fs.promises.realpath(candidate);
      realRoot = root ? await fs.promises.realpath(root) : undefined;
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${requested}. It may have been moved or deleted.`);
      return;
    }
    const relative = realRoot ? path.relative(realRoot, real) : "";
    const inside = Boolean(realRoot) && relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    if (!(await allowOpenPath(inside ? path.join(root as string, relative) : real))) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(real));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${requested}. It may have been moved or deleted.`);
    }
  }

  private async _exportJson() {
    const receipt = this._shownReceipt();
    if (!receipt) return;
    const safeId = this._sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "session";
    const fileName = `receipt-${safeId}-turn-${Math.trunc(receipt.turn_index) + 1}.json`;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : vscode.Uri.file(path.join(os.homedir(), fileName)),
      filters: { JSON: ["json"] },
    });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(receipt, null, 2) + "\n", "utf8"));
      void vscode.window.showInformationMessage(`Receipt saved to ${target.fsPath}`);
    } catch {
      void vscode.window.showErrorMessage("The receipt could not be saved there. Choose another folder.");
    }
  }

  public dispose() {
    this._disposed = true;
    ReceiptPanel._panels.delete(this._sessionId);
    this._disposeRpcEvents();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}
