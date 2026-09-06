import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { getWaterfallHtml } from "../providers/waterfall/waterfallHtml.js";

export class WaterfallPanel {
  public static readonly viewType = "andromity.waterfall";
  private static _panels = new Map<string, WaterfallPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _rpcClient: RpcClient | null;
  private readonly _context: vscode.ExtensionContext;
  private _sessionId: string;
  private _sessionName: string;
  private _disposables: vscode.Disposable[] = [];
  private _rpcDisposables: Array<() => void> = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    sessionId: string,
    sessionName: string,
    rpcClient: RpcClient | null,
    context: vscode.ExtensionContext
  ): WaterfallPanel {
    if (WaterfallPanel._panels.has(sessionId)) {
      const existing = WaterfallPanel._panels.get(sessionId)!;
      if (rpcClient && existing._rpcClient !== rpcClient) {
        existing.setRpcClient(rpcClient);
      }
      if (sessionName) {
        existing._sessionName = sessionName;
        existing._panel.title = `🌊 Waterfall: ${sessionName}`;
      }
      existing._panel.reveal(vscode.ViewColumn.Beside);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      WaterfallPanel.viewType,
      `🌊 Waterfall: ${sessionName || "Session"}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    const instance = new WaterfallPanel(
      panel,
      extensionUri,
      sessionId,
      sessionName,
      rpcClient,
      context
    );

    WaterfallPanel._panels.set(sessionId, instance);
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    sessionId: string,
    sessionName: string,
    rpcClient: RpcClient | null,
    context: vscode.ExtensionContext
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._sessionId = sessionId;
    this._sessionName = sessionName;
    this._rpcClient = rpcClient;
    this._context = context;

    this._panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "sidebar-icon.svg");

    this._panel.onDidDispose(
      () => {
        this.dispose();
      },
      null,
      this._disposables
    );

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables
    );

    this._bindRpcEvents();

    this._panel.webview.html = getWaterfallHtml(
      this._panel.webview,
      this._sessionId,
      this._sessionName,
      this._extensionUri
    );
  }

  public setRpcClient(client: RpcClient) {
    this._disposeRpcEvents();
    this._rpcClient = client;
    this._bindRpcEvents();
  }

  private _disposeRpcEvents() {
    for (const d of this._rpcDisposables) {
      try { d(); } catch {}
    }
    this._rpcDisposables = [];
  }

  private _postMessage(msg: any) {
    try {
      this._panel.webview.postMessage(msg);
    } catch {}
  }

  private _bindRpcEvents() {
    if (!this._rpcClient) return;
    const client = this._rpcClient;

    const bind = (event: string, handler: (...args: any[]) => void) => {
      client.on(event, handler);
      this._rpcDisposables.push(() => client.off(event, handler));
    };

    const isMatch = (params: any) => {
      if (!params) return true;
      if (params.session_id) return params.session_id === this._sessionId;
      return true;
    };

    bind("agent/started", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "agent_started", ...params });
    });
    bind("waterfall/llmStart", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "waterfall_llm_start", ...params });
    });
    bind("waterfall/llmEnd", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "waterfall_llm_end", ...params });
    });
    bind("agent/toolStart", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_start", ...params });
    });
    bind("agent/toolDelta", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_delta", ...params });
    });
    bind("agent/toolResult", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_result", ...params });
    });
    bind("agent/done", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "agent_done", ...params });
    });
    bind("agent/cancelled", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "agent_cancelled", ...params });
    });
    bind("agent/error", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "agent_error", ...params });
    });
    bind("agent/toolApprovalRequired", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_approval_required", ...params });
    });
    bind("agent/askQuestions", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "agent_ask_questions", ...params });
    });
    bind("agent/thinkingDelta", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "thinking_delta", ...params });
    });
    bind("agent/textDelta", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "text_delta", ...params });
    });
    bind("session/compacting", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "session_compacting", ...params });
    });
    bind("session/compacted", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "session_compacted", ...params });
    });
    bind("subagent/spawned", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "subagent_spawned", ...params });
    });
    bind("subagent/progress", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "subagent_progress", ...params });
    });
    bind("subagent/done", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "subagent_done", ...params });
    });
    bind("subagent/failed", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "subagent_failed", ...params });
    });
    const isSessionTarget = (params: any) => {
      if (!params) return false;
      const sId = this._sessionId;
      const sName = this._sessionName;
      return params.to_session_id === sId || params.to_session === sId || (sName && params.to_session === sName) ||
             params.from_session_id === sId || params.from_session === sId || (sName && params.from_session === sName) ||
             params.to_session === "all" || params.to_session === "*";
    };

    bind("session/messageReceived", (params: any) => {
      if (isSessionTarget(params)) this._postMessage({ type: "session_message_received", ...params });
    });
    bind("session/questionReceived", (params: any) => {
      if (isSessionTarget(params)) this._postMessage({ type: "session_question_received", ...params });
    });
    bind("session/answerReceived", (params: any) => {
      if (isSessionTarget(params)) this._postMessage({ type: "session_answer_received", ...params });
    });
    bind("session/sharedStateChanged", (params: any) => {
      this._postMessage({ type: "session_shared_state_changed", ...params });
    });
    bind("session/handoffWritten", (params: any) => {
      if (isSessionTarget(params)) this._postMessage({ type: "session_handoff_written", ...params });
    });
  }

  private async _handleMessage(message: any) {
    if (!message || !message.type) return;

    switch (message.type) {
      case "export_waterfall": {
        try {
          const defaultFileName = `waterfall-${this._sessionId.slice(0, 8)}-${Date.now()}.json`;
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultFileName),
            filters: { "JSON Files": ["json"] },
          });

          if (saveUri) {
            const buffer = Buffer.from(JSON.stringify(message.data, null, 2), "utf8");
            await vscode.workspace.fs.writeFile(saveUri, buffer);
            vscode.window.showInformationMessage(
              `Waterfall trace saved to ${saveUri.fsPath}`
            );
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to export waterfall: ${err.message}`);
        }
        break;
      }
      case "copy_clipboard": {
        if (message.text) {
          await vscode.env.clipboard.writeText(message.text);
        }
        break;
      }
      case "waterfall_ready": {
        if (this._rpcClient) {
          try {
            const sessionData = await this._rpcClient.call<any>("session.get", {
              session_id: this._sessionId,
            });
            if (sessionData) {
              this._postMessage({
                type: "session_history",
                session: sessionData,
              });
            }
          } catch (err: any) {
            console.error("[WaterfallPanel] Failed to fetch session history:", err);
          }
        }
        break;
      }
    }
  }

  public dispose() {
    WaterfallPanel._panels.delete(this._sessionId);
    this._disposeRpcEvents();
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        try { x.dispose(); } catch {}
      }
    }
  }
}
