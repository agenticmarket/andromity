import * as path from "path";
import * as vscode from "vscode";
import { DiffManager } from "../integrations/DiffManager.js";
import { EditorBridge } from "../integrations/EditorBridge.js";
import { SettingsPanel } from "../panels/SettingsPanel.js";
import { SessionTabPanel } from "../panels/SessionTabPanel.js";
import { WaterfallPanel } from "../panels/WaterfallPanel.js";
import { ChangesReviewPanel } from "../panels/ChangesReviewPanel.js";
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
import { getChatViewHtml, ChatViewState } from "./chatview/chatHtml.js";
import { PlanViewProvider } from "./PlanViewProvider.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "andromity.chatView";
  public static currentProvider: ChatViewProvider | null = null;
  private _view?: vscode.WebviewView;
  private _rpcClient: RpcClient | null = null;
  private _pythonBridge: PythonBridge | null = null;
  private _diffManager: DiffManager | null = null;
  private _currentSessionId: string = "";
  private _isExecuting: boolean = false;
  private _runningSessions: Set<string> = new Set<string>();
  private _sessionNames: Map<string, string> = new Map<string, string>();
  private _currentProfile: string = "builder";
  private _currentModel: string = "claude-sonnet-4-6";
  private _currentProvider: string = "anthropic";
  private _currentMode: string = "safe";
  private _currentReasoning: string = "medium";
  private _models: ModelInfo[] = [];
  private _providers: ProviderInfo[] = [];
  private _currentPlan: any = null;
  private _sessionPlans: Map<string, any> = new Map();
  private _planViewProvider: PlanViewProvider | null = null;

  /** workspaceState key persisting the session the user had active last. */
  private static readonly LAST_ACTIVE_SESSION_KEY = "andromity.lastActiveSessionId";

  /** Session id created for the current reload cycle in "fresh" startup mode.
   *  Guards against creating duplicate empty sessions when _loadInitialConfig
   *  fires more than once per window load. Cleared on explicit session switch. */
  private _freshSessionId: string | undefined;
  private _creatingSession: Promise<string | null> | null = null;

  private _boundClient: RpcClient | null = null;
  private _rpcDisposables: Array<() => void> = [];
  private _latestTurnFiles: Set<string> = new Set<string>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context?: vscode.ExtensionContext
  ) {
    ChatViewProvider.currentProvider = this;
    if (this._context) {
      let activeEditorDebounce: NodeJS.Timeout | null = null;
      const syncActiveEditor = () => {
        if (activeEditorDebounce) clearTimeout(activeEditorDebounce);
        activeEditorDebounce = setTimeout(() => {
          this.broadcastActiveEditorContext();
        }, 150);
      };

      this._context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration("andromity.wallpaper")) {
            this.broadcastWallpaperConfig();
          }
          if (e.affectsConfiguration("andromity.mascotEnabled")) {
            this.broadcastMascotConfig();
          }
        }),
        vscode.window.onDidChangeActiveTextEditor(syncActiveEditor),
        vscode.window.onDidChangeTextEditorSelection(syncActiveEditor),
        vscode.languages.onDidChangeDiagnostics(syncActiveEditor)
      );
    }
  }

  public broadcastActiveEditorContext() {
    const ctx = EditorBridge.getActiveContext();
    const payload = {
      type: "active_editor_context",
      context: {
        relativePath: ctx.relativePath || null,
        fileName: ctx.relativePath ? path.basename(ctx.relativePath) : null,
        languageId: ctx.languageId || null,
        cursorLine: ctx.cursorLine || null,
        cursorColumn: ctx.cursorColumn || null,
        hasSelection: !!ctx.selectedText,
        errorCount: ctx.diagnostics?.filter((d) => d.severity === "error").length || 0,
        warningCount: ctx.diagnostics?.filter((d) => d.severity === "warning").length || 0,
      },
    };
    this._postToWebview(payload);
    for (const tab of SessionTabPanel.getAllPanels()) {
      try { tab.postMessage(payload); } catch {}
    }
  }

  public broadcastMascotConfig() {
    const enabled = vscode.workspace.getConfiguration("andromity").get<boolean>("mascotEnabled", true);
    if (this._view) {
      this._postToWebview({
        type: "set_mascot_enabled",
        enabled: enabled,
      });
    }
    for (const tab of SessionTabPanel.getAllPanels()) {
      try {
        tab.postMessage({
          type: "set_mascot_enabled",
          enabled: enabled,
        });
      } catch {}
    }
  }

  public getWallpaperConfig(_webview?: vscode.Webview) {
    const cfg = vscode.workspace.getConfiguration("andromity.wallpaper");
    return {
      enabled: cfg.get<boolean>("enabled", false),
      rippleIntensity: cfg.get<"off" | "light" | "medium" | "strong">("rippleIntensity", "medium"),
      floatingAsterisks: cfg.get<boolean>("floatingAsterisks", true),
      cursorLightAura: cfg.get<boolean>("cursorLightAura", true),
    };
  }

  public broadcastWallpaperConfig() {
    if (this._view) {
      this._postToWebview({
        type: "wallpaper_config_changed",
        wallpaper: this.getWallpaperConfig(this._view.webview),
      });
    }
    for (const tab of SessionTabPanel.getAllPanels()) {
      try {
        tab.postMessage({
          type: "wallpaper_config_changed",
          wallpaper: this.getWallpaperConfig(tab.webview),
        });
      } catch {}
    }
  }

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
    // Also re-bind RPC client for any open SessionTabPanel tabs
    for (const tab of SessionTabPanel.getAllPanels()) {
      try { tab.setRpcClient(client); } catch {}
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
    this._isExecuting = false;
    this._runningSessions.clear();
    void vscode.commands.executeCommand("setContext", "andromity.isAgentRunning", false);
  }

  public isSessionRunning(sessionId?: string): boolean {
    const sid = sessionId || this._currentSessionId;
    if (!sid) return this._isExecuting;
    return this._runningSessions.has(sid) || (sid === this._currentSessionId && this._isExecuting);
  }

  public async showGitDiff(): Promise<void> {
    if (this._diffManager) {
      await this._diffManager.showGitDiff();
    }
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

  public setPlanViewProvider(provider: PlanViewProvider) {
    this._planViewProvider = provider;
  }

  public updateCurrentPlan(plan: any, sessionId?: string) {
    if (sessionId) {
      this._sessionPlans.set(sessionId, plan);
    }
    if (!sessionId || sessionId === this._currentSessionId) {
      this._currentPlan = plan;
      if (this._view) {
        this._view.webview.postMessage({ type: "plan_updated", plan, session_id: sessionId });
      }
    }
    if (this._planViewProvider) {
      this._planViewProvider.updatePlan(plan, sessionId);
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
      for (const s of sessions) {
        if (s.id && s.name) {
          this._sessionNames.set(s.id, s.name);
        }
        if (s.status === "running") {
          this._runningSessions.add(s.id);
        }
      }
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

  public setCurrentSessionId(sessionId: string, forceReload: boolean = false) {
    if (!forceReload && this._currentSessionId === sessionId) {
      return;
    }
    this._currentSessionId = sessionId;
    if (sessionId !== this._freshSessionId) {
      this._freshSessionId = undefined;
    }
    this._persistLastActiveSession(sessionId);
    if (this._view) {
      this._view.webview.postMessage({ type: "session_switched", sessionId });
      this._loadSession(sessionId);
    }
  }

  public async sendPromptFromExternal(
    prompt: string,
    context?: any,
    options?: { taskName?: string; forceNewSession?: boolean; forkSessionIfBusy?: boolean }
  ) {
    if (!this._view) {
      await vscode.commands.executeCommand("andromity.chatView.focus");
      for (let i = 0; i < 20 && !this._view; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const forkIfBusy = options?.forkSessionIfBusy ?? true;
    const isBusy = this.isSessionRunning(this._currentSessionId);
    const shouldFork = Boolean(options?.forceNewSession || (forkIfBusy && isBusy));

    if (shouldFork && this._rpcClient) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const taskTitle = options?.taskName || (
        prompt.length > 28 ? `${prompt.slice(0, 25).trim()}...` : prompt.trim()
      );
      const previousSessionId = this._currentSessionId;

      try {
        const newSess = await this._rpcClient.call<SessionInfo>("session.create", {
          name: taskTitle,
          project_path: workspaceFolder,
        });

        if (newSess?.id) {
          this._sessionNames.set(newSess.id, newSess.name || taskTitle);
          this._currentSessionId = newSess.id;
          this._persistLastActiveSession(newSess.id);

          if (this._view) {
            this._view.show?.(true);
            this._view.webview.postMessage({ type: "session_switched", sessionId: newSess.id });
            await this._loadSession(newSess.id);
          }

          void this.fetchAndPostSessions();
          void vscode.commands.executeCommand("andromity.refreshSessions");

          if (isBusy) {
            const prevName = this._sessionNames.get(previousSessionId) || "Previous Task";
            vscode.window.showInformationMessage(
              `Active session ("${prevName}") is currently running. Started "${taskTitle}" in a parallel session so your work is not interrupted.`,
              "View Previous Session"
            ).then((choice) => {
              if (choice === "View Previous Session" && previousSessionId) {
                this.setCurrentSessionId(previousSessionId);
              }
            });
          }

          if (this._view) {
            this._view.webview.postMessage({
              type: "external_prompt",
              prompt,
              context,
            });
          }
          return;
        }
      } catch (err: any) {
        console.warn("[Andromity] Failed to create parallel session, falling back to active session:", err);
      }
    }

    // Default / Idle path: Reuse active session so conversation history & context are preserved!
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
      try {
        vscode.commands.executeCommand("git.refresh");
        vscode.commands.executeCommand("andromity.refreshChanges");
      } catch {}
    } else if (this._rpcClient) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const res = await this._rpcClient.call<any>("session.undo", {
        session_id: this._currentSessionId,
        project_path: workspaceFolder,
      });
      if (res?.success) {
        try {
          vscode.commands.executeCommand("git.refresh");
          vscode.commands.executeCommand("andromity.refreshChanges");
        } catch {}
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

  /** Open a file directly in VS Code's editor, optionally jumping to a specific line. */
  public async openFile(filePath: string, line?: number): Promise<void> {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let cleanPath = filePath;
      const match = cleanPath.match(/^(.+?):(\d+)(?::\d+)?$/);
      if (match) {
        cleanPath = match[1];
        if (!line) line = parseInt(match[2], 10);
      }
      const absPath = path.isAbsolute(cleanPath) ? cleanPath : (ws ? path.join(ws, cleanPath) : cleanPath);
      const uri = vscode.Uri.file(absPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
    }
  }

  /** Attach a file as prompt context in the webview. */
  public attachFile(fsPath: string) {
    if (!fsPath) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let relPath = fsPath;
    if (ws && fsPath.startsWith(ws)) {
      relPath = path.relative(ws, fsPath).replace(/\\/g, "/");
    }
    const name = path.basename(fsPath);
    this._postToWebview({
      type: "file_attached",
      file: {
        name,
        path: relPath,
        fsPath,
      },
    });
    if (this._view) {
      this._view.show?.(true);
    }
  }

  /** Open native file picker to manually attach file(s) to chat prompt context. */
  public async pickAndAttachFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach File",
      title: "Attach File to Andromity Context",
    });
    if (!uris || uris.length === 0) return;
    for (const uri of uris) {
      this.attachFile(uri.fsPath);
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

  /** Open the dedicated Changes Review Webview tab. */
  public openReviewWebview(filePath?: string, turnFiles?: string[]) {
    const effectiveTurnFiles = turnFiles ?? (this._latestTurnFiles.size > 0 ? Array.from(this._latestTurnFiles) : undefined);
    if (this._diffManager) {
      this._diffManager.openReviewWebview(filePath, effectiveTurnFiles);
    } else if (this._context) {
      ChangesReviewPanel.createOrShow(this._extensionUri, this._rpcClient, filePath, effectiveTurnFiles);
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
      void this._rpcClient.call("telemetry.recordFeature", {
        feature: approved ? "plan_approved" : "plan_rejected",
        session_id: this._currentSessionId,
      }).catch(() => {});
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

    this.broadcastMascotConfig();
    this.broadcastActiveEditorContext();
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
      const sid = params?.session_id || this._currentSessionId;
      if (sid) {
        this._runningSessions.add(sid);
      }
      if (!sid || sid === this._currentSessionId) {
        this._isExecuting = true;
      }
      this._latestTurnFiles.clear();
      void vscode.commands.executeCommand("setContext", "andromity.isAgentRunning", true);
      this._postToWebview({ type: "agent_started", ...params });
      if (sid && this._context) {
        // Auto-open live Waterfall in an editor tab for the user's first 3 agent sessions
        const autoOpenCount = this._context.globalState.get<number>("andromity.waterfallAutoOpenCount", 0);
        if (autoOpenCount < 3) {
          void this._context.globalState.update("andromity.waterfallAutoOpenCount", autoOpenCount + 1);
          void this._context.globalState.update("andromity.waterfallFirstSessionShown", true);
          WaterfallPanel.createOrShow(
            this._extensionUri,
            sid,
            "Live Session",
            this._rpcClient,
            this._context,
            vscode.ViewColumn.Active
          );
          this._postToWebview({ type: "dismiss_waterfall_callout" });
        }
      }
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

    bind("agent/toolApprovalRequired", (params: ToolApprovalEvent) => {
      this._postToWebview({ type: "tool_approval_required", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
      }
    });

    bind("agent/askQuestions", (params: ClarifyingQuestionsEvent) => {
      this._postToWebview({ type: "ask_questions", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
      }
    });

    bind("agent/planApproval", (params: any) => {
      const sid = params.session_id;
      if (sid) {
        this._sessionPlans.set(sid, params.plan);
      }
      if (!sid || sid === this._currentSessionId) {
        this._currentPlan = params.plan;
        this._postToWebview({ type: "plan_approval", plan: params.plan, session_id: sid });
        const cfg = vscode.workspace.getConfiguration("andromity");
        if (cfg.get<boolean>("soundNotifications", true)) {
          this._postToWebview({ type: "play_sound", kind: "attention" });
        }
      }
      this._planViewProvider?.updatePlan(params.plan, sid);
    });

    bind("agent/planUpdated", (params: any) => {
      if (params.plan) {
        const sid = params.session_id;
        if (sid) {
          this._sessionPlans.set(sid, params.plan);
        }
        if (!sid || sid === this._currentSessionId) {
          this._currentPlan = params.plan;
          this._postToWebview({ type: "plan_updated", plan: params.plan, session_id: sid });
        }
        this._planViewProvider?.updatePlan(params.plan, sid);
      }
    });

    bind("session/updated", (params: any) => {
      if (params.session_id && params.name) {
        this._sessionNames.set(params.session_id, params.name);
      }
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

    bind("session/messageReceived", (params: any) => {
      this._postToWebview({ type: "session_message_received", ...params });
    });
    bind("session/questionReceived", (params: any) => {
      this._postToWebview({ type: "session_question_received", ...params });
    });
    bind("session/answerReceived", (params: any) => {
      this._postToWebview({ type: "session_answer_received", ...params });
    });
    bind("session/sharedStateChanged", (params: any) => {
      this._postToWebview({ type: "session_shared_state_changed", ...params });
    });
    bind("session/handoffWritten", (params: any) => {
      this._postToWebview({ type: "session_handoff_written", ...params });
    });

    bind("cron/run_started", (params: any) => {
      this.fetchAndPostCrons();
    });

    bind("cron/run_completed", (params: any) => {
      this.fetchAndPostCrons();
      const jobName = params.job?.name || "Scheduled Job";
      const status = params.run?.status || "completed";
      const durSec = params.run?.duration_ms ? (params.run.duration_ms / 1000).toFixed(1) : "0";
      const sessionId = params.run?.session_id;

      if (status === "success") {
        const msgPromise = sessionId
          ? vscode.window.showInformationMessage(`⏱ Cron "${jobName}" completed in ${durSec}s.`, "Open Session")
          : vscode.window.showInformationMessage(`⏱ Cron "${jobName}" completed in ${durSec}s.`);
        msgPromise.then((choice) => {
          if (choice === "Open Session" && sessionId) {
            vscode.commands.executeCommand("andromity.switchSessionById", sessionId);
          }
        });
      } else if (status === "failed") {
        const msgPromise = sessionId
          ? vscode.window.showWarningMessage(`⏱ Cron "${jobName}" failed: ${params.run?.error || "Error during execution"}`, "Open Session")
          : vscode.window.showWarningMessage(`⏱ Cron "${jobName}" failed: ${params.run?.error || "Error during execution"}`);
        msgPromise.then((choice) => {
          if (choice === "Open Session" && sessionId) {
            vscode.commands.executeCommand("andromity.switchSessionById", sessionId);
          }
        });
      }
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
      const sid = params?.session_id || this._currentSessionId;
      if (sid) {
        this._runningSessions.delete(sid);
      }
      if (!sid || sid === this._currentSessionId) {
        this._isExecuting = false;
      }
      if (this._runningSessions.size === 0) {
        void vscode.commands.executeCommand("setContext", "andromity.isAgentRunning", false);
      }

      const turnFiles: string[] | undefined = params?.turn_files;
      if (Array.isArray(turnFiles)) {
        this._latestTurnFiles = new Set(turnFiles);
        if (ChangesReviewPanel.currentPanel) {
          ChangesReviewPanel.currentPanel.setTurnFiles(turnFiles);
        }
      }

      this._postToWebview({ type: "agent_done", ...params, turn_files: turnFiles });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "done" });
      }
      vscode.commands.executeCommand("andromity.refreshChanges");

      if (sid && sid !== this._currentSessionId) {
        const name = this._sessionNames.get(sid) || "Parallel Task";
        vscode.window.showInformationMessage(
          `Parallel task completed in session "${name}".`,
          "Switch to Session"
        ).then((choice) => {
          if (choice === "Switch to Session") {
            this.setCurrentSessionId(sid);
          }
        });
      }
    });

    bind("agent/cancelled", (params: any) => {
      const sid = params?.session_id || this._currentSessionId;
      if (sid) {
        this._runningSessions.delete(sid);
      }
      if (!sid || sid === this._currentSessionId) {
        this._isExecuting = false;
      }
      if (this._runningSessions.size === 0) {
        void vscode.commands.executeCommand("setContext", "andromity.isAgentRunning", false);
      }
      void this._rpcClient?.call("telemetry.recordFeature", { feature: "turn_cancelled", session_id: sid }).catch(() => {});
      this._postToWebview({ type: "agent_cancelled", ...params });
    });

    bind("agent/error", (params: any) => {
      const sid = params?.session_id || this._currentSessionId;
      if (sid) {
        this._runningSessions.delete(sid);
      }
      if (!sid || sid === this._currentSessionId) {
        this._isExecuting = false;
      }
      if (this._runningSessions.size === 0) {
        void vscode.commands.executeCommand("setContext", "andromity.isAgentRunning", false);
      }
      const errStr = String(params?.error || "").toLowerCase();
      let cat = "error_generic";
      if (errStr.includes("401") || errStr.includes("unauthorized") || errStr.includes("invalid api key") || errStr.includes("authentication")) {
        cat = "error_auth";
      } else if (errStr.includes("429") || errStr.includes("rate limit") || errStr.includes("quota")) {
        cat = "error_rate_limit";
      } else if (errStr.includes("context length") || errStr.includes("maximum context") || errStr.includes("token limit")) {
        cat = "error_context_length";
      } else if (errStr.includes("timeout") || errStr.includes("timed out")) {
        cat = "error_timeout";
      } else if (errStr.includes("tool") || errStr.includes("command failed")) {
        cat = "error_tool_execution";
      }
      void this._rpcClient?.call("telemetry.recordFeature", { feature: cat, session_id: sid }).catch(() => {});
      this._postToWebview({ type: "agent_error", ...params });
    });

    bind("session/compacting", (params: any) => {
      this._postToWebview({ type: "session_compacting", ...params });
    });

    bind("session/compacted", (params: any) => {
      this._postToWebview({ type: "session_compacted", ...params });
    });
  }

  private async _checkAndAutoConnectOllama(providers: ProviderInfo[]): Promise<string | null> {
    const hasAnyKey = providers.some((p) => p.has_key);
    return new Promise((resolve) => {
      try {
        const http = require("http");
        const req = http.get("http://127.0.0.1:11434/api/tags", { timeout: 350 }, (res: any) => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          let raw = "";
          res.on("data", (chunk: any) => { raw += chunk; });
          res.on("end", () => {
            try {
              const data = JSON.parse(raw);
              const models = (data.models || []).map((m: any) => m.name || m.model);
              if (models.length > 0) {
                const bestModel =
                  models.find((m: string) => /qwen|coder/i.test(m)) ||
                  models.find((m: string) => /deepseek/i.test(m)) ||
                  models.find((m: string) => /llama/i.test(m)) ||
                  models[0];
                if (!hasAnyKey || this._currentProvider === "ollama") {
                  this._currentProvider = "ollama";
                  this._currentModel = bestModel;
                  void this._rpcClient?.call("config.set", { section: "default", key: "provider", value: "ollama" }).catch(() => {});
                  void this._rpcClient?.call("config.set", { section: "default", key: "model", value: bestModel }).catch(() => {});
                }
                resolve(bestModel);
                return;
              }
            } catch {}
            resolve(null);
          });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
      } catch {
        resolve(null);
      }
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

      const detectedOllama = await this._checkAndAutoConnectOllama(this._providers);
      if (detectedOllama) {
        const existingOllamaModel = (this._models || []).find((m) => m.id === detectedOllama || m.name === detectedOllama);
        if (!existingOllamaModel) {
          this._models.push({
            id: detectedOllama,
            name: detectedOllama,
            provider: "ollama",
            desc: "Local Ollama Model",
            is_free: true,
            tags: ["local", "coding"],
          } as any);
        }
      }

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
        waterfallFirstSessionShown: this._context?.globalState.get<boolean>("andromity.waterfallFirstSessionShown", false) || false,
        wallpaper: this.getWallpaperConfig(this._view?.webview),
        mascotEnabled: vscode.workspace.getConfiguration("andromity").get<boolean>("mascotEnabled", true),
        ollamaDetectedModel: detectedOllama,
      });
    } catch (e: any) {
      console.error("[Andromity Chat] Initial config load failed:", e);
    }
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
      if (sessionData?.name) {
        this._sessionNames.set(sessionId, sessionData.name);
      }
      if (sessionData && sessionData.plan && sessionData.plan.steps && sessionData.plan.steps.length > 0) {
        this._currentPlan = sessionData.plan;
      } else {
        this._currentPlan = null;
      }
      this._sessionPlans.set(sessionId, this._currentPlan);
      this._postToWebview({
        type: "plan_updated",
        plan: this._currentPlan,
        session_id: sessionId,
      });
      this._planViewProvider?.updatePlan(this._currentPlan, sessionId);
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
        message.tab || "keys",
        () => this.refreshConfig()
      );
      return;
    }

    if (message.type === "open_about") {
      SettingsPanel.createOrShow(
        this._extensionUri,
        this._rpcClient,
        "about",
        () => this.refreshConfig()
      );
      return;
    }

    if (message.type === "open_personalisation") {
      SettingsPanel.createOrShow(
        this._extensionUri,
        this._rpcClient,
        "personalisation",
        () => {
          this.broadcastWallpaperConfig();
          this.broadcastMascotConfig();
        }
      );
      return;
    }

    if (message.type === "update_mascot_setting") {
      const config = vscode.workspace.getConfiguration("andromity");
      await config.update("mascotEnabled", !!message.enabled, vscode.ConfigurationTarget.Global);
      this.broadcastMascotConfig();
      return;
    }

    if (message.type === "open_diff" || message.type === "open_review_tab" || message.type === "open_changes_review") {
      this.openReviewWebview(message.filePath, message.turnFiles);
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
          promptText = EditorBridge.formatPromptWithEditorState(
            promptText,
            editorContext,
            message.attachContext !== false
          );

          const targetSessionId = message.sessionId || this._currentSessionId;
          if (!this._currentSessionId && targetSessionId) {
            this._currentSessionId = targetSessionId;
          }
          if (!targetSessionId) {
            const newSess = await this._rpcClient.call<SessionInfo>("session.create", {
              name: "Main Session",
              project_path: workspaceFolder,
            }).catch(() => ({ id: "main-session" } as SessionInfo));
            this._currentSessionId = newSess.id;
            this._persistLastActiveSession();
          }

          const cleanModel = (message.model || this._currentModel || "").replace(/^~+/, "");
          const activeSid = targetSessionId || this._currentSessionId;
          if (activeSid) {
            this._runningSessions.add(activeSid);
            if (activeSid === this._currentSessionId) {
              this._isExecuting = true;
            }
            void vscode.commands.executeCommand("setContext", "andromity.isAgentRunning", true);
          }
          void this._rpcClient.call("telemetry.recordFeature", {
            feature: "prompt_sent",
            session_id: activeSid,
          }).catch(() => {});

          const slashMatch = (promptText || "").trim().match(/^\/([a-zA-Z0-9_-]+)/);
          if (slashMatch) {
            void this._rpcClient.call("telemetry.recordFeature", {
              feature: `slash_${slashMatch[1].toLowerCase()}`,
              session_id: activeSid,
            }).catch(() => {});
          }

          await this._rpcClient.call("agent.prompt", {
            session_id: activeSid,
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
          const activeSid = message.sessionId || this._currentSessionId;
          const msg = err.message || String(err);
          const lowerMsg = msg.toLowerCase();

          // Zero-PII error classification
          let errCategory = "error_generic";
          if (lowerMsg.includes("already running a turn") || lowerMsg.includes("-32603") || lowerMsg.includes("agent_busy")) {
            errCategory = "error_agent_busy";
          } else if (lowerMsg.includes("rpc timeout") || lowerMsg.includes("timed out")) {
            errCategory = "error_rpc_timeout";
          } else if (lowerMsg.includes("401") || lowerMsg.includes("unauthorized") || lowerMsg.includes("invalid api key") || lowerMsg.includes("authentication")) {
            errCategory = "error_auth";
          } else if (lowerMsg.includes("429") || lowerMsg.includes("rate limit") || lowerMsg.includes("quota")) {
            errCategory = "error_rate_limit";
          } else if (lowerMsg.includes("context length") || lowerMsg.includes("maximum context") || lowerMsg.includes("token limit")) {
            errCategory = "error_context_length";
          }
          void this._rpcClient?.call("telemetry.recordFeature", {
            feature: errCategory,
            session_id: activeSid,
          }).catch(() => {});

          if (msg.includes("already running a turn") || msg.includes("-32603") || msg.includes("AGENT_BUSY")) {
            vscode.window.showInformationMessage("Agent is still working on the previous turn. Your message was queued and will send automatically when it finishes.");
            this._postToWebview({ type: "agent_busy", error: msg, queuedPrompt: promptText });
          } else if (msg.includes("RPC timeout")) {
            vscode.window.showWarningMessage("Agent started but confirmation timed out. Streaming will continue -- check the chat for progress. If stuck, use Cancel.");
            this._postToWebview({ type: "agent_started", session_id: this._currentSessionId });
          } else {
            if (activeSid) {
              this._runningSessions.delete(activeSid);
              if (activeSid === this._currentSessionId) {
                this._isExecuting = false;
              }
              if (this._runningSessions.size === 0) {
                void vscode.commands.executeCommand("setContext", "andromity.isAgentRunning", false);
              }
            }
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

          // Fetch real models live from the provider API using verified key
          let liveModels: ModelInfo[] = [];
          try {
            liveModels = await this._rpcClient.call<ModelInfo[]>("config.refresh_models", {
              provider,
            }, 6000);
          } catch (e) {
            liveModels = await this._rpcClient.call<ModelInfo[]>("config.list_models", {
              provider,
            }, 3000).catch(() => []);
          }

          const providers = await this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}).catch(() => []);
          this._providers = providers || [];

          // Filter models for this provider
          const providerModels = (liveModels || []).filter((m: any) => {
            if (provider === "openrouter") return m.provider === "openrouter" || m.id?.includes("/");
            return !m.provider || m.provider === provider;
          });

          if (providerModels.length > 0) {
            this._models = liveModels;
            void this._rpcClient?.call("telemetry.recordFeature", {
              feature: "onboarding_key_saved",
              session_id: this._currentSessionId,
            }).catch(() => {});
            this._postToWebview({
              type: "key_configured_select_model",
              provider,
              models: providerModels,
              defaultModel: modelId || providerModels[0].id,
            });
          } else {
            if (modelId) {
              await this._rpcClient.call("config.set", {
                section: "default",
                key: "model",
                value: modelId,
              });
              this._currentModel = modelId;
            }

            void this._rpcClient?.call("telemetry.recordFeature", {
              feature: "onboarding_completed",
              session_id: this._currentSessionId,
            }).catch(() => {});

            vscode.window.showInformationMessage(
              `Connected to ${provider || "AI Provider"}! You're ready to code.`
            );

            await this._loadInitialConfig(false);
            this._postToWebview({
              type: "key_configured_success",
              provider,
              model: this._currentModel,
            });
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to configure provider: ${err.message}`);
          this._postToWebview({
            type: "key_configure_failed",
            error: err.message,
          });
        }
        break;
      }

      case "finish_onboarding_model": {
        try {
          const provider = message.provider;
          const modelId = message.modelId;

          if (modelId) {
            await this._rpcClient.call("config.set", {
              section: "default",
              key: "model",
              value: modelId,
            });
            this._currentModel = modelId;
          }

          void this._rpcClient?.call("telemetry.recordFeature", {
            feature: "onboarding_completed",
            session_id: this._currentSessionId,
          }).catch(() => {});

          vscode.window.showInformationMessage(
            `Connected to ${provider || "AI Provider"}! Using model ${modelId || "ready"}.`
          );

          await this._loadInitialConfig(false);
          this._postToWebview({
            type: "key_configured_success",
            provider,
            model: this._currentModel,
          });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to configure model: ${err.message}`);
          this._postToWebview({
            type: "key_configured_success",
            provider: message.provider,
            model: this._currentModel,
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
        let nextMode = modes[nextIdx];

        if (nextMode === "yolo") {
          const confirm = await vscode.window.showWarningMessage(
            "⚠️ Enter YOLO Mode? Autonomous agent will execute shell commands and edit files without confirmation.",
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
        this._postToWebview({ type: "config_updated", key: "mode", value: this._currentMode });
        void this._rpcClient?.call("telemetry.recordFeature", { feature: "mode_" + this._currentMode }).catch(() => {});
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
          session_id: this._currentSessionId,
          approved: true,
          scope: message.scope || "once",
          tool_name: message.toolName,
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
          session_id: this._currentSessionId,
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
          session_id: this._currentSessionId,
          answers: message.answers,
        });
        break;
      }

      case "cancel_turn": {
        const targetSessionId = message.sessionId || this._currentSessionId;
        if (targetSessionId) {
          this._runningSessions.delete(targetSessionId);
          if (targetSessionId === this._currentSessionId) {
            this._isExecuting = false;
          }
          if (this._runningSessions.size === 0) {
            void vscode.commands.executeCommand("setContext", "andromity.isAgentRunning", false);
          }
        }
        try {
          void this._rpcClient?.call("telemetry.recordFeature", { feature: "turn_cancelled", session_id: targetSessionId }).catch(() => {});
          await this._rpcClient.call("agent.cancel", {
            session_id: targetSessionId,
          });
        } catch (e: any) {
          console.warn("[Andromity] cancel_turn RPC failed:", e?.message || e);
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
            this.setCurrentSessionId(this._currentSessionId, true);
            await this.fetchAndPostSessions();
            break;
          }
        }
        this._creatingSession = (async () => {
          const r = await this._rpcClient!.call<SessionInfo>("session.create", {
            name: message.name || `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            project_path: workspaceFolder,
          });
          this._currentPlan = null;
          void this._rpcClient?.call("telemetry.recordFeature", { feature: "session_created" }).catch(() => {});
          this._sessionPlans.set(r.id, null);
          this._postToWebview({
            type: "plan_updated",
            plan: null,
            session_id: r.id,
          });
          this._planViewProvider?.updatePlan(null, r.id);
          this.setCurrentSessionId(r.id);
          await this.fetchAndPostSessions();
          vscode.commands.executeCommand("andromity.refreshSessions");
          return r.id;
        })();
        try { await this._creatingSession; } finally { this._creatingSession = null; }
        break;
      }

      case "open_file": {
        if (message.filePath) {
          await this.openFile(message.filePath, message.line);
        }
        break;
      }

      case "pick_file_attachment": {
        await this.pickAndAttachFile();
        break;
      }

      case "open_file_diff": {
        if (message.filePath) {
          void this._rpcClient?.call("telemetry.recordFeature", { feature: "side_by_side_diff", session_id: this._currentSessionId }).catch(() => {});
          await this.openFileDiff(message.filePath, false);
        }
        break;
      }

      case "open_review_tab":
      case "open_changes_review": {
        this.openReviewWebview(message.filePath, message.turnFiles);
        break;
      }

      case "get_file_diff_stats": {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
          const res = await this._rpcClient?.call<{ files: Record<string, { additions: number; deletions: number }> }>(
            "git.diff_numstat",
            { project_path: ws }
          );
          if (res?.files) {
            this._postToWebview({
              type: "file_diff_stats_result",
              stats: res.files,
            });
          }
        } catch {}
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
            this,
            message.queue,
            {
              draft: message.draft || "",
              images: message.images || [],
              seedMessages: message.seedMessages || [],
            }
          );
          // If shifting the active session from the sidebar to an editor tab,
          // give the sidebar a fresh new session so it starts clean!
          if (sid === this._currentSessionId) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (this._rpcClient) {
              const r = await this._rpcClient.call<SessionInfo>("session.create", {
                name: `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
                project_path: workspaceFolder,
                keep_id: sid,
              }).catch(() => null);
              if (r && r.id) {
                this.setCurrentSessionId(r.id);
                await this.fetchAndPostSessions();
                vscode.commands.executeCommand("andromity.refreshSessions");
              }
            }
          }
        }
        break;
      }

      case "open_waterfall": {
        const sid = message.sessionId || this._currentSessionId;
        const sname = message.sessionName || "Chat Session";
        if (sid) {
          void this._rpcClient?.call("telemetry.recordFeature", { feature: "waterfall", session_id: sid }).catch(() => {});
          if (this._context) {
            void this._context.globalState.update("andromity.waterfallFirstSessionShown", true);
          }
          WaterfallPanel.createOrShow(
            this._extensionUri,
            sid,
            sname,
            this._rpcClient,
            this._context!
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

      case "cron_run_now": {
        if (this._rpcClient && message.id) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          vscode.window.showInformationMessage(`Triggering scheduled task "${message.name || message.id}"...`);
          await this._rpcClient.call("cron.run_now", {
            id: message.id,
            project_path: workspaceFolder,
          }).catch((e: any) => vscode.window.showErrorMessage(`Failed to trigger cron: ${e.message}`));
          await this.fetchAndPostCrons();
        }
        break;
      }

      case "cron_toggle": {
        if (this._rpcClient && message.id) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("cron.toggle", {
            id: message.id,
            project_path: workspaceFolder,
          }).catch((e: any) => vscode.window.showErrorMessage(`Failed to toggle cron: ${e.message}`));
          await this.fetchAndPostCrons();
        }
        break;
      }

      case "open_cron_settings": {
        vscode.commands.executeCommand("andromity.openSettings", "crons");
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
        const turnIndex = message.turnIndex;
        const turnsToUndo = message.turnsToUndo ?? (turnIndex !== undefined && message.totalTurns ? message.totalTurns - turnIndex : 1);
        if (this._diffManager) {
          const undone = await this._diffManager.undoLastTurn(this._currentSessionId, turnIndex, turnsToUndo);
          if (undone) {
            await this._loadSession(this._currentSessionId);
            this._postToWebview({ type: "turn_undone", turnsUndone: turnsToUndo, targetTurnIndex: turnIndex });
            try {
              vscode.commands.executeCommand("git.refresh");
              vscode.commands.executeCommand("andromity.refreshChanges");
            } catch {}
          }
        } else if (this._rpcClient) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const res = await this._rpcClient.call<any>("session.undo", {
            session_id: this._currentSessionId,
            project_path: workspaceFolder,
            turn_index: turnIndex,
            turns_to_undo: turnsToUndo,
          });
          if (res?.success) {
            try {
              vscode.commands.executeCommand("git.refresh");
              vscode.commands.executeCommand("andromity.refreshChanges");
            } catch {}
            const countMsg = (res.turns_undone && res.turns_undone > 1) ? `${res.turns_undone} turns undone` : "Turn undone";
            vscode.window.showInformationMessage(`${countMsg} successfully. (${res.popped_messages || 0} messages removed.)`);
            await this._loadSession(this._currentSessionId);
            this._postToWebview({ type: "turn_undone", turnsUndone: res.turns_undone, targetTurnIndex: res.target_turn_index });
          }
        }
        void this._rpcClient?.call("telemetry.recordFeature", { feature: "turn_undone" }).catch(() => {});
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
        void this._rpcClient?.call("telemetry.recordFeature", { feature: "code_inserted", session_id: this._currentSessionId }).catch(() => {});
        await EditorBridge.applySnippetToEditor(message.code, message.mode || "insert_at_cursor");
        break;
      }

      case "copy_clipboard": {
        if (message.text) {
          void this._rpcClient?.call("telemetry.recordFeature", { feature: "code_copied", session_id: this._currentSessionId }).catch(() => {});
          await vscode.env.clipboard.writeText(message.text);
        }
        break;
      }

      case "open_diff": {
        void this._rpcClient?.call("telemetry.recordFeature", { feature: "open_diff", session_id: this._currentSessionId }).catch(() => {});
        this.openReviewWebview(message.filePath, message.turnFiles);
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
          void this._rpcClient?.call("telemetry.recordFeature", { feature: `config_${daemonKey}`, session_id: this._currentSessionId }).catch(() => {});
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

      case "telemetry_feature": {
        const feature = message.feature;
        const sid = message.sessionId || this._currentSessionId;
        if (feature && this._rpcClient) {
          void this._rpcClient.call("telemetry.recordFeature", {
            feature,
            session_id: sid,
          }).catch(() => {});
        }
        break;
      }

      case "webview_error": {
        console.error("[Andromity Webview Error]", message);
        break;
      }
    }
  }

  public _getHtmlForWebview(webview: vscode.Webview, customState?: Partial<ChatViewState>): string {
    return getChatViewHtml(webview, this._extensionUri, {
      currentSessionId: customState?.currentSessionId ?? this._currentSessionId,
      currentModel: customState?.currentModel ?? this._currentModel,
      currentProvider: customState?.currentProvider ?? this._currentProvider,
      currentMode: customState?.currentMode ?? this._currentMode,
      currentProfile: customState?.currentProfile ?? this._currentProfile,
      currentReasoning: customState?.currentReasoning ?? this._currentReasoning,
      models: customState?.models ?? this._models,
      wallpaperConfig: customState?.wallpaperConfig ?? this.getWallpaperConfig(webview),
      defaultWallpaperUri: customState?.defaultWallpaperUri ?? webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "wildcat-panther-dusk.jpg")).toString(),
    });
  }
}
