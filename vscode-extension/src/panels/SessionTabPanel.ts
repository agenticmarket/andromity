import * as vscode from "vscode";
import * as path from "path";
import { RpcClient } from "../server/RpcClient.js";
import { ChatViewProvider } from "../providers/ChatViewProvider.js";
import { ModelInfo, ProviderInfo, SessionInfo } from "../server/types.js";
import { EditorBridge } from "../integrations/EditorBridge.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { PlanEditorPanel } from "./PlanEditorPanel.js";

/**
 * SessionTabPanel allows opening any Andromity session in a dedicated editor tab
 * (WebviewPanel) to view and interact with multiple sessions side-by-side in parallel.
 */
export class SessionTabPanel {
  public static readonly viewType = "andromity.sessionTab";
  private static _panels = new Map<string, SessionTabPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _rpcClient: RpcClient | null;
  private readonly _context: vscode.ExtensionContext;
  private readonly _viewProvider: ChatViewProvider;
  private _sessionId: string;
  private _sessionName: string;
  private _currentMode: string = "safe";
  private _currentModel: string = "anthropic/claude-3.7-sonnet";
  private _currentProvider: string = "openrouter";
  private _currentProfile: string = "builder";
  private _currentReasoning: string = "medium";
  private _disposables: vscode.Disposable[] = [];
  private _rpcDisposables: Array<() => void> = [];

  public static getAllPanels(): SessionTabPanel[] {
    return Array.from(SessionTabPanel._panels.values());
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    sessionId: string,
    sessionName: string,
    rpcClient: RpcClient | null,
    context: vscode.ExtensionContext,
    viewProvider: ChatViewProvider
  ): SessionTabPanel {
    // If a tab for this session is already open, reveal it
    if (SessionTabPanel._panels.has(sessionId)) {
      const existing = SessionTabPanel._panels.get(sessionId)!;
      if (rpcClient && existing._rpcClient !== rpcClient) {
        existing.setRpcClient(rpcClient);
      }
      if (sessionName) {
        existing._sessionName = sessionName;
        existing._panel.title = sessionName;
      }
      existing._panel.reveal(vscode.ViewColumn.Beside);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      SessionTabPanel.viewType,
      sessionName || "Chat Session",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    const instance = new SessionTabPanel(
      panel,
      extensionUri,
      sessionId,
      sessionName,
      rpcClient,
      context,
      viewProvider
    );

    SessionTabPanel._panels.set(sessionId, instance);
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    sessionId: string,
    sessionName: string,
    rpcClient: RpcClient | null,
    context: vscode.ExtensionContext,
    viewProvider: ChatViewProvider
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._sessionId = sessionId;
    this._sessionName = sessionName;
    this._rpcClient = rpcClient;
    this._context = context;
    this._viewProvider = viewProvider;

    this._panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");

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

    // Render chat HTML with session-isolated state and hide redundant "Open in tab" icon
    let html = this._viewProvider._getHtmlForWebview(this._panel.webview, {
      currentSessionId: this._sessionId,
      currentModel: this._currentModel,
      currentProvider: this._currentProvider,
      currentMode: this._currentMode,
      currentProfile: this._currentProfile,
      currentReasoning: this._currentReasoning,
    });
    // In an editor tab, hide the redundant "Open in tab" action button in the top bar
    html = html.replace("</head>", "<style>#btn-top-open-tab { display: none !important; }</style></head>");
    this._panel.webview.html = html;
  }

  public setRpcClient(client: RpcClient) {
    this._disposeRpcEvents();
    this._rpcClient = client;
    this._bindRpcEvents();
    this._postMessage({ type: "backend_ready" });
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
    bind("agent/textDelta", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "text_delta", ...params });
    });
    bind("agent/thinkingDelta", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "thinking_delta", ...params });
    });
    bind("agent/toolStart", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_start", ...params });
    });
    bind("agent/toolDelta", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_delta", ...params });
    });
    bind("agent/toolEnd", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_end", ...params });
    });
    bind("agent/toolResult", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_result", ...params });
    });
    bind("agent/toolApprovalRequired", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "tool_approval_required", ...params });
    });
    bind("agent/askQuestions", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "ask_questions", ...params });
    });
    bind("agent/planApproval", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "plan_approval", plan: params.plan });
    });
    bind("agent/planUpdated", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "plan_updated", plan: params.plan, session_id: params.session_id });
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
    bind("agent/done", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "agent_done", ...params });
    });
    bind("agent/cancelled", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "agent_cancelled", ...params });
    });
    bind("agent/error", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "agent_error", ...params });
    });
    bind("session/compacting", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "session_compacting", ...params });
    });
    bind("session/compacted", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "session_compacted", ...params });
    });
    bind("session/updated", (params: any) => {
      if (isMatch(params)) {
        if (params.name && params.session_id === this._sessionId) {
          this._sessionName = params.name;
          this._panel.title = params.name;
        }
        this._postMessage({
          type: "session_updated",
          session_id: params.session_id,
          name: params.name,
          message_count: params.message_count,
          context_tokens: params.context_tokens,
          token_total: params.token_total,
          cost_usd: params.cost_usd,
        });
      }
    });
  }

  private async _handleMessage(message: any) {
    if (!message) return;

    if (message.type === "ready" || message.type === "webview_ready") {
      this._postMessage({ type: "backend_ready" });
      await this._loadSession();
      return;
    }

    if (message.type === "copy_clipboard") {
      if (message.text) await vscode.env.clipboard.writeText(message.text);
      return;
    }

    if (message.type === "apply_code") {
      await EditorBridge.applySnippetToEditor(message.code, message.mode || "insert_at_cursor");
      return;
    }

    if (message.type === "open_settings") {
      SettingsPanel.createOrShow(this._extensionUri, this._rpcClient, "keys");
      return;
    }

    if (message.type === "open_plan_tab") {
      PlanEditorPanel.createOrShow(this._extensionUri, null, this._rpcClient);
      return;
    }

    if (message.type === "open_file_diff") {
      if (message.filePath) {
        await this._viewProvider.openFileDiff(message.filePath, false);
      }
      return;
    }

    if (message.type === "open_diff") {
      await this._viewProvider.showGitDiff();
      return;
    }

    if (message.type === "get_editor_context") {
      const ctx = EditorBridge.getActiveContext();
      this._postMessage({ type: "editor_context", context: ctx });
      return;
    }

    if (message.type === "open_session_tab") {
      if (message.sessionId) {
        SessionTabPanel.createOrShow(
          this._extensionUri,
          message.sessionId,
          message.sessionName || "Chat Session",
          this._rpcClient,
          this._context,
          this._viewProvider
        );
      }
      return;
    }

    if (!this._rpcClient) {
      vscode.window.showErrorMessage("Andromity daemon is not connected.");
      return;
    }

    switch (message.type) {
      case "send_prompt":
      case "prompt": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          let promptText = message.prompt || "";
          const editorContext = EditorBridge.getActiveContext();
          if (message.attachContext && editorContext.selectedText) {
            promptText += `\n\n--- Context from ${editorContext.relativePath} (lines ${editorContext.selectionRange?.startLine}-${editorContext.selectionRange?.endLine}) ---\n\`\`\`${editorContext.languageId || ""}\n${editorContext.selectedText}\n\`\`\``;
          }
          const cleanModel = (message.model || this._currentModel || "").replace(/^~+/, "");
          await this._rpcClient.call("agent.prompt", {
            session_id: this._sessionId,
            prompt: promptText,
            project_path: workspaceFolder,
            profile: message.profile || this._currentProfile,
            model: cleanModel,
            provider: message.provider || this._currentProvider,
            mode: message.mode || this._currentMode,
            reasoning_effort: message.reasoningEffort || this._currentReasoning,
            image_uris: message.images || [],
          }, 120000);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Agent run failed: ${err.message}`);
          this._postMessage({ type: "agent_error", error: err.message, session_id: this._sessionId });
        }
        break;
      }

      case "cancel_turn":
      case "cancel_agent": {
        try {
          await this._rpcClient.call("agent.cancel", { session_id: this._sessionId });
        } catch {
          this._postMessage({ type: "agent_cancelled", session_id: this._sessionId });
        }
        break;
      }

      case "cycle_mode": {
        const nextMode = message.nextMode || (this._currentMode === "safe" ? "trust" : this._currentMode === "trust" ? "yolo" : "safe");
        this._currentMode = nextMode;
        this._postMessage({ type: "config_updated", key: "mode", value: nextMode });
        break;
      }

      case "select_model":
      case "update_config": {
        const key = message.key || (message.modelId ? "model" : undefined);
        const value = message.value || message.modelId;
        if (key) {
          switch (key) {
            case "model": this._currentModel = value; break;
            case "provider": this._currentProvider = value; break;
            case "profile": this._currentProfile = value; break;
            case "mode": this._currentMode = value; break;
            case "reasoningEffort": this._currentReasoning = value; break;
          }
          this._postMessage({ type: "config_updated", key: key, value: value, provider: message.provider || this._currentProvider });
        }
        break;
      }

      case "tool_approval_response": {
        await this._rpcClient.call("agent.approve_tool", {
          call_id: message.callId,
          approved: message.approved,
          reason: message.reason,
          answer: message.answer,
        }).catch((err) => console.error("[SessionTab] Tool approval error:", err));
        break;
      }

      case "plan_approval_response": {
        await this._rpcClient.call("agent.approve_plan", {
          session_id: this._sessionId,
          approved: message.approved,
          feedback: message.feedback,
        }).catch((err) => console.error("[SessionTab] Plan approval error:", err));
        break;
      }

      case "ask_question_response": {
        await this._rpcClient.call("agent.answer_questions", {
          session_id: this._sessionId,
          question_id: message.questionId,
          answers: message.answers,
        }).catch((err) => console.error("[SessionTab] Answer question error:", err));
        break;
      }

      case "switch_session": {
        if (message.sessionId && message.sessionId !== this._sessionId) {
          const oldId = this._sessionId;
          this._sessionId = message.sessionId;
          SessionTabPanel._panels.delete(oldId);
          SessionTabPanel._panels.set(this._sessionId, this);
          await this._loadSession();
        }
        break;
      }

      case "undo_turn": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const res = await this._rpcClient.call<any>("session.undo", {
          session_id: this._sessionId,
          project_path: workspaceFolder,
        }).catch(() => null);
        if (res?.success) {
          await this._loadSession();
        } else if (res?.error) {
          vscode.window.showWarningMessage(res.error);
        }
        break;
      }

      case "compact_session": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const res = await this._rpcClient.call<any>("session.compact", {
          session_id: this._sessionId,
          project_path: workspaceFolder,
        }).catch(() => null);
        if (res?.success) {
          this._postMessage({ type: "session_compacted", ...res });
          await this._loadSession();
        } else if (res?.error) {
          vscode.window.showWarningMessage(res.error);
        }
        break;
      }

      case "fetch_sessions": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const sessions = await this._rpcClient.call<SessionInfo[]>("session.list", {
          project_path: workspaceFolder,
          include_subagents: true,
        }).catch(() => []);
        this._postMessage({ type: "sessions_data", sessions, currentSessionId: this._sessionId });
        break;
      }

      case "delete_session": {
        if (message.sessionId) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("session.delete", {
            session_id: message.sessionId,
            project_path: workspaceFolder,
          }).catch(() => null);
          if (message.sessionId === this._sessionId) {
            this.dispose();
          } else {
            const sessions = await this._rpcClient.call<SessionInfo[]>("session.list", {
              project_path: workspaceFolder,
              include_subagents: true,
            }).catch(() => []);
            this._postMessage({ type: "sessions_data", sessions, currentSessionId: this._sessionId });
          }
        }
        break;
      }

      case "request_rename_session": {
        if (message.sessionId && message.name) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("session.rename", {
            session_id: message.sessionId,
            name: message.name,
            project_path: workspaceFolder,
          }).catch(() => null);
          if (message.sessionId === this._sessionId) {
            this._sessionName = message.name;
            this._panel.title = message.name;
          }
        }
        break;
      }
    }
  }

  private async _loadSession() {
    if (!this._rpcClient || !this._sessionId) return;
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const [sessionData, configData, models, providers, sessions] = await Promise.all([
        this._rpcClient.call<any>("session.get", { session_id: this._sessionId, project_path: workspaceFolder }),
        this._rpcClient.call<any>("config.get", { project_path: workspaceFolder }).catch(() => ({})),
        this._rpcClient.call<ModelInfo[]>("config.list_models", {}).catch(() => []),
        this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}).catch(() => []),
        this._rpcClient.call<SessionInfo[]>("session.list", { project_path: workspaceFolder, include_subagents: true }).catch(() => []),
      ]);

      if (sessionData && sessionData.name) {
        this._sessionName = sessionData.name;
        this._panel.title = sessionData.name;
      }

      this._currentModel = sessionData?.model || configData?.default_model || "anthropic/claude-3.7-sonnet";
      this._currentProvider = sessionData?.provider || configData?.default_provider || "openrouter";
      this._currentMode = sessionData?.mode || configData?.permission_mode || "safe";
      this._currentProfile = configData?.default_profile || "builder";
      this._currentReasoning = configData?.reasoning_effort || "medium";

      this._postMessage({
        type: "init_state",
        sessionId: this._sessionId,
        profile: this._currentProfile,
        availableProfiles: configData?.available_profiles || ["builder", "coder", "reviewer", "planner"],
        availableReasoningEfforts: configData?.available_reasoning_efforts || ["low", "medium", "high", "off"],
        model: this._currentModel,
        provider: this._currentProvider,
        mode: this._currentMode,
        reasoningEffort: this._currentReasoning,
        models: models || [],
        providers: providers || [],
        skills: [],
        sessions: sessions || [],
        isTrusted: true,
        workspaceName: workspaceFolder ? path.basename(workspaceFolder) : "Workspace Ready",
        currentPlan: sessionData?.plan || null,
      });

      this._postMessage({
        type: "session_loaded",
        session: sessionData,
      });
    } catch (err) {
      console.error("[Andromity SessionTab] Failed to load session:", err);
    }
  }

  public dispose() {
    SessionTabPanel._panels.delete(this._sessionId);
    this._disposeRpcEvents();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }
}
