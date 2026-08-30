import * as path from "path";
import { exec } from "child_process";
import * as vscode from "vscode";
import { DiffManager } from "../integrations/DiffManager.js";
import { EditorBridge } from "../integrations/EditorBridge.js";
import { SettingsPanel } from "../panels/SettingsPanel.js";
import { RpcClient } from "../server/RpcClient.js";
import {
  ClarifyingQuestionsEvent,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  SubAgentEvent,
  ToolApprovalEvent,
} from "../server/types.js";

function playNativeDoneSound(extensionUri: vscode.Uri) {
  try {
    const soundPath = path.join(extensionUri.fsPath, "media", "done.wav");
    if (process.platform === "win32") {
      const escaped = soundPath.replace(/'/g, "''");
      exec(`powershell -NoProfile -NonInteractive -Command "(New-Object Media.SoundPlayer '${escaped}').PlaySync()"`, { windowsHide: true });
    } else if (process.platform === "darwin") {
      exec(`afplay "${soundPath}"`);
    } else {
      exec(`aplay -q "${soundPath}"`);
    }
  } catch (e) {
    // ignore
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "andromity.chatView";
  private _view?: vscode.WebviewView;
  private _rpcClient: RpcClient | null = null;
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

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context?: vscode.ExtensionContext
  ) {}

  public setRpcClient(client: RpcClient) {
    this._rpcClient = client;
    this._diffManager = new DiffManager(client, this._context!);
    this._bindRpcEvents();
    this._loadInitialConfig(true);
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

  public setCurrentSessionId(sessionId: string) {
    this._currentSessionId = sessionId;
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
  public requestUndoTurn() {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.postMessage({ type: "do_undo_turn" });
    }
  }

  /** Wired to the "Andromity: Open File Diff" command. */
  public async openFileDiff(filePath: string, isUntracked: boolean) {
    if (this._diffManager) {
      await this._diffManager.showFileDiff(filePath, isUntracked);
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
        approved ? "Plan approved — agent is executing." : "Plan rejected — agent will revise."
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
      const res = await this._rpcClient.call<{ success: boolean; message_count: number }>("session.compact", {
        session_id: this._currentSessionId,
      });
      if (res?.success) {
        vscode.window.showInformationMessage(`Session compacted (${res.message_count} messages retained).`);
        await this._loadSession(this._currentSessionId);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to compact session: ${e.message}`);
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

    this._rpcClient.on("agent/started", (params: any) => {
      this._postToWebview({ type: "agent_started", ...params });
    });

    this._rpcClient.on("agent/textDelta", (params: any) => {
      this._postToWebview({ type: "text_delta", ...params });
    });

    this._rpcClient.on("agent/thinkingDelta", (params: any) => {
      this._postToWebview({ type: "thinking_delta", ...params });
    });

    this._rpcClient.on("agent/toolStart", (params: any) => {
      this._postToWebview({ type: "tool_start", ...params });
    });

    this._rpcClient.on("agent/toolDelta", (params: any) => {
      this._postToWebview({ type: "tool_delta", ...params });
    });

    this._rpcClient.on("agent/toolEnd", (params: any) => {
      this._postToWebview({ type: "tool_end", ...params });
    });

    this._rpcClient.on("agent/toolResult", (params: any) => {
      this._postToWebview({ type: "tool_result", ...params });
    });

    this._rpcClient.on("agent/toolApprovalRequired", (params: ToolApprovalEvent) => {
      this._postToWebview({ type: "tool_approval_required", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
        playNativeDoneSound(this._extensionUri);
      }
    });

    this._rpcClient.on("agent/askQuestions", (params: ClarifyingQuestionsEvent) => {
      this._postToWebview({ type: "ask_questions", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
        playNativeDoneSound(this._extensionUri);
      }
    });

    this._rpcClient.on("agent/planApproval", (params: any) => {
      if (params.plan) {
        this._currentPlan = params.plan;
        this._postToWebview({ type: "plan_updated", plan: params.plan });
      }
      this._postToWebview({ type: "plan_approval", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "attention" });
        playNativeDoneSound(this._extensionUri);
      }
    });

    this._rpcClient.on("agent/planUpdated", (params: any) => {
      if (params.plan) {
        this._currentPlan = params.plan;
        this._postToWebview({ type: "plan_updated", plan: params.plan });
      }
    });

    this._rpcClient.on("subagent/spawned", (params: SubAgentEvent) => {
      this._postToWebview({ type: "subagent_spawned", ...params });
    });

    this._rpcClient.on("subagent/progress", (params: SubAgentEvent) => {
      this._postToWebview({ type: "subagent_progress", ...params });
    });

    this._rpcClient.on("subagent/done", (params: SubAgentEvent) => {
      this._postToWebview({ type: "subagent_done", ...params });
    });

    this._rpcClient.on("subagent/failed", (params: SubAgentEvent) => {
      this._postToWebview({ type: "subagent_failed", ...params });
    });

    this._rpcClient.on("agent/done", (params: any) => {
      this._postToWebview({ type: "agent_done", ...params });
      const cfg = vscode.workspace.getConfiguration("andromity");
      if (cfg.get<boolean>("soundNotifications", true)) {
        this._postToWebview({ type: "play_sound", kind: "done" });
        playNativeDoneSound(this._extensionUri);
      }
      // Files may have changed — refresh the Changes view and session stats.
      vscode.commands.executeCommand("andromity.refreshChanges");
    });

    this._rpcClient.on("agent/cancelled", (params: any) => {
      this._postToWebview({ type: "agent_cancelled", ...params });
    });

    this._rpcClient.on("agent/error", (params: any) => {
      this._postToWebview({ type: "agent_error", ...params });
    });

    this._rpcClient.on("session/updated", (params: any) => {
      this._postToWebview({ type: "session_updated", ...params });
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
      const [configData, models, providers, sessions, trustStatus] = await Promise.all([
        this._rpcClient.call<any>("config.get", { project_path: workspaceFolder }).catch(() => ({})),
        this._rpcClient.call<ModelInfo[]>("config.list_models", {}).catch(() => []),
        this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}).catch(() => []),
        this._rpcClient.call<SessionInfo[]>("session.list", { project_path: workspaceFolder }).catch(() => []),
        this._rpcClient.call<any>("trust.status", { project_path: workspaceFolder }).catch(() => ({ is_trusted: true })),
      ]);

      this._models = models || [];
      this._providers = providers || [];
      this._currentProvider = configData?.default_provider || "openrouter";
      this._currentModel = configData?.default_model || "anthropic/claude-3.7-sonnet";
      this._currentProfile = configData?.default_profile || "builder";
      this._currentReasoning = configData?.reasoning_effort || "medium";
      this._currentMode = configData?.permission_mode || "safe";

      if (loadSession) {
        if (sessions && sessions.length > 0) {
          this._currentSessionId = sessions[0].id;
          await this._loadSession(this._currentSessionId);
        } else {
          const newSess = await this._rpcClient.call<SessionInfo>("session.create", {
            name: "Main Session",
            project_path: workspaceFolder,
          }).catch(() => ({ id: "main-session" } as SessionInfo));
          this._currentSessionId = newSess.id;
        }
      }

      this._postToWebview({
        type: "init_state",
        sessionId: this._currentSessionId,
        profile: this._currentProfile,
        model: this._currentModel,
        provider: this._currentProvider,
        mode: this._currentMode,
        reasoningEffort: this._currentReasoning,
        models: this._models,
        providers: this._providers,
        sessions: sessions || [],
        isTrusted: trustStatus?.is_trusted !== false,
        workspaceName: workspaceFolder ? path.basename(workspaceFolder) : "Workspace Ready",
        currentPlan: this._currentPlan,
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
      if (this._rpcClient) {
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

    if (!this._rpcClient) {
      vscode.window.showErrorMessage("Andromity daemon is not connected.");
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
            // Server actually started but ACK timed out — keep turn alive, wait for streaming notifications
            vscode.window.showWarningMessage("Agent started but confirmation timed out. Streaming will continue — check the chat for progress. If stuck, use Cancel.");
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
        });
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
        await this._rpcClient.call("agent.cancel", {
          session_id: this._currentSessionId,
        });
        break;
      }

      case "new_session": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const res = await this._rpcClient.call<SessionInfo>("session.create", {
          name: message.name || `Session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
          project_path: workspaceFolder,
        });
        this.setCurrentSessionId(res.id);
        await this.fetchAndPostSessions();
        vscode.commands.executeCommand("andromity.refreshSessions");
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
            description: s.id === this._currentSessionId ? "★ Current" : (s.message_count ? `${s.message_count} msgs` : ""),
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
          vscode.commands.executeCommand("andromity.refreshChanges");
        }
        break;
      }

      case "compact_session": {
        try {
          await this._rpcClient.call("session.compact", {
            session_id: this._currentSessionId,
          });
          vscode.window.showInformationMessage("Context compacted successfully.");
          await this._loadSession(this._currentSessionId);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to compact context: ${e.message}`);
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

      case "update_config": {
        if (message.key) {
          const keyMap: Record<string, string> = {
            model: "model",
            provider: "provider",
            profile: "profile",
            reasoningEffort: "reasoning_effort",
            mode: "permission_mode",
          };
          const daemonKey = keyMap[message.key] || message.key;
          await this._rpcClient.call("config.set", {
            section: "default",
            key: daemonKey,
            value: message.value,
          });
          switch (message.key) {
            case "model": this._currentModel = message.value; break;
            case "provider": this._currentProvider = message.value; break;
            case "profile": this._currentProfile = message.value; break;
            case "mode": this._currentMode = message.value; break;
            case "reasoningEffort": this._currentReasoning = message.value; break;
          }
          this._postToWebview({ type: "config_updated", key: message.key, value: message.value });
          SettingsPanel.currentPanel?.loadData();
        }
        break;
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const doneAudioUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "done.wav"));
    const sidebarIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "sidebar-icon.png"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; media-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Andromity AI</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #18181b);
      --fg: var(--vscode-foreground, #e4e4e7);
      --card-bg: var(--vscode-editor-background, #1e1e1e);
      --input-bg: var(--vscode-input-background, #252526);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --border: var(--vscode-widget-border, rgba(255,255,255,0.08));
      --accent: var(--vscode-focusBorder, #007fd4);
      --accent-glow: rgba(0, 127, 212, 0.25);
      --green: #3fb950;
      --red: #f85149;
      --purple: #bc8cff;
      --muted: var(--vscode-descriptionForeground, #888888);
      --radius: 6px;
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Top Bar: Minimal, Sleek, Professional ─────────────────────── */
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      gap: 6px;
      flex-shrink: 0;
      position: relative;
    }

    .top-bar-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }

    /* Session Badge */
    .session-badge-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 10px;
      color: var(--fg);
      cursor: pointer;
      font-size: 11.5px;
      font-weight: 500;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: all 0.15s ease;
    }
    .session-badge-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--accent);
    }
    .session-badge-icon {
      width: 12px;
      height: 12px;
      color: var(--accent);
      flex-shrink: 0;
    }
    .session-badge-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Model Pill */
    .model-badge-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 3px 8px;
      color: var(--fg);
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      max-width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: all 0.15s ease;
    }

    .model-badge-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: var(--accent);
    }

    .model-badge-icon {
      width: 12px;
      height: 12px;
      color: var(--accent);
      flex-shrink: 0;
    }

    .model-badge-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chevron-icon {
      width: 10px;
      height: 10px;
      color: var(--muted);
      flex-shrink: 0;
    }

    /* Mode Badge */
    .mode-badge-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(63, 185, 80, 0.12);
      border: 1px solid rgba(63, 185, 80, 0.3);
      border-radius: 4px;
      padding: 2px 6px;
      color: var(--green);
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      letter-spacing: 0.3px;
      flex-shrink: 0;
      transition: all 0.15s ease;
    }

    .mode-badge-btn svg { width: 10px; height: 10px; }
    .mode-badge-btn:hover { background: rgba(63, 185, 80, 0.2); }

    .mode-badge-btn.mode-safe {
      background: rgba(63, 185, 80, 0.12);
      border-color: rgba(63, 185, 80, 0.35);
      color: var(--green);
    }
    .mode-badge-btn.mode-safe:hover { background: rgba(63, 185, 80, 0.22); }

    .mode-badge-btn.mode-trust {
      background: rgba(88, 166, 255, 0.12);
      border-color: rgba(88, 166, 255, 0.35);
      color: #58a6ff;
    }
    .mode-badge-btn.mode-trust:hover { background: rgba(88, 166, 255, 0.22); }

    .mode-badge-btn.mode-full {
      background: rgba(188, 140, 255, 0.12);
      border-color: rgba(188, 140, 255, 0.35);
      color: #bc8cff;
    }
    .mode-badge-btn.mode-full:hover { background: rgba(188, 140, 255, 0.22); }

    .mode-badge-btn.mode-yolo {
      background: rgba(240, 136, 62, 0.12);
      border-color: rgba(240, 136, 62, 0.35);
      color: #f0883e;
    }
    .mode-badge-btn.mode-yolo:hover { background: rgba(240, 136, 62, 0.22); }

    /* ── Sessions Drawer / Flyout ─────────────────────────────────── */
    .sessions-flyout {
      position: absolute;
      top: 36px;
      left: 8px;
      right: 8px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 10px 28px rgba(0,0,0,0.5);
      z-index: 120;
      display: flex;
      flex-direction: column;
      max-height: 340px;
      overflow: hidden;
    }
    .sessions-flyout-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.02);
    }
    .sessions-search {
      flex: 1;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--fg);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 11px;
      outline: none;
    }
    .sessions-search:focus { border-color: var(--accent); }
    .sessions-new-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 10px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .sessions-new-btn:hover { opacity: 0.9; }
    .sessions-list {
      overflow-y: auto;
      padding: 4px;
    }
    .session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      color: var(--fg);
      transition: background 0.12s;
      border: 1px solid transparent;
    }
    .session-item:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .session-item.active {
      background: rgba(6, 182, 212, 0.08);
      border-color: rgba(6, 182, 212, 0.25);
      color: var(--accent);
    }
    .session-item-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .session-item-title {
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-item-meta {
      font-size: 10px;
      color: var(--muted);
      display: flex;
      gap: 8px;
    }
    .session-item-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.12s;
    }
    .session-item:hover .session-item-actions {
      opacity: 1;
    }
    .session-action-icon {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 3px;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .session-action-icon:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.1);
    }
    .session-action-delete:hover {
      color: var(--red);
      background: rgba(248, 81, 73, 0.15);
    }

    /* ── Scheduled Crons Overlay ───────────────────────────────────── */
    .crons-flyout {
      position: absolute;
      top: 36px;
      left: 8px;
      right: 8px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 10px 28px rgba(0,0,0,0.5);
      z-index: 120;
      display: flex;
      flex-direction: column;
      max-height: 320px;
      overflow: hidden;
    }
    .crons-flyout-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.02);
    }
    .crons-header-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--fg);
    }
    .crons-close-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 2px;
      border-radius: 3px;
    }
    .crons-close-btn:hover { color: var(--fg); }
    .crons-list {
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cron-card {
      padding: 8px 10px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cron-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .cron-card-schedule {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--accent);
    }
    .cron-status-pill {
      font-size: 9.5px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 1px 6px;
      border-radius: 8px;
    }
    .cron-status-active { background: rgba(63, 185, 80, 0.15); color: var(--green); }
    .cron-status-paused { background: rgba(148, 163, 184, 0.15); color: var(--pending-fg); }
    .cron-prompt {
      font-size: 11px;
      color: var(--fg);
      line-height: 1.3;
    }

    /* ── Inline Todo Progress Bar (Live Planner Tracker) ──────────── */
    .plan-tracker-strip {
      padding: 8px 10px;
      background: rgba(6, 182, 212, 0.05);
      border-bottom: 1px solid rgba(6, 182, 212, 0.22);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 5px;
      transition: all 0.2s ease;
    }
    .tracker-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tracker-info {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      color: var(--fg);
    }
    .tracker-icon {
      color: var(--accent);
      flex-shrink: 0;
    }
    .tracker-title {
      font-weight: 600;
    }
    .tracker-count {
      color: var(--muted);
      font-size: 11px;
    }
    .btn-tracker-open {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(6, 182, 212, 0.12);
      border: 1px solid rgba(6, 182, 212, 0.3);
      color: var(--accent);
      font-size: 11px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.12s;
    }
    .btn-tracker-open:hover {
      background: rgba(6, 182, 212, 0.22);
    }
    .tracker-progress-track {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
    }
    .tracker-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #06b6d4, #10b981);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .tracker-step-title {
      font-size: 10.5px;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Model Quick Switcher Flyout ───────────────────────────────── */
    .model-flyout {
      position: absolute;
      top: 36px;
      left: 10px;
      right: 10px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 100;
      display: flex;
      flex-direction: column;
      max-height: 280px;
      overflow: hidden;
    }

    .flyout-header {
      display: flex;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }

    .flyout-search {
      flex: 1;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--fg);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 11px;
      outline: none;
    }

    .flyout-hub-link {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }

    .flyout-list {
      overflow-y: auto;
      padding: 4px;
    }

    .flyout-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      color: var(--fg);
      transition: background 0.12s;
    }

    .flyout-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .flyout-item.active {
      color: var(--green);
      font-weight: 600;
    }

    .flyout-item-meta {
      font-size: 10px;
      color: var(--muted);
    }

    /* ── Chat Feed ─────────────────────────────────────────────────── */
    .chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    /* Zero state greeting */
    .zero-state {
      margin: auto 0;
      padding: 16px 8px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }

    .zero-icon.brand-glow {
      width: 32px;
      height: 32px;
    }

    .andromity-turn-loader {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 500;
      color: var(--fg);
      // background: rgba(6, 182, 212, 0.08);
      // border: 1px solid rgba(6, 182, 212, 0.25);
      border-radius: 6px;
      margin: 4px 0 8px;
      width: fit-content;
    }

    .andromity-turn-loader svg,
    .andromity-turn-loader img {
      width: 14px;
      height: 14px;
      object-fit: contain;
      flex-shrink: 0;
    }

    @keyframes spin { 100% { transform: rotate(360deg); } }
    .spinning { animation: spin 1.2s linear infinite; }

    .zero-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--fg);
      letter-spacing: -0.2px;
      margin-bottom: 2px;
    }

    .zero-subtitle {
      font-size: 12.5px;
      color: var(--muted);
      text-align: center;
      margin-bottom: 4px;
      min-height: 18px;
      max-width: 290px;
      line-height: 1.4;
    }

    .zero-context-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      font-size: 11px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-top: 2px;
    }

    .starter-cards {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 100%;
      max-width: 320px;
      margin-top: 8px;
    }

    .starter-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      text-align: left;
      color: var(--fg);
      transition: all 0.15s ease;
    }

    .starter-card:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(6, 182, 212, 0.4);
      transform: translateY(-1px);
    }

    .starter-icon {
      width: 15px;
      height: 15px;
      color: var(--accent);
      flex-shrink: 0;
    }

    .starter-info {
      display: flex;
      flex-direction: column;
      gap: 1px;
      text-align: left;
    }

    .starter-header {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 0.6px;
      text-transform: uppercase;
      margin-bottom: 2px;
    }

    .starter-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--fg);
    }

    .starter-desc {
      font-size: 11px;
      color: var(--muted);
    }

    /* ── Recent Sessions at Home / Zero State ──────────────────────── */
    .recent-sessions-section {
      width: 100%;
      max-width: 320px;
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .recent-sessions-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 2px;
      margin-bottom: 2px;
    }

    .recent-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 0.6px;
      text-transform: uppercase;
    }

    .recent-header-left svg {
      width: 13px;
      height: 13px;
      color: var(--muted);
    }

    .recent-view-all-btn {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: 11.5px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      transition: color 0.12s;
    }

    .recent-view-all-btn:hover {
      color: var(--fg);
    }

    .recent-view-all-btn svg {
      width: 11px;
      height: 11px;
    }

    .recent-sessions-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .recent-session-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 12px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s ease;
    }

    .recent-session-card:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(6, 182, 212, 0.35);
      transform: translateY(-1px);
    }

    .recent-session-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .recent-session-title {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--fg);
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    }

    .recent-session-sub {
      font-size: 11px;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .recent-session-side {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .recent-session-date {
      font-size: 11.5px;
      color: var(--muted);
      white-space: nowrap;
    }

    /* ── Status Bar Footer ──────────────────────── */
    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 12px;
      border-top: 1px solid var(--border);
      background: var(--bg);
      font-size: 11px;
      color: var(--muted);
      flex-shrink: 0;
      height: 25px;
    }

    .token-capacity-widget {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: help;
      padding: 2px 4px;
      border-radius: 4px;
      transition: background 0.15s;
    }

    .token-capacity-widget:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--fg);
    }

    .token-icon {
      width: 12px;
      height: 12px;
      color: var(--muted);
    }

    .token-mini-track {
      width: 44px;
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
      display: inline-flex;
    }

    .token-mini-bar {
      height: 100%;
      background: linear-gradient(90deg, #06b6d4, #10b981);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    /* Messages */
    .message {
      display: flex;
      flex-direction: column;
      gap: 6px;
      animation: fadeIn 0.2s ease-out;
      word-break: break-word;
    }

    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* Messages */
    .message-wrap {
      display: flex;
      flex-direction: column;
      margin: 8px 0;
      width: 100%;
      position: relative;
    }

    .message-wrap.user {
      align-items: flex-end;
    }

    .message-wrap.assistant {
      align-items: flex-start;
    }

    .message.user {
      background: rgba(0, 127, 212, 0.15);
      border: 1px solid rgba(0, 127, 212, 0.3);
      color: var(--fg);
      padding: 8px 12px;
      border-radius: 8px 8px 2px 8px;
      max-width: 85%;
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
    }

    .message.assistant {
      background: transparent;
      max-width: 100%;
      width: 100%;
      font-size: 13px;
      line-height: 1.5;
    }

    /* Assistant Header with Andromity Brand Icon */
    .assistant-header {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 6px;
      user-select: none;
    }
    .assistant-avatar {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .assistant-avatar svg {
      width: 13px;
      height: 13px;
    }
    .assistant-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
      letter-spacing: 0.2px;
    }

    .message-footer {
      display: none;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
      font-size: 12.5px;
      color: var(--muted);
      padding: 0 2px;
    }
    .message-wrap:hover .message-footer{
    display:flex;
    z-index:2;
    }

     .msg-copy-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      font-size: 12.5px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 5px;
      border-radius: 3px;
      opacity: 0.55;
      transition: all 0.15s;
    }
    .msg-copy-btn:hover {
      opacity: 1;
      color: var(--fg);
      background: rgba(255, 255, 255, 0.06);
    }
    /* User bubbles — TUI has no copy, keep footer minimal */
    .message-wrap.user .message-footer { justify-content: flex-end; opacity: 0.6; }
    .message-wrap.user .msg-copy-btn { display: none; }

    .turn-duration-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family, monospace);
    }

    /* Thinking bubble — TUI parity: auto-expand while streaming, auto-collapse when done, clickable anytime */
    .thinking-card {
      background: transparent;
      border: none;
      border-left: 1px solid rgba(188, 140, 255, 0.35);
      border-radius: 0;
      padding: 0;
      margin: 4px 0;
    }
    .thinking-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 400;
      font-style: italic;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
      padding: 4px 8px;
      border-radius: 4px;
      transition: background 0.15s, color 0.15s;
    }
    .thinking-header:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.04);
    }
    .thinking-pulse {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--purple);
      box-shadow: 0 0 6px var(--purple);
      animation: pulse 1.2s infinite;
      flex-shrink: 0;
    }
    @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
    .thinking-content {
      font-size: 12px;
      font-style: italic;
      color: var(--muted);
      margin: 0 0 0 18px;
      padding: 4px 10px 8px;
      white-space: pre-wrap;
      line-height: 1.55;
      max-height: 240px;
      overflow-y: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
      display: none;
      border-left: 1px dashed rgba(188,140,255,0.25);
    }
    .thinking-content::-webkit-scrollbar {
      display: none;
    }
    .thinking-card.expanded .thinking-content { display: block; }
    .thinking-card.expanded .thinking-chevron { transform: rotate(90deg); }
    .thinking-chevron {
      margin-left: auto;
      width: 10px; height: 10px;
      color: var(--muted);
      transition: transform 0.15s;
      flex-shrink: 0;
    }

    /* Markdown Typography & Blocks */
    .assistant-text {
      font-size: 13px;
      line-height: 1.6;
      color: var(--fg);
      word-break: break-word;
    }
    .assistant-text strong {
      font-weight: 600;
      color: #ffffff;
    }
    .assistant-text em {
      font-style: italic;
      color: var(--fg);
    }
    .assistant-text code {
      font-family: var(--vscode-editor-font-family, "Consolas", "Courier New", monospace);
      font-size: 12px;
      background: rgba(255, 255, 255, 0.09);
      color: #79c0ff;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .assistant-text h3 {
      font-size: 15px;
      font-weight: 600;
      margin: 12px 0 6px;
      color: #ffffff;
    }
    .assistant-text h4 {
      font-size: 13.5px;
      font-weight: 600;
      margin: 10px 0 4px;
      color: #ffffff;
    }
    .assistant-text h5 {
      font-size: 12px;
      font-weight: 600;
      margin: 8px 0 3px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .md-spacer {
      height: 8px;
    }
    .md-line {
      margin: 2px 0;
      line-height: 1.55;
    }
    .md-bullet {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      margin: 2px 0 2px 6px;
      line-height: 1.55;
    }
    .md-dot {
      color: var(--accent);
      font-size: 14px;
      line-height: 1.2;
      user-select: none;
      flex-shrink: 0;
    }
    .md-num {
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
      min-width: 14px;
      user-select: none;
      flex-shrink: 0;
    }
    .md-text {
      flex: 1;
    }
    .md-quote {
      border-left: 3px solid var(--accent);
      padding: 4px 10px;
      margin: 6px 0;
      background: rgba(0, 127, 212, 0.08);
      border-radius: 0 4px 4px 0;
      color: var(--muted);
    }
    .code-block-container {
      margin: 10px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: rgba(0, 0, 0, 0.25);
      overflow: hidden;
    }
    .code-block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 10px;
      background: rgba(255, 255, 255, 0.05);
      border-bottom: 1px solid var(--border);
      font-size: 10.5px;
      color: var(--muted);
    }
    .code-lang-tag {
      font-weight: 600;
      letter-spacing: 0.5px;
      color: var(--muted);
    }
     .code-block-actions {
      display: flex;
      gap: 6px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .code-block-container:hover .code-block-actions { opacity: 1; }
    .code-btn {
      padding: 2px 7px;
      font-size: 10.5px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .code-btn:hover {
      background: rgba(255,255,255,0.08);
      color: var(--fg);
      border-color: var(--border);
    }
    .code-block-pre {
      margin: 0;
      padding: 10px 12px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, "Consolas", "Courier New", monospace);
      font-size: 12px;
      line-height: 1.5;
    }

    /* Tool Card — TUI parity: expand while running, collapse when done, toggle on click */
    .tool-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 6px 10px;
      margin: 4px 0;
      font-size: 11.5px;
    }
    .tool-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
    }
    .tool-header:hover {
      color: var(--fg);
    }
    .tool-title-group {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .tool-tag {
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 3px;
      background: rgba(0, 127, 212, 0.15);
      color: var(--accent);
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .tool-chevron {
      width: 10px;
      height: 10px;
      color: var(--muted);
      transition: transform 0.15s;
      flex-shrink: 0;
      margin-left: 6px;
    }
    .tool-card.expanded .tool-chevron {
      transform: rotate(90deg);
    }
    .tool-body {
      color: var(--muted);
      font-family: var(--vscode-editor-font-family, "Consolas", monospace);
      font-size: 11.5px;
      line-height: 1.45;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      white-space: pre-wrap;
      max-height: 160px;
      overflow-y: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
      display: none;
    }
    .tool-body::-webkit-scrollbar {
      display: none;
    }
    .tool-card.expanded .tool-body {
      display: block;
    }

    /* Tool Sequence — TUI parity: group tools under working/worked collapsible */
    .tool-sequence {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 6px 0;
      overflow: hidden;
    }
    .tool-seq-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      font-size: 11.5px;
      font-weight: 500;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
      background: rgba(255,255,255,0.02);
    }
    .tool-seq-header:hover { background: rgba(255,255,255,0.05); color: var(--fg); }
    .tool-seq-icon { font-size: 12px; }
    .tool-seq-title { flex: 1; font-weight: 600; }
    .tool-seq-chevron { width: 12px; height: 12px; color: var(--muted); transition: transform 0.15s; }
    .tool-sequence.collapsed .tool-seq-chevron { transform: rotate(90deg); }
    .tool-sequence.collapsed .tool-seq-body { display: none; }
    .tool-seq-body { padding: 4px 6px; display: flex; flex-direction: column; gap: 4px; }
    .tool-seq-copy {
      font-size: 10px;
      padding: 2px 7px;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 4px;
      cursor: pointer;
    }
    .tool-seq-copy:hover { color: var(--fg); background: rgba(255,255,255,0.06); }
    .tool-sequence .tool-card { margin: 0; border-radius: 4px; }
    .tool-sequence .thinking-card { margin: 0; }

    /* Subagent Card */
    .subagent-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 8px;
      margin: 4px 0;
      font-size: 11px;
    }

    .subagent-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
    }

    .subagent-role {
      color: var(--accent);
      text-transform: capitalize;
    }

    .subagent-status {
      margin-left: auto;
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--muted);
    }

    .subagent-status.done {
      background: rgba(63, 185, 80, 0.15);
      color: var(--green);
    }

    .subagent-body {
      color: var(--muted);
      margin-top: 4px;
      white-space: pre-wrap;
    }

    /* Interactive Cards — approval / questions */
    .approval-card {
      background: var(--card-bg, #1e1e1e);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      border-radius: 4px;
      padding: 12px;
      margin: 10px 0;
      font-size: 12px;
    }

    /* ── Clarifying Questions Carousel ────────────────────────── */
    .questions-card {
      background: var(--card-bg, #1e1e1e);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      border-radius: 4px;
      padding: 12px;
      margin: 10px 0;
      font-size: 12px;
    }

    .questions-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }

    .questions-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg);
    }

    .questions-step-badge {
      font-size: 11px;
      color: var(--muted);
      font-weight: 500;
    }

    .carousel-slides {
      margin-bottom: 12px;
    }

    .question-prompt {
      font-size: 12px;
      font-weight: 500;
      color: var(--fg);
      line-height: 1.4;
      margin-bottom: 8px;
    }

    .question-num-tag {
      color: var(--accent, #007fd4);
      font-weight: 600;
    }

    .question-options-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .question-option-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      border-radius: 3px;
      background: transparent;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      color: var(--fg);
      transition: background 0.1s ease;
    }

    .question-option-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
    }

    .question-option-row input {
      margin: 0;
      cursor: pointer;
      accent-color: var(--vscode-focusBorder, #007fd4);
    }

    .question-option-row span {
      line-height: 1.3;
    }

    .question-textarea {
      width: 100%;
      padding: 6px 8px;
      font-size: 12px;
      font-family: inherit;
      color: var(--fg);
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      outline: none;
      resize: vertical;
      box-sizing: border-box;
    }

    .question-textarea:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .carousel-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }

    .btn-carousel-prev,
    .btn-carousel-next,
    .btn-carousel-submit {
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 2px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      transition: background 0.1s ease;
    }

    .btn-carousel-prev {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
    }

    .btn-carousel-prev:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    .btn-carousel-next,
    .btn-carousel-submit {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
    }

    .btn-carousel-next:hover,
    .btn-carousel-submit:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }

    .approval-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .approval-icon {
      width: 26px; height: 26px;
      border-radius: 6px;
      background: rgba(6, 182, 212, 0.12);
      border: 1px solid rgba(6, 182, 212, 0.25);
      display: flex; align-items: center; justify-content: center;
      color: var(--accent);
      flex-shrink: 0;
    }
    .approval-kicker {
      font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
      text-transform: uppercase; color: var(--accent);
      margin-bottom: 2px;
    }
    .approval-title { font-size: 12.5px; font-weight: 600; color: var(--fg); }
    .approval-tool-meta {
      display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap;
    }
    .approval-tool-pill {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; font-weight: 500;
      padding: 3px 8px; border-radius: 4px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--border);
      color: var(--fg);
    }
    .approval-tool-pill.status-pill {
      font-size: 9.5px;
      font-weight: 700;
      background: rgba(6, 182, 212, 0.12);
      color: var(--accent);
      border-color: rgba(6, 182, 212, 0.25);
    }
    .approval-path {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; color: var(--muted);
      background: rgba(0,0,0,0.25); border: 1px solid var(--border);
      padding: 3px 7px; border-radius: 4px;
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .approval-desc {
      font-size: 11.5px; color: var(--muted); line-height: 1.45; margin: 8px 0 0;
    }
    .approval-args {
      margin-top: 8px; padding: 8px 10px;
      background: rgba(0,0,0,0.25); border: 1px solid var(--border);
      border-radius: 6px; font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; color: var(--muted);
      max-height: 100px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
      display: none;
    }
    .approval-card.show-args .approval-args { display: block; }
    .approval-toggle-args {
      margin-top: 6px; font-size: 10.5px; color: var(--accent);
      cursor: pointer; user-select: none; display: inline-flex; align-items: center; gap: 4px;
    }
    .approval-toggle-args:hover { text-decoration: underline; }
    .approval-buttons {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    .btn-approve, .btn-reject {
      padding: 6px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11.5px;
      font-weight: 600;
      border: 1px solid transparent;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      transition: all 0.15s ease;
    }

    .btn-approve {
      background: #059669;
      color: #fff;
    }
    .btn-approve:hover {
      background: #10b981;
      box-shadow: 0 2px 10px rgba(16, 185, 129, 0.4);
    }
    .btn-reject {
      background: rgba(255,255,255,0.06);
      color: var(--fg);
      border-color: var(--border);
    }
    .btn-reject:hover {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      border-color: rgba(239, 68, 68, 0.3);
    }
    .btn-ghost {
      margin-left: auto; padding: 6px 10px; font-size: 11px;
      background: transparent; border: 1px solid var(--border);
      color: var(--muted); border-radius: 6px; cursor: pointer;
    }
    .btn-ghost:hover { color: var(--fg); background: rgba(255,255,255,0.05); }

    /* Prompt Queue */
    .queue-container {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 4px 10px;
      background: rgba(255, 255, 255, 0.03);
      border-top: 1px solid var(--border);
    }

    .queue-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--muted);
      background: var(--input-bg);
      padding: 3px 8px;
      border-radius: 4px;
    }

    .queue-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .queue-remove { background: transparent; border: none; color: var(--muted); cursor: pointer; }

    /* Input Section (Codex-style prompt card) */
    .input-section {
      padding: 8px 10px 6px 10px;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }

    .prompt-box {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 8px 10px 8px 10px;
      display: flex;
      flex-direction: column;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .prompt-box:focus-within {
      border-color: rgba(255, 255, 255, 0.18);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.05);
    }

    #prompt-input {
      width: 100%;
      background: transparent;
      border: none;
      color: var(--fg);
      font-family: inherit;
      font-size: 13px;
      outline: none;
      resize: none;
      min-height: 38px;
      max-height: 160px;
      line-height: 1.45;
      padding: 2px 2px 6px 2px;
    }
    #prompt-input::placeholder {
      color: rgba(255, 255, 255, 0.35);
    }

    .prompt-box-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-top: 4px;
      padding-top: 2px;
      user-select: none;
    }

    .prompt-left-controls, .prompt-right-controls {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Icon button (+ button) */
    .prompt-icon-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      transition: all 0.15s;
    }
    .prompt-icon-btn:hover {
      color: var(--fg);
      background: rgba(255, 255, 255, 0.08);
    }

    /* Pill buttons (Mode pill, Model pill, Context pill) */
    .prompt-pill-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--muted);
      border-radius: 6px;
      font-size: 11px;
      padding: 3px 7px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .prompt-pill-btn:hover {
      color: var(--fg);
      border-color: rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.08);
    }
    .prompt-pill-btn svg {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
    }

    /* Send & Cancel Circular Buttons */
    .codex-send-btn {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.35);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
      padding: 0;
    }
    .codex-send-btn.has-text {
      background: #ffffff;
      color: #000000;
    }
    .codex-send-btn.has-text:hover {
      background: #e2e8f0;
      transform: translateY(-1px);
    }

    .codex-cancel-btn {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 1px solid rgba(248, 81, 73, 0.4);
      background: rgba(248, 81, 73, 0.2);
      color: var(--red);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
      padding: 0;
    }
    .codex-cancel-btn:hover {
      background: rgba(248, 81, 73, 0.35);
    }
    .codex-cancel-btn svg, .codex-send-btn svg {
      width: 12px;
      height: 12px;
    }

    /* Status Bar */
    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 10px;
      font-size: 10px;
      color: var(--muted);
      border-top: 1px solid var(--border);
      background: var(--bg);
      flex-shrink: 0;
    }

    /* Trust Prompt Banner */
    .trust-banner {
      background: rgba(210, 153, 34, 0.12);
      border: 1px solid rgba(210, 153, 34, 0.35);
      border-radius: var(--radius);
      padding: 12px 14px;
      margin: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .trust-banner-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #d29922;
    }
    .trust-banner-header svg { width: 16px; height: 16px; color: #d29922; }
    .trust-banner-desc { font-size: 11px; color: var(--muted); line-height: 1.4; }
    .trust-banner-actions { display: flex; gap: 8px; margin-top: 4px; }
    .trust-btn {
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      background: #d29922;
      color: #000;
      transition: background 0.15s;
    }
    .trust-btn:hover { background: #e3a830; }
    .trust-btn-sec {
      padding: 5px 10px;
      font-size: 11px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg);
      cursor: pointer;
    }
    .trust-btn-sec:hover { background: rgba(255,255,255,0.06); }
  </style>
</head>
<body>
  <audio id="audio-done" preload="auto" src="${doneAudioUri}"></audio>

  <!-- Top Bar (Clean Session Header, No Duplicate Buttons) -->
  <div class="top-bar">
    <div class="top-bar-left">
      <button class="session-badge-btn" id="btn-session-picker" title="Sessions (Click to switch or manage sessions)">
        <svg class="session-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="session-badge-text" id="active-session-name">Main Session</span>
        <svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </div>
  </div>

  <!-- Sessions Flyout / Drawer -->
  <div class="sessions-flyout" id="sessions-flyout" style="display:none;">
    <div class="sessions-flyout-header">
      <input type="text" class="sessions-search" id="sessions-search" placeholder="Search sessions...">
      <button class="sessions-new-btn" id="btn-sessions-new" title="Create Fresh Session">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        <span>New</span>
      </button>
    </div>
    <div class="sessions-list" id="sessions-list">
      <div style="padding:14px; text-align:center; color:var(--muted); font-size:11px;">Loading sessions...</div>
    </div>
  </div>


  <!-- Inline Todo Progress Bar (Live Planner Tracker Inside) -->
  <div class="plan-tracker-strip" id="plan-tracker-strip" style="display:none;">
    <div class="tracker-row">
      <div class="tracker-info">
        <svg class="tracker-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
        <span class="tracker-title" id="tracker-title">Plan Tracker</span>
        <span class="tracker-count" id="tracker-count">0/0 steps</span>
      </div>
      <button class="btn-tracker-open" id="btn-tracker-open" title="Open Full Plan in Editor Tab">
        <span>View Plan</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
      </button>
    </div>
    <div class="tracker-progress-track">
      <div class="tracker-progress-bar" id="tracker-progress-bar" style="width:0%;"></div>
    </div>
    <div class="tracker-step-title" id="tracker-step-title"></div>
  </div>

  <div class="model-flyout" id="model-flyout" style="display:none;">
    <div class="flyout-header">
      <input type="text" class="flyout-search" id="flyout-search" placeholder="Search 396+ models...">
      <button class="flyout-hub-link" id="btn-flyout-open-hub">Open Full Hub</button>
    </div>
    <div class="flyout-list" id="flyout-list"></div>
  </div>

  <!-- Trust Banner (shown if workspace not trusted) -->
  <div class="trust-banner" id="trust-banner" style="display:none;">
    <div class="trust-banner-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <span>Workspace Trust Required</span>
    </div>
    <div class="trust-banner-desc">
      Do you trust the files in this folder? Andromity requires workspace trust to edit files and execute shell commands safely.
    </div>
    <div class="trust-banner-actions">
      <button class="trust-btn" id="btn-trust-confirm">Trust Folder</button>
      <button class="trust-btn-sec" id="btn-trust-dismiss">Restricted Mode</button>
    </div>
  </div>

  <!-- Chat Messages Feed -->
  <div class="chat-container" id="chat-messages">
    <!-- Clean Onboarding Zero State (No Emojis) -->
    <div class="zero-state" id="zero-state">
      <div class="zero-brand-wrap">
        <img class="zero-icon" src="${sidebarIconUri}" width="38" height="38" alt="Andromity" />
      </div>
      <div class="zero-title">Andromity</div>
      <div class="zero-subtitle" id="zero-greeting">What can I do for you?</div>
      <div class="zero-context-pill">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        <span id="zero-workspace-label">Workspace Ready</span>
      </div>

      <!-- Recent Sessions Section (rendered dynamically when past sessions exist) -->
      <div class="recent-sessions-section" id="recent-sessions-section" style="display:none;">
        <div class="recent-sessions-header">
          <div class="recent-header-left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <span>RECENT</span>
          </div>
          <button class="recent-view-all-btn" data-action="view-all-sessions" title="View all sessions in drawer">
            <span>View All</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        </div>
        <div class="recent-sessions-list" id="recent-sessions-list"></div>
      </div>

      <div class="starter-cards">
        <div class="starter-header">Quick Starters</div>
        <div class="starter-card" data-action="send-starter" data-prompt="Explain the architecture of this project in detail">
          <svg class="starter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
          <div class="starter-info">
            <span class="starter-name">Explain Architecture</span>
            <span class="starter-desc">Map dependencies and project design</span>
          </div>
        </div>
        <div class="starter-card" data-action="send-starter" data-prompt="Analyze diagnostics and fix any syntax or type errors in the current file">
          <svg class="starter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
          </svg>
          <div class="starter-info">
            <span class="starter-name">Fix Diagnostics & Errors</span>
            <span class="starter-desc">Inspect active errors and repair code</span>
          </div>
        </div>
        <div class="starter-card" data-action="send-starter" data-prompt="Write comprehensive unit tests with edge cases for the active code">
          <svg class="starter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 3h6v3H9zM10 6v7.3a4 4 0 1 0 4 0V6"></path>
            <circle cx="12" cy="17" r="1.5" fill="currentColor"></circle>
          </svg>
          <div class="starter-info">
            <span class="starter-name">Generate Unit Tests</span>
            <span class="starter-desc">Cover edge cases and critical paths</span>
          </div>
        </div>
        <div class="starter-card" data-action="open-model-hub">
          <svg class="starter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
          </svg>
          <div class="starter-info">
            <span class="starter-name">Model Catalog</span>
            <span class="starter-desc">Browse 396+ OpenRouter models</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Interactive Modals Slot -->
  <div id="interactive-slot" style="padding: 0 10px;"></div>

  <!-- Prompt Queue (messages waiting while agent runs) -->
  <div class="queue-container" id="queue-container" style="display:none;"></div>

  <!-- Input Box (Modern Card Layout) -->
  <div class="input-section">
    <div class="prompt-box">
      <textarea id="prompt-input" placeholder="Ask Andromity (Enter to send, Shift+Enter for newline)..." rows="1"></textarea>
      <div class="prompt-box-footer">
        <div class="prompt-left-controls">
          <button class="prompt-icon-btn" id="btn-prompt-plus" title="Browse 396+ OpenRouter Models" data-action="open-model-hub">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button class="prompt-pill-btn" id="btn-prompt-mode" title="Permission Governance Mode (Click to cycle)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            </svg>
            <span id="prompt-mode-label">${(this._currentMode || 'safe').toUpperCase()}</span>
          </button>
        </div>

        <div class="prompt-right-controls">
          <button class="prompt-pill-btn" id="btn-prompt-model" title="Select or search model">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <span id="prompt-model-label">${this._formatModelDisplayName(this._currentModel)}</span>
          </button>
          <button class="codex-cancel-btn" id="btn-cancel" title="Stop Generation" style="display:none;">
            <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
          </button>
          <button class="codex-send-btn" id="btn-send" title="Send (Enter)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Status Bar Footer -->
  <div class="status-bar" id="status-bar-footer">
    <div class="status-bar-left">
      <div class="token-capacity-widget" id="token-capacity-widget" title="Token Usage & Model Capacity">
        <svg class="token-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        <span id="token-label">0 tokens</span>
        <div class="token-mini-track" id="token-mini-track">
          <div class="token-mini-bar" id="token-mini-bar" style="width: 0%;"></div>
        </div>
      </div>
    </div>
    <div class="status-bar-right">
      <span id="cost-label">$0.0000 USD</span>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const sidebarIconUri = "${sidebarIconUri}";

    const chatContainer = document.getElementById('chat-messages');
    const zeroState = document.getElementById('zero-state');
    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('btn-send');
    const cancelBtn = document.getElementById('btn-cancel');
    const interactiveSlot = document.getElementById('interactive-slot');
    const activeModelName = document.getElementById('active-model-name');
    const activeModeLabel = document.getElementById('active-mode-label');
    const modelFlyout = document.getElementById('model-flyout');
    const flyoutSearch = document.getElementById('flyout-search');
    const flyoutList = document.getElementById('flyout-list');
    const queueContainer = document.getElementById('queue-container');
    const tokenLabel = document.getElementById('token-label');
    const costLabel = document.getElementById('cost-label');

    const sessionsFlyout = document.getElementById('sessions-flyout');
    const sessionsSearch = document.getElementById('sessions-search');
    const sessionsListEl = document.getElementById('sessions-list');
    const cronsFlyout = document.getElementById('crons-flyout');
    const cronsListEl = document.getElementById('crons-list');
    const planTrackerStrip = document.getElementById('plan-tracker-strip');
    const trackerTitle = document.getElementById('tracker-title');
    const trackerCount = document.getElementById('tracker-count');
    const trackerProgressBar = document.getElementById('tracker-progress-bar');
    const trackerStepTitle = document.getElementById('tracker-step-title');
    const zeroWorkspaceLabel = document.getElementById('zero-workspace-label');
    const recentSessionsSection = document.getElementById('recent-sessions-section');
    const recentSessionsList = document.getElementById('recent-sessions-list');
    let allSessions = [];

    const DEVELOPER_GREETINGS = [
      "What can I do for you?",
      "What can I build for you today?",
      "Are we ready? Let's write some code.",
      "Ready to code. What's on your mind?",
      "Let's inspect, build, and optimize.",
      "How can I help you accelerate your project?",
      "Ready when you are. What are we coding?",
      "Diagnostics, features, or tests? I'm on it.",
      "Ready to dive into the codebase.",
      "Let's turn your ideas into working code."
    ];

    function setRandomGreeting() {
      const el = document.getElementById('zero-greeting');
      if (el) {
        const randomIdx = Math.floor(Math.random() * DEVELOPER_GREETINGS.length);
        el.textContent = DEVELOPER_GREETINGS[randomIdx];
      }
    }

    function formatTokenCount(tokens) {
      if (!tokens || tokens === 0) return '0 tokens';
      if (tokens < 1000) return tokens + ' tokens';
      if (tokens < 1000000) {
        const k = (tokens / 1000).toFixed(tokens < 10000 ? 1 : 0);
        return k + 'k tokens';
      }
      const m = (tokens / 1000000).toFixed(1);
      return m + 'M tokens';
    }

    function updateTokenDisplay(sessionOrUsage) {
      const tokens = (sessionOrUsage && (sessionOrUsage.context_tokens || sessionOrUsage.token_total || (sessionOrUsage.usage && sessionOrUsage.usage.total_tokens))) || 0;
      const cost = (sessionOrUsage && (typeof sessionOrUsage.cost_usd === 'number' ? sessionOrUsage.cost_usd : 0)) || 0;

      let capacity = 200000;
      const matched = allModels.find(m => m.id === currentModel);
      if (matched && matched.context_limit) {
        capacity = matched.context_limit;
      } else if (currentModel.includes('gemini')) {
        capacity = 1000000;
      } else if (currentModel.includes('gpt-4o') || currentModel.includes('deepseek')) {
        capacity = 128000;
      }

      const pct = Math.min(100, Math.max(0, (tokens / capacity) * 100));
      const miniBar = document.getElementById('token-mini-bar');
      if (miniBar) {
        miniBar.style.width = pct.toFixed(1) + '%';
        if (pct > 80) miniBar.style.background = '#ef4444';
        else if (pct > 60) miniBar.style.background = '#f59e0b';
        else miniBar.style.background = 'linear-gradient(90deg, #06b6d4, #10b981)';
      }

      if (tokenLabel) {
        tokenLabel.textContent = formatTokenCount(tokens);
      }
      if (costLabel) {
        costLabel.textContent = cost > 0 ? ('$' + cost.toFixed(4) + ' USD') : '$0.0000 USD';
      }

      const widget = document.getElementById('token-capacity-widget');
      if (widget) {
        widget.title = [
          'Session Tokens: ' + Number(tokens).toLocaleString() + ' / ' + Number(capacity).toLocaleString() + ' (' + formattedCap + ' limit, ' + pct.toFixed(1) + '% context used)',
          'Estimated Cost: $' + cost.toFixed(4) + ' USD'
        ].join('\\n');
      }
    }

    function hideZeroState() {
      if (zeroState) zeroState.style.display = 'none';
    }
    function showZeroState() {
      if (zeroState) {
        if (!chatContainer.contains(zeroState)) {
          chatContainer.appendChild(zeroState);
        }
        zeroState.style.display = 'flex';
        setRandomGreeting();
      }
    }

    let currentSessionId = ${JSON.stringify(this._currentSessionId || "")};
    let currentModel = ${JSON.stringify(this._currentModel || "anthropic/claude-3.7-sonnet")};
    let currentProvider = ${JSON.stringify(this._currentProvider || "openrouter")};
    let currentMode = ${JSON.stringify(this._currentMode || "safe")};
    let currentProfile = ${JSON.stringify(this._currentProfile || "builder")};
    let currentReasoning = ${JSON.stringify(this._currentReasoning || "medium")};
    let allModels = [];
    let isRunning = false;
    const promptQueue = [];
    let currentTurnStartTime = 0;
    let thinkingStartTime = 0;

    let currentTurnAssistantDiv = null;
    let currentThinkingDiv = null;
    let currentThinkingContent = null;
    let currentAssistantContent = null;
    let accumulatedAssistantText = '';
    let currentToolSequence = null;
    let toolSeqCount = 0;
    let toolSeqStartTime = 0;
    let toolSeqTimer = null;
    let lastToolName = "";
    let lastToolRunning = false;
    let userScrolledUp = false;

    function isAtBottom() {
      return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 90;
    }
    function scrollToBottomIfNeeded() {
      if (!userScrolledUp) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }
    chatContainer.addEventListener('scroll', () => {
      userScrolledUp = !isAtBottom();
    });

    let toolSeqDoneTools = new Set();
    let toolSeqUserToggled = false;
    let toolSeqFinished = false;

    function ensureToolSequence() {
      if (currentToolSequence && !toolSeqFinished) return currentToolSequence;

      // Finish previous sequence if one was open
      if (currentToolSequence) {
        finishToolSequence();
      }

      currentToolSequence = document.createElement('div');
      currentToolSequence.className = 'tool-sequence';
      toolSeqCount = 0;
      toolSeqStartTime = Date.now();
      lastToolName = "";
      lastToolRunning = false;
      toolSeqDoneTools = new Set();
      toolSeqUserToggled = false;
      toolSeqFinished = false;

      currentToolSequence.innerHTML = '<div class="tool-seq-header"><svg class="tool-seq-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg><span class="tool-seq-title">0 tools · working… (0s)</span><svg class="tool-seq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg><button class="tool-seq-copy" title="Copy tool log"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button></div><div class="tool-seq-body"></div>';
      
      const thisSeq = currentToolSequence;
      const hdr = thisSeq.querySelector('.tool-seq-header');
      hdr.addEventListener('click', (e) => {
        if (e.target.closest('.tool-seq-copy')) return;
        thisSeq.classList.toggle('collapsed');
        toolSeqUserToggled = true;
      });

      thisSeq.querySelector('.tool-seq-copy').addEventListener('click', () => {
        try {
          const parts = [];
          thisSeq.querySelectorAll('.tool-card').forEach((c, i) => {
            const n = c.querySelector('.tool-title-group span')?.textContent || 'tool';
            const args = c.querySelector('.tool-body')?.textContent || '';
            parts.push((i + 1) + '. ' + n + '\\n   Args: ' + args);
          });
          const txt = parts.join('\\n\\n') || thisSeq.textContent;
          copyToClipboard(txt);
        } catch {}
      });

      if (currentTurnAssistantDiv) {
        currentTurnAssistantDiv.appendChild(thisSeq);
      }

      // Reset currentAssistantContent so any subsequent text creates a new text block below this tool sequence
      currentAssistantContent = null;

      if (toolSeqTimer) clearInterval(toolSeqTimer);
      toolSeqTimer = setInterval(updateToolSeqHeader, 1000);
      return currentToolSequence;
    }

    function updateToolSeqHeader() {
      if (!currentToolSequence) return;
      const elapsed = Math.floor((Date.now() - toolSeqStartTime) / 1000);
      const el = currentToolSequence.querySelector('.tool-seq-title');
      if (!el) return;
      const label = toolSeqCount + (toolSeqCount === 1 ? ' tool' : ' tools');
      const doneCount = toolSeqDoneTools.size;

      if (toolSeqFinished) {
        el.textContent = label + ' · ' + (elapsed < 1 ? 'complete' : 'worked for ' + elapsed + 's');
      } else if (lastToolRunning && lastToolName) {
        el.textContent = label + ' · ' + lastToolName + ' working… (' + elapsed + 's)';
      } else if (doneCount > 0) {
        el.textContent = label + ' · ' + doneCount + '/' + toolSeqCount + ' done · working… (' + elapsed + 's)';
      } else {
        el.textContent = label + ' · working… (' + elapsed + 's)';
      }
    }

    function finishToolSequence() {
      if (currentToolSequence && !toolSeqFinished) {
        toolSeqFinished = true;
        if (toolSeqTimer) {
          clearInterval(toolSeqTimer);
          toolSeqTimer = null;
        }
        updateToolSeqHeader();
        const seqToCollapse = currentToolSequence;
        if (!toolSeqUserToggled) {
          seqToCollapse.classList.add('collapsed');
        }
        currentToolSequence = null;
      }
    }

    // Send on click or Enter
    sendBtn.addEventListener('click', sendCurrentPrompt);
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentPrompt();
      }
    });

    // Auto-resize prompt input & toggle send button brightness
    promptInput.addEventListener('input', () => {
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
      if (promptInput.value.trim().length > 0) {
        sendBtn.classList.add('has-text');
      } else {
        sendBtn.classList.remove('has-text');
      }
    });

    cancelBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel_turn' });
    });

    document.getElementById('btn-session-picker')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSessionsFlyout();
    });

    sessionsSearch?.addEventListener('input', (e) => {
      filterAndRenderSessions(e.target.value);
    });

    document.getElementById('btn-sessions-new')?.addEventListener('click', () => {
      sessionsFlyout.style.display = 'none';
      vscode.postMessage({ type: 'new_session' });
    });

    document.getElementById('btn-crons-close')?.addEventListener('click', () => {
      cronsFlyout.style.display = 'none';
    });

    document.getElementById('btn-tracker-open')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'open_plan_tab' });
    });

    function toggleSessionsFlyout() {
      if (sessionsFlyout.style.display === 'none' || !sessionsFlyout.style.display) {
        sessionsFlyout.style.display = 'flex';
        cronsFlyout.style.display = 'none';
        modelFlyout.style.display = 'none';
        vscode.postMessage({ type: 'fetch_sessions' });
        if (sessionsSearch) {
          sessionsSearch.value = '';
          setTimeout(() => sessionsSearch.focus(), 50);
        }
      } else {
        sessionsFlyout.style.display = 'none';
      }
    }

    function toggleCronsFlyout() {
      if (cronsFlyout.style.display === 'none' || !cronsFlyout.style.display) {
        cronsFlyout.style.display = 'flex';
        sessionsFlyout.style.display = 'none';
        modelFlyout.style.display = 'none';
        vscode.postMessage({ type: 'fetch_crons' });
      } else {
        cronsFlyout.style.display = 'none';
      }
    }

    function formatDateBadge(dateStr) {
      if (!dateStr) return '';
      try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '';
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 2) return 'Just now';
        if (diffMins < 60) return diffMins + 'm ago';
        if (diffHours < 24 && now.getDate() === d.getDate()) return formatTime(d);
        if (diffDays === 1 || (diffDays === 0 && now.getDate() !== d.getDate())) return 'Yesterday';

        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return months[d.getMonth()] + ' ' + d.getDate();
      } catch (e) {
        return '';
      }
    }

    function renderHomeRecentSessions(sessions) {
      if (!recentSessionsSection || !recentSessionsList) return;
      if (!sessions || sessions.length === 0) {
        recentSessionsSection.style.display = 'none';
        return;
      }

      // Prioritize sessions with messages, or named sessions
      const nonEmpty = sessions.filter(s => (s.message_count && s.message_count > 0) || (s.name && s.name !== 'Main Session'));
      const candidates = nonEmpty.length > 0 ? nonEmpty : sessions;
      const recent = candidates.slice(0, 3);

      if (recent.length === 0) {
        recentSessionsSection.style.display = 'none';
        return;
      }

      recentSessionsSection.style.display = 'flex';
      recentSessionsList.innerHTML = recent.map(s => {
        const name = escapeHtml(s.name || s.id || 'Untitled Session');
        const dateStr = formatDateBadge(s.updated_at || s.created_at);
        const hasCost = typeof s.cost_usd === 'number' && s.cost_usd > 0;
        const badgeText = hasCost ? ('$' + s.cost_usd.toFixed(2)) : (s.message_count ? (s.message_count + ' msgs') : '$0.00');
        const msgsText = s.message_count ? (s.message_count + ' msgs') : 'Empty';
        const modelTag = s.model ? escapeHtml(s.model.split('/').pop().replace(/-/g, ' ')) : '';

        return '<div class="recent-session-card" data-action="switch-session" data-session-id="' + s.id + '">' +
          '<div class="recent-session-main">' +
            '<div class="recent-session-title">' + name + '</div>' +
            '<div class="recent-session-sub">' +
              '<span>' + msgsText + '</span>' +
              (modelTag ? '<span>· ' + modelTag + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="recent-session-side">' +
            (dateStr ? '<span class="recent-session-date">' + dateStr + '</span>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderSessionsList(sessions, activeId) {
      allSessions = sessions || [];
      filterAndRenderSessions(sessionsSearch ? sessionsSearch.value : '');
      renderHomeRecentSessions(allSessions);
    }

    function filterAndRenderSessions(query) {
      if (!sessionsListEl) return;
      const q = (query || '').toLowerCase().trim();
      const filtered = allSessions.filter(s => (s.name || s.id || '').toLowerCase().includes(q));

      if (filtered.length === 0) {
        sessionsListEl.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted); font-size:11px;">No matching sessions</div>';
        return;
      }

      sessionsListEl.innerHTML = filtered.map(s => {
        const isCur = s.id === currentSessionId;
        const name = escapeHtml(s.name || s.id || 'Session');
        const msgs = s.message_count ? (s.message_count + ' msgs') : 'Empty';
        const cost = s.cost_usd ? ('$' + s.cost_usd.toFixed(3)) : '';

        return '<div class="session-item ' + (isCur ? 'active' : '') + '">' +
          '<div class="session-item-info" data-action="switch-session" data-session-id="' + s.id + '">' +
            '<div class="session-item-title">' + (isCur ? '✓ ' : '') + name + '</div>' +
            '<div class="session-item-meta">' +
              '<span>' + msgs + '</span>' +
              (cost ? '<span>· ' + cost + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="session-item-actions">' +
            '<button class="session-action-icon" data-action="rename-session" data-session-id="' + s.id + '" data-session-name="' + escapeHtml(name) + '" title="Rename">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
            '</button>' +
            '<button class="session-action-icon session-action-delete" data-action="delete-session" data-session-id="' + s.id + '" title="Delete">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
            '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderCronsList(crons) {
      if (!cronsListEl) return;
      if (!crons || crons.length === 0) {
        cronsListEl.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted); font-size:11.5px;">No scheduled cron jobs found.<br/><span style="font-size:10.5px; opacity:0.8;">Crons can be scheduled through prompt instructions.</span></div>';
        return;
      }
      cronsListEl.innerHTML = crons.map(c => {
        const isEnabled = c.enabled !== false;
        return '<div class="cron-card">' +
          '<div class="cron-card-top">' +
            '<span class="cron-card-schedule">' + escapeHtml(c.schedule || 'cron') + '</span>' +
            '<span class="cron-status-pill ' + (isEnabled ? 'cron-status-active' : 'cron-status-paused') + '">' + (isEnabled ? 'Active' : 'Paused') + '</span>' +
          '</div>' +
          '<div class="cron-prompt">' + escapeHtml(c.prompt || c.name || '') + '</div>' +
        '</div>';
      }).join('');
    }

    function updatePlanTracker(plan) {
      if (!planTrackerStrip) return;
      if (!plan || !plan.title) {
        planTrackerStrip.style.display = 'none';
        return;
      }
      const steps = plan.steps || plan.todos || [];
      if (steps.length === 0) {
        planTrackerStrip.style.display = 'none';
        return;
      }
      planTrackerStrip.style.display = 'flex';
      if (trackerTitle) trackerTitle.textContent = plan.title || 'Plan Tracker';

      let completed = 0;
      let activeStep = '';
      steps.forEach((s, idx) => {
        const sStatus = (typeof s === 'string' ? 'pending' : (s.status || 'pending')).toLowerCase();
        const sText = typeof s === 'string' ? s : (s.title || s.description || ('Step ' + (idx + 1)));
        if (sStatus === 'done' || sStatus === 'completed') {
          completed++;
        } else if (!activeStep && (sStatus === 'active' || sStatus === 'in_progress' || sStatus === 'running')) {
          activeStep = sText;
        }
      });

      if (!activeStep && completed < steps.length) {
        for (let i = 0; i < steps.length; i++) {
          const st = (typeof steps[i] === 'string' ? 'pending' : (steps[i].status || 'pending')).toLowerCase();
          if (st !== 'done' && st !== 'completed') {
            activeStep = typeof steps[i] === 'string' ? steps[i] : (steps[i].title || steps[i].description || ('Step ' + (i + 1)));
            break;
          }
        }
      }

      const pct = Math.round((completed / steps.length) * 100);
      if (trackerCount) trackerCount.textContent = completed + '/' + steps.length + ' (' + pct + '%)';
      if (trackerProgressBar) trackerProgressBar.style.width = pct + '%';
      if (trackerStepTitle) trackerStepTitle.textContent = activeStep ? ('Current: ' + activeStep) : (completed === steps.length ? 'All steps completed' : '');
    }

    document.getElementById('btn-prompt-mode')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'cycle_mode' });
    });

    document.getElementById('btn-model-picker')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelFlyout();
    });

    document.getElementById('btn-prompt-model')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelFlyout();
    });

    document.getElementById('btn-flyout-open-hub')?.addEventListener('click', () => {
      modelFlyout.style.display = 'none';
      vscode.postMessage({ type: 'open_model_hub' });
    });

    flyoutSearch.addEventListener('input', (e) => {
      renderFlyoutList(e.target.value.toLowerCase().trim());
    });

    document.addEventListener('click', (e) => {
      const isPicker = e.target.closest('#btn-model-picker') || e.target.closest('#btn-prompt-model');
      if (!modelFlyout.contains(e.target) && !isPicker) {
        modelFlyout.style.display = 'none';
      }
      const isSessionTrigger = e.target.closest('#btn-session-picker');
      if (sessionsFlyout && !sessionsFlyout.contains(e.target) && !isSessionTrigger) {
        sessionsFlyout.style.display = 'none';
      }
      const isCronsClose = e.target.closest('#btn-crons-close');
      if (cronsFlyout && !cronsFlyout.contains(e.target) && !isCronsClose) {
        cronsFlyout.style.display = 'none';
      }
    });

    // Global event delegation for headers and actions (CSP compliant)
    document.addEventListener('click', (e) => {
      // 1. Thinking card toggle (works while streaming, after turn ends, and in session history)
      const thinkingHdr = e.target.closest('.thinking-header');
      if (thinkingHdr) {
        const card = thinkingHdr.closest('.thinking-card');
        if (card) {
          card.classList.toggle('expanded');
        }
        return;
      }

      // 2. Tool card toggle (works while streaming, after turn ends, and in session history)
      const toolHdr = e.target.closest('.tool-header');
      if (toolHdr) {
        const card = toolHdr.closest('.tool-card');
        if (card) {
          card.classList.toggle('expanded');
        }
        return;
      }

      // 3. Approval parameter toggle
      const argsToggle = e.target.closest('.approval-toggle-args');
      if (argsToggle) {
        const card = argsToggle.closest('.approval-card');
        if (card) {
          card.classList.toggle('show-args');
          argsToggle.textContent = card.classList.contains('show-args') ? '▾ Hide parameters' : '▸ View parameters';
        }
        return;
      }

      // 4. Action buttons
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      switch (action) {
        case 'switch-session':
          const sId = target.getAttribute('data-session-id');
          if (sId) {
            sessionsFlyout.style.display = 'none';
            vscode.postMessage({ type: 'switch_session', sessionId: sId });
          }
          break;
        case 'view-all-sessions':
          toggleSessionsFlyout();
          break;
        case 'rename-session':
          e.stopPropagation();
          const rId = target.getAttribute('data-session-id');
          const rName = target.getAttribute('data-session-name') || '';
          vscode.postMessage({ type: 'request_rename_session', sessionId: rId, currentName: rName });
          break;
        case 'delete-session':
          e.stopPropagation();
          const delId = target.getAttribute('data-session-id');
          if (delId) {
            vscode.postMessage({ type: 'delete_session', sessionId: delId });
          }
          break;
        case 'open-plan-tab':
          vscode.postMessage({ type: 'open_plan_tab' });
          break;
        case 'new-session':
          vscode.postMessage({ type: 'new_session' });
          break;
        case 'open-diff':
          vscode.postMessage({ type: 'open_diff' });
          break;
        case 'undo-turn':
          vscode.postMessage({ type: 'undo_turn' });
          break;
        case 'open-settings':
          vscode.postMessage({ type: 'open_settings' });
          break;
        case 'send-starter':
          promptInput.value = target.getAttribute('data-prompt') || '';
          sendCurrentPrompt();
          break;
        case 'open-model-hub':
          vscode.postMessage({ type: 'open_model_hub' });
          break;
        case 'pick-model':
          pickModel(target.getAttribute('data-model-id'), target.getAttribute('data-provider'));
          break;
        case 'remove-queued':
          removeQueued(parseInt(target.getAttribute('data-idx') || '0', 10));
          break;
        case 'copy-code':
          copyCode(target);
          break;
        case 'apply-code':
          applyCode(target);
          break;
        case 'copy-message':
          copyMessageText(target);
          break;
        case 'approve-tool':
          approveTool(target.getAttribute('data-approval-id'));
          break;
        case 'reject-tool':
          rejectTool(target.getAttribute('data-approval-id'));
          break;
        case 'approve-plan':
          approvePlan();
          break;
        case 'reject-plan':
          rejectPlan();
          break;
        case 'q-prev':
          window.navigateQuestionSlide(-1);
          break;
        case 'q-next':
          window.navigateQuestionSlide(1);
          break;
        case 'submit-questions':
          submitQuestions(target.getAttribute('data-question-id'), parseInt(target.getAttribute('data-total-q') || '0', 10));
          break;
      }
    });

    // CSP-safe Enter handling for free-text question inputs (replaces inline onkeydown)
    document.addEventListener('keydown', (e) => {
      const ta = e.target.closest('.question-textarea');
      if (!ta) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (window.currentQuestionSlide < window.totalQuestionSlides - 1) {
          window.navigateQuestionSlide(1);
        } else {
          const s = document.getElementById('btn-q-submit');
          if (s) s.click();
        }
      }
    });

    function toggleModelFlyout() {
      const isVisible = modelFlyout.style.display === 'flex';
      if (isVisible) {
        modelFlyout.style.display = 'none';
      } else {
        modelFlyout.style.display = 'flex';
        flyoutSearch.value = '';
        renderFlyoutList('');
        setTimeout(() => flyoutSearch.focus(), 50);
      }
    }

    function renderFlyoutList(query) {
      const filtered = allModels.filter(m => {
        if (!query) return true;
        const hay = ((m.name || '') + ' ' + (m.id || '') + ' ' + (m.provider || '')).toLowerCase();
        return hay.includes(query);
      }).slice(0, 40);

      flyoutList.innerHTML = filtered.map(m => {
        const isActive = m.id === currentModel;
        return \`
          <div class="flyout-item \${isActive ? 'active' : ''}" data-action="pick-model" data-model-id="\${escapeHtml(m.id)}" data-provider="\${escapeHtml(m.provider)}">
            <span>\${escapeHtml(m.name || m.id)}</span>
            <span class="flyout-item-meta">\${escapeHtml(m.provider)} \${m.pricing ? '· ' + escapeHtml(m.pricing) : ''}</span>
          </div>
        \`;
      }).join('');
    }

    window.pickModel = function(modelId, provider) {
      currentModel = modelId;
      if (provider) currentProvider = provider;
      updateModelBadge();
      modelFlyout.style.display = 'none';
      vscode.postMessage({ type: 'update_config', key: 'model', value: modelId });
      if (provider) {
        vscode.postMessage({ type: 'update_config', key: 'provider', value: provider });
      }
    };

    window.openModelHub = function() {
      vscode.postMessage({ type: 'open_model_hub' });
    };

    window.sendStarter = function(promptText) {
      promptInput.value = promptText;
      sendCurrentPrompt();
    };

    function formatModelDisplayName(id) {
      if (!id || id === 'Loading model...') return 'Claude 3.7 Sonnet';
      const parts = id.split('/');
      const raw = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
      return raw
        .replace(/-/g, ' ')
        .replace(/\\b\\w/g, l => l.toUpperCase())
        .replace(/Gpt/g, 'GPT')
        .replace(/Claude/g, 'Claude')
        .replace(/Gemini/g, 'Gemini');
    }

    function updateModelBadge() {
      const found = allModels.find(m => m.id === currentModel);
      let name = found ? (found.name || found.id) : formatModelDisplayName(currentModel);
      if (!name || name === "Loading model...") {
        name = "Claude 3.7 Sonnet";
      }
      if (activeModelName) {
        activeModelName.textContent = name;
        activeModelName.title = "Model: " + currentModel + " (" + currentProvider + ")";
      }
      const promptModelLabel = document.getElementById('prompt-model-label');
      if (promptModelLabel) {
        promptModelLabel.textContent = name;
        promptModelLabel.parentElement.title = "Active Model: " + currentModel + " (" + currentProvider + ") - Click to switch";
      }
    }
    updateModelBadge();

    function sendCurrentPrompt() {
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      promptInput.style.height = 'auto';
      sendBtn.classList.remove('has-text');

      if (isRunning) {
        promptQueue.push(text);
        renderQueue();
        return;
      }
      dispatchPrompt(text, true);
    }

    function dispatchPrompt(text, attachContext) {
      try {
        console.log('[Andromity webview] dispatchPrompt sending:', text.slice(0,120));
        hideZeroState();
        appendUserMessage(text);
        startAssistantTurn();
        vscode.postMessage({
          type: 'send_prompt',
          prompt: text,
          sessionId: currentSessionId,
          profile: currentProfile,
          mode: currentMode,
          model: currentModel,
          provider: currentProvider,
          reasoningEffort: currentReasoning,
          attachContext: attachContext,
        });
      } catch (e) {
        console.error('[Andromity webview] dispatchPrompt failed', e);
        appendSystemNote('Webview error: ' + (e.message||String(e)));
      }
    }

    function hideZeroState() {
      if (zeroState) zeroState.style.display = 'none';
    }

    function flushQueue() {
      if (promptQueue.length === 0) return;
      const next = promptQueue.shift();
      renderQueue();
      dispatchPrompt(next, true);
    }

    function renderQueue() {
      if (promptQueue.length === 0) {
        queueContainer.style.display = 'none';
        queueContainer.innerHTML = '';
        return;
      }
      queueContainer.style.display = 'flex';
      queueContainer.innerHTML = promptQueue.map((q, i) => \`
        <div class="queue-chip">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          <span class="queue-text">\${escapeHtml(q)}</span>
          <button class="queue-remove" data-action="remove-queued" data-idx="\${i}">✕</button>
        </div>
      \`).join('');
    }

    window.removeQueued = function(idx) {
      promptQueue.splice(idx, 1);
      renderQueue();
    };

    function renderInline(str) {
      if (!str) return '';
      var parts = str.split(String.fromCharCode(96));
      var out = '';
      for (var i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          out += '<code>' + escapeHtml(parts[i]) + '</code>';
        } else {
          var t = escapeHtml(parts[i]);
          t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
          t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
          t = t.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
          t = t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" style="color:var(--accent); text-decoration:underline;">$1</a>');
          out += t;
        }
      }
      return out;
    }

    function renderMarkdown(md) {
      if (!md) return '';
      var codeParts = md.split(String.fromCharCode(96, 96, 96));
      var html = '';

      for (var i = 0; i < codeParts.length; i++) {
        if (i % 2 === 1) {
          var lines = codeParts[i].split('\\n');
          var lang = lines[0].trim() || 'code';
          var code = lines.slice(1).join('\\n');
          var enc = encodeURIComponent(code);
          html += '<div class="code-block-container">' +
            '<div class="code-block-header">' +
              '<span class="code-lang-tag">' + escapeHtml(lang.toUpperCase()) + '</span>' +
              '<div class="code-block-actions">' +
                '<button class="code-btn" data-code="' + enc + '" data-action="copy-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>' +
                '<button class="code-btn" data-code="' + enc + '" data-action="apply-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg> Insert</button>' +
              '</div>' +
            '</div>' +
            '<pre class="code-block-pre"><code>' + escapeHtml(code.trim()) + '</code></pre>' +
          '</div>';
        } else {
          var rawLines = codeParts[i].split('\\n');
          for (var l = 0; l < rawLines.length; l++) {
            var line = rawLines[l];
            var trimmed = line.trim();

            if (!trimmed) {
              html += '<div class="md-spacer"></div>';
              continue;
            }

            if (/^###\\s+/.test(trimmed)) {
              html += '<h5>' + renderInline(trimmed.replace(/^###\\s+/, '')) + '</h5>';
            } else if (/^##\\s+/.test(trimmed)) {
              html += '<h4>' + renderInline(trimmed.replace(/^##\\s+/, '')) + '</h4>';
            } else if (/^#\\s+/.test(trimmed)) {
              html += '<h3>' + renderInline(trimmed.replace(/^#\\s+/, '')) + '</h3>';
            } else if (/^[-*•]\\s+/.test(trimmed)) {
              var itemText = trimmed.replace(/^[-*•]\\s+/, '');
              html += '<div class="md-bullet"><span class="md-dot">•</span><span class="md-text">' + renderInline(itemText) + '</span></div>';
            } else if (/^\\d+\\.\\s+/.test(trimmed)) {
              var numMatch = trimmed.match(/^(\\d+)\\.\\s+(.*)$/);
              var num = numMatch ? numMatch[1] : '1';
              var itemText = numMatch ? numMatch[2] : trimmed;
              html += '<div class="md-bullet"><span class="md-num">' + num + '.</span><span class="md-text">' + renderInline(itemText) + '</span></div>';
            } else if (/^>\\s+/.test(trimmed)) {
              var quoteText = trimmed.replace(/^>\\s+/, '');
              html += '<div class="md-quote">' + renderInline(quoteText) + '</div>';
            } else {
              html += '<div class="md-line">' + renderInline(line) + '</div>';
            }
          }
        }
      }
      return html;
    }

    function copyToClipboard(text) {
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {
          fallbackCopyText(text);
        });
      } else {
        fallbackCopyText(text);
      }
      vscode.postMessage({ type: 'copy_clipboard', text: text });
    }

    function fallbackCopyText(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch(e) {}
      document.body.removeChild(ta);
    }

    window.copyCode = function(btn) {
      var enc = btn.getAttribute('data-code') || '';
      var code = decodeURIComponent(enc);
      copyToClipboard(code);
      var orig = btn.innerHTML;
      btn.innerHTML = '<span style="color:var(--green)">Copied!</span>';
      setTimeout(function() { btn.innerHTML = orig; }, 1500);
    };

    window.applyCode = function(btn) {
      var enc = btn.getAttribute('data-code') || '';
      var code = decodeURIComponent(enc);
      vscode.postMessage({ type: 'apply_code', code: code });
    };

    function formatTime(date) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function appendUserMessage(text) {
      const wrap = document.createElement('div');
      wrap.className = 'message-wrap user';

      const msgDiv = document.createElement('div');
      msgDiv.className = 'message user';
      msgDiv.textContent = text;
      wrap.appendChild(msgDiv);

      const footer = document.createElement('div');
      footer.className = 'message-footer';
      footer.innerHTML = '<span>' + formatTime(new Date()) + '</span>';
      wrap.appendChild(footer);

      chatContainer.appendChild(wrap);
      scrollToBottomIfNeeded();
    }

    window.copyMessageText = function(btn) {
      const wrap = btn.closest('.message-wrap');
      if (!wrap) return;
      let text = '';
      const userMsg = wrap.querySelector('.message.user');
      const asstMsg = wrap.querySelector('.assistant-text');
      if (userMsg) text = userMsg.textContent || '';
      else if (asstMsg) text = asstMsg.innerText || asstMsg.textContent || '';
      if (text) {
        copyToClipboard(text);
        const orig = btn.innerHTML;
        btn.innerHTML = '<span style="color:var(--green)">Copied!</span>';
        setTimeout(function() { btn.innerHTML = orig; }, 1500);
      }
    };

    function playTone(kind) {
      try {
        const audio = document.getElementById('audio-done');
        if (audio) {
          audio.currentTime = 0;
          audio.play().catch(function() {});
          return;
        }
      } catch (e) {
        console.warn('Audio play failed:', e);
      }
    }

    function updateModeBadge(mode) {
      if (!mode) return;
      currentMode = mode.toLowerCase();
      if (activeModeLabel) activeModeLabel.textContent = currentMode.toUpperCase();
      const modeBtn = document.getElementById('btn-mode-cycle');
      if (modeBtn) modeBtn.className = 'mode-badge-btn mode-' + currentMode;
      const promptModeLabel = document.getElementById('prompt-mode-label');
      if (promptModeLabel) {
        promptModeLabel.textContent = currentMode.toUpperCase();
      }
      const titles = {
        safe: 'SAFE Mode: Confirms before every file edit and shell command (Click to cycle)',
        trust: 'TRUST Mode: Auto-approves file writes in workspace; prompts for commands (Click to cycle)',
        full: 'FULL Mode: Auto-approves all tool actions and logs to stream (Click to cycle)',
        yolo: 'YOLO Mode: Autonomous silent execution (Click to cycle)'
      };
      if (modeBtn) modeBtn.title = titles[currentMode] || 'Permission Governance Mode (Click to cycle)';
    }

    function removeTurnLoader() {
      const el = document.getElementById('turn-loading-indicator');
      if (el) el.remove();
    }

    function finishCurrentThinking() {
      if (currentThinkingDiv) {
        const elapsedSec = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : '0.0';
        const hdr = currentThinkingDiv.querySelector('.thinking-header span');
        if (hdr) hdr.textContent = 'thought (' + elapsedSec + 's)';
        const pulse = currentThinkingDiv.querySelector('.thinking-pulse');
        if (pulse) {
          pulse.style.opacity = '0.4';
          pulse.style.animation = 'none';
          pulse.style.boxShadow = 'none';
        }
        // Auto-collapse when done (TUI parity)
        currentThinkingDiv.classList.remove('expanded');
        currentThinkingDiv = null;
        currentThinkingContent = null;
      }
    }

    function startAssistantTurn() {
      isRunning = true;
      userScrolledUp = false; // new turn always shows latest
      cancelBtn.style.display = 'flex';
      sendBtn.style.display = 'none';
      accumulatedAssistantText = '';
      currentTurnStartTime = Date.now();
      currentToolSequence = null; toolSeqCount = 0; lastToolName = ""; lastToolRunning = false;
      if (toolSeqTimer) { clearInterval(toolSeqTimer); toolSeqTimer = null; }

      const wrap = document.createElement('div');
      wrap.className = 'message-wrap assistant';
      currentTurnAssistantDiv = wrap;

      const header = document.createElement('div');
      header.className = 'assistant-header';
      header.innerHTML = '<div class="assistant-avatar">' +
        '<img class="" src="' + sidebarIconUri + '" width="48" alt="Andromity" />' +
      '</div>' +
      '<span class="assistant-name">Andromity</span>';
      wrap.appendChild(header);

      const loader = document.createElement('div');
      loader.className = 'andromity-turn-loader';
      loader.id = 'turn-loading-indicator';
      loader.innerHTML = '<img class="spinning" src="' + sidebarIconUri + '" width="14" height="14" alt="Andromity" /> <span>Andromity is thinking... (0s)</span>';
      wrap.appendChild(loader);

      const loaderTimer = setInterval(() => {
        const span = loader.querySelector('span');
        if (!span || !document.getElementById('turn-loading-indicator')) {
          clearInterval(loaderTimer);
          return;
        }
        const elapsed = Math.floor((Date.now() - currentTurnStartTime) / 1000);
        if (elapsed < 6) {
          span.textContent = 'Andromity is thinking... (' + elapsed + 's)';
        } else if (elapsed < 16) {
          span.textContent = 'Contacting ' + (currentModel || 'model') + '... (' + elapsed + 's)';
        } else {
          span.textContent = 'Waiting for ' + (currentProvider || 'provider') + ' stream... (' + elapsed + 's)';
        }
      }, 1000);

      currentAssistantContent = null;
      accumulatedAssistantText = '';

      chatContainer.appendChild(wrap);
      scrollToBottomIfNeeded();
    }

    function endAssistantTurn() {
      removeTurnLoader();
      finishCurrentThinking();
      finishToolSequence();
      isRunning = false;
      cancelBtn.style.display = 'none';
      sendBtn.style.display = 'flex';

      if (currentTurnAssistantDiv) {
        const elapsedSec = ((Date.now() - currentTurnStartTime) / 1000).toFixed(1);
        const footer = document.createElement('div');
        footer.className = 'message-footer';
        footer.innerHTML = '<span class="turn-duration-badge">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
          '<span>' + elapsedSec + 's · ' + formatTime(new Date()) + '</span>' +
        '</span>' +
        '<button class="msg-copy-btn" data-action="copy-message" title="Copy response">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy' +
        '</button>';
        currentTurnAssistantDiv.appendChild(footer);
      }

      currentTurnAssistantDiv = null;
      currentThinkingDiv = null;
      currentThinkingContent = null;
      currentAssistantContent = null;
      accumulatedAssistantText = '';
    }

    const trustBanner = document.getElementById('trust-banner');
    document.getElementById('btn-trust-confirm')?.addEventListener('click', () => {
      trustBanner.style.display = 'none';
      vscode.postMessage({ type: 'trust_workspace' });
    });
    document.getElementById('btn-trust-dismiss')?.addEventListener('click', () => {
      trustBanner.style.display = 'none';
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'init_state':
          currentSessionId = msg.sessionId;
          allModels = msg.models || [];
          if (msg.model) currentModel = msg.model;
          if (msg.provider) currentProvider = msg.provider;
          if (msg.mode) {
            updateModeBadge(msg.mode);
          }
          if (msg.profile) currentProfile = msg.profile;
          if (msg.reasoningEffort) currentReasoning = msg.reasoningEffort;
          if (msg.isTrusted === false) {
            trustBanner.style.display = 'flex';
          } else {
            trustBanner.style.display = 'none';
          }
          const curSess = (msg.sessions || []).find(s => s.id === msg.sessionId);
          const sessLabel = document.getElementById('active-session-name');
          if (sessLabel) {
            sessLabel.textContent = curSess ? (curSess.name || curSess.id) : 'Main Session';
          }
          if (msg.sessions) {
            allSessions = msg.sessions;
            renderHomeRecentSessions(allSessions);
          }
          if (msg.workspaceName && zeroWorkspaceLabel) {
            zeroWorkspaceLabel.textContent = msg.workspaceName;
          }
          if (curSess) {
            updateTokenDisplay(curSess);
          }
          if (msg.currentPlan) {
            updatePlanTracker(msg.currentPlan);
          }
          updateModelBadge();
          break;

        case 'trust_updated':
          if (msg.isTrusted) {
            trustBanner.style.display = 'none';
          } else {
            trustBanner.style.display = 'flex';
          }
          break;

        case 'config_updated':
          if (msg.key === 'mode') {
            updateModeBadge(msg.value);
            // If switched from SAFE to TRUST/FULL/YOLO, auto-dismiss any pending tool approval card
            if (msg.value !== 'safe') {
              const appCard = interactiveSlot.querySelector('.approval-card');
              if (appCard) {
                interactiveSlot.innerHTML = '';
                appendSystemNote('Mode switched to ' + msg.value.toUpperCase() + ' — pending tool auto-approved.');
              }
            }
          } else if (msg.key === 'model') {
            currentModel = msg.value;
            updateModelBadge();
          } else if (msg.key === 'provider') {
            currentProvider = msg.value;
            updateModelBadge();
          } else if (msg.key === 'profile') {
            currentProfile = msg.value;
          } else if (msg.key === 'reasoningEffort') {
            currentReasoning = msg.value;
          }
          break;

        case 'session_updated':
          if (msg.name) {
            const activeSessName = document.getElementById('active-session-name');
            if (activeSessName) {
              activeSessName.textContent = msg.name;
            }
          }
          break;

        case 'session_switched':
          removeTurnLoader();
          finishCurrentThinking();
          interactiveSlot.innerHTML = '';
          break;

        case 'session_loaded':
          removeTurnLoader();
          finishCurrentThinking();
          chatContainer.innerHTML = '';
          interactiveSlot.innerHTML = '';
          const activeSessName = document.getElementById('active-session-name');
          if (activeSessName && msg.session) {
            activeSessName.textContent = msg.session.name || msg.session.id || 'Main Session';
          }
          if (msg.session && msg.session.messages && msg.session.messages.length > 0) {
            hideZeroState();
            let currentAssistantWrap = null;
            let currentAssistantTextEl = null;

            for (let i = 0; i < msg.session.messages.length; i++) {
              const m = msg.session.messages[i];
              if (m.role === 'user') {
                currentAssistantWrap = null;
                currentAssistantTextEl = null;
                appendUserMessage(m.content || '');
              } else if (m.role === 'assistant') {
                if (!currentAssistantWrap) {
                  currentAssistantWrap = document.createElement('div');
                  currentAssistantWrap.className = 'message-wrap assistant';

                  const hdr = document.createElement('div');
                  hdr.className = 'assistant-header';
                  hdr.innerHTML = '<div class="assistant-avatar">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                      '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#38bdf8"></path>' +
                      '<circle cx="12" cy="12" r="2.5" fill="#a855f7"></circle>' +
                    '</svg>' +
                  '</div>' +
                  '<span class="assistant-name">Andromity</span>';
                  currentAssistantWrap.appendChild(hdr);

                  currentAssistantTextEl = document.createElement('div');
                  currentAssistantTextEl.className = 'assistant-text';
                  currentAssistantWrap.appendChild(currentAssistantTextEl);
                  chatContainer.appendChild(currentAssistantWrap);
                }

                if (m.thinking) {
                  const thinkEl = document.createElement('div');
                  thinkEl.className = 'thinking-card';
                  thinkEl.innerHTML = '<div class="thinking-header"><div class="thinking-pulse" style="opacity:0.4; animation:none;"></div><span>thought</span><svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div><div class="thinking-content">' + escapeHtml(m.thinking) + '</div>';
                  currentAssistantWrap.insertBefore(thinkEl, currentAssistantTextEl);
                }

                if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                  const seq = document.createElement('div');
                  seq.className = 'tool-sequence collapsed';
                  const cnt = m.tool_calls.length;
                  seq.innerHTML = '<div class="tool-seq-header"><svg class="tool-seq-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg><span class="tool-seq-title">' + cnt + (cnt===1?' tool':' tools') + ' · worked</span><svg class="tool-seq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg><button class="tool-seq-copy" title="Copy tool log"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button></div><div class="tool-seq-body"></div>';
                  seq.querySelector('.tool-seq-header').addEventListener('click', (e) => {
                    if (e.target.closest('.tool-seq-copy')) return;
                    seq.classList.toggle('collapsed');
                  });
                  const body = seq.querySelector('.tool-seq-body');
                  for (const tc of m.tool_calls) {
                    const fn = tc.function || {};
                    const tDiv = document.createElement('div');
                    tDiv.className = 'tool-card';
                    tDiv.innerHTML = '<div class="tool-header">' +
                      '<div class="tool-title-group">' +
                        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' +
                        '<span>' + escapeHtml(fn.name || 'tool') + '</span>' +
                      '</div>' +
                      '<div style="display:flex; align-items:center;">' +
                        '<span class="tool-tag" style="background:rgba(63,185,80,0.2); color:var(--green);">DONE</span>' +
                        '<svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
                      '</div>' +
                    '</div>' +
                    '<div class="tool-body">' + escapeHtml(fn.arguments || '') + '</div>';
                    body.appendChild(tDiv);
                  }
                  currentAssistantWrap.insertBefore(seq, currentAssistantTextEl);
                }

                if (m.content) {
                  currentAssistantTextEl.innerHTML += renderMarkdown(m.content);
                }

                // Check if next message is NOT an assistant message (or is last message) -> append ONE footer
                const nextMsg = msg.session.messages[i + 1];
                if (!nextMsg || nextMsg.role === 'user') {
                  const footer = document.createElement('div');
                  footer.className = 'message-footer';
                  footer.innerHTML = '<button class="msg-copy-btn" data-action="copy-message" title="Copy response">' +
                    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy' +
                  '</button>';
                  currentAssistantWrap.appendChild(footer);
                  currentAssistantWrap = null;
                  currentAssistantTextEl = null;
                }
              }
            }
          } else {
            chatContainer.appendChild(zeroState);
            zeroState.style.display = 'flex';
          }
          if (msg.session) {
            currentSessionId = msg.session.id || currentSessionId;
            updateTokenDisplay(msg.session);
          }
          break;

        case 'play_sound':
          playTone(msg.kind);
          break;

        case 'text_delta':
          removeTurnLoader();
          finishCurrentThinking();
          if (!currentTurnAssistantDiv) startAssistantTurn();

          // TUI parity (chat.py:1003): intermediate text splits sequence; next tool starts a new bucket
          if (msg.text && msg.text.trim() && currentToolSequence) {
            finishToolSequence();
          }

          if (!currentAssistantContent) {
            currentAssistantContent = document.createElement('div');
            currentAssistantContent.className = 'assistant-text';
            currentTurnAssistantDiv.appendChild(currentAssistantContent);
            currentAssistantContent._blockText = '';
          }
          currentAssistantContent._blockText = (currentAssistantContent._blockText || '') + msg.text;
          accumulatedAssistantText += msg.text;
          currentAssistantContent.innerHTML = renderMarkdown(currentAssistantContent._blockText);
          scrollToBottomIfNeeded();
          break;

        case 'thinking_delta':
          removeTurnLoader();
          if (!currentTurnAssistantDiv) startAssistantTurn();
          if (!currentThinkingDiv) {
            thinkingStartTime = Date.now();
            currentThinkingDiv = document.createElement('div');
            currentThinkingDiv.className = 'thinking-card expanded';
            currentThinkingDiv.innerHTML = '<div class="thinking-header">' +
              '<div class="thinking-pulse"></div>' +
              '<span>thinking…</span>' +
              '<svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
            '</div>';
            currentThinkingContent = document.createElement('div');
            currentThinkingContent.className = 'thinking-content';
            currentThinkingDiv.appendChild(currentThinkingContent);
            // TUI parity: thinking between tools goes inside tool sequence
            if (currentToolSequence) {
              currentToolSequence.querySelector('.tool-seq-body').appendChild(currentThinkingDiv);
            } else {
              currentTurnAssistantDiv.appendChild(currentThinkingDiv);
            }
          }
          currentThinkingContent.textContent += msg.text;
          scrollToBottomIfNeeded();
          break;

        case 'tool_start': {
          removeTurnLoader();
          finishCurrentThinking();
          if (!currentTurnAssistantDiv) startAssistantTurn();

          // Reset assistant text block so text following this tool sequence creates a new block
          currentAssistantContent = null;

          const seq = ensureToolSequence();
          toolSeqCount++;
          lastToolName = msg.tool_name || 'tool';
          lastToolRunning = true;
          updateToolSeqHeader();
          const toolDiv = document.createElement('div');
          toolDiv.className = 'tool-card expanded';
          toolDiv.id = 'tool-' + msg.tool_id;
          toolDiv.innerHTML = '<div class="tool-header">' +
            '<div class="tool-title-group">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' +
              '<span>' + escapeHtml(msg.tool_name) + '</span>' +
            '</div>' +
            '<div style="display:flex; align-items:center;">' +
              '<span class="tool-tag">RUNNING</span>' +
              '<svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
            '</div>' +
          '</div>' +
          '<div class="tool-body" id="args-' + msg.tool_id + '"></div>';
          seq.querySelector('.tool-seq-body').appendChild(toolDiv);
          scrollToBottomIfNeeded();
          break; }

        case 'tool_delta':
          const argsEl = document.getElementById('args-' + msg.tool_id);
          if (argsEl) argsEl.textContent += msg.chunk;
          break;

        case 'tool_result':
        case 'tool_end': {
          const targetTool = document.getElementById('tool-' + msg.tool_id);
          if (targetTool) {
            const tag = targetTool.querySelector('.tool-tag');
            if (tag) {
              tag.textContent = 'DONE';
              tag.style.background = 'rgba(63, 185, 80, 0.2)';
              tag.style.color = 'var(--green)';
            }
            targetTool.classList.remove('expanded');
          }
          if (msg.tool_id) {
            toolSeqDoneTools.add(msg.tool_id);
          }
          lastToolRunning = false;
          updateToolSeqHeader();
          break; }

        case 'tool_approval_required':
          const toolArgs = msg.args || {};
          const rawArgs = (()=>{ try{ return JSON.stringify(toolArgs, null, 2); }catch{ return String(toolArgs); } })();
          const previewPath = toolArgs.path || toolArgs.file || toolArgs.file_path || toolArgs.TargetFile || toolArgs.command || "";
          const shortPath = previewPath ? (previewPath.length>48 ? previewPath.slice(0,22)+"…"+previewPath.slice(-22) : previewPath) : "";
          interactiveSlot.innerHTML = \`
            <div class="approval-card">
              <div class="approval-header">
                <div class="approval-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                </div>
                <div style="flex:1; min-width:0;">
                  <div class="approval-kicker">Permission Request</div>
                  <div class="approval-title">Allow <code>\${escapeHtml(msg.tool_name)}</code> to run?</div>
                </div>
                <span class="approval-tool-pill status-pill">SAFE</span>
              </div>
              <div class="approval-tool-meta">
                <span class="approval-tool-pill"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg> \${escapeHtml(msg.tool_name)}</span>
                \${shortPath ? \`<span class="approval-path" title="\${escapeHtml(previewPath)}">\${escapeHtml(shortPath)}</span>\` : ''}
              </div>
              <div class="approval-desc">The assistant is requesting permission to execute <strong>\${escapeHtml(msg.tool_name)}</strong>.</div>
              \${rawArgs && Object.keys(toolArgs).length ? \`<div class="approval-toggle-args"><span>▸ View parameters</span></div><div class="approval-args">\${escapeHtml(rawArgs)}</div>\` : ''}
              <div class="approval-buttons">
                <button class="btn-approve" data-action="approve-tool" data-approval-id="\${msg.approval_id}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Allow</button>
                <button class="btn-reject" data-action="reject-tool" data-approval-id="\${msg.approval_id}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Deny</button>
              </div>
            </div>
          \`;
          break;

        case 'ask_questions': {
          const questions = msg.questions || [];
          const totalQ = questions.length;
          window.currentQuestionSlide = 0;
          window.totalQuestionSlides = totalQ;

          let slidesHtml = '';
          questions.forEach((q, idx) => {
            let optionsHtml = '';
            if (q.options && q.options.length > 0) {
              const isMulti = q.type === 'multi';
              optionsHtml = '<div class="question-options-list">';
              q.options.forEach(opt => {
                optionsHtml += '<label class="question-option-row">' +
                  '<input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="q_' + idx + '" value="' + escapeHtml(opt) + '">' +
                  '<span>' + escapeHtml(opt) + '</span>' +
                '</label>';
              });
              optionsHtml += '</div>';
            } else {
              optionsHtml = '<div style="margin-top:4px;">' +
                '<textarea id="q_input_' + idx + '" class="question-textarea" data-q-idx="' + idx + '" placeholder="Type your answer..." rows="2"></textarea>' +
              '</div>';
            }

            slidesHtml += '<div class="question-slide" id="q-slide-' + idx + '" style="' + (idx === 0 ? 'display:block;' : 'display:none;') + '">' +
              '<div class="question-prompt">' +
                (totalQ > 1 ? '<span class="question-num-tag">Question ' + (idx + 1) + ':</span> ' : '') + escapeHtml(q.question) +
              '</div>' +
              optionsHtml +
            '</div>';
          });

          let qHtml = '<div class="questions-card" id="questions-carousel-card">' +
            '<div class="questions-header">' +
              '<div class="questions-title">Clarifying Questions</div>' +
              (totalQ > 1 ? '<div class="questions-step-badge" id="q-step-badge">1 of ' + totalQ + '</div>' : '') +
            '</div>' +
            '<div class="carousel-slides">' + slidesHtml + '</div>' +
            '<div class="carousel-footer">' +
              '<button class="btn-carousel-prev" id="btn-q-prev" data-action="q-prev" style="visibility:hidden;">Back</button>' +
              '<div style="display:flex; gap:6px;">' +
                (totalQ > 1 ? '<button class="btn-carousel-next" id="btn-q-next" data-action="q-next">Next</button>' : '') +
                '<button class="btn-carousel-submit" id="btn-q-submit" data-action="submit-questions" data-question-id="' + msg.question_id + '" data-total-q="' + totalQ + '" style="' + (totalQ > 1 ? 'display:none;' : '') + '">Submit ' + (totalQ > 1 ? 'Answers' : 'Answer') + '</button>' +
              '</div>' +
            '</div>' +
          '</div>';

          interactiveSlot.innerHTML = qHtml;
          break;
        }

        case 'plan_approval':
          const plan = msg.plan || {};
          let todosHtml = '';
          if (plan.todos && plan.todos.length > 0) {
            todosHtml = '<div style="margin-top:6px; display:flex; flex-direction:column; gap:3px;">' +
              plan.todos.map(t => '<div style="font-size:11px; color:var(--muted);"><span style="color:var(--accent); font-weight:600;">•</span> ' + escapeHtml(t.description || t.title || t) + '</div>').join('') +
            '</div>';
          }
          interactiveSlot.innerHTML = \`
            <div class="approval-card">
              <div style="font-weight:600; color:var(--purple); display:flex; align-items:center; gap:6px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                <span>Plan Review: \${escapeHtml(plan.title || 'Implementation Plan')}</span>
              </div>
              \${plan.description ? \`<div style="margin-top:4px; font-size:11.5px; color:var(--fg);">\${escapeHtml(plan.description)}</div>\` : ''}
              \${todosHtml}
              <input type="text" id="plan-feedback-input" placeholder="Optional review note or instructions..." style="width:100%; margin-top:8px; padding:5px 8px; font-size:11.5px; background:var(--input-bg); border:1px solid var(--input-border); color:var(--fg); border-radius:4px; outline:none;">
              <div class="approval-buttons" style="margin-top:8px;">
                <button class="btn-approve" data-action="approve-plan" style="background:var(--green); color:#fff;">Approve & Execute</button>
                <button class="btn-reject" data-action="reject-plan" style="background:var(--red); color:#fff;">Reject & Revise</button>
              </div>
            </div>
          \`;
          break;

        case 'subagent_spawned':
          if (!currentTurnAssistantDiv) startAssistantTurn();
          appendSubagentCard(msg);
          break;

        case 'subagent_progress':
        case 'subagent_done':
        case 'subagent_failed':
          updateSubagentCard(msg);
          break;

        case 'agent_started':
          if (!currentTurnAssistantDiv) startAssistantTurn();
          break;

        case 'agent_busy':
          if (msg.queuedPrompt) {
            promptQueue.push(msg.queuedPrompt);
            renderQueue();
            appendSystemNote('Agent busy — your message was queued (will send after this turn).');
          } else {
            appendSystemNote('Agent is still working — please wait for this turn to finish.');
          }
          break;

        case 'agent_done':
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          updateTokenDisplay({
            token_total: msg.token_total,
            cost_usd: msg.cost_usd,
          });
          flushQueue();
          break;

        case 'agent_cancelled':
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          appendSystemNote('Turn cancelled by user.');
          flushQueue();
          break;

        case 'agent_error':
          // If error is just a timeout but stream already started, don't end turn abruptly
          if (msg.error && msg.error.includes('RPC timeout')) {
            appendSystemNote('Note: ' + msg.error + ' — but agent is still streaming. Watch the footer for progress.');
            if (!currentTurnAssistantDiv) startAssistantTurn();
            break;
          }
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          appendErrorCard(msg.error || 'Unknown agent error.');
          flushQueue();
          break;

        case 'toggle_sessions':
          toggleSessionsFlyout();
          break;

        case 'toggle_crons':
          toggleCronsFlyout();
          break;

        case 'sessions_data':
          renderSessionsList(msg.sessions || [], msg.currentSessionId || currentSessionId);
          break;

        case 'crons_data':
          renderCronsList(msg.crons || []);
          break;

        case 'plan_updated':
          updatePlanTracker(msg.plan);
          break;
      }
    });

    function appendErrorCard(text) {
      const errDiv = document.createElement('div');
      errDiv.className = 'error-card';
      errDiv.style.color = 'var(--red)';
      errDiv.style.fontSize = '12px';
      errDiv.textContent = 'Error: ' + text;
      chatContainer.appendChild(errDiv);
      scrollToBottomIfNeeded();
    }

    function appendSystemNote(text) {
      const note = document.createElement('div');
      note.className = 'system-note';
      note.style.fontSize = '11px';
      note.style.color = 'var(--muted)';
      note.textContent = text;
      chatContainer.appendChild(note);
      scrollToBottomIfNeeded();
    }

    function appendSubagentCard(msg) {
      const card = document.createElement('div');
      card.className = 'subagent-card';
      card.id = 'subagent-' + msg.agent_id;
      card.innerHTML = \`
        <div class="subagent-header">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 6v6m11-9h-6m-6 0H1"></path></svg>
          <span class="subagent-role">\${escapeHtml(msg.role || 'sub-agent')}</span>
          <span class="subagent-status">RUNNING</span>
        </div>
        <div class="subagent-body">\${escapeHtml(msg.task || '')}</div>
      \`;
      currentTurnAssistantDiv.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function updateSubagentCard(msg) {
      let card = document.getElementById('subagent-' + msg.agent_id);
      if (!card) {
        if (!currentTurnAssistantDiv) return;
        appendSubagentCard(msg);
        card = document.getElementById('subagent-' + msg.agent_id);
        if (!card) return;
      }
      const statusEl = card.querySelector('.subagent-status');
      const bodyEl = card.querySelector('.subagent-body');
      const detail = msg.detail || msg.result || msg.error || (msg.tool_name ? 'Tool: ' + msg.tool_name : '') || (msg.status || '');

      if (detail && bodyEl) {
        bodyEl.textContent += (bodyEl.textContent ? '\\n' : '') + detail;
      }

      if (statusEl) {
        if (msg.error) {
          statusEl.className = 'subagent-status failed';
          statusEl.textContent = 'FAILED';
        } else if (msg.result || msg.status === 'completed' || msg.status === 'done') {
          statusEl.className = 'subagent-status done';
          statusEl.textContent = 'DONE';
        }
      }
      scrollToBottomIfNeeded();
    }

    window.approveTool = function(approvalId) {
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'approve_tool', approvalId });
    };

    window.rejectTool = function(approvalId) {
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'reject_tool', approvalId });
    };

    window.approvePlan = function() {
      const feedbackInput = document.getElementById('plan-feedback-input');
      const feedback = feedbackInput ? feedbackInput.value.trim() : '';
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'approve_plan', feedback });
    };

    window.rejectPlan = function() {
      const feedbackInput = document.getElementById('plan-feedback-input');
      const feedback = feedbackInput ? feedbackInput.value.trim() : '';
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'reject_plan', feedback });
    };

    window.currentQuestionSlide = 0;
    window.totalQuestionSlides = 1;

    window.navigateQuestionSlide = function(delta) {
      const nextIdx = window.currentQuestionSlide + delta;
      if (nextIdx < 0 || nextIdx >= window.totalQuestionSlides) return;
      const oldSlide = document.getElementById('q-slide-' + window.currentQuestionSlide);
      const newSlide = document.getElementById('q-slide-' + nextIdx);
      if (oldSlide) oldSlide.style.display = 'none';
      if (newSlide) newSlide.style.display = 'block';

      window.currentQuestionSlide = nextIdx;

      const badge = document.getElementById('q-step-badge');
      if (badge) badge.textContent = (nextIdx + 1) + ' of ' + window.totalQuestionSlides;

      const btnPrev = document.getElementById('btn-q-prev');
      if (btnPrev) btnPrev.style.visibility = (nextIdx > 0) ? 'visible' : 'hidden';

      const btnNext = document.getElementById('btn-q-next');
      const btnSubmit = document.getElementById('btn-q-submit');
      if (nextIdx === window.totalQuestionSlides - 1) {
        if (btnNext) btnNext.style.display = 'none';
        if (btnSubmit) btnSubmit.style.display = 'inline-flex';
      } else {
        if (btnNext) btnNext.style.display = 'inline-flex';
        if (btnSubmit) btnSubmit.style.display = 'none';
      }
    };

    window.handleQuestionKey = function(event, idx) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (window.currentQuestionSlide < window.totalQuestionSlides - 1) {
          window.navigateQuestionSlide(1);
        } else {
          const s = document.getElementById('btn-q-submit');
          if (s) s.click();
        }
      }
    };

    window.submitQuestions = function(questionId, totalQ) {
      const answers = [];
      for (let i = 0; i < totalQ; i++) {
        const checked = document.querySelectorAll('input[name="q_' + i + '"]:checked');
        if (checked.length > 0) {
          const vals = Array.from(checked).map(c => c.value);
          answers.push(vals.join(', '));
        } else {
          const textIn = document.getElementById('q_input_' + i);
          answers.push(textIn ? textIn.value.trim() : '');
        }
      }
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'answer_question', questionId, answers: answers.join(', ') });
    };

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    setRandomGreeting();
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'webview_ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}