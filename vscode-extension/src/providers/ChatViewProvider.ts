import * as path from "path";
import { exec } from "child_process";
import * as vscode from "vscode";
import { DiffManager } from "../integrations/DiffManager.js";
import { EditorBridge } from "../integrations/EditorBridge.js";
import { SettingsPanel } from "../panels/SettingsPanel.js";
import { SessionTabPanel } from "../panels/SessionTabPanel.js";
import { PythonBridge } from "../server/PythonBridge.js";
import { RpcClient } from "../server/RpcClient.js";
import {
  ClarifyingQuestionsEvent,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  SubAgentEvent,
  ToolApprovalEvent,
} from "../server/types.js";
import { getChatViewHtml } from "./chatview/chatHtml.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "andromity.chatView";
  private _view?: vscode.WebviewView;
  private _rpcClient: RpcClient | null = null;
  private _pythonBridge: PythonBridge | null = null;
  private _diffManager: DiffManager | null = null;
  private _currentSessionId: string = "";
  private _currentProfile: string = "builder";
  private _currentModel: string = "claude-sonnet-4-6";
  private _currentProvider: string = "anthropic";
  private _currentMode: string = "safe";
  private _currentReasoning: string = "medium";
  private _models: ModelInfo[] = [];
  private _providers: ProviderInfo[] = [];
  private _currentPlan: any = null;

  /** workspaceState key persisting the session the user had active last. */
  private static readonly LAST_ACTIVE_SESSION_KEY = "andromity.lastActiveSessionId";

  /** Session id created for the current reload cycle in "fresh" startup mode.
   *  Guards against creating duplicate empty sessions when _loadInitialConfig
   *  fires more than once per window load. Cleared on explicit session switch. */
  private _freshSessionId: string | undefined;
  private _creatingSession: Promise<string | null> | null = null;

  private _boundClient: RpcClient | null = null;
  private _rpcDisposables: Array<() => void> = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context?: vscode.ExtensionContext
  ) {}

  public setPythonBridge(bridge: PythonBridge) {
    this._pythonBridge = bridge;
  }

  public setRpcClient(client: RpcClient) {
    if (this._boundClient === client && this._rpcClient === client) {
      return;
    }
    this._disposeRpcEvents();
    this._rpcClient = client;
    this._boundClient = client;
    // Reuse the DiffManager across reconnects — constructing a new one for
    // every connection registers another TextDocumentContentProvider for the
    // same scheme and leaks the old one.
    if (!this._diffManager) {
      this._diffManager = new DiffManager(client, this._context!);
    } else {
      this._diffManager.setRpcClient(client);
    }
    this._bindRpcEvents();
    this._postToWebview({ type: "backend_ready" });
    this._loadInitialConfig(true);
  }

  private _disposeRpcEvents() {
    for (const dispose of this._rpcDisposables) {
      try {
        dispose();
      } catch (e) {
        // ignore
      }
    }
    this._rpcDisposables = [];
    this._boundClient = null;
  }

  public toggleSessionsDrawer() {
    if (this._view) {
      this._view.show?.(true);
      this.fetchAndPostSessions();
      this._view.webview.postMessage({ type: "toggle_sessions" });
    }
  }

  public toggleCronsDrawer() {
    if (this._view) {
      this._view.show?.(true);
      this.fetchAndPostCrons();
      this._view.webview.postMessage({ type: "toggle_crons" });
    }
  }

  public updateCurrentPlan(plan: any) {
    this._currentPlan = plan;
    if (this._view) {
      this._view.webview.postMessage({ type: "plan_updated", plan });
    }
  }

  public getCurrentPlan(): any {
    return this._currentPlan;
  }

  public async fetchAndPostSessions() {
    if (!this._rpcClient) return;
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const sessions = await this._rpcClient.call<SessionInfo[]>("session.list", {
        project_path: workspaceFolder,
        include_subagents: true,
      }).catch(() => []) || [];
      this._postToWebview({
        type: "sessions_data",
        sessions,
        currentSessionId: this._currentSessionId,
      });
    } catch (e) {
      // ignore
    }
  }

  public async fetchAndPostCrons() {
    if (!this._rpcClient) return;
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const crons = await this._rpcClient.call<any[]>("cron.list", {
        project_path: workspaceFolder,
      }).catch(() => []) || [];
      this._postToWebview({
        type: "crons_data",
        crons,
      });
    } catch (e) {
      // ignore
    }
  }

  /** Remember which session the user had active (survives window reloads). */
  private _persistLastActiveSession(sessionId: string = this._currentSessionId) {
    if (sessionId && this._context) {
      void this._context.workspaceState.update(
        ChatViewProvider.LAST_ACTIVE_SESSION_KEY,
        sessionId
      );
    }
  }

  public setCurrentSessionId(sessionId: string) {
    this._currentSessionId = sessionId;
    // Explicit switch abandons whatever fresh startup session this cycle made.
    if (sessionId !== this._freshSessionId) {
      this._freshSessionId = undefined;
    }
    this._persistLastActiveSession(sessionId);
    if (this._view) {
      this._view.webview.postMessage({ type: "session_switched", sessionId });
      this._loadSession(sessionId);
    }
  }

  public async sendPromptFromExternal(prompt: string, context?: any) {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.postMessage({
        type: "external_prompt",
        prompt,
        context,
      });
    }
  }

  /** Wired to the "Andromity: Undo Last Turn & Rollback Diff" command. */
  public async requestUndoTurn() {
    if (this._diffManager) {
      await this._diffManager.undoLastTurn(this._currentSessionId);
      await this._loadSession(this._currentSessionId);
      vscode.commands.executeCommand("andromity.refreshChanges");
    } else if (this._rpcClient) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const res = await this._rpcClient.call<any>("session.undo", {
        session_id: this._currentSessionId,
        project_path: workspaceFolder,
      });
      if (res?.success) {
        vscode.window.showInformationMessage(`Turn undone successfully. (${res.popped_messages || 0} messages removed.)`);
        await this._loadSession(this._currentSessionId);
      }
    }
  }

  /** Wired to the "Andromity: Open File Diff" command. */
  public async openFileDiff(filePath: string, isUntracked: boolean) {
    if (this._diffManager) {
      await this._diffManager.showFileDiff(filePath, isUntracked);
    }
  }

  /** Open a session in a dedicated editor tab (side-by-side parallel view). */
  public openSessionInTab(sessionId?: string, sessionName?: string) {
    const sid = sessionId || this._currentSessionId;
    if (sid) {
      SessionTabPanel.createOrShow(
        this._extensionUri,
        sid,
        sessionName || "Chat Session",
        this._rpcClient,
        this._context!,
        this
      );
    }
  }

  /** Wired to the "Andromity: View Git Diff" command (QuickPick of changed files). */
  public async pickAndShowFileDiff() {
    if (this._diffManager) {
      await this._diffManager.pickAndShowFileDiff();
    }
  }

  /** Refresh config and models from daemon without wiping chat messages */
  public async refreshConfig() {
    await this._loadInitialConfig(false);
  }

  /**
   * Plan approve/reject flow (TUI parity): persists plan status on the daemon,
   * then sends the follow-up prompt through the chat queue.
   */
  public async handlePlanApproval(approved: boolean, feedback: string = "") {
    if (!this._rpcClient || !this._currentSessionId) return;
    try {
      await this._rpcClient.call(approved ? "plan.approve" : "plan.reject", {
        session_id: this._currentSessionId,
        comment: feedback,
        feedback: feedback,
      });
      const msg = approved
        ? "The plan has been approved by the user. Proceed with execution of the todos in order." +
          (feedback ? ` User note: ${feedback}` : "")
        : "The plan was rejected by the user. Please revise the plan and present a new one." +
          (feedback ? ` User reason: ${feedback}` : "");
      this.sendPromptFromExternal(msg);
      vscode.window.showInformationMessage(
        approved ? "Plan approved -- agent is executing." : "Plan rejected -- agent will revise."
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Failed to ${approved ? "approve" : "reject"} plan: ${e.message}`
      );
    }
  }

  public getCurrentSessionId(): string {
    return this._currentSessionId;
  }

  public async compactSession(): Promise<void> {
    if (!this._rpcClient) return;
    try {
      this._postToWebview({
        type: "session_compacting",
        reason: "Compacting conversation context to save tokens...",
      });
      const res = await this._rpcClient.call<{ success: boolean; message_count: number; old_count?: number; skipped?: boolean; reason?: string; error?: string }>("session.compact", {
        session_id: this._currentSessionId,
      }, 35000);
      if (res?.skipped) {
        this._postToWebview({
          type: "session_compacted",
          skipped: true,
          reason: res.reason,
          old_count: res.old_count,
          message_count: res.message_count,
        });
        vscode.window.showInformationMessage(res.reason || "Conversation is already compact.");
      } else if (res?.error) {
        vscode.window.showWarningMessage(`Compaction notice: ${res.error}`);
        this._postToWebview({
          type: "session_compacted",
          error: res.error,
        });
      } else if (res?.success) {
        vscode.window.showInformationMessage(`Session compacted (${res.message_count} messages retained).`);
        await this._loadSession(this._currentSessionId);
        this._postToWebview({
          type: "session_compacted",
          old_count: res.old_count,
          message_count: res.message_count,
        });
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to compact session: ${e.message}`);
      this._postToWebview({
        type: "session_compacted",
        error: e.message,
      });
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this._handleWebviewMessage(message);
    });

    if (this._rpcClient) {
      this._loadInitialConfig(true);
    }
  }

  private _bindRpcEvents() {
    if (!this._rpcClient) return;
    const client = this._rpcClient;

    const bind = (event: string, handler: (...args: any[]) => void) => {
      client.on(event, handler);
      this._rpcDisposables.push(() => client.off(event, handler));
    };

    bind("agent/started", (params: any) => {
      this._postToWebview({ type: "agent_started", ...params });
    });

    bind("agent/textDelta", (params: any) => {
      this._postToWebview({ type: "text_delta", ...params });
    });

    bind("agent/thinkingDelta", (params: any) => {
      this._postToWebview({ type: "thinking_delta", ...params });
    });

    bind("agent/toolStart", (params: any) => {
      this._postToWebview({ type: "tool_start", ...params });
    });

    bind("agent/toolDelta", (params: any) => {
      this._postToWebview({ type: "tool_delta", ...params });
    });

    bind("agent/toolEnd", (params: any) => {
      this._postToWebview({ type: "tool_end", ...params });
    });

    bind("agent/toolResult", (params: any) => {
      this._postToWebview({ type: "tool_result", ...params });
    });

    bind("agent/toolApprovalRequired", (params: any) => {
      this._postToWebview({ type: "tool_approval_required", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
      }
    });

    bind("agent/askQuestions", (params: any) => {
      this._postToWebview({ type: "ask_questions", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
      }
    });

    bind("agent/planApproval", (params: any) => {
      this._currentPlan = params.plan;
      this._postToWebview({ type: "plan_approval", plan: params.plan });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
      }
    });

    bind("agent/planUpdated", (params: any) => {
      if (params.plan) {
        this._currentPlan = params.plan;
        this._postToWebview({ type: "plan_updated", plan: params.plan });
      }
    });

    bind("session/updated", (params: any) => {
      this._postToWebview({
        type: "session_updated",
        session_id: params.session_id,
        name: params.name,
        message_count: params.message_count,
        context_tokens: params.context_tokens,
        token_total: params.token_total,
        cost_usd: params.cost_usd,
      });
      vscode.commands.executeCommand("andromity.refreshSessions");
    });

    bind("subagent/spawned", (params: SubAgentEvent) => {
      this._postToWebview({ type: "subagent_spawned", ...params });
    });

    bind("subagent/progress", (params: SubAgentEvent) => {
      this._postToWebview({ type: "subagent_progress", ...params });
    });

    bind("subagent/done", (params: SubAgentEvent) => {
      this._postToWebview({ type: "subagent_done", ...params });
    });

    bind("subagent/failed", (params: SubAgentEvent) => {
      this._postToWebview({ type: "subagent_failed", ...params });
    });

    bind("agent/done", (params: any) => {
      this._postToWebview({ type: "agent_done", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "done" });
      }
      // Files may have changed -- refresh the Changes view and session stats.
      vscode.commands.executeCommand("andromity.refreshChanges");
    });

    bind("agent/cancelled", (params: any) => {
      this._postToWebview({ type: "agent_cancelled", ...params });
    });

    bind("agent/error", (params: any) => {
      this._postToWebview({ type: "agent_error", ...params });
    });

    bind("session/compacting", (params: any) => {
      this._postToWebview({ type: "session_compacting", ...params });
    });

    bind("session/compacted", (params: any) => {
      this._postToWebview({ type: "session_compacted", ...params });
    });
  }

  private _postToWebview(msg: any) {
    if (this._view) {
      this._view.webview.postMessage(msg);
    }
  }

  private async _loadInitialConfig(loadSession: boolean = true) {
    if (!this._rpcClient) return;

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const [configData, models, providers, sessions, trustStatus, skills] = await Promise.all([
        this._rpcClient.call<any>("config.get", { project_path: workspaceFolder }).catch(() => ({})),
        this._rpcClient.call<ModelInfo[]>("config.list_models", {}).catch(() => []),
        this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}).catch(() => []),
        this._rpcClient.call<SessionInfo[]>("session.list", { project_path: workspaceFolder }).catch(() => []),
        this._rpcClient.call<any>("trust.status", { project_path: workspaceFolder }).catch(() => ({ is_trusted: true })),
        this._rpcClient.call<any[]>("skills.list", { project_path: workspaceFolder }).catch(() => []),
      ]);

      this._models = models || [];
      this._providers = providers || [];
      this._currentProvider = configData?.default_provider || "openrouter";
      this._currentModel = configData?.default_model || "anthropic/claude-3.7-sonnet";
      this._currentProfile = configData?.default_profile || "builder";
      this._currentReasoning = configData?.reasoning_effort || "medium";
      this._currentMode = configData?.permission_mode || "safe";

      if (loadSession) {
        const startupMode = vscode.workspace
          .getConfiguration("andromity")
          .get<string>("startupSession", "last");

        if (startupMode === "fresh") {
          // "fresh" mode: start on an empty conversation; previous sessions
          // remain accessible in the history drawer.
          // Reuse session if already created this reload cycle or if an empty session exists
          const existingEmpty = (sessions || []).find(
            (s: any) => (!s.message_count || s.message_count === 0) && !s.parent_session
          );
          if (this._freshSessionId) {
            this._currentSessionId = this._freshSessionId;
            this._persistLastActiveSession();
          } else if (existingEmpty) {
            this._currentSessionId = (existingEmpty as any).id;
            this._freshSessionId = (existingEmpty as any).id;
            this._persistLastActiveSession();
          } else if (this._creatingSession) {
            const waited = await this._creatingSession;
            if (waited) this._currentSessionId = waited;
            this._persistLastActiveSession();
          } else {
            this._creatingSession = (async () => {
              try {
                const s = await this._rpcClient!.call<SessionInfo>("session.create", {
                  name: `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
                  project_path: workspaceFolder,
                });
                this._currentSessionId = s.id;
                this._freshSessionId = s.id;
                this._persistLastActiveSession();
                await this.fetchAndPostSessions();
                return s.id;
              } catch { return null; } finally { this._creatingSession = null; }
            })();
            await this._creatingSession;
          }
        } else if (sessions && sessions.length > 0) {
          // "last" mode (default): restore exactly the session the user had
          // active when the window was last closed. Fall back to the previous
          // heuristic (newest session with messages) when nothing is stored
          // or the stored session no longer exists (e.g. deleted).
          const storedId = this._context?.workspaceState.get<string>(
            ChatViewProvider.LAST_ACTIVE_SESSION_KEY
          );
          const storedSession = storedId
            ? sessions.find((s: any) => s.id === storedId)
            : undefined;
          const target =
            storedSession ||
            sessions.find((s: any) => s.message_count && s.message_count > 0) ||
            sessions[0];
          this._currentSessionId = target.id;
          this._persistLastActiveSession();
          await this._loadSession(this._currentSessionId);
        } else {
          const newSess = await this._rpcClient.call<SessionInfo>("session.create", {
            name: "Main Session",
            project_path: workspaceFolder,
          }).catch(() => ({ id: "main-session" } as SessionInfo));
          this._currentSessionId = newSess.id;
          this._persistLastActiveSession();
        }
      }

      // Do not auto-inject workspace plan.json into the chat session.
      // The plan tracker is session-scoped (session.plan). Workspace plan is
      // only loaded on demand when the Plan tab is opened.

      this._postToWebview({
        type: "init_state",
        sessionId: this._currentSessionId,
        profile: this._currentProfile,
        availableProfiles: configData?.available_profiles || ["builder", "coder", "reviewer", "planner"],
        availableReasoningEfforts: configData?.available_reasoning_efforts || ["low", "medium", "high", "off"],
        model: this._currentModel,
        provider: this._currentProvider,
        mode: this._currentMode,
        reasoningEffort: this._currentReasoning,
        models: this._models,
        providers: this._providers,
        skills: skills || [],
        sessions: sessions || [],
        isTrusted: trustStatus?.is_trusted !== false,
        workspaceName: workspaceFolder ? path.basename(workspaceFolder) : "Workspace Ready",
        currentPlan: this._currentPlan,
      });
    } catch (e: any) {
      console.error("[Andromity Chat] Initial config load failed:", e);
    }
  }

  private async _loadPlanFromWorkspace(): Promise<any | null> {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return null;
      const rootUri = folders[0].uri;

      let planObj: any = null;
      try {
        const jsonUri = vscode.Uri.joinPath(rootUri, ".andromity", "plan.json");
        const bytes = await vscode.workspace.fs.readFile(jsonUri);
        planObj = JSON.parse(new TextDecoder().decode(bytes));
      } catch {}

      // Try reading todos.md if steps missing
      let steps: any[] = planObj?.steps || planObj?.todos || [];
      if (steps.length === 0) {
        try {
          const todosUri = vscode.Uri.joinPath(rootUri, ".andromity", "todos.md");
          const mdBytes = await vscode.workspace.fs.readFile(todosUri);
          const mdText = new TextDecoder().decode(mdBytes);
          const lines = mdText.split("\n");
          for (const line of lines) {
            const m = line.match(/^-\s+(\[[ x/!\-]\])\s+(t\d+)\.\s+(.+)/);
            if (m) {
              const statusMap: Record<string, string> = {
                "[ ]": "pending",
                "[x]": "done",
                "[/]": "active",
                "[!]": "failed",
                "[-]": "skipped",
              };
              steps.push({
                id: m[2],
                title: m[3].trim(),
                status: statusMap[m[1]] || "pending",
              });
            }
          }
        } catch {}
      }

      if (planObj) {
        planObj.steps = steps;
        planObj.todos = steps;
        return planObj;
      } else if (steps.length > 0) {
        return {
          title: "Current Tasks",
          status: "approved",
          steps,
          todos: steps,
        };
      }
    } catch {}
    return null;
  }

  private _formatModelDisplayName(id?: string): string {
    if (!id || id === "Loading model...") return "Claude 3.7 Sonnet";
    const found = this._models.find((m) => m.id === id);
    if (found?.name) return found.name;
    const parts = id.split("/");
    const raw = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
    return raw
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase())
      .replace(/Gpt/g, "GPT")
      .replace(/Claude/g, "Claude")
      .replace(/Gemini/g, "Gemini");
  }

  private async _loadSession(sessionId: string) {
    if (!this._rpcClient || !sessionId) return;
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const sessionData = await this._rpcClient.call<any>("session.get", {
        session_id: sessionId,
        project_path: workspaceFolder,
      });
      if (sessionData && sessionData.plan && sessionData.plan.steps && sessionData.plan.steps.length > 0) {
        this._currentPlan = sessionData.plan;
      } else {
        this._currentPlan = null;
      }
      this._postToWebview({
        type: "plan_updated",
        plan: this._currentPlan,
        session_id: sessionId,
      });
      this._postToWebview({
        type: "session_loaded",
        session: sessionData,
      });
    } catch (e: any) {
      console.error("[Andromity Chat] Failed to load session:", e);
    }
  }

  private async _handleWebviewMessage(message: any) {
    if (message.type === "ready" || message.type === "webview_ready") {
      if (!this._rpcClient && this._pythonBridge) {
        const client = await this._pythonBridge.waitForClient(3000);
        if (client) {
          this.setRpcClient(client);
        }
      }
      if (this._rpcClient) {
        this._postToWebview({ type: "backend_ready" });
        await this._loadInitialConfig(true);
      }
      return;
    }

    if (message.type === "copy_clipboard") {
      if (message.text) {
        await vscode.env.clipboard.writeText(message.text);
      }
      return;
    }

    if (message.type === "apply_code") {
      await EditorBridge.applySnippetToEditor(message.code, message.mode || "insert_at_cursor");
      return;
    }

    if (message.type === "open_settings") {
      SettingsPanel.createOrShow(
        this._extensionUri,
        this._rpcClient,
        "keys",
        () => this.refreshConfig()
      );
      return;
    }

    if (message.type === "open_diff") {
      if (this._diffManager) {
        await this._diffManager.showGitDiff();
      }
      return;
    }

    if (!this._rpcClient && this._pythonBridge) {
      const client = await this._pythonBridge.waitForClient(3000);
      if (client) {
        this.setRpcClient(client);
      }
    }

    if (!this._rpcClient) {
      vscode.window.showErrorMessage(
        "Andromity daemon is not connected.",
        "Restart Server",
        "Run Setup Check"
      ).then((choice) => {
        if (choice === "Restart Server") {
          vscode.commands.executeCommand("andromity.restartServer");
        } else if (choice === "Run Setup Check") {
          vscode.commands.executeCommand("andromity.checkSetup");
        }
      });
      return;
    }

    switch (message.type) {

      case "send_prompt": {
        let promptText = message.prompt || "";
        console.log('[Andromity ext] send_prompt recv:', promptText.slice(0,120), 'sess', this._currentSessionId, 'hasClient', !!this._rpcClient);
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const editorContext = EditorBridge.getActiveContext();
          if (message.attachContext && editorContext.selectedText) {
            promptText += `\n\n--- Context from ${editorContext.relativePath} (lines ${editorContext.selectionRange?.startLine}-${editorContext.selectionRange?.endLine}) ---\n\`\`\`${editorContext.languageId || ""}\n${editorContext.selectedText}\n\`\`\``;
          }

          if (!this._currentSessionId && message.sessionId) {
            this._currentSessionId = message.sessionId;
          }
          if (!this._currentSessionId) {
            const newSess = await this._rpcClient.call<SessionInfo>("session.create", {
              name: "Main Session",
              project_path: workspaceFolder,
            }).catch(() => ({ id: "main-session" } as SessionInfo));
            this._currentSessionId = newSess.id;
            this._persistLastActiveSession();
          }

          const cleanModel = (message.model || this._currentModel || "").replace(/^~+/, "");
          await this._rpcClient.call("agent.prompt", {
            session_id: this._currentSessionId,
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
          const msg = err.message || String(err);
          if (msg.includes("already running a turn") || msg.includes("-32603") || msg.includes("AGENT_BUSY")) {
            vscode.window.showInformationMessage("Agent is still working on the previous turn. Your message was queued and will send automatically when it finishes.");
            this._postToWebview({ type: "agent_busy", error: msg, queuedPrompt: promptText });
          } else if (msg.includes("RPC timeout")) {
            // Server actually started but ACK timed out -- keep turn alive, wait for streaming notifications
            vscode.window.showWarningMessage("Agent started but confirmation timed out. Streaming will continue -- check the chat for progress. If stuck, use Cancel.");
            this._postToWebview({ type: "agent_started", session_id: this._currentSessionId });
          } else {
            vscode.window.showErrorMessage(`Failed to send prompt: ${msg}`);
            this._postToWebview({ type: "agent_error", error: msg });
          }
        }
        break;
      }

      case "open_settings": {
        SettingsPanel.createOrShow(
          this._extensionUri,
          this._rpcClient,
          "keys",
          () => this.refreshConfig()
        );
        break;
      }

      case "open_external_url": {
        if (message.url && typeof message.url === "string") {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      }

      case "set_api_key": {
        try {
          const provider = message.provider;
          const apiKey = message.apiKey || "";
          const modelId = message.modelId;
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

          if (provider && apiKey) {
            await this._rpcClient.call("config.set_api_key", {
              provider,
              api_key: apiKey,
            });
          }

          if (provider) {
            await this._rpcClient.call("config.set", {
              section: "default",
              key: "provider",
              value: provider,
            });
            this._currentProvider = provider;
          }

          if (modelId) {
            await this._rpcClient.call("config.set", {
              section: "default",
              key: "model",
              value: modelId,
            });
            this._currentModel = modelId;
          }

          const providers = await this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}).catch(() => []);
          this._providers = providers || [];

          vscode.window.showInformationMessage(
            `Connected to ${provider || "AI Provider"}! You're ready to code.`
          );

          await this._loadInitialConfig(false);
          this._postToWebview({
            type: "key_configured_success",
            provider,
            model: this._currentModel,
          });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to configure provider: ${err.message}`);
          this._postToWebview({
            type: "key_configure_failed",
            error: err.message,
          });
        }
        break;
      }

      case "open_skills_settings": {
        SettingsPanel.createOrShow(
          this._extensionUri,
          this._rpcClient,
          "skills",
          () => this.refreshConfig()
        );
        break;
      }

      case "check_setup": {
        vscode.commands.executeCommand("andromity.checkSetup");
        break;
      }

      case "install_python": {
        vscode.env.openExternal(vscode.Uri.parse("https://www.python.org/downloads/"));
        break;
      }

      case "configure_python_path": {
        vscode.commands.executeCommand("workbench.action.openSettings", "andromity.pythonPath");
        break;
      }

      case "open_model_hub": {
        SettingsPanel.createOrShow(
          this._extensionUri,
          this._rpcClient,
          "models",
          () => this.refreshConfig()
        );
        break;
      }

      case "cycle_mode": {
        const modes = ["safe", "trust", "full", "yolo"];
        const nextIdx = (modes.indexOf(this._currentMode) + 1) % modes.length;
        this._currentMode = modes[nextIdx];
        const config = vscode.workspace.getConfiguration("andromity");
        await config.update("permissionMode", this._currentMode, vscode.ConfigurationTarget.Global);
        await this._rpcClient?.call("config.set", {
          section: "default",
          key: "permission_mode",
          value: this._currentMode,
        });
        this._postToWebview({ type: "config_updated", key: "mode", value: this._currentMode });
        SettingsPanel.currentPanel?.loadData();
        vscode.window.showInformationMessage(`Permission Mode: ${this._currentMode.toUpperCase()}`);
        break;
      }

      case "cycle_profile":
      case "update_profile": {
        const profiles = ["builder", "coder", "architect", "reviewer", "tester", "writer"];
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
        });
        this._postToWebview({ type: "config_updated", key: "profile", value: this._currentProfile });
        SettingsPanel.currentPanel?.loadData();
        vscode.window.showInformationMessage(`Agent Profile: ${this._currentProfile.toUpperCase()}`);
        break;
      }

      case "cycle_reasoning":
      case "update_reasoning": {
        const efforts = ["high", "medium", "low", "off"];
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
        });
        this._postToWebview({ type: "config_updated", key: "reasoningEffort", value: this._currentReasoning });
        SettingsPanel.currentPanel?.loadData();
        vscode.window.showInformationMessage(`Reasoning Effort: ${this._currentReasoning.toUpperCase()}`);
        break;
      }


      case "trust_workspace": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await this._rpcClient?.call("trust.set", { project_path: workspaceFolder });
        vscode.window.showInformationMessage("Workspace trusted. File editing and shell commands enabled.");
        this._postToWebview({ type: "trust_updated", isTrusted: true });
        SettingsPanel.currentPanel?.loadData();
        break;
      }

      case "approve_tool": {
        await this._rpcClient.call("agent.approve_tool", {
          approval_id: message.approvalId,
          approved: true,
          scope: message.scope || "once",
        });
        if (message.scope === "session") {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("config.set", { section: "default", key: "permission_mode", value: "trust" }).catch(() => {});
          this._currentMode = "trust";
          this._postToWebview({ type: "config_updated", key: "mode", value: "trust" });
        } else if (message.scope === "always") {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("trust.set", { project_path: workspaceFolder }).catch(() => {});
          await this._rpcClient.call("config.set", { section: "default", key: "permission_mode", value: "trust" }).catch(() => {});
          this._currentMode = "trust";
          this._postToWebview({ type: "trust_updated", isTrusted: true });
          this._postToWebview({ type: "config_updated", key: "mode", value: "trust" });
        }
        break;
      }

      case "reject_tool": {
        await this._rpcClient.call("agent.reject_tool", {
          approval_id: message.approvalId,
        });
        break;
      }

      case "approve_plan": {
        await this.handlePlanApproval(true, message.feedback || "");
        break;
      }

      case "reject_plan": {
        await this.handlePlanApproval(false, message.feedback || "");
        break;
      }

      case "answer_question": {
        await this._rpcClient.call("agent.answer_question", {
          question_id: message.questionId,
          answers: message.answers,
        });
        break;
      }

      case "cancel_turn": {
        const targetSessionId = message.sessionId || this._currentSessionId;
        try {
          await this._rpcClient.call("agent.cancel", {
            session_id: targetSessionId,
          });
        } catch (e: any) {
          console.warn("[Andromity] cancel_turn RPC failed:", e?.message || e);
          // Still notify webview so fallback can trigger even if daemon is slow/dead
          this._postToWebview({ type: "agent_cancelled", session_id: targetSessionId });
        }
        break;
      }

      case "new_session": {
        if (this._creatingSession) { await this._creatingSession; break; }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (this._currentSessionId && this._rpcClient) {
          const currentSess = await this._rpcClient.call<any>("session.get", {
            session_id: this._currentSessionId,
            project_path: workspaceFolder,
          }).catch(() => null);
          if (currentSess && (!currentSess.messages || currentSess.messages.length === 0)) {
            this.setCurrentSessionId(this._currentSessionId);
            await this.fetchAndPostSessions();
            break;
          }
        }
        this._creatingSession = (async () => {
          const r = await this._rpcClient!.call<SessionInfo>("session.create", {
            name: message.name || `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            project_path: workspaceFolder,
          });
          this.setCurrentSessionId(r.id);
          await this.fetchAndPostSessions();
          vscode.commands.executeCommand("andromity.refreshSessions");
          return r.id;
        })();
        try { await this._creatingSession; } finally { this._creatingSession = null; }
        break;
      }

      case "open_file_diff": {
        if (message.filePath) {
          await this.openFileDiff(message.filePath, false);
        }
        break;
      }

      case "open_session_tab": {
        const sid = message.sessionId || this._currentSessionId;
        const sname = message.sessionName || "Chat Session";
        if (sid) {
          SessionTabPanel.createOrShow(
            this._extensionUri,
            sid,
            sname,
            this._rpcClient,
            this._context!,
            this
          );
        }
        break;
      }

      case "switch_session": {
        this.setCurrentSessionId(message.sessionId);
        break;
      }

      case "fetch_sessions": {
        await this.fetchAndPostSessions();
        break;
      }

      case "fetch_crons": {
        await this.fetchAndPostCrons();
        break;
      }

      case "open_plan_tab": {
        vscode.commands.executeCommand("andromity.openPlanTab", this._currentPlan);
        break;
      }

      case "delete_session": {
        if (this._rpcClient && message.sessionId) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("session.delete", {
            session_id: message.sessionId,
            project_path: workspaceFolder,
          }).catch(() => {});
          await this.fetchAndPostSessions();
          vscode.commands.executeCommand("andromity.refreshSessions");
          if (message.sessionId === this._currentSessionId) {
            const res = await this._rpcClient.call<SessionInfo>("session.create", {
              name: `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
              project_path: workspaceFolder,
            }).catch(() => null);
            if (res?.id) this.setCurrentSessionId(res.id);
          }
        }
        break;
      }

      case "request_rename_session": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const newName = await vscode.window.showInputBox({
          prompt: "Enter new session name",
          value: message.currentName || "",
        });
        if (newName && newName.trim() && this._rpcClient) {
          await this._rpcClient.call("session.rename", {
            session_id: message.sessionId,
            name: newName.trim(),
            project_path: workspaceFolder,
          }).catch(() => {});
          await this.fetchAndPostSessions();
          if (message.sessionId === this._currentSessionId) {
            this._postToWebview({ type: "session_updated", sessionId: message.sessionId, name: newName.trim() });
          }
        }
        break;
      }

      case "pick_session": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const sessions = await this._rpcClient?.call<SessionInfo[]>("session.list", {
          project_path: workspaceFolder,
        }).catch(() => []) || [];

        const cur = sessions.find(s => s.id === this._currentSessionId);
        const currentName = cur?.name || "Current Session";

        const items: Array<vscode.QuickPickItem & { action?: string; sessionId?: string }> = [
          {
            label: "$(add) New Session",
            description: "Start a fresh conversation",
            action: "new",
          },
          {
            label: "$(edit) Rename Current Session",
            description: currentName,
            action: "rename",
          },
          {
            label: "",
            kind: vscode.QuickPickItemKind.Separator,
          },
        ];

        sessions.forEach(s => {
          items.push({
            label: s.name || s.id,
            description: s.id === this._currentSessionId ? "... Current" : (s.message_count ? `${s.message_count} msgs` : ""),
            sessionId: s.id,
            action: "switch",
          });
        });

        const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select a Session or Action" });
        if (!picked) return;

        if (picked.action === "new") {
          const res = await this._rpcClient?.call<SessionInfo>("session.create", {
            name: `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            project_path: workspaceFolder,
          });
          if (res?.id) {
            this.setCurrentSessionId(res.id);
            vscode.commands.executeCommand("andromity.refreshSessions");
          }
        } else if (picked.action === "rename") {
          const newName = await vscode.window.showInputBox({
            prompt: "Enter new name for current session",
            value: currentName,
          });
          if (newName && newName.trim()) {
            await this._rpcClient?.call("session.rename", {
              session_id: this._currentSessionId,
              name: newName.trim(),
              project_path: workspaceFolder,
            });
            this._postToWebview({ type: "session_updated", sessionId: this._currentSessionId, name: newName.trim() });
            vscode.commands.executeCommand("andromity.refreshSessions");
          }
        } else if (picked.action === "switch" && picked.sessionId && picked.sessionId !== this._currentSessionId) {
          this.setCurrentSessionId(picked.sessionId);
        }
        break;
      }

      case "undo_turn": {
        if (this._diffManager) {
          await this._diffManager.undoLastTurn(this._currentSessionId);
          await this._loadSession(this._currentSessionId);
          this._postToWebview({ type: "turn_undone" });
          vscode.commands.executeCommand("andromity.refreshChanges");
        } else if (this._rpcClient) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const res = await this._rpcClient.call<any>("session.undo", {
            session_id: this._currentSessionId,
            project_path: workspaceFolder,
          });
          if (res?.success) {
            vscode.window.showInformationMessage(`Turn undone successfully. (${res.popped_messages || 0} messages removed.)`);
            await this._loadSession(this._currentSessionId);
            this._postToWebview({ type: "turn_undone" });
          }
        }
        break;
      }

      case "compact_session": {
        try {
          this._postToWebview({
            type: "session_compacting",
            reason: "Compacting conversation context to reduce tokens...",
          });
          const res = await this._rpcClient.call<any>("session.compact", {
            session_id: this._currentSessionId,
          }, 35000);
          if (res?.skipped) {
            this._postToWebview({
              type: "session_compacted",
              skipped: true,
              reason: res.reason,
              old_count: res.old_count,
              message_count: res.message_count,
            });
            vscode.window.showInformationMessage(res.reason || "Conversation is already compact.");
          } else if (res?.error) {
            vscode.window.showWarningMessage(`Compaction notice: ${res.error}`);
            this._postToWebview({
              type: "session_compacted",
              error: res.error,
            });
          } else {
            vscode.window.showInformationMessage("Context compacted successfully.");
            await this._loadSession(this._currentSessionId);
            this._postToWebview({
              type: "session_compacted",
              old_count: res?.old_count,
              message_count: res?.message_count,
              context_tokens: res?.context_tokens,
            });
          }
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to compact context: ${e.message}`);
          this._postToWebview({
            type: "session_compacted",
            error: e.message,
          });
        }
        break;
      }

      case "apply_code": {
        await EditorBridge.applySnippetToEditor(message.code, message.mode || "insert_at_cursor");
        break;
      }

      case "copy_clipboard": {
        if (message.text) {
          await vscode.env.clipboard.writeText(message.text);
        }
        break;
      }

      case "open_diff": {
        if (this._diffManager) {
          await this._diffManager.showGitDiff();
        }
        break;
      }

      case "get_editor_context": {
        const ctx = EditorBridge.getActiveContext();
        this._postToWebview({ type: "editor_context", context: ctx });
        break;
      }

      case "select_model":
      case "update_config": {
        const key = message.key || (message.modelId ? "model" : undefined);
        const value = message.value || message.modelId;
        if (key) {
          const keyMap: Record<string, string> = {
            model: "model",
            provider: "provider",
            profile: "profile",
            reasoningEffort: "reasoning_effort",
            mode: "permission_mode",
          };
          const daemonKey = keyMap[key] || key;
          await this._rpcClient.call("config.set", {
            section: "default",
            key: daemonKey,
            value: value,
          });
          if (key === "model" && message.provider) {
            this._currentProvider = message.provider;
            await this._rpcClient.call("config.set", {
              section: "default",
              key: "provider",
              value: message.provider,
            });
          }
          switch (key) {
            case "model": this._currentModel = value; break;
            case "provider": this._currentProvider = value; break;
            case "profile": this._currentProfile = value; break;
            case "mode": this._currentMode = value; break;
            case "reasoningEffort": this._currentReasoning = value; break;
          }
          this._postToWebview({ type: "config_updated", key: key, value: value, provider: this._currentProvider });
          SettingsPanel.currentPanel?.loadData();
        }
        break;
      }

      case "webview_error": {
        console.error("[Andromity Webview Error]", message);
        break;
      }
    }
  }

  public _getHtmlForWebview(webview: vscode.Webview): string {
    return getChatViewHtml(webview, this._extensionUri, {
      currentSessionId: this._currentSessionId,
      currentModel: this._currentModel,
      currentProvider: this._currentProvider,
      currentMode: this._currentMode,
      currentProfile: this._currentProfile,
      currentReasoning: this._currentReasoning,
      models: this._models,
    });
  }
}
