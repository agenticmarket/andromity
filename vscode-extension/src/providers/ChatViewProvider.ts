import * as fs from "fs";
import { airGapPillMessage, currentAirGap } from "../airgapState.js";
import { AwayBadge, AwayEvent } from "../awayBadge.js";
import { collectStarterContext, watchStarterContext } from "../smartStarters.js";
import { copySessionAsMarkdown } from "../chatMarkdown.js";
import { SidePanelPart } from "../sidePanelData.js";
import { normalizeSidePanelPreferences } from "../sidePanelPreferences.js";
import { runSidePanelCommand, SidePanelFeed } from "../sidePanelFeed.js";
import { airGapOffMessage } from "../airgap.js";
import * as path from "path";
import * as vscode from "vscode";
import { DiffManager } from "../integrations/DiffManager.js";
import { EditorBridge } from "../integrations/EditorBridge.js";
import { runCodeBlockInTerminal } from "../integrations/TerminalRunner.js";
import { confirmRewindAndResend, resendPromptOf } from "../integrations/rewind.js";
import { handlePromptImageMessage, undonePromptOf } from "../integrations/promptImages.js";
import { SettingsPanel } from "../panels/SettingsPanel.js";
import { SessionTabPanel } from "../panels/SessionTabPanel.js";
import { WaterfallPanel } from "../panels/WaterfallPanel.js";
import { FingerprintPanel } from "../panels/FingerprintPanel.js";
import { BackgroundTaskPanel } from "../panels/BackgroundTaskPanel.js";
import { ChangesReviewPanel } from "../panels/ChangesReviewPanel.js";
import { PythonBridge } from "../server/PythonBridge.js";
import { RpcClient } from "../server/RpcClient.js";
import { handleInputMessage } from "../server/inputBridge.js";
import { handleInteractionMessage, reportDisconnectedAction } from "../server/interactionBridge.js";
import { SessionHydration } from "../server/sessionHydration.js";
import {
  allowOpenPath,
  clampPromptMode,
  confirmAndromityTrust,
  confirmPermissionMode,
  resolveWebviewConfigWrite,
} from "../server/securityPolicy.js";
import {
  ClarifyingQuestionsEvent,
  ModelInfo,
  PinnedModelInfo,
  ProviderInfo,
  SessionInfo,
  SessionUndoResult,
  SubAgentEvent,
  ToolApprovalEvent,
} from "../server/types.js";
import { getChatViewHtml, ChatViewState } from "./chatview/chatHtml.js";
import { PlanViewProvider } from "./PlanViewProvider.js";
import { accountUrl } from "./accountEndpoints.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import { FeatureTipsController } from "../engagement/featureTipsController.js";
import { isFeatureTipId, isSourcePath, isTestPath } from "../engagement/featureTips.js";
import { DOCS } from "../docsLinks.js";
import { cronRunToast, SCHEDULED_RUN_BUSY, SCHEDULED_RUN_BUSY_TEXT } from "../cronNotifications.js";
import { wakeSessionForQuestion } from "../collabActions.js";
import { recordNextStepEvent } from "../nextSteps.js";
import { handleFeedbackMessage } from "../engagement/feedbackWebview.js";
import { ANNOYANCES } from "../engagement/checkIn.js";
import type { FeedbackNotifications } from "../engagement/feedbackNotifications.js";
import { checkSessionForNavigation } from "../sessionNavigation.js";
import { confirmAndOpenLink } from "../linkOpener.js";

let chatViewOpenRecorded = false;

export interface OllamaStatus {
  running: boolean;
  installed: boolean;
  models: string[];
  bestModel: string | null;
  host: string;
}

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
  private _waterfallAutoOpenedSessions: Set<string> = new Set<string>();
  private _sessionNames: Map<string, string> = new Map<string, string>();
  private _currentProfile: string = "builder";
  private _currentModel: string = "";
  private _currentProvider: string = "";
  private _currentMode: string = "safe";
  private _currentReasoning: string = "medium";
  private _models: ModelInfo[] = [];
  private _pinnedModels: PinnedModelInfo[] = [];
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

  /** Startup state load shared by setRpcClient, resolveWebviewView and the
   *  webview's ready message, which used to each run it in full. */
  private _startupLoad: Promise<void> | null = null;
  /** Incremented whenever the chat webview is (re)created. */
  private _viewGeneration = 0;
  private _delivered: { generation: number; client: RpcClient } | null = null;
  private _webviewReady = false;
  private _webviewReadyWaiters: Array<() => void> = [];
  private _workspaceIndex: Promise<{ files: string[]; dirs: string[] }> | null = null;
  private _workspaceIndexTimer: NodeJS.Timeout | null = null;
  private _latestTurnFiles: Set<string> = new Set<string>();
  private _hydration = new SessionHydration();

  public async undoSession(sessionId: string, turnIndex?: number, turnsToUndo?: number): Promise<SessionUndoResult | undefined> {
    return this._diffManager ? this._diffManager.undoLastTurn(sessionId, turnIndex, turnsToUndo) : undefined;
  }
  private _configData: any = null;
  private _lastOllamaStatus: OllamaStatus | null = null;
  private _ollamaTerminal: vscode.Terminal | null = null;
  private _ollamaBinaryPath: string | null = null;
  private _ollamaAppBinaryPath: string | null = null;
  private _ollamaInstalledCached: boolean | null = null;

  public isViewVisible(): boolean {
    return !!(this._view && this._view.visible);
  }

  private _viewStateListeners: Array<() => void> = [];
  private _sidePanelFeed = new SidePanelFeed(() => this._rpcClient, (message) => this._postToWebview(message));

  public async saveSidePanelVisibility(off: unknown): Promise<void> {
    if (typeof off !== "boolean") return;
    await this._context?.globalState?.update("andromity.sidePanelOff", off);
    this.broadcastToWebviews({ type: "side_panel_visibility", off });
  }

  public async saveSidePanelPreferences(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const preferences = normalizeSidePanelPreferences(value);
    await this._context?.globalState?.update("andromity.sidePanel", preferences);
    this.broadcastToWebviews({ type: "side_panel_preferences", preferences });
  }

  /** Sends MCP status and uncommitted changes to the chat's side panel and MCP icon (debounced). */
  private _refreshSidePanel(parts: SidePanelPart[] = ["mcp", "changes"]) {
    this._sidePanelFeed?.refresh(parts);
  }
  private _awayBadge = new AwayBadge();

  /** Badge the Andromity icon for replies and requests that arrive while the chat is hidden. */
  private _noteWhileAway(event: AwayEvent, params?: any) {
    if (!this._view || this._view.visible || params?.scheduled) return;
    this._awayBadge.note(event);
    this._view.badge = this._awayBadge.badge();
  }

  /** Fires when the session in view or the chat's visibility changes. */
  public onDidChangeViewState(listener: () => void): vscode.Disposable {
    this._viewStateListeners.push(listener);
    return { dispose: () => { this._viewStateListeners = this._viewStateListeners.filter((l) => l !== listener); } };
  }

  private _fireViewStateChanged() {
    for (const listener of this._viewStateListeners || []) listener();
  }

  /** Shows or hides the Air-gap pill in every chat view. */
  public broadcastAirGapState() {
    this.broadcastToWebviews(airGapPillMessage());
  }

  public async copyCurrentChatAsMarkdown(): Promise<void> {
    await copySessionAsMarkdown(this._rpcClient, this._currentSessionId);
  }

  public getSessionName(sessionId: string): string | undefined {
    return this._sessionNames?.get(sessionId);
  }

  public isSoundEnabled(kind: "done" | "attention" = "done"): boolean {
    const cfg = vscode.workspace.getConfiguration("andromity");
    const vsCodeEnabled = cfg.get<boolean>("soundNotifications", true);
    if (!vsCodeEnabled) return false;
    if (this._configData) {
      if (kind === "done" && this._configData.sound_done === false) return false;
      if (kind === "attention" && this._configData.sound_attention === false) return false;
    }
    return true;
  }

  public getCurrentModel(): string | undefined {
    return this._currentModel || undefined;
  }

  /** Settings a turn started outside the chat view (native chat, Copilot tool) should use. */
  public getTurnDefaults(): { model: string; provider: string; mode: string; profile: string; reasoningEffort: string } {
    return {
      model: this._currentModel,
      provider: this._currentProvider,
      mode: this._currentMode,
      profile: this._currentProfile,
      reasoningEffort: this._currentReasoning,
    };
  }

  public getCurrentProvider(): string | undefined {
    return this._currentProvider || undefined;
  }

  public hasRunningSessions(): boolean {
    return (this._runningSessions?.size || 0) > 0;
  }

  private readonly _featureTips: FeatureTipsController | null;
  private _checkIn: FeedbackNotifications | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context?: vscode.ExtensionContext
  ) {
    ChatViewProvider.currentProvider = this;
    this._featureTips = this._context ? new FeatureTipsController(this._context.globalState) : null;
    if (this._featureTips) this._context?.subscriptions.push(this._featureTips);
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
        vscode.window.onDidChangeTextEditorSelection((e) => {
          if (e.textEditor === vscode.window.activeTextEditor) syncActiveEditor();
        }),
        vscode.languages.onDidChangeDiagnostics((e) => {
          const active = vscode.window.activeTextEditor?.document.uri.toString();
          if (active && e.uris.some((uri) => uri.toString() === active)) syncActiveEditor();
        })
      );
      const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
      const invalidateIndex = () => this._scheduleWorkspaceIndexRefresh();
      this._context.subscriptions.push(
        watcher,
        watcher.onDidCreate(invalidateIndex),
        watcher.onDidDelete(invalidateIndex),
        vscode.workspace.onDidChangeWorkspaceFolders(invalidateIndex)
      );
    }
  }

  private async _handleFeatureTipMessage(message: any): Promise<void> {
    const tips = this._featureTips;
    if (!tips) return;
    if (message.type === "turn_finished") {
      const sessionId = String(message.sessionId || this._currentSessionId || "");
      const count = (value: unknown) => Math.max(0, Number(value) || 0);
      const files: string[] = Array.isArray(message.editedFiles)
        ? message.editedFiles.filter((f: unknown): f is string => typeof f === "string" && !!f)
        : [];
      const sourceFiles = files.filter(isSourcePath);
      const tip = await tips.onTurnFinished({
        sessionId,
        filesEdited: files.length,
        sourceFilesEdited: sourceFiles.length,
        testFilesEdited: files.filter(isTestPath).length,
        toolCalls: count(message.toolCalls),
        shellCommands: count(message.shellCommands),
        inGitRepo: this._inGitRepo(),
        scheduled: message.scheduled === true,
        localModel: this._currentProvider === "ollama",
        airGapOn: currentAirGap().enabled,
        mcpServers: tips.wantsMcpCount() ? await this._mcpServerCount() : -1,
      });
      if (tip && sessionId === this._currentSessionId) {
        const file = tip === "generate_tests" ? sourceFiles[0] : tip === "inline_edit" ? files[0] : "";
        this._postToWebview({ type: "feature_tip", session_id: sessionId, tip, file: file || "" });
      }
      return;
    }
    if (message.type === "feature_tip_off") {
      await tips.turnOff();
      return;
    }
    if (!isFeatureTipId(message.tip)) return;
    if (message.type === "feature_tip_hide") {
      await tips.hide(message.tip);
      return;
    }
    await tips.acted(message.tip);
    switch (message.tip) {
      case "fingerprint":
        await vscode.commands.executeCommand("andromity.openFingerprint");
        break;
      case "commit_message":
        await vscode.commands.executeCommand("workbench.view.scm");
        await vscode.commands.executeCommand("andromity.generateCommitMessage");
        break;
      case "inline_edit":
        if (typeof message.file === "string" && message.file) await this.openFile(message.file);
        break;
      case "cron_jobs":
        await vscode.commands.executeCommand("andromity.openCrons");
        break;
      case "generate_tests":
        if (typeof message.file === "string" && message.file) {
          await this.openFile(message.file);
          await vscode.commands.executeCommand("andromity.generateTests");
        }
        break;
      case "air_gap":
        await vscode.env.openExternal(vscode.Uri.parse(DOCS.airGap));
        break;
      case "mcp_servers":
        SettingsPanel.createOrShow(this._extensionUri, this._rpcClient, "mcp", () => this.refreshConfig());
        break;
    }
  }

  private async _mcpServerCount(): Promise<number> {
    if (!this._rpcClient) return -1;
    const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const servers = await this._rpcClient.call<any[]>("mcp.list", { project_path: projectPath }, 5000).catch(() => null);
    return Array.isArray(servers) ? servers.length : -1;
  }

  private _inGitRepo(): boolean {
    try {
      const git = vscode.extensions.getExtension("vscode.git");
      const api = git?.isActive ? git.exports?.getAPI?.(1) : null;
      return Boolean(api && api.repositories && api.repositories.length > 0);
    } catch {
      return false;
    }
  }

  public broadcastActiveEditorContext() {
    const tabs = SessionTabPanel.getAllPanels();
    if (!this._view?.visible && !tabs.some((tab) => tab.visible)) return;
    const summary = EditorBridge.getActiveSummary();
    const payload = {
      type: "active_editor_context",
      context: {
        ...summary,
        fileName: summary.relativePath ? path.basename(summary.relativePath) : null,
      },
    };
    this._postToWebview(payload);
    for (const tab of tabs) {
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
    this._refreshSidePanel();
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
    this._recordChatViewOpened();
    void this._loadStartupState();
  }

  /** Load and deliver the initial chat state once per (webview, daemon client)
   *  pair. Concurrent callers share the in-flight load; it repeats only if the
   *  webview was recreated or the daemon reconnected while it ran. */
  private _loadStartupState(): Promise<void> {
    if (!this._startupLoad) {
      this._startupLoad = (async () => {
        try {
          let generation: number;
          let client: RpcClient | null;
          let attempts = 0;
          do {
            generation = this._viewGeneration;
            client = this._rpcClient;
            attempts++;
            await this._loadInitialConfig(true);
          } while (
            attempts < 3 &&
            this._rpcClient &&
            (generation !== this._viewGeneration ||
              client !== this._rpcClient ||
              (this._webviewReady && !this._isStartupStateDelivered()))
          );
        } finally {
          this._startupLoad = null;
        }
      })();
    }
    return this._startupLoad;
  }

  private _isStartupStateDelivered(): boolean {
    return !!this._delivered && this._delivered.generation === this._viewGeneration && this._delivered.client === this._rpcClient;
  }

  /** Resolves once the current webview's script has loaded (or after a timeout),
   *  so state isn't posted into a page that can't receive it yet. */
  private _whenWebviewReady(timeoutMs = 10000): Promise<void> {
    if (!this._view || this._webviewReady) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this._webviewReadyWaiters = this._webviewReadyWaiters.filter((w) => w !== done);
        resolve();
      }, timeoutMs);
      this._webviewReadyWaiters.push(done);
    });
  }

  private _markWebviewReady() {
    this._webviewReady = true;
    const waiters = this._webviewReadyWaiters;
    this._webviewReadyWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Once per window, as soon as the chat has been shown and the engine is connected. */
  private _recordChatViewOpened() {
    if (chatViewOpenRecorded || !this._webviewReady || !this._rpcClient) return;
    if (this._pythonBridge && this._pythonBridge.getClient() !== this._rpcClient) return;
    chatViewOpenRecorded = true;
    recordFeatureUse("chat_view_opened", { client: this._rpcClient });
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

  public setFeedbackCheckIn(checkIn: FeedbackNotifications) {
    this._checkIn = checkIn;
  }

  /** Puts the check-in under the reply just finished. Only when someone is looking at the chat. */
  public showFeedbackCheckIn(): boolean {
    if (!this._view?.visible || !this._currentSessionId) return false;
    this._postToWebview({
      type: "feedback_checkin",
      session_id: this._currentSessionId,
      annoyances: ANNOYANCES.map((a) => ({ id: a.id, label: a.label })),
    });
    return true;
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
    this._fireViewStateChanged();
    if (sessionId !== this._freshSessionId) {
      this._freshSessionId = undefined;
    }
    this._persistLastActiveSession(sessionId);
    if (this._view) {
      this._view.webview.postMessage({ type: "session_switched", sessionId });
      this._loadSession(sessionId);
    }
  }

  /** "New session" on a suggested next step: runs it in a background session linked to the
   *  one it came from, which stays open and is told when the background session finishes. */
  public async startNextStepSession(prompt: string, title?: string, parentSessionId?: string): Promise<void> {
    const parentId = parentSessionId || this._currentSessionId;
    if (!this._rpcClient || !parentId) {
      vscode.window.showWarningMessage("Andromity is still starting. Try again in a moment.");
      return;
    }
    recordNextStepEvent("new_session", parentId);
    try {
      await this._rpcClient.call("session.startBackground", {
        parent_session_id: parentId,
        prompt,
        title: title || "",
        project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        profile: this._currentProfile,
        model: (this._currentModel || "").replace(/^~+/, ""),
        provider: this._currentProvider,
        mode: this._currentMode,
        reasoning_effort: this._currentReasoning,
      });
      await this.fetchAndPostSessions();
    } catch (err) {
      console.error("[ChatView] Could not start background session:", err);
      vscode.window.showWarningMessage("Andromity couldn't start the new session. Try again, or use Do it to run it here.");
    }
  }

  public async sendPromptFromExternal(
    prompt: string,
    context?: any,
    options?: { taskName?: string; forceNewSession?: boolean; forkSessionIfBusy?: boolean; targetSessionId?: string }
  ) {
    if (!this._view) {
      await vscode.commands.executeCommand("andromity.chatView.focus");
      for (let i = 0; i < 20 && !this._view; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    if (options?.targetSessionId && options.targetSessionId !== this._currentSessionId) {
      this._currentSessionId = options.targetSessionId;
      this._persistLastActiveSession(options.targetSessionId);
      if (this._view) {
        this._view.webview.postMessage({ type: "session_switched", sessionId: options.targetSessionId });
        await this._loadSession(options.targetSessionId);
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
              sessionId: newSess.id,
            });
          }
          return;
        }
      } catch (err: any) {
        console.warn("[Andromity] Failed to create parallel session, falling back to active session:", err);
      }
    }

    // Default / Idle / Dedicated path: Reuse active session so conversation history & context are preserved!
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.postMessage({
        type: "external_prompt",
        prompt,
        context,
        sessionId: options?.targetSessionId || this._currentSessionId,
      });
    }
  }

  /** Wired to the "Andromity: Undo Last Turn & Rollback Diff" command. */
  public async requestUndoTurn() {
    if (this._diffManager) {
      const undone = await this._diffManager.undoLastTurn(this._currentSessionId);
      await this._loadSession(this._currentSessionId);
      if (undone?.turns_undone) {
        this._postToWebview({ type: "turn_undone", turnsUndone: undone.turns_undone, undonePrompt: undonePromptOf(undone) });
      }
      try {
        vscode.commands.executeCommand("git.refresh");
        vscode.commands.executeCommand("andromity.refreshChanges");
      } catch {}
    } else if (this._rpcClient) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const res = await this._rpcClient.call<SessionUndoResult>("session.undo", {
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
        if (res.turns_undone) {
          this._postToWebview({ type: "turn_undone", turnsUndone: res.turns_undone, undonePrompt: undonePromptOf(res) });
        }
      }
    }
  }

  /** Wired to the "Andromity: Open File Diff" command. */
  public async openFileDiff(filePath: string, isUntracked: boolean = false) {
    this.openReviewWebview(filePath);
  }

  /** Open a file directly in VS Code's editor in a new tab, or reveal a folder in the Explorer sidebar. */
  public async openFile(filePath: string, line?: number): Promise<void> {
    try {
      if (!filePath) return;
      let cleanPath = filePath.trim();
      cleanPath = cleanPath.replace(/^[`'"]+|[`'"]+$/g, "");
      let endLine: number | undefined;
      // "Add to Andromity" chips reference "path#L19-27" (or "#L19").
      const anchor = cleanPath.match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/i);
      if (anchor) {
        cleanPath = anchor[1];
        if (!line) line = parseInt(anchor[2], 10);
        if (anchor[3]) endLine = parseInt(anchor[3], 10);
      }
      const match = cleanPath.match(/^(.+?):(\d+)(?::\d+)?$/);
      if (match) {
        cleanPath = match[1];
        if (!line) line = parseInt(match[2], 10);
      }
      if (!(await allowOpenPath(cleanPath))) return;
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let resolvedPath = path.isAbsolute(cleanPath) ? cleanPath : (ws ? path.join(ws, cleanPath) : cleanPath);

      if (!fs.existsSync(resolvedPath)) {
        let found = false;
        if (vscode.workspace.workspaceFolders) {
          for (const wf of vscode.workspace.workspaceFolders) {
            const candidate = path.join(wf.uri.fsPath, cleanPath);
            if (fs.existsSync(candidate)) {
              resolvedPath = candidate;
              found = true;
              break;
            }
          }
        }
        if (!found) {
          const matchDir = this._findWorkspaceDirectory(cleanPath);
          if (matchDir) {
            resolvedPath = matchDir;
            found = true;
          }
        }
        if (!found) {
          const files = await vscode.workspace.findFiles(`**/${cleanPath}`, "**/node_modules/**", 1);
          if (files && files.length > 0) {
            resolvedPath = files[0].fsPath;
            found = true;
          }
        }
      }

      const uri = vscode.Uri.file(resolvedPath);

      // If directory/folder: reveal in Explorer sidebar view
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
        try {
          await vscode.commands.executeCommand("workbench.view.explorer");
        } catch {}
        await vscode.commands.executeCommand("revealInExplorer", uri);
        return;
      }

      // If file: open in editor in a new tab (preview: false)
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
      if (line && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        const end = endLine && endLine >= line
          ? doc.lineAt(Math.min(endLine, doc.lineCount) - 1).range.end
          : pos;
        editor.selection = new vscode.Selection(pos, end);
        editor.revealRange(new vscode.Range(pos, end), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to open: ${err.message}`);
    }
  }

  private _findWorkspaceDirectory(dirName: string): string | null {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders || !dirName) return null;
    const target = dirName.replace(/[\\/]+$/, "").toLowerCase();
    const ignore = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", ".pytest_cache", "__pycache__"]);

    // Runs synchronously on a click, so cap the walk on very large trees.
    let budget = 5000;
    for (const wf of wsFolders) {
      const root = wf.uri.fsPath;
      if (path.basename(root).toLowerCase() === target) return root;
      const queue = [root];
      for (let head = 0; head < queue.length && budget-- > 0; head++) {
        const current = queue[head];
        try {
          const entries = fs.readdirSync(current, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (ignore.has(entry.name) || entry.name.includes("venv") || entry.name.includes("cache")) continue;
              const full = path.join(current, entry.name);
              const rel = path.relative(root, full).replace(/\\/g, "/");
              if (entry.name.toLowerCase() === target || rel.toLowerCase() === target) {
                return full;
              }
              queue.push(full);
            }
          }
        } catch {}
      }
    }
    return null;
  }

  /** File and folder names the chat uses to turn paths in replies into
   *  clickable chips. Built asynchronously with findFiles (the previous
   *  synchronous readdir walk blocked the extension host on large repos),
   *  cached, and refreshed when files are created or deleted. */
  public getWorkspaceIndex(): Promise<{ files: string[]; dirs: string[] }> {
    if (!this._workspaceIndex) {
      this._workspaceIndex = ChatViewProvider._buildWorkspaceIndex().catch(() => ({ files: [], dirs: [] }));
    }
    return this._workspaceIndex;
  }

  private static readonly WORKSPACE_INDEX_LIMIT = 5000;
  private static readonly WORKSPACE_INDEX_EXCLUDE =
    "**/{node_modules,.git,.venv,venv,dist,build,.pytest_cache,__pycache__,.session_cache,.pyinstaller-build}/**";
  private static readonly VISIBLE_DOT_DIRS = new Set([".github", ".vscode", ".andromity", ".kilo"]);

  private static async _buildWorkspaceIndex(): Promise<{ files: string[]; dirs: string[] }> {
    if (!vscode.workspace.workspaceFolders?.length) return { files: [], dirs: [] };
    const uris = await vscode.workspace.findFiles(
      "**/*",
      ChatViewProvider.WORKSPACE_INDEX_EXCLUDE,
      ChatViewProvider.WORKSPACE_INDEX_LIMIT
    );
    const files = new Set<string>();
    const dirs = new Set<string>();
    for (const uri of uris) {
      const rel = vscode.workspace.asRelativePath(uri, false).split(path.sep).join("/");
      const parts = rel.split("/");
      const hidden = parts.some((part, i) =>
        (part.startsWith(".") && !ChatViewProvider.VISIBLE_DOT_DIRS.has(part)) ||
        (i < parts.length - 1 && (part.includes("venv") || part.includes("cache")))
      );
      if (hidden) continue;
      files.add(parts[parts.length - 1]);
      files.add(rel);
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts[i - 1]);
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    return { files: Array.from(files), dirs: Array.from(dirs) };
  }

  private _scheduleWorkspaceIndexRefresh() {
    if (this._workspaceIndexTimer) clearTimeout(this._workspaceIndexTimer);
    this._workspaceIndexTimer = setTimeout(() => {
      this._workspaceIndexTimer = null;
      this._workspaceIndex = null;
      if (!this._view && SessionTabPanel.getAllPanels().length === 0) return;
      void this.getWorkspaceIndex().then((index) => {
        this.broadcastToWebviews({ type: "workspace_files_updated", files: index.files, dirs: index.dirs });
      });
    }, 3000);
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

  /** Attach a line range of a file as prompt context ("Add to Andromity"). */
  public attachSelection(fsPath: string, startLine: number, endLine: number) {
    if (!fsPath) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const relPath = ws && fsPath.startsWith(ws) ? path.relative(ws, fsPath).split(path.sep).join("/") : fsPath;
    const lines = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    this._postToWebview({
      type: "file_attached",
      file: { name: `${path.basename(fsPath)}:${lines}`, path: `${relPath}#L${lines}`, fsPath },
    });
    this._view?.show?.(true);
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

  /** Open onboarding or login card in webview. */
  public showOnboardingOrLogin() {
    if (this._view) {
      this._view.show?.(true);
      this._postToWebview({ type: "show_onboarding_guide" });
    }
  }

  public async handleAuthToken(token: string, username?: string, email?: string) {
    if (!token) return;
    if (currentAirGap().enabled) {
      void vscode.window.showWarningMessage(airGapOffMessage("signing in to AgenticMarket"));
      return;
    }
    try {
      const validation = await fetch(`${this._getGatewayBaseUrl()}/v1/user/usage`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "Andromity" },
        signal: AbortSignal.timeout(10000),
      });
      if (validation.status === 401) {
        throw new Error("AgenticMarket rejected this sign-in token. Sign in again. If it repeats, the account session needs to be checked on the gateway.");
      }
      if (!validation.ok) {
        throw new Error("Could not verify AgenticMarket sign-in. Please retry when the gateway is available.");
      }
      const account = await validation.json();
      if (account.plan !== "authenticated") {
        throw new Error("AgenticMarket has not activated this account session. Retry sign-in shortly.");
      }
      if (!this._rpcClient) {
        throw new Error("The Andromity daemon is unavailable. Reload VS Code and sign in again.");
      }
      if (this._rpcClient) {
        try {
          await this._rpcClient.call("config.set_api_key", { provider: "andromity", api_key: token });
          await this._rpcClient.call("config.set", { section: "default", key: "provider", value: "andromity" });
          await this._rpcClient.call("config.set", { section: "default", key: "model", value: "auto" });
          if (username) await this._rpcClient.call("config.set", { section: "default", key: "user_name", value: username });
          if (email) await this._rpcClient.call("config.set", { section: "default", key: "user_email", value: email });
        } catch {
          throw new Error("Could not apply your sign-in to the Andromity daemon. Reload VS Code and sign in again.");
        }
      }
      if (this._context?.secrets) {
        await this._context.secrets.store("andromity.authToken", token);
        if (username) await this._context.secrets.store("andromity.userName", username);
        if (email) await this._context.secrets.store("andromity.userEmail", email);
      }
      this._currentProvider = "andromity";
      this._currentModel = "auto";
      this.broadcastToWebviews({
        type: "auth_state_changed",
        isAuthenticated: true,
        plan: "authenticated",
        username: username || "Developer",
      });
      await this.fetchUsage(true);
      if (SettingsPanel.currentPanel) {
        await SettingsPanel.currentPanel.loadData(true);
      }
      vscode.window.showInformationMessage("Successfully signed in to AgenticMarket!");
      await this.refreshConfig();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to activate login: ${e.message}`);
    }
  }

  public async logout() {
    if (this._context?.secrets) {
      await this._context.secrets.delete("andromity.authToken");
      await this._context.secrets.delete("andromity.userName");
      await this._context.secrets.delete("andromity.userEmail");
    }
    if (this._rpcClient) {
      try {
        await this._rpcClient.call("auth.logout", {});
        await this._rpcClient.call("config.set_api_key", { provider: "andromity", api_key: "" });
      } catch {}
    }
    this.broadcastToWebviews({
      type: "auth_state_changed",
      isAuthenticated: false,
      plan: "anonymous",
      username: "Anonymous",
    });
    await this.fetchUsage();
    if (SettingsPanel.currentPanel) {
      await SettingsPanel.currentPanel.loadData(true);
    }
    vscode.window.showInformationMessage("Signed out of AgenticMarket account. Reverted to anonymous trial.");
    await this.refreshConfig();
  }

  public async openLogin() {
    if (currentAirGap().enabled) {
      void vscode.window.showWarningMessage(airGapOffMessage("signing in to AgenticMarket", "Local models work without an account."));
      return;
    }
    let state = "";
    try {
      const crypto = await import("crypto");
      state = crypto.randomBytes(24).toString("hex");
    } catch {
      state = Array.from(Array(48), () => Math.floor(Math.random() * 16).toString(16)).join("");
    }
    if (this._context?.secrets) {
      await this._context.secrets.store("andromity.oauth_state", state);
    }
    const scheme = vscode.env.uriScheme || "vscode";
    const callbackUrl = `${scheme}://agenticmarket.andromity-agent/auth?state=${state}`;
    const base = await this._getWebAppBaseUrl();
    const targetUrl = `${base}/auth/connect?callback=${encodeURIComponent(callbackUrl)}`;
    await vscode.env.openExternal(vscode.Uri.parse(targetUrl));
  }

  public async _getWebAppBaseUrl(): Promise<string> {
    return accountUrl("webAppUrl");
  }

  public _getGatewayBaseUrl(): string {
    return accountUrl("gatewayUrl");
  }

  private _usageInFlight: Promise<any> | null = null;
  private _installClientId: string | null = null;
  private _lastUsageData: any = null;
  private _lastUsageFetchedAt: number = 0;

  /** The per-install ID the daemon sends with gateway requests, so usage matches its quota. */
  private async _gatewayClientId(): Promise<string> {
    if (this._installClientId) return this._installClientId;
    const result = await this._rpcClient?.call("gateway.clientId", {}).catch(() => null);
    const id = typeof result?.client_id === "string" ? result.client_id.trim() : "";
    if (id) this._installClientId = id;
    return id || "local_client";
  }

  public async fetchUsage(forceRefresh = false): Promise<any> {
    if (!forceRefresh && this._lastUsageData && Date.now() - this._lastUsageFetchedAt < 10000) {
      return this._lastUsageData;
    }
    if (this._usageInFlight) {
      return this._usageInFlight;
    }

    this._usageInFlight = (async () => {
      const token = await this._context?.secrets.get("andromity.authToken");
      const storedUsername = await this._context?.secrets.get("andromity.userName");
      const clientId = storedUsername || (token ? "local_client" : await this._gatewayClientId());
      const gatewayUrl = this._getGatewayBaseUrl();
      let rejectedToken = false;

      // Air-gap mode: no usage lookup; the fallback below reports usage as unavailable.
      if (!currentAirGap().enabled) {
        try {
          const headers: Record<string, string> = {
            "User-Agent": "Andromity",
            "x-andromity-client-id": clientId,
          };
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
          const res = await fetch(`${gatewayUrl}/v1/user/usage`, {
            headers,
            signal: AbortSignal.timeout(3500),
          });
          if (res.status === 401 && token) {
            rejectedToken = true;
            await this._context?.secrets.delete("andromity.authToken");
            await this._context?.secrets.delete("andromity.userName");
            await this._context?.secrets.delete("andromity.userEmail");
            this.broadcastToWebviews({
              type: "auth_state_changed", isAuthenticated: false,
              plan: "anonymous", username: "Anonymous",
            });
            await this._rpcClient?.call("auth.logout", {}).catch(() => undefined);
            vscode.window.showWarningMessage("Your AgenticMarket session was rejected. Please sign in again.");
          }
          if (res.ok) {
            const data = await res.json();
            const effectiveUser = storedUsername || data.username || "Anonymous";
            this._lastUsageData = data;
            this._lastUsageFetchedAt = Date.now();
            this.broadcastToWebviews({
              type: "usage_updated",
              ...data,
              username: effectiveUser,
            });
            return data;
          }
        } catch {}
      }

      const isAuthed = Boolean(token) && !rejectedToken;
      const fallback = {
        user_id: clientId,
        username: isAuthed ? storedUsername || "Developer" : "Anonymous",
        plan: isAuthed ? "authenticated" : "anonymous",
        turns_today: null,
        limit_today: null,
        turns_remaining: null,
        status: "unavailable",
        last_model: "auto",
      };
      this._lastUsageData = fallback;
      this._lastUsageFetchedAt = Date.now();
      this.broadcastToWebviews({
        type: "usage_updated",
        ...fallback,
      });
      return fallback;
    })().finally(() => {
      this._usageInFlight = null;
    });

    return this._usageInFlight;
  }

  /** Open a session in a dedicated editor tab (pop-out editor view). */
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
      void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => {});
    }
  }

  /** Wired to the "Andromity: View Git Diff" command (QuickPick of changed files). */
  public async pickAndShowFileDiff() {
    if (this._diffManager) {
      await this._diffManager.pickAndShowFileDiff();
    }
  }

  /** Open the dedicated Changes Review Webview tab.
   *  `turnFiles: null` means the caller has no turn scope (e.g. an edit row in a
   *  still-running turn), so the latest completed turn must not be substituted. */
  public openReviewWebview(filePath?: string, turnFiles?: string[] | null) {
    const effectiveTurnFiles = turnFiles === null
      ? undefined
      : (turnFiles ?? (this._latestTurnFiles.size > 0 ? Array.from(this._latestTurnFiles) : undefined));
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
  public async handlePlanApproval(approved: boolean, feedback: string = "", targetSessionId?: string) {
    const activeSid = targetSessionId || this._currentSessionId;
    if (!this._rpcClient || !activeSid) return;
    try {
      void this._rpcClient.call("telemetry.recordFeature", {
        feature: approved ? "plan_approved" : "plan_rejected",
        session_id: activeSid,
      }).catch(() => {});
      await this._rpcClient.call(approved ? "plan.approve" : "plan.reject", {
        session_id: activeSid,
        comment: feedback,
        feedback: feedback,
      });
      const msg = approved
        ? "The plan has been approved by the user. Proceed with execution of the todos in order." +
          (feedback ? ` User note: ${feedback}` : "")
        : "The plan was rejected by the user. Please revise the plan and present a new one." +
          (feedback ? ` User reason: ${feedback}` : "");

      // CRITICAL: Plan approval MUST ALWAYS continue in the session to which the plan belongs!
      // Never fork a new session for plan approval. If the session is currently running,
      // it queues in that session so it seamlessly executes when the current turn finishes.
      await this.sendPromptFromExternal(msg, undefined, {
        forkSessionIfBusy: false,
        targetSessionId: activeSid,
      });
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
    this._viewGeneration++;
    this._webviewReady = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    const subscriptions = [
      watchStarterContext((context) => {
        this._postToWebview({ type: "starter_context", ...context });
        // Same signal covers commits, checkouts and edits, so the panel's branch and changes stay current.
        this._refreshSidePanel(["changes"]);
      }),
      webviewView.webview.onDidReceiveMessage(async (message) => {
        await this._handleWebviewMessage(message);
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.broadcastActiveEditorContext();
          this._awayBadge.clear();
          webviewView.badge = undefined;
        }
        this._fireViewStateChanged();
      }),
    ];
    webviewView.onDidDispose(() => {
      for (const subscription of subscriptions) subscription.dispose();
      if (this._view === webviewView) {
        this._view = undefined;
        this._webviewReady = false;
      }
    });

    this.broadcastMascotConfig();
    this.broadcastActiveEditorContext();
    if (this._rpcClient) {
      void this._loadStartupState();
    }
  }

  private _bindRpcEvents() {
    if (!this._rpcClient) return;
    const client = this._rpcClient;

    const bind = (event: string, handler: (...args: any[]) => void) => {
      client.on(event, handler);
      this._rpcDisposables.push(() => client.off(event, handler));
    };

    bind("agent/queueChanged", (params: unknown) => this._postToWebview({ type: "queue_state", ...(params as object), supported: true }));
    bind("agent/inputApplied", (params: unknown) => this._postToWebview({ type: "input_applied", ...(params as object) }));
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
        const config = vscode.workspace.getConfiguration("andromity");
        const shouldAutoOpen = config.get<boolean>("waterfallAutoOpen", true);
        const isFirstPrompt = params?.turn_index !== undefined
          ? params.turn_index === 0
          : !this._waterfallAutoOpenedSessions.has(sid);

        // Scheduled runs start in the background; never pop a panel open for them.
        if (shouldAutoOpen && isFirstPrompt && !params?.scheduled && !this._waterfallAutoOpenedSessions.has(sid)) {
          this._waterfallAutoOpenedSessions.add(sid);
          WaterfallPanel.createOrShow(
            this._extensionUri,
            sid,
            "Live Session",
            this._rpcClient,
            this._context,
            vscode.ViewColumn.Active,
            "auto"
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
      this._noteWhileAway("approval", params);
      if (this.isSoundEnabled("attention")) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
      }
    });

    bind("agent/askQuestions", (params: ClarifyingQuestionsEvent) => {
      this._postToWebview({ type: "ask_questions", ...params });
      this._noteWhileAway("question", params);
      if (this.isSoundEnabled("attention")) {
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
        this._postToWebview({ type: "plan_approval", ...params });
        if (this.isSoundEnabled("attention")) {
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
          this._postToWebview({ type: "plan_updated", ...params });
        }
        this._planViewProvider?.updatePlan(params.plan, sid);
      }
    });

    bind("agent/nextStepSuggested", (params: any) => {
      this._postToWebview({ type: "next_step_suggested", ...params });
    });
    bind("session/backgroundStarted", (params: any) => {
      this._postToWebview({ type: "background_session_started", ...params });
    });
    bind("session/backgroundFinished", (params: any) => {
      this._postToWebview({ type: "background_session_finished", ...params });
      void this.fetchAndPostSessions();
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
        status: params.status,
        collaborators: params.collaborators,
        watching_for: params.watching_for,
        consecutive_auto_wakes: params.consecutive_auto_wakes,
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
      const toast = cronRunToast(params);
      if (!toast) return;
      const sessionId = params.run?.session_id;
      const show = toast.level === "info" ? vscode.window.showInformationMessage
        : toast.level === "warning" ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
      show(toast.text, ...toast.actions).then((choice) => {
        if (choice === "Open Session" && sessionId) {
          vscode.commands.executeCommand("andromity.switchSessionById", sessionId);
        } else if (choice === "Open Cron Jobs") {
          vscode.commands.executeCommand("andromity.openSettings", "crons");
        }
      });
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

    bind("process/started", (params: any) => {
      this._postToWebview({ type: "process_started", ...params });
    });
    bind("agent/interactionResolved", (params: any) => {
      this._postToWebview({ type: "interaction_resolved", ...params });
    });

    bind("process/exited", (params: any) => {
      this._postToWebview({ type: "process_exited", ...params });
    });

    bind("mcp/statusChanged", () => this._refreshSidePanel(["mcp"]));

    bind("agent/done", (params: any) => {
      const sid = params?.session_id || this._currentSessionId;
      this._noteWhileAway("reply", params);
      this._refreshSidePanel(["changes"]);
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
      // Scheduled runs report through their own cron notification instead.
      if (this.isSoundEnabled("done") && !params?.scheduled) {
        this._postToWebview({ type: "play_sound", kind: "done" });
      }
      vscode.commands.executeCommand("andromity.refreshChanges");

      if (sid && sid !== this._currentSessionId && !params?.scheduled) {
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
      this._postToWebview({ type: "agent_error", ...params });
    });

    bind("session/compacting", (params: any) => {
      this._postToWebview({ type: "session_compacting", ...params });
    });

    bind("session/compacted", (params: any) => {
      this._postToWebview({ type: "session_compacted", ...params });
    });
  }

  public async probeOllama(): Promise<OllamaStatus> {
    const configuredHost =
      vscode.workspace.getConfiguration("andromity").inspect<string>("ollamaHost")?.globalValue ||
      (await this._engineOllamaHost()) ||
      "http://127.0.0.1:11434";
    const candidateHosts = [configuredHost, "http://127.0.0.1:11434", "http://localhost:11434"];
    const uniqueHosts = Array.from(new Set(candidateHosts));

    // Probe in parallel: refused connections are slow on Windows (~2 s each).
    const results = await Promise.all(uniqueHosts.map((host) => this._probeOllamaHost(host)));
    const running = results.find((res) => res.running);
    if (running) {
      this._lastOllamaStatus = running;
      return running;
    }

    const installed = await this._checkOllamaCliInstalled();
    const res: OllamaStatus = {
      running: false,
      installed,
      models: [],
      bestModel: null,
      host: configuredHost,
    };
    this._lastOllamaStatus = res;
    return res;
  }

  /** The Ollama address in config.toml, so the status shown is for the server the engine uses. */
  private async _engineOllamaHost(): Promise<string | undefined> {
    const providers = await this._rpcClient
      ?.call<Array<{ id: string; base_url?: string }>>("config.list_providers", {}, 3000)
      .catch(() => null);
    return providers?.find((p) => p.id === "ollama")?.base_url || undefined;
  }

  private _probeOllamaHost(host: string): Promise<OllamaStatus> {
    return new Promise((resolve) => {
      try {
        const cleanHost = host.replace(/\/+$/, "");
        const isHttps = cleanHost.startsWith("https:");
        const client = isHttps ? require("https") : require("http");
        const url = `${cleanHost}/api/tags`;
        const req = client.get(url, { timeout: 1200 }, (res: any) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve({ running: false, installed: true, models: [], bestModel: null, host: cleanHost });
            return;
          }
          let raw = "";
          res.on("data", (chunk: any) => { raw += chunk; });
          res.on("end", () => {
            try {
              const data = JSON.parse(raw);
              const isEmbeddingModel = (m: any) => {
                const caps = m.capabilities || [];
                if (caps.length > 0 && caps.includes("embedding") && !caps.includes("completion") && !caps.includes("chat")) {
                  return true;
                }
                const nm = (m.name || m.model || "").toLowerCase();
                return (
                  nm.includes("embed") ||
                  nm.includes("minilm") ||
                  nm.includes("bge-") ||
                  nm.includes("e5-") ||
                  nm.includes("sentence-transformers")
                );
              };

              const allModels = (data.models || []).map((m: any) => m.name || m.model);
              const chatModels = (data.models || [])
                .filter((m: any) => !isEmbeddingModel(m))
                .map((m: any) => m.name || m.model);

              const models = chatModels.length > 0 ? chatModels : allModels;
              const bestModel =
                models.find((m: string) => /qwen.*coder/i.test(m)) ||
                models.find((m: string) => /deepseek.*coder/i.test(m)) ||
                models.find((m: string) => /codellama/i.test(m)) ||
                models.find((m: string) => /qwen/i.test(m)) ||
                models.find((m: string) => /deepseek/i.test(m)) ||
                models.find((m: string) => /llama3/i.test(m)) ||
                models.find((m: string) => /llama/i.test(m)) ||
                models.find((m: string) => /mistral/i.test(m)) ||
                models[0] ||
                null;

              resolve({
                running: true,
                installed: true,
                models,
                bestModel,
                host: cleanHost,
              });
            } catch {
              resolve({ running: true, installed: true, models: [], bestModel: null, host: cleanHost });
            }
          });
        });
        req.on("error", () => resolve({ running: false, installed: false, models: [], bestModel: null, host }));
        req.on("timeout", () => { req.destroy(); resolve({ running: false, installed: false, models: [], bestModel: null, host }); });
      } catch {
        resolve({ running: false, installed: false, models: [], bestModel: null, host });
      }
    });
  }

  private _resolveOllamaBinary(): string | null {
    if (this._ollamaBinaryPath) return this._ollamaBinaryPath;
    const fs = require("fs");
    const path = require("path");

    // 1. Direct standard paths based on OS
    if (process.platform === "win32") {
      const candidates = [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe") : "",
        process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Ollama", "ollama.exe") : "",
        process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Ollama", "ollama.exe") : "",
      ].filter(Boolean);

      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            this._ollamaBinaryPath = p;
            this._ollamaInstalledCached = true;
            return p;
          }
        } catch {}
      }
    } else {
      const candidates = [
        "/usr/local/bin/ollama",
        "/usr/bin/ollama",
        "/opt/homebrew/bin/ollama",
      ];
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            this._ollamaBinaryPath = p;
            this._ollamaInstalledCached = true;
            return p;
          }
        } catch {}
      }
    }

    // 2. Search PATH directories directly with fs.existsSync (instant, zero console popups)
    const envPath = process.env.PATH || "";
    const sep = process.platform === "win32" ? ";" : ":";
    const exeName = process.platform === "win32" ? "ollama.exe" : "ollama";
    for (const dir of envPath.split(sep)) {
      if (!dir) continue;
      const full = path.join(dir, exeName);
      try {
        if (fs.existsSync(full)) {
          this._ollamaBinaryPath = full;
          this._ollamaInstalledCached = true;
          return full;
        }
      } catch {}
    }

    return null;
  }

  private _resolveOllamaAppBinary(): string | null {
    if (this._ollamaAppBinaryPath) return this._ollamaAppBinaryPath;
    if (process.platform !== "win32") return null;
    const fs = require("fs");
    const path = require("path");

    const candidates = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama app.exe") : "",
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Ollama", "ollama app.exe") : "",
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Ollama", "ollama app.exe") : "",
    ].filter(Boolean);

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          this._ollamaAppBinaryPath = p;
          return p;
        }
      } catch {}
    }
    return null;
  }

  private async _checkOllamaCliInstalled(): Promise<boolean> {
    if (this._ollamaInstalledCached !== null) return this._ollamaInstalledCached;
    const binary = this._resolveOllamaBinary();
    if (binary) {
      this._ollamaInstalledCached = true;
      return true;
    }

    // Fallback: asynchronous check with windowsHide: true so no black window appears
    return new Promise((resolve) => {
      const { exec } = require("child_process");
      const cmd = process.platform === "win32" ? "where.exe ollama" : "which ollama";
      exec(cmd, { timeout: 1500, windowsHide: true }, (err: any, stdout: any) => {
        const ok = !err && Boolean(stdout && stdout.trim());
        this._ollamaInstalledCached = ok;
        if (ok && stdout) {
          const firstLine = stdout.trim().split(/\r?\n/)[0];
          if (firstLine) this._ollamaBinaryPath = firstLine.trim();
        }
        resolve(ok);
      });
    });
  }

  private _getOrCreateOllamaTerminal(title: string = "Ollama"): vscode.Terminal {
    if (this._ollamaTerminal) {
      const isAlive = vscode.window.terminals.includes(this._ollamaTerminal);
      if (isAlive && this._ollamaTerminal.exitStatus === undefined) {
        return this._ollamaTerminal;
      }
    }
    const existing = vscode.window.terminals.find((t) => t.name.startsWith("Ollama") && t.exitStatus === undefined);
    if (existing) {
      this._ollamaTerminal = existing;
      return existing;
    }
    this._ollamaTerminal = vscode.window.createTerminal(title);
    return this._ollamaTerminal;
  }

  public async startOllamaServer(): Promise<boolean> {
    // 1. If already running, return immediately without spawning anything
    const initialStatus = await this.probeOllama();
    if (initialStatus.running) return true;

    // 2. Resolve installed binary without running visible console windows
    const installed = await this._checkOllamaCliInstalled();
    if (!installed) {
      vscode.window.showErrorMessage(
        "Ollama is not installed on this machine. Please download it from https://ollama.com",
        "Download Ollama"
      ).then((action) => {
        if (action === "Download Ollama") {
          vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
        }
      });
      return false;
    }

    // 3. Start silently in background
    try {
      const { spawn } = require("child_process");
      const appExe = this._resolveOllamaAppBinary();
      const binary = this._resolveOllamaBinary();

      if (appExe) {
        // On Windows, launching the official tray app starts Ollama cleanly with no console window
        const child = spawn(appExe, [], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.on("error", () => {});
        child.unref();
      } else if (binary) {
        const child = spawn(binary, ["serve"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.on("error", () => {});
        child.unref();
      } else {
        const child = spawn("ollama", ["serve"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          shell: process.platform === "win32",
        });
        child.on("error", () => {});
        child.unref();
      }
    } catch {}

    // 4. Poll up to 4s (8 x 500ms) for background server to respond to HTTP
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const status = await this.probeOllama();
      if (status.running) return true;
    }

    return false;
  }

  public async pullOllamaModel(modelName: string) {
    if (currentAirGap().enabled) {
      void vscode.window.showWarningMessage(airGapOffMessage("downloading Ollama models",
        "Copy model files in from your internal source, or run ollama pull on a connected machine."));
      return;
    }
    const installed = await this._checkOllamaCliInstalled();
    if (!installed) {
      vscode.window.showErrorMessage("Ollama CLI is not installed on this machine. Please install Ollama first.");
      return;
    }
    const raw = String(modelName || "").trim();
    if (!/^[a-zA-Z0-9._:\-\/]+$/.test(raw)) {
      vscode.window.showErrorMessage("Invalid model name format.");
      return;
    }
    const t = this._getOrCreateOllamaTerminal("Ollama");
    t.show(true);
    t.sendText(`ollama pull ${raw}`);
  }

  private async _checkAndAutoConnectOllama(providers: ProviderInfo[]): Promise<string | null> {
    const hasAnyKey = providers.some((p) => p.has_key);
    const status = await this.probeOllama();
    if (status.running && status.bestModel) {
      if (!hasAnyKey || this._currentProvider === "ollama") {
        this._currentProvider = "ollama";
        this._currentModel = status.bestModel;
        void this._rpcClient?.call("config.set", { section: "default", key: "provider", value: "ollama" }).catch(() => {});
        void this._rpcClient?.call("config.set", { section: "default", key: "model", value: status.bestModel }).catch(() => {});
      }
      return status.bestModel;
    }
    return null;
  }

  private _addOllamaModel(model: string) {
    if (this._models.some((m) => m.id === model || m.name === model)) return;
    this._models.push({
      id: model,
      name: model,
      provider: "ollama",
      desc: "Local Ollama Model",
      is_free: true,
      tags: ["local", "coding"],
    } as any);
  }

  private _ollamaRefresh: Promise<void> | null = null;

  /** Background Ollama detection that patches the already-rendered chat state. */
  private _refreshOllamaDetection(): Promise<void> {
    if (!this._ollamaRefresh) {
      this._ollamaRefresh = (async () => {
        try {
          const providerBefore = this._currentProvider;
          const detected = await this._checkAndAutoConnectOllama(this._providers);
          const status = this._lastOllamaStatus;
          if (!detected) {
            if (status) this._postToWebview({ type: "ollama_status_updated", status });
            return;
          }
          this._addOllamaModel(detected);
          this._postToWebview({ type: "ollama_detected", model: detected, models: this._models, status });
          if (providerBefore === "ollama" && this._currentProvider === "ollama") {
            this._postToWebview({ type: "config_updated", key: "model", value: this._currentModel, provider: "ollama" });
          }
        } catch {
          // Ollama is optional; detection failures are not user-facing.
        } finally {
          this._ollamaRefresh = null;
        }
      })();
    }
    return this._ollamaRefresh;
  }

  public broadcastToWebviews(msg: any) {
    this._postToWebview(msg);
    for (const tab of SessionTabPanel.getAllPanels()) {
      try {
        tab.postMessage(msg);
      } catch {}
    }
  }

  private _postToWebview(msg: any) {
    if (this._hydration.capture(msg)) return;
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
        this._rpcClient.call<any>("trust.status", { project_path: workspaceFolder }).catch(() => ({ is_trusted: false })),
        this._rpcClient.call<any[]>("skills.list", { project_path: workspaceFolder }).catch(() => []),
      ]);

      this._models = models || [];
      this._providers = providers || [];
      if (!this._providers.some(p => p.id === "andromity")) {
        this._providers.unshift({
          id: "andromity",
          name: "Andromity Auto",
          has_key: true,
          portal: "https://agenticmarket.dev",
        });
      }
      if (!this._models.some(m => m.id === "auto" && m.provider === "andromity")) {
        this._models.unshift({
          id: "auto",
          name: "Andromity Auto",
          provider: "andromity",
          desc: "Autonomous intelligence engine optimized for agentic coding",
          context: "256K",
          is_free: true,
          tags: ["auto", "recommended"],
        } as any);
      }
      this._configData = configData || {};
      this._pinnedModels = Array.isArray(configData?.pinned_models) && configData.pinned_models.length > 0
        ? configData.pinned_models
        : [
            { id: "auto", provider: "andromity", name: "Andromity Auto" },
            { id: "anthropic/claude-3.7-sonnet", provider: "openrouter", name: "Claude 3.7 Sonnet" },
          ];
      this._currentProvider = configData?.default_provider || "andromity";
      this._currentModel = configData?.default_model || "auto";
      this._currentProfile = configData?.default_profile || "builder";
      this._currentReasoning = configData?.reasoning_effort || "auto";
      this._currentMode = configData?.permission_mode || "safe";

      // The RPCs above overlap with the webview's own loading; only posting waits for it.
      await this._whenWebviewReady();
      const deliveredToReadyPage = this._webviewReady;
      const deliveryGeneration = this._viewGeneration;
      const deliveryClient = this._rpcClient;

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

      // Ollama is probed after init_state: a refused connection takes ~2 s per
      // address on Windows and used to hold the whole chat UI back.
      const knownOllamaModel = this._lastOllamaStatus?.running ? this._lastOllamaStatus.bestModel : null;
      if (knownOllamaModel) this._addOllamaModel(knownOllamaModel);

      this._postToWebview({
        type: "init_state",
        sessionId: this._currentSessionId,
        profile: this._currentProfile,
        availableProfiles: configData?.available_profiles || ["builder", "coder", "reviewer", "planner"],
        availableReasoningEfforts: configData?.available_reasoning_efforts || [],
        modelReasoningCapability: configData?.model_reasoning_capability
          ? { ...configData.model_reasoning_capability, _modelId: this._currentModel, _providerId: this._currentProvider }
          : undefined,
        model: this._currentModel,
        provider: this._currentProvider,
        mode: this._currentMode,
        reasoningEffort: this._currentReasoning,
        models: this._models,
        pinnedModels: this._pinnedModels,
        providers: this._providers,
        skills: skills || [],
        sessions: sessions || [],
        isTrusted: trustStatus?.is_trusted !== false,
        workspaceName: workspaceFolder ? path.basename(workspaceFolder) : "Workspace Ready",
        currentPlan: this._currentPlan,
        waterfallFirstSessionShown: this._context?.globalState.get<boolean>("andromity.waterfallFirstSessionShown", false) || false,
        wallpaper: this.getWallpaperConfig(this._view?.webview),
        mascotEnabled: vscode.workspace.getConfiguration("andromity").get<boolean>("mascotEnabled", true),
        ollamaDetectedModel: knownOllamaModel,
        ollamaStatus: this._lastOllamaStatus,
      });
      // A ready-wait that timed out may have posted into a page that wasn't
      // listening yet; leave it undelivered so the late ready message resends.
      if (loadSession && this._view && deliveredToReadyPage && deliveryClient && deliveryGeneration === this._viewGeneration) {
        this._delivered = { generation: deliveryGeneration, client: deliveryClient };
      }
      void this._refreshOllamaDetection();

      const storedToken = await this._context?.secrets.get("andromity.authToken");
      const storedUser = await this._context?.secrets.get("andromity.userName");
      const isAuthed = Boolean(storedToken);
      this._postToWebview({
        type: "auth_state_changed",
        isAuthenticated: isAuthed,
        plan: isAuthed ? "authenticated" : "anonymous",
        username: storedUser || (isAuthed ? "Developer" : "Anonymous"),
      });
      void this.fetchUsage();
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
    const version = this._hydration.begin(sessionId);
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const sessionData = await this._rpcClient.call<any>("session.get", {
        session_id: sessionId,
        project_path: workspaceFolder,
      });
      if (!this._hydration.isCurrent(version) || sessionId !== this._currentSessionId) return;
      if (sessionData?.name) {
        this._sessionNames.set(sessionId, sessionData.name);
      }
      if (sessionData?.messages && sessionData.messages.some((m: any) => m.role === "user")) {
        this._waterfallAutoOpenedSessions.add(sessionId);
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
      this._hydration.finish(version, sessionData?.runtime?.event_seq || 0, (event) => this._postToWebview(event));
    } catch (e: any) {
      this._hydration.finish(version, -1, (event) => this._postToWebview(event));
      console.error("[Andromity Chat] Failed to load session:", e);
      this._postToWebview({ type: "session_load_failed", session_id: sessionId });
    }
  }

  private async _handleWebviewMessage(message: any) {
    if (message.type === "ready" || message.type === "webview_ready") {
      this._markWebviewReady();
      this.broadcastAirGapState();
      this._postToWebview({ type: "starter_context", ...collectStarterContext() });
      this._refreshSidePanel();
      void this.getWorkspaceIndex().then((index) => {
        this._postToWebview({ type: "workspace_files_updated", files: index.files, dirs: index.dirs });
      });
      if (!this._rpcClient && this._pythonBridge) {
        const client = await this._pythonBridge.waitForClient(3000);
        if (client) {
          this.setRpcClient(client);
        }
      }
      if (this._rpcClient) {
        this._postToWebview({ type: "backend_ready" });
        this._recordChatViewOpened();
        if (!this._isStartupStateDelivered()) await this._loadStartupState();
      }
      return;
    }

    if (message.type === "side_panel_preferences") {
      await this.saveSidePanelPreferences(message.preferences);
      return;
    }

    if (message.type === "side_panel_visibility") {
      await this.saveSidePanelVisibility(message.off);
      return;
    }

    if (message.type === "side_panel_refresh") {
      this._refreshSidePanel();
      return;
    }

    if (message.type === "side_panel_command") {
      runSidePanelCommand(message.command);
      return;
    }

    if (message.type === "copy_chat_markdown") {
      await copySessionAsMarkdown(this._rpcClient, message.sessionId || this._currentSessionId);
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

    if (message.type === "run_in_terminal") {
      const runId = typeof message.runId === "string" ? message.runId : "";
      await runCodeBlockInTerminal(message.code, message.lang,
        runId ? (status) => this._postToWebview({ type: "run_status", runId, ...status }) : undefined);
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
      reportDisconnectedAction(message, this._currentSessionId, event => this._postToWebview(event));
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

    if (this._rpcClient && await handleInputMessage(this._rpcClient, message, this._currentSessionId || "", (event) => {
      const data = event as { type: string; session_id?: string };
      if (data.type === "input_session" && data.session_id) this._currentSessionId = data.session_id;
      this._postToWebview(event);
    }, this._currentMode)) return;

    if (await handleInteractionMessage(this._rpcClient, message, this._currentSessionId, (event) => this._postToWebview(event))) return;
    if (await handlePromptImageMessage(this._rpcClient, message, this._currentSessionId, (event) => this._postToWebview(event))) return;

    switch (message.type) {

      case "kill_process": {
        recordFeatureUse("bg_task_stopped", { sessionId: this._currentSessionId });
        const procId = message.processId || message.process_id;
        if (procId && this._rpcClient) {
          try {
            await this._rpcClient.call("process.kill", { process_id: procId, session_id: this._currentSessionId });
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to stop process ${procId}: ${err?.message || err}`);
          }
        }
        break;
      }

      case "open_bg_task_tab": {
        recordFeatureUse("bg_task_opened", { sessionId: this._currentSessionId, oncePerSession: true });
        const procId = message.processId || message.process_id;
        const cmd = message.command || "";
        if (procId) {
          BackgroundTaskPanel.createOrShow(
            this._extensionUri,
            procId,
            this._rpcClient,
            cmd,
            this._currentSessionId
          );
        }
        break;
      }

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
            mode: clampPromptMode(message.mode, this._currentMode),
            reasoning_effort: message.reasoningEffort || this._currentReasoning,
            image_uris: message.images || [],
          }, 600000);
        } catch (err: any) {
          const activeSid = message.sessionId || this._currentSessionId;
          const msg = err.message || String(err);
          const lowerMsg = msg.toLowerCase();

          // Error category only; no message text or paths
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

          if (msg.includes(SCHEDULED_RUN_BUSY)) {
            this._postToWebview({ type: "agent_error", error: SCHEDULED_RUN_BUSY_TEXT, session_id: activeSid, scheduled_busy: true });
          } else if (msg.includes("already running a turn") || msg.includes("-32603") || msg.includes("AGENT_BUSY")) {
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
            this._postToWebview({ type: "agent_error", error: msg });
          }
        }
        break;
      }

      case "open_settings": {
        SettingsPanel.createOrShow(
          this._extensionUri,
          this._rpcClient,
          message.tab === "mcp" ? "mcp" : "keys",
          () => this.refreshConfig()
        );
        break;
      }

      case "retry_turn": {
        this._postToWebview({ type: "retry_result", session_id: message.sessionId || this._currentSessionId,
          success: false, error: "The daemon is disconnected. Reconnect and try again." });
        break;
      }

      case "open_link": {
        await confirmAndOpenLink(message.url);
        break;
      }

      case "submit_feedback":
      case "feedback_issue": {
        const reply = await handleFeedbackMessage(message, this._context);
        if (reply) this._postToWebview(reply);
        break;
      }

      case "checkin_send": {
        if (this._checkIn) this._postToWebview(await this._checkIn.sendCheckIn(message));
        break;
      }

      case "checkin_dismiss": {
        await this._checkIn?.dismissCheckIn(message.never === true);
        break;
      }

      case "checkin_review": {
        await this._checkIn?.reviewFromCheckIn();
        break;
      }

      case "open_external_url": {
        if (message.url && typeof message.url === "string") {
          try {
            const parsed = vscode.Uri.parse(message.url);
            if (parsed.scheme === "http" || parsed.scheme === "https") {
              vscode.env.openExternal(parsed);
            } else {
              console.warn(`[Andromity] Blocked non-http external URL: ${message.url}`);
            }
          } catch {
            // Ignore invalid URLs
          }
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

          if (provider === "ollama") {
            const status = await this.probeOllama();
            if (!status.running) {
              const msg = status.installed
                ? "Ollama server is not running. Please start Ollama before activating."
                : "Ollama is not installed on this machine. Please download it from https://ollama.com";
              vscode.window.showWarningMessage(msg);
              this._postToWebview({ type: "ollama_status_updated", status });
              this._postToWebview({ type: "key_configure_failed", error: msg });
              break;
            }
            if (!status.models || status.models.length === 0) {
              const msg = "Ollama server is running, but no models are installed. Please pull a coding model first.";
              vscode.window.showWarningMessage(msg);
              this._postToWebview({ type: "ollama_status_updated", status });
              this._postToWebview({ type: "key_configure_failed", error: msg });
              break;
            }
            for (const nm of status.models) {
              if (!providerModels.some((m: any) => m.id === nm)) {
                providerModels.push({
                  id: nm,
                  name: nm,
                  provider: "ollama",
                  desc: "Local Ollama Model",
                  is_free: true,
                } as any);
              }
            }
          }

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

      case "activate_andromity_free": {
        try {
          if (this._rpcClient) {
            await this._rpcClient.call("config.set", {
              section: "default",
              key: "provider",
              value: "andromity",
            });
            await this._rpcClient.call("config.set", {
              section: "default",
              key: "model",
              value: "auto",
            });
          }
          this._currentProvider = "andromity";
          this._currentModel = "auto";
          void this._rpcClient?.call("telemetry.recordFeature", {
            feature: "onboarding_free_trial_started",
            session_id: this._currentSessionId,
          }).catch(() => {});
          vscode.window.showInformationMessage(
            "⚡ Andromity Free Trial activated! You're ready to code."
          );
          await this._loadInitialConfig(false);
          this._postToWebview({
            type: "key_configured_success",
            provider: "andromity",
            model: "auto",
          });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to activate free trial: ${err.message}`);
          this._postToWebview({
            type: "key_configure_failed",
            error: err.message,
          });
        }
        break;
      }

      case "open_login":
      case "open_github_login": {
        recordFeatureUse("login_started");
        try {
          await this.openLogin();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Could not open login page: ${err.message}`);
        }
        break;
      }

      case "logout_account": {
        recordFeatureUse("logout", { sessionId: this._currentSessionId });
        await this.logout();
        break;
      }

      case "refresh_usage": {
        await this.fetchUsage();
        break;
      }

      case "start_ollama_server": {
        recordFeatureUse("ollama_started", { sessionId: this._currentSessionId });
        const ok = await this.startOllamaServer();
        const status = await this.probeOllama();
        this._postToWebview({
          type: "ollama_status_updated",
          status,
        });
        if (ok) {
          vscode.window.showInformationMessage("Ollama server started successfully!");
          await this.refreshConfig();
        } else {
          vscode.window.showWarningMessage(
            "Could not start Ollama server automatically in background. You can open a terminal to inspect or run 'ollama serve'.",
            "Open Terminal"
          ).then((action) => {
            if (action === "Open Terminal") {
              const t = this._getOrCreateOllamaTerminal("Ollama");
              t.show(true);
              t.sendText("ollama serve");
            }
          });
        }
        break;
      }

      case "pull_ollama_model": {
        recordFeatureUse("ollama_model_pulled", { sessionId: this._currentSessionId });
        const modelName = message.model || message.modelName || "qwen2.5-coder:7b";
        this.pullOllamaModel(modelName);
        break;
      }

      case "check_ollama_status": {
        const status = await this.probeOllama();
        this._postToWebview({
          type: "ollama_status_updated",
          status,
        });
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
        const requestedMode = typeof message.nextMode === "string" && modes.includes(message.nextMode.toLowerCase())
          ? message.nextMode.toLowerCase()
          : modes[nextIdx];
        const nextMode = await confirmPermissionMode(requestedMode, this._currentMode);
        if (!nextMode) {
          // Declined or invalid: resync the webview's badge to the unchanged mode.
          this._postToWebview({ type: "config_updated", key: "mode", value: this._currentMode });
        } else {
          this._currentMode = nextMode;
          const config = vscode.workspace.getConfiguration("andromity");
          await config.update("permissionMode", this._currentMode, vscode.ConfigurationTarget.Global);
          await this._rpcClient?.call("config.set", {
            section: "default",
            key: "permission_mode",
            value: this._currentMode,
          });
          const modeChangeNotice = this._isExecuting
            ? `Permissions set to ${this._currentMode.toUpperCase()} for the next turn. Eligible pending approvals may proceed now.`
            : `Permissions: ${this._currentMode.toUpperCase()}`;
          this._postToWebview({ type: "config_updated", key: "mode", value: this._currentMode, notice: modeChangeNotice, appliesNextTurn: this._isExecuting });
          void this._rpcClient?.call("telemetry.recordFeature", { feature: "mode_" + this._currentMode }).catch(() => {});
          SettingsPanel.currentPanel?.loadData();
          vscode.window.showInformationMessage(modeChangeNotice);
        }
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
        });
        this._postToWebview({ type: "config_updated", key: "profile", value: this._currentProfile });
        recordFeatureUse("profile_" + this._currentProfile);
        SettingsPanel.currentPanel?.loadData();
        vscode.window.showInformationMessage(`Agent Profile: ${this._currentProfile.toUpperCase()}`);
        break;
      }

      case "cycle_reasoning":
      case "update_reasoning": {
        const cap = await this._rpcClient?.call("model.reasoning_capability", {
          provider: this._currentProvider, model: this._currentModel,
        });
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
        });
        this._postToWebview({ type: "config_updated", key: "reasoningEffort", value: this._currentReasoning });
        recordFeatureUse("reasoning_" + (this._currentReasoning.startsWith("budget") ? "budget" : this._currentReasoning));
        SettingsPanel.currentPanel?.loadData();
        vscode.window.showInformationMessage(`Reasoning Effort: ${this._currentReasoning.toUpperCase()}`);
        break;
      }


      case "trust_workspace": {
        const workspaceFolder = await confirmAndromityTrust();
        if (workspaceFolder) recordFeatureUse("trust_granted");
        if (!workspaceFolder) {
          this._postToWebview({ type: "trust_updated", isTrusted: false });
          break;
        }
        await this._rpcClient?.call("trust.set", { project_path: workspaceFolder });
        vscode.window.showInformationMessage("Workspace trusted. File editing and shell commands enabled.");
        this._postToWebview({ type: "trust_updated", isTrusted: true });
        SettingsPanel.currentPanel?.loadData();
        break;
      }

      case "untrust_workspace":
      case "revoke_trust": {
        const workspaceFolder = (message.path as string) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceFolder) {
          recordFeatureUse("trust_revoked");
          await this._rpcClient?.call("trust.revoke", { project_path: workspaceFolder });
          vscode.window.showInformationMessage("Workspace trust revoked. File editing and shell commands blocked.");
          this._postToWebview({ type: "trust_updated", isTrusted: false });
          SettingsPanel.currentPanel?.loadData();
        }
        break;
      }

      case "approve_plan": {
        await this.handlePlanApproval(true, message.feedback || "", message.sessionId);
        break;
      }

      case "reject_plan": {
        await this.handlePlanApproval(false, message.feedback || "", message.sessionId);
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
          void this._rpcClient?.call("telemetry.recordFeature", { feature: "cancel_requested", session_id: targetSessionId }).catch(() => {});
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
        recordFeatureUse("file_attached", { sessionId: this._currentSessionId, oncePerSession: true });
        await this.pickAndAttachFile();
        break;
      }

      case "open_file_diff": {
        if (message.filePath) {
          void this._rpcClient?.call("telemetry.recordFeature", { feature: "side_by_side_diff", session_id: this._currentSessionId }).catch(() => {});
          this.openReviewWebview(message.filePath);
        }
        break;
      }

      case "open_review_tab":
      case "open_changes_review": {
        recordFeatureUse("changes_review_opened", { sessionId: this._currentSessionId, oncePerSession: true });
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
          void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => {});
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
          this._waterfallAutoOpenedSessions.add(sid);
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

      case "open_fingerprint": {
        const sid = message.sessionId || this.getCurrentSessionId();
        const sname = message.sessionName || "Chat Session";
        if (sid) {
          FingerprintPanel.createOrShow(
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
        recordFeatureUse("session_switched");
        this.setCurrentSessionId(message.sessionId, true);
        break;
      }

      case "navigate_session": {
        const result = await checkSessionForNavigation(this._rpcClient, message.sessionId,
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        this._postToWebview(result);
        if (result.status === "ok") {
          recordFeatureUse("session_switched");
          this.setCurrentSessionId(result.sessionId, true);
        }
        break;
      }

      case "reset_auto_wake": {
        if (this._rpcClient && message.sessionId) {
          await this._rpcClient.call("session.resetAutoWake", {
            session_id: message.sessionId,
          }).catch((err) => console.error("[ChatView] Reset auto wake error:", err));
        }
        break;
      }

      case "start_next_step_session": {
        if (message.prompt) await this.startNextStepSession(message.prompt, message.title);
        break;
      }

      case "next_step_event": {
        recordNextStepEvent(message.event, message.sessionId || this._currentSessionId);
        break;
      }

      case "wake_for_question": {
        if (message.sessionId && message.questionId) {
          const notice = await wakeSessionForQuestion(this._rpcClient, message.sessionId, message.questionId);
          if (notice) vscode.window.showWarningMessage(notice);
        }
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
        recordFeatureUse("plan_tab_opened", { sessionId: this._currentSessionId, oncePerSession: true });
        vscode.commands.executeCommand("andromity.openPlanTab", this._currentPlan);
        break;
      }

      case "delete_session": {
        if (this._rpcClient && message.sessionId) {
          const confirmDelete = await vscode.window.showWarningMessage(
            `Delete session "${message.sessionName || message.sessionId}"?`,
            { modal: true },
            "Delete"
          );
          if (confirmDelete !== "Delete") break;
          recordFeatureUse("session_deleted", { sessionId: this._currentSessionId });
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          try {
            const result = await this._rpcClient.call<{ success: boolean; error?: string }>("session.delete", {
              session_id: message.sessionId,
              project_path: workspaceFolder,
            });
            if (!result.success) {
              void vscode.window.showErrorMessage(result.error || "Could not delete this chat. Please retry.");
              break;
            }
          } catch {
            void vscode.window.showErrorMessage("Could not delete this chat. Check the connection and retry.");
            break;
          }
          this._waterfallAutoOpenedSessions.delete(message.sessionId);
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
        recordFeatureUse("session_renamed", { sessionId: this._currentSessionId });
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
        const resendPrompt = resendPromptOf(message);
        if (resendPrompt && !(await confirmRewindAndResend(turnsToUndo))) break;
        if (this._diffManager) {
          const undone = await this._diffManager.undoLastTurn(this._currentSessionId, turnIndex, turnsToUndo);
          if (undone) {
            recordFeatureUse("turn_undone", { sessionId: this._currentSessionId });
            await this._loadSession(this._currentSessionId);
            this._postToWebview({ type: "turn_undone", turnsUndone: turnsToUndo, targetTurnIndex: turnIndex, resendPrompt,
              undonePrompt: undonePromptOf(undone) });
            try {
              vscode.commands.executeCommand("git.refresh");
              vscode.commands.executeCommand("andromity.refreshChanges");
            } catch {}
          }
        } else if (this._rpcClient) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const res = await this._rpcClient.call<SessionUndoResult>("session.undo", {
            session_id: this._currentSessionId,
            project_path: workspaceFolder,
            turn_index: turnIndex,
            turns_to_undo: turnsToUndo,
          });
          if (res?.success) {
            recordFeatureUse("turn_undone", { sessionId: this._currentSessionId });
            try {
              vscode.commands.executeCommand("git.refresh");
              vscode.commands.executeCommand("andromity.refreshChanges");
            } catch {}
            const countMsg = (res.turns_undone && res.turns_undone > 1) ? `${res.turns_undone} turns undone` : "Turn undone";
            vscode.window.showInformationMessage(`${countMsg} successfully. (${res.popped_messages || 0} messages removed.)`);
            await this._loadSession(this._currentSessionId);
            this._postToWebview({ type: "turn_undone", turnsUndone: res.turns_undone, targetTurnIndex: res.target_turn_index, resendPrompt,
              undonePrompt: undonePromptOf(res) });
          }
        }
        break;
      }

      case "compact_session": {
        recordFeatureUse("compact_manual", { sessionId: this._currentSessionId });
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
              session_id: this._currentSessionId,
              old_count: res?.old_count,
              message_count: res?.message_count,
              context_tokens: res?.context_tokens,
              context_estimated: res?.context_estimated === true,
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
        const key = message.key || (message.modelId || message.model ? "model" : undefined);
        const value = message.value ?? message.modelId ?? message.model;
        if (key === "mode") {
          await this._handleWebviewMessage({ type: "cycle_mode", nextMode: value });
          break;
        }
        const write = key ? resolveWebviewConfigWrite(key, value) : null;
        if (key && !write) {
          console.warn(`[Andromity Chat] Ignored config write for "${key}" from the chat view.`);
          break;
        }
        if (write && (key !== "model" || !message.provider || resolveWebviewConfigWrite("provider", message.provider))) {
          void this._rpcClient?.call("telemetry.recordFeature", { feature: `config_${write.key}`, session_id: this._currentSessionId }).catch(() => {});
          await this._rpcClient.call("config.set", write);
          if (key === "model" && message.provider) {
            this._currentProvider = message.provider;
            await this._rpcClient.call("config.set", {
              section: "default",
              key: "provider",
              value: message.provider,
            });
          }
          let modelReasoningCap: any = undefined;
          switch (key) {
            case "model": {
              this._currentModel = value;
              const foundModel = this._models.find((m: any) => m.id === value && (!this._currentProvider || m.provider === this._currentProvider));
              modelReasoningCap = (foundModel as any)?.reasoning;
              if (this._rpcClient) {
                try {
                  modelReasoningCap = await this._rpcClient.call("model.reasoning_capability", {
                    provider: this._currentProvider || "openrouter",
                    model: value,
                  });
                } catch {
                  // Keep cached capabilities if discovery is unavailable.
                }
              }
              if (modelReasoningCap && typeof modelReasoningCap === "object") {
                modelReasoningCap._modelId = value;
              }
              break;
            }
            case "provider": this._currentProvider = value; break;
            case "profile": this._currentProfile = value; break;
            case "reasoningEffort": this._currentReasoning = value; break;
          }
          this._postToWebview({
            type: "config_updated",
            key: key,
            value: value,
            provider: this._currentProvider,
            reasoningCapability: modelReasoningCap,
          });
          SettingsPanel.currentPanel?.loadData();
        }
        break;
      }

      case "get_context_breakdown": {
        const sid = message.sessionId || this._currentSessionId;
        if (!sid || !this._rpcClient) break;
        try {
          const data = await this._rpcClient.call<any>("session.context", {
            session_id: sid,
            project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          });
          this._postToWebview({ type: "context_breakdown", session_id: sid, data });
        } catch {
          // Older daemons have no session.context; the popover keeps its simple view.
        }
        break;
      }

      case "telemetry_feature": {
        if (message.feature) {
          recordFeatureUse(String(message.feature), {
            sessionId: message.sessionId || this._currentSessionId,
            oncePerSession: message.once === true,
          });
        }
        break;
      }

      case "webview_error": {
        console.error("[Andromity Webview Error]", message);
        break;
      }

      case "turn_finished":
      case "feature_tip_run":
      case "feature_tip_hide":
      case "feature_tip_off": {
        await this._handleFeatureTipMessage(message);
        break;
      }

      case "toggle_pin": {
        recordFeatureUse("model_pinned", { sessionId: this._currentSessionId });
        const { modelId, provider, name } = message;
        if (modelId) {
          const idx = this._pinnedModels.findIndex(
            (p) => p.id === modelId && (!provider || !p.provider || p.provider === provider)
          );
          if (idx >= 0) {
            this._pinnedModels.splice(idx, 1);
          } else {
            this._pinnedModels.push({
              id: modelId,
              provider: provider || "openrouter",
              name: name || modelId,
            });
          }
          void this._rpcClient?.call("config.toggle_pin", { modelId, provider, name }).catch(() => {});
          this._postToWebview({
            type: "update_pinned_models",
            pinnedModels: this._pinnedModels,
          });
        }
        break;
      }
    }
  }

  public _getHtmlForWebview(webview: vscode.Webview, customState?: Partial<ChatViewState>): string {
    const sidePanelPreferences = this._context?.globalState?.get<unknown>("andromity.sidePanel");
    // The workspace index arrives by postMessage after load instead of being
    // computed synchronously and inlined into every HTML build.
    return getChatViewHtml(webview, this._extensionUri, {
      currentSessionId: customState?.currentSessionId ?? this._currentSessionId,
      currentModel: customState?.currentModel ?? this._currentModel,
      currentProvider: customState?.currentProvider ?? this._currentProvider,
      currentMode: customState?.currentMode ?? this._currentMode,
      currentProfile: customState?.currentProfile ?? this._currentProfile,
      currentReasoning: customState?.currentReasoning ?? this._currentReasoning,
      models: customState?.models ?? this._models,
      pinnedModels: customState?.pinnedModels ?? this._pinnedModels,
      wallpaperConfig: customState?.wallpaperConfig ?? this.getWallpaperConfig(webview),
      defaultWallpaperUri: customState?.defaultWallpaperUri ?? webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "wildcat-panther-dusk.jpg")).toString(),
      workspaceFiles: customState?.workspaceFiles ?? [],
      workspaceFolders: customState?.workspaceFolders ?? [],
      extensionVersion: customState?.extensionVersion ?? (this._context?.extension?.packageJSON?.version || "0.2.15"),
      sidePanelOff: this._context?.globalState?.get<boolean>("andromity.sidePanelOff"),
      sidePanelPreferences: sidePanelPreferences === undefined ? undefined : normalizeSidePanelPreferences(sidePanelPreferences),
    });
  }
}
