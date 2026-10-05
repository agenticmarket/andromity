import * as vscode from "vscode";
import * as path from "path";
import { RpcClient } from "../server/RpcClient.js";
import { handleInputMessage } from "../server/inputBridge.js";
import { handleInteractionMessage, reportDisconnectedAction } from "../server/interactionBridge.js";
import { SessionHydration } from "../server/sessionHydration.js";
import { ChatViewProvider } from "../providers/ChatViewProvider.js";
import { ModelInfo, ProviderInfo, SessionInfo } from "../server/types.js";
import { EditorBridge } from "../integrations/EditorBridge.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { PlanEditorPanel } from "./PlanEditorPanel.js";
import { WaterfallPanel } from "./WaterfallPanel.js";
import { BackgroundTaskPanel } from "./BackgroundTaskPanel.js";

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
  private _hydration = new SessionHydration();
  private _creatingSession: Promise<void> | null = null;

  public static getAllPanels(): SessionTabPanel[] {
    return Array.from(SessionTabPanel._panels.values());
  }

  private _initialQueue: any[] = [];
  private _initialDraft: string = "";
  private _initialImages: string[] = [];
  private _initialSeedMessages: any[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    sessionId: string,
    sessionName: string,
    rpcClient: RpcClient | null,
    context: vscode.ExtensionContext,
    viewProvider: ChatViewProvider,
    initialQueue?: any[],
    tabState?: { draft?: string; images?: string[]; seedMessages?: any[] },
    viewColumn?: vscode.ViewColumn
  ): SessionTabPanel {
    if (rpcClient) {
      void rpcClient.call("telemetry.recordFeature", { feature: "side_by_side", session_id: sessionId }).catch(() => {});
    }

    const targetColumn =
      viewColumn ||
      (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined) ||
      vscode.ViewColumn.One;

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
      existing._postMessage({
        type: "init_tab_state",
        queue: initialQueue || [],
        draft: tabState?.draft || "",
        images: tabState?.images || [],
        seedMessages: tabState?.seedMessages || [],
      });
      existing._panel.reveal(targetColumn);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      SessionTabPanel.viewType,
      sessionName || "Chat Session",
      targetColumn,
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
      viewProvider,
      initialQueue,
      tabState
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
    viewProvider: ChatViewProvider,
    initialQueue?: any[],
    tabState?: { draft?: string; images?: string[]; seedMessages?: any[] }
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._sessionId = sessionId;
    this._sessionName = sessionName;
    this._rpcClient = rpcClient;
    this._context = context;
    this._viewProvider = viewProvider;
    this._initialQueue = initialQueue || [];
    this._initialDraft = tabState?.draft || "";
    this._initialImages = tabState?.images || [];
    this._initialSeedMessages = tabState?.seedMessages || [];

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
        try { await this._handleMessage(message); }
        catch (error) {
          console.error("[Andromity SessionTab] Action failed:", error);
          this._postMessage({ type: "action_failed", session_id: this._sessionId,
            error: "This action could not be completed. Reconnect and try again." });
        }
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
    html = html.replace(
      "</head>",
      "<style>#btn-top-open-tab { display: none !important; }</style></head>"
    );
    html = html.replace('<body class="loading">', '<body class="loading andromity-session-tab">');
    this._panel.webview.html = html;
  }

  public setRpcClient(client: RpcClient) {
    this._disposeRpcEvents();
    this._rpcClient = client;
    this._bindRpcEvents();
    this._postMessage({ type: "backend_ready" });
    void this._loadSession();
  }

  private _disposeRpcEvents() {
    for (const d of this._rpcDisposables) {
      try { d(); } catch {}
    }
    this._rpcDisposables = [];
  }

  public get webview(): vscode.Webview {
    return this._panel.webview;
  }

  public postMessage(msg: any) {
    this._postMessage(msg);
  }

  private _postMessage(msg: any) {
    if (this._hydration.capture(msg)) return;
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

    bind("agent/queueChanged", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "queue_state", ...params, supported: true });
    });
    bind("agent/inputApplied", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "input_applied", ...params });
    });
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
      if (isMatch(params)) {
        this._postMessage({ type: "tool_approval_required", ...params });
        if (this._viewProvider.isSoundEnabled("attention") && !this._viewProvider.isViewVisible()) {
          this._postMessage({ type: "play_sound", kind: "attention" });
        }
      }
    });
    bind("agent/askQuestions", (params: any) => {
      if (isMatch(params)) {
        this._postMessage({ type: "ask_questions", ...params });
        if (this._viewProvider.isSoundEnabled("attention") && !this._viewProvider.isViewVisible()) {
          this._postMessage({ type: "play_sound", kind: "attention" });
        }
      }
    });
    bind("agent/interactionResolved", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "interaction_resolved", ...params });
    });
    bind("process/started", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "process_started", ...params });
    });
    bind("process/exited", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "process_exited", ...params });
    });
    bind("agent/planApproval", (params: any) => {
      if (isMatch(params)) {
        this._postMessage({ type: "plan_approval", ...params });
        if (this._viewProvider.isSoundEnabled("attention") && !this._viewProvider.isViewVisible()) {
          this._postMessage({ type: "play_sound", kind: "attention" });
        }
      }
    });
    bind("agent/planUpdated", (params: any) => {
      if (isMatch(params)) this._postMessage({ type: "plan_updated", ...params });
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
      if (isMatch(params)) {
        this._postMessage({ type: "agent_done", ...params });
        if (this._viewProvider.isSoundEnabled("done") && !this._viewProvider.isViewVisible()) {
          this._postMessage({ type: "play_sound", kind: "done" });
        }
      }
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
          status: params.status,
          collaborators: params.collaborators,
          watching_for: params.watching_for,
          consecutive_auto_wakes: params.consecutive_auto_wakes,
        });
      }
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
      SettingsPanel.createOrShow(this._extensionUri, this._rpcClient, message.tab || "keys");
      return;
    }

    if (message.type === "open_about") {
      SettingsPanel.createOrShow(this._extensionUri, this._rpcClient, "about");
      return;
    }

    if (message.type === "open_personalisation") {
      SettingsPanel.createOrShow(this._extensionUri, this._rpcClient, "personalisation");
      return;
    }

    if (message.type === "update_mascot_setting") {
      const config = vscode.workspace.getConfiguration("andromity");
      await config.update("mascotEnabled", !!message.enabled, vscode.ConfigurationTarget.Global);
      this._viewProvider.broadcastMascotConfig();
      return;
    }

    if (message.type === "open_plan_tab") {
      const plan = await this._rpcClient?.call<{ plan: unknown }>("plan.get", { session_id: this._sessionId });
      PlanEditorPanel.createOrShow(
        this._extensionUri,
        plan?.plan || null,
        this._rpcClient,
        async (approved, feedback, sid) => {
          await this._viewProvider.handlePlanApproval(approved, feedback, sid || this._sessionId);
        },
        this._sessionId
      );
      return;
    }

    if (message.type === "open_file") {
      if (message.filePath) {
        await this._viewProvider.openFile(message.filePath, message.line);
      }
      return;
    }
    if (message.type === "pick_file_attachment") {
      const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
        canSelectMany: true, openLabel: "Attach File", title: "Attach File to Andromity Context" });
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      for (const uri of uris || []) {
        this._postMessage({ type: "file_attached", file: { name: path.basename(uri.fsPath), fsPath: uri.fsPath,
          path: workspaceFolder ? path.relative(workspaceFolder, uri.fsPath).replace(/\\/g, "/") : uri.fsPath } });
      }
      return;
    }

    if (message.type === "open_file_diff") {
      if (message.filePath) {
        this._viewProvider.openReviewWebview(message.filePath);
      }
      return;
    }

    if (message.type === "open_diff" || message.type === "open_review_tab" || message.type === "open_changes_review") {
      this._viewProvider.openReviewWebview(message.filePath, message.turnFiles);
      return;
    }

    if (message.type === "get_file_diff_stats") {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      try {
        const res = await this._rpcClient?.call<{ files: Record<string, { additions: number; deletions: number }> }>(
          "git.diff_numstat",
          { project_path: ws }
        );
        if (res?.files) {
          this._postMessage({
            type: "file_diff_stats_result",
            stats: res.files,
          });
        }
      } catch {}
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

    if (message.type === "open_waterfall") {
      const sid = message.sessionId || this._sessionId;
      const sname = message.sessionName || this._sessionName || "Chat Session";
      if (sid) {
        WaterfallPanel.createOrShow(
          this._extensionUri,
          sid,
          sname,
          this._rpcClient,
          this._context
        );
      }
      return;
    }

    if (!this._rpcClient) {
      reportDisconnectedAction(message, this._sessionId, event => this._postMessage(event));
      vscode.window.showErrorMessage("Andromity daemon is not connected.");
      return;
    }

    if (await handleInputMessage(this._rpcClient, message, this._sessionId, (event) => this._postMessage(event))) return;
    if (await handleInteractionMessage(this._rpcClient, message, this._sessionId, (event) => this._postMessage(event))) return;

    switch (message.type) {
      case "set_api_key": {
        try {
          if (!message.provider) throw new Error("Missing provider");
          if (message.apiKey) await this._rpcClient.call("config.set_api_key", { provider: message.provider, api_key: message.apiKey });
          const models = await this._rpcClient.call<ModelInfo[]>("config.refresh_models", { provider: message.provider }, 6000)
            .catch(() => this._rpcClient!.call<ModelInfo[]>("config.list_models", { provider: message.provider }));
          if (!models.length) {
            this._postMessage({ type: "key_configure_failed", error: "No models returned. Check the provider endpoint and model ID in Settings." });
            break;
          }
          this._postMessage({ type: "key_configured_select_model", provider: message.provider, models,
            defaultModel: message.modelId || models[0].id });
        } catch {
          this._postMessage({ type: "key_configure_failed", error: "Could not configure this provider. Check the connection in Settings." });
        }
        break;
      }
      case "activate_andromity_free": {
        await this._handleMessage({ type: "update_config", key: "model", value: "auto", provider: "andromity" });
        this._postMessage({ type: "key_configured_success", provider: "andromity", model: "auto" });
        break;
      }
      case "start_ollama_server": {
        await this._viewProvider.startOllamaServer();
        this._postMessage({ type: "ollama_status_updated", status: await this._viewProvider.probeOllama() });
        break;
      }
      case "open_external": {
        try {
          const uri = vscode.Uri.parse(message.url);
          if (uri.scheme === "http" || uri.scheme === "https") await vscode.env.openExternal(uri);
        } catch { /* Ignore invalid links. */ }
        break;
      }
      case "trust_workspace": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const trust = await this._rpcClient.call<{ is_trusted: boolean }>("trust.set", { project_path: workspaceFolder });
        this._postMessage({ type: "trust_updated", isTrusted: trust.is_trusted });
        break;
      }
      case "toggle_pin": {
        const result = await this._rpcClient.call<{ pinned: unknown[] }>("config.toggle_pin", {
          modelId: message.modelId, provider: message.provider, name: message.name,
        });
        this._postMessage({ type: "update_pinned_models", pinnedModels: result.pinned });
        break;
      }
      case "kill_process": {
        await this._rpcClient.call("process.kill", { process_id: message.processId || message.process_id, session_id: this._sessionId });
        break;
      }
      case "open_bg_task_tab": {
        const id = message.processId || message.process_id;
        if (id) BackgroundTaskPanel.createOrShow(this._extensionUri, id, this._rpcClient, message.command, this._sessionId);
        break;
      }
      case "new_session": {
        if (this._creatingSession) { await this._creatingSession; break; }
        this._creatingSession = (async () => {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const current = await this._rpcClient!.call<any>("session.get", { session_id: this._sessionId, project_path: workspaceFolder });
          if (!current.is_running && !current.messages?.length) { await this._loadSession(); return; }
          const created = await this._rpcClient!.call<SessionInfo>("session.create", {
            project_path: workspaceFolder, keep_id: this._sessionId,
            name: `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
          });
          await this._switchSession(created.id);
          void vscode.commands.executeCommand("andromity.refreshSessions");
        })();
        try { await this._creatingSession; }
        finally { this._creatingSession = null; }
        break;
      }
      case "send_prompt":
      case "prompt": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          let promptText = message.prompt || "";
          const editorContext = EditorBridge.getActiveContext();
          promptText = EditorBridge.formatPromptWithEditorState(
            promptText,
            editorContext,
            message.attachContext !== false
          );
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
          }, 600000);
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
        let nextMode = message.nextMode || (this._currentMode === "safe" ? "trust" : this._currentMode === "trust" ? "yolo" : "safe");
        if (nextMode === "yolo") {
          const confirm = await vscode.window.showWarningMessage(
            "Enter YOLO Mode? Autonomous agent will execute shell commands and edit files without confirmation.",
            { modal: true },
            "Enable YOLO Mode",
            "Keep Safe Mode"
          );
          if (confirm !== "Enable YOLO Mode") {
            nextMode = "safe";
          }
        }
        this._currentMode = nextMode;
        const config = vscode.workspace.getConfiguration("andromity");
        await config.update("permissionMode", this._currentMode, vscode.ConfigurationTarget.Global);
        await this._rpcClient?.call("config.set", {
          section: "default",
          key: "permission_mode",
          value: this._currentMode,
        });
        this._postMessage({ type: "config_updated", key: "mode", value: this._currentMode });
        this._viewProvider.refreshConfig();
        vscode.window.showInformationMessage(`Permission Mode: ${this._currentMode.toUpperCase()}`);
        break;
      }

      case "cycle_profile":
      case "update_profile": {
        const profiles = ["builder", "coder", "planner", "reviewer"];
        if (message.value && profiles.includes(message.value.toLowerCase())) {
          this._currentProfile = message.value.toLowerCase();
        } else {
          const nextIdx = (profiles.indexOf(this._currentProfile.toLowerCase()) + 1) % profiles.length;
          this._currentProfile = profiles[nextIdx];
        }
        await this._rpcClient?.call("config.set", {
          section: "default",
          key: "profile",
          value: this._currentProfile,
        }).catch(() => {});
        this._postMessage({ type: "config_updated", key: "profile", value: this._currentProfile });
        vscode.window.showInformationMessage(`Agent Profile: ${this._currentProfile.toUpperCase()}`);
        break;
      }

      case "cycle_reasoning":
      case "update_reasoning": {
        const cap = await this._rpcClient?.call<any>("model.reasoning_capability", {
          provider: this._currentProvider, model: this._currentModel,
        }).catch(() => null);
        const efforts: string[] = ["auto", ...(cap?.supported_efforts || []).filter((effort: string) => effort !== "auto")];
        if (efforts.length === 1 && !cap?.supports_max_tokens) {
          break;
        }
        if (message.value && efforts.includes(message.value.toLowerCase())) {
          this._currentReasoning = message.value.toLowerCase();
        } else {
          const nextIdx = (efforts.indexOf(this._currentReasoning.toLowerCase()) + 1) % efforts.length;
          this._currentReasoning = efforts[nextIdx];
        }
        await this._rpcClient?.call("config.set", {
          section: "default",
          key: "reasoning_effort",
          value: this._currentReasoning,
        }).catch(() => {});
        this._postMessage({ type: "config_updated", key: "reasoningEffort", value: this._currentReasoning });
        vscode.window.showInformationMessage(`Reasoning Effort: ${this._currentReasoning.toUpperCase()}`);
        break;
      }

      case "select_model":
      case "update_config": {
        const key = message.key || (message.modelId || message.model ? "model" : undefined);
        const value = message.value ?? message.modelId ?? message.model;
        if (key) {
          switch (key) {
            case "model":
              this._currentModel = value;
              if (message.provider) this._currentProvider = message.provider;
              break;
            case "provider": this._currentProvider = value; break;
            case "profile": this._currentProfile = value; break;
            case "mode": this._currentMode = value; break;
            case "reasoningEffort": this._currentReasoning = value; break;
          }
          await this._rpcClient?.call("config.set", {
            section: "default",
            key: key === "reasoningEffort" ? "reasoning_effort" : key === "mode" ? "permission_mode" : key,
            value: value,
          });
          if (key === "model" && message.provider) {
            await this._rpcClient.call("config.set", { section: "default", key: "provider", value: message.provider });
          }
          const reasoningCapability = key === "model" ? await this._rpcClient?.call<any>("model.reasoning_capability", {
            provider: this._currentProvider, model: this._currentModel,
          }).catch(() => null) : undefined;
          this._postMessage({ type: "config_updated", key, value, provider: this._currentProvider, reasoningCapability });
        }
        break;
      }

      case "approve_plan": {
        try {
          await this._rpcClient.call("plan.approve", {
            session_id: this._sessionId,
            comment: message.feedback || "",
            feedback: message.feedback || "",
          });
          const msg = "The plan has been approved by the user. Proceed with execution of the todos in order." +
            (message.feedback ? ` User note: ${message.feedback}` : "");
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const cleanModel = (this._currentModel || "").replace(/^~+/, "");
          await this._rpcClient.call("agent.prompt", {
            session_id: this._sessionId,
            prompt: msg,
            project_path: workspaceFolder,
            profile: this._currentProfile,
            model: cleanModel,
            provider: this._currentProvider,
            mode: this._currentMode,
            reasoning_effort: this._currentReasoning,
          }, 600000);
          vscode.window.showInformationMessage("Plan approved -- agent is executing.");
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to approve plan: ${e.message}`);
        }
        break;
      }

      case "reject_plan": {
        try {
          await this._rpcClient.call("plan.reject", {
            session_id: this._sessionId,
            comment: message.feedback || "",
            feedback: message.feedback || "",
          });
          const msg = "The plan was rejected by the user. Please revise the plan and present a new one." +
            (message.feedback ? ` User reason: ${message.feedback}` : "");
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const cleanModel = (this._currentModel || "").replace(/^~+/, "");
          await this._rpcClient.call("agent.prompt", {
            session_id: this._sessionId,
            prompt: msg,
            project_path: workspaceFolder,
            profile: this._currentProfile,
            model: cleanModel,
            provider: this._currentProvider,
            mode: this._currentMode,
            reasoning_effort: this._currentReasoning,
          }, 600000);
          vscode.window.showInformationMessage("Plan rejected -- agent will revise.");
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to reject plan: ${e.message}`);
        }
        break;
      }

      case "switch_session": {
        if (message.sessionId && message.sessionId !== this._sessionId) {
          await this._switchSession(message.sessionId);
        }
        break;
      }

      case "reset_auto_wake": {
        await this._rpcClient.call("session.resetAutoWake", {
          session_id: this._sessionId,
        }).catch((err) => console.error("[SessionTab] Reset auto wake error:", err));
        break;
      }

      case "undo_turn": {
        const undone = await this._viewProvider.undoSession(this._sessionId, message.turnIndex, message.turnsToUndo);
        if (undone) {
          try {
            vscode.commands.executeCommand("git.refresh");
            vscode.commands.executeCommand("andromity.refreshChanges");
          } catch {}
          await this._loadSession();
          this._postMessage({
            type: "turn_undone",
            turnsUndone: message.turnsToUndo || 1,
            targetTurnIndex: message.turnIndex,
          });
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

      case "open_settings": {
        vscode.commands.executeCommand("andromity.openSettings");
        break;
      }

      case "open_model_hub": {
        vscode.commands.executeCommand("andromity.openModelHub");
        break;
      }

      case "open_login":
      case "open_github_login": {
        try {
          await this._viewProvider.openLogin();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Could not open login page: ${err.message}`);
        }
        break;
      }

      case "logout_account": {
        await this._viewProvider.logout();
        break;
      }

      case "refresh_usage": {
        await this._viewProvider.fetchUsage();
        break;
      }

      case "request_rename_session": {
        const name = message.name || await vscode.window.showInputBox({ prompt: "Enter new session name", value: message.currentName || "" });
        if (message.sessionId && name?.trim()) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("session.rename", {
            session_id: message.sessionId,
            name: name.trim(),
            project_path: workspaceFolder,
          }).catch(() => null);
          if (message.sessionId === this._sessionId) {
            this._sessionName = name.trim();
            this._panel.title = name.trim();
          }
          await this._handleMessage({ type: "fetch_sessions" });
        }
        break;
      }
    }
  }

  private async _switchSession(sessionId: string) {
    const existing = SessionTabPanel._panels.get(sessionId);
    if (existing && existing !== this) {
      existing._panel.reveal();
      return;
    }
    SessionTabPanel._panels.delete(this._sessionId);
    this._sessionId = sessionId;
    SessionTabPanel._panels.set(sessionId, this);
    this._postMessage({ type: "session_switched", sessionId });
    await this._loadSession();
  }

  private async _loadSession() {
    if (!this._rpcClient || !this._sessionId) return;
    const sessionId = this._sessionId;
    const version = this._hydration.begin(sessionId);
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const [configData, models, providers, sessions] = await Promise.all([
        this._rpcClient.call<any>("config.get", { project_path: workspaceFolder }).catch(() => ({})),
        this._rpcClient.call<ModelInfo[]>("config.list_models", {}).catch(() => []),
        this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}).catch(() => []),
        this._rpcClient.call<SessionInfo[]>("session.list", { project_path: workspaceFolder, include_subagents: true }).catch(() => []),
      ]);
      if (!this._hydration.isCurrent(version)) return;
      const sessionData = await this._rpcClient.call<any>("session.get", { session_id: sessionId, project_path: workspaceFolder });
      if (!this._hydration.isCurrent(version)) return;

      if (sessionData && sessionData.name) {
        this._sessionName = sessionData.name;
        this._panel.title = sessionData.name;
      }

      this._currentModel = sessionData?.model || configData?.default_model || "anthropic/claude-3.7-sonnet";
      this._currentProvider = sessionData?.provider || configData?.default_provider || "openrouter";
      this._currentMode = sessionData?.permission_mode || sessionData?.mode || configData?.permission_mode || "safe";
      this._currentProfile = sessionData?.profile || configData?.default_profile || "builder";
      this._currentReasoning = configData?.reasoning_effort || "auto";

      const capability = await this._rpcClient.call<any>("model.reasoning_capability", {
        provider: this._currentProvider, model: this._currentModel,
      }).catch(() => null);
      if (!this._hydration.isCurrent(version)) return;

      this._postMessage({
        type: "init_state",
        sessionId: this._sessionId,
        profile: this._currentProfile,
        availableProfiles: configData?.available_profiles || ["builder", "coder", "reviewer", "planner"],
        availableReasoningEfforts: configData?.available_reasoning_efforts || [],
        modelReasoningCapability: capability,
        model: this._currentModel,
        provider: this._currentProvider,
        mode: this._currentMode,
        reasoningEffort: this._currentReasoning,
        models: models || [],
        providers: providers || [],
        skills: [],
        sessions: sessions || [],
        isTrusted: configData?.is_trusted === true,
        workspaceName: workspaceFolder ? path.basename(workspaceFolder) : "Workspace Ready",
        currentPlan: sessionData?.plan || null,
      });

      this._postMessage({
        type: "session_loaded",
        session: sessionData,
        draft: this._initialDraft,
        images: this._initialImages,
        seedMessages: this._initialSeedMessages,
      });
      this._hydration.finish(version, sessionData?.runtime?.event_seq || 0, (event) => this._postMessage(event));

      if (this._initialQueue && this._initialQueue.length > 0) {
        this._postMessage({
          type: "init_queue",
          queue: this._initialQueue,
        });
      }
      this._initialQueue = [];
      this._initialDraft = "";
      this._initialImages = [];
      this._initialSeedMessages = [];

      // Sync auth state & account quota with the tab webview
      const storedToken = await this._context?.secrets.get("andromity.authToken");
      const storedUser = await this._context?.secrets.get("andromity.userName");
      const isAuthed = Boolean(storedToken);
      this._postMessage({
        type: "auth_state_changed",
        isAuthenticated: isAuthed,
        plan: isAuthed ? "authenticated" : "anonymous",
        username: storedUser || (isAuthed ? "Developer" : "Anonymous"),
      });

      if (this._viewProvider) {
        void this._viewProvider.fetchUsage();
      }
    } catch (err) {
      if (!this._hydration.isCurrent(version)) return;
      this._hydration.finish(version, -1, (event) => this._postMessage(event));
      console.error("[Andromity SessionTab] Failed to load session:", err);
      this._postMessage({ type: "session_load_failed", session_id: sessionId });
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
