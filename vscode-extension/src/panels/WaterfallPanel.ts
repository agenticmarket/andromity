import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { getWaterfallHtml } from "../providers/waterfall/waterfallHtml.js";

export class WaterfallTraceStore {
  private static _buffers = new Map<string, any[]>();
  private static _client: RpcClient | null = null;
  private static _disposables: Array<() => void> = [];

  public static init(client: RpcClient) {
    if (WaterfallTraceStore._client === client) return;
    WaterfallTraceStore.dispose();
    WaterfallTraceStore._client = client;

    const record = (sessionId: string, msg: any) => {
      if (!sessionId) return;
      let buf = WaterfallTraceStore._buffers.get(sessionId);
      if (!buf) {
        buf = [];
        WaterfallTraceStore._buffers.set(sessionId, buf);
      }
      buf.push(msg);
      if (buf.length > 500) {
        buf.shift();
      }
    };

    const bind = (event: string, msgType: string, getSid?: (p: any) => string) => {
      const handler = (params: any) => {
        const sid = getSid ? getSid(params) : (params?.session_id || "");
        if (sid) {
          record(sid, { type: msgType, ...params });
        }
      };
      client.on(event, handler);
      WaterfallTraceStore._disposables.push(() => client.off(event, handler));
    };

    bind("agent/started", "agent_started");
    bind("waterfall/llmStart", "waterfall_llm_start");
    bind("waterfall/llmEnd", "waterfall_llm_end");
    bind("agent/toolStart", "tool_start");
    bind("agent/toolDelta", "tool_delta");
    bind("agent/toolResult", "tool_result");
    bind("agent/done", "agent_done");
    bind("agent/cancelled", "agent_cancelled");
    bind("agent/error", "agent_error");
    bind("agent/toolApprovalRequired", "tool_approval_required");
    bind("agent/askQuestions", "agent_ask_questions");
    bind("agent/thinkingDelta", "thinking_delta");
    bind("agent/textDelta", "text_delta");
    bind("session/compacting", "session_compacting");
    bind("session/compacted", "session_compacted");
    bind("subagent/spawned", "subagent_spawned");
    bind("subagent/progress", "subagent_progress");
    bind("subagent/done", "subagent_done");
    bind("subagent/failed", "subagent_failed");
    bind("session/messageReceived", "session_message_received", (p) => p?.to_session_id || p?.from_session_id);
    bind("session/questionReceived", "session_question_received", (p) => p?.to_session_id || p?.from_session_id);
    bind("session/answerReceived", "session_answer_received", (p) => p?.to_session_id || p?.from_session_id);
    bind("session/sharedStateChanged", "session_shared_state_changed");
    bind("session/handoffWritten", "session_handoff_written", (p) => p?.to_session_id || p?.from_session_id);
  }

  public static getEvents(sessionId: string): any[] {
    return WaterfallTraceStore._buffers.get(sessionId) || [];
  }

  public static clearSession(sessionId: string) {
    WaterfallTraceStore._buffers.delete(sessionId);
  }

  public static dispose() {
    for (const d of WaterfallTraceStore._disposables) {
      try { d(); } catch {}
    }
    WaterfallTraceStore._disposables = [];
    WaterfallTraceStore._client = null;
  }
}

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
    if (rpcClient) {
      WaterfallTraceStore.init(rpcClient);
    }
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
    WaterfallTraceStore.init(client);
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
        const bufferedEvents = WaterfallTraceStore.getEvents(this._sessionId);
        if (bufferedEvents && bufferedEvents.length > 0) {
          for (const ev of bufferedEvents) {
            this._postMessage(ev);
          }
        } else if (this._rpcClient) {
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
