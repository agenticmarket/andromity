import * as vscode from "vscode";
import * as path from "node:path";
import { RpcClient } from "../server/RpcClient.js";
import { getFingerprintHtml } from "../providers/fingerprint/fingerprintHtml.js";
import { WaterfallTraceStore } from "./WaterfallPanel.js";

export class FingerprintPanel {
  public static readonly viewType = "andromity.fingerprint";
  private static _panels = new Map<string, FingerprintPanel>();
  private static _sessionRecordedFeatures = new Map<string, Set<string>>();

  public static recordFeature(
    sessionId: string,
    feature: string,
    rpcClient: RpcClient | null
  ): void {
    if (!sessionId || !feature || !rpcClient) {
      return;
    }
    try {
      const vscodeConfig = vscode.workspace.getConfiguration("andromity");
      const telemetryAllowed = (vscode.env.isTelemetryEnabled ?? true) && vscodeConfig.get<boolean>("telemetry", true);
      if (!telemetryAllowed) {
        return;
      }
    } catch {
      // In mock/test environments
    }
    let features = FingerprintPanel._sessionRecordedFeatures.get(sessionId);
    if (!features) {
      features = new Set<string>();
      FingerprintPanel._sessionRecordedFeatures.set(sessionId, features);
    }
    if (features.has(feature)) {
      return;
    }
    features.add(feature);
    void rpcClient
      .call("telemetry.recordFeature", {
        feature,
        session_id: sessionId,
      })
      .catch(() => {});
  }

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _rpcClient: RpcClient | null;
  private readonly _context: vscode.ExtensionContext;
  private _sessionId: string;
  private _sessionName: string;
  private _disposables: vscode.Disposable[] = [];
  private _rpcDisposables: Array<() => void> = [];
  private _refreshTimer: NodeJS.Timeout | null = null;

  public static createOrShow(
    extensionUri: vscode.Uri,
    sessionId: string,
    sessionName: string,
    rpcClient: RpcClient | null,
    context: vscode.ExtensionContext,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active
  ): FingerprintPanel {
    if (rpcClient) {
      WaterfallTraceStore.init(rpcClient);
      FingerprintPanel.recordFeature(sessionId, "fingerprint", rpcClient);
    }
    if (FingerprintPanel._panels.has(sessionId)) {
      const existing = FingerprintPanel._panels.get(sessionId)!;
      if (rpcClient && existing._rpcClient !== rpcClient) {
        existing.setRpcClient(rpcClient);
      }
      if (sessionName) {
        existing._sessionName = sessionName;
        existing._panel.title = `Fingerprint: ${sessionName}`;
      }
      existing._panel.reveal(viewColumn);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      FingerprintPanel.viewType,
      `Fingerprint: ${sessionName || "Session"}`,
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    const instance = new FingerprintPanel(
      panel,
      extensionUri,
      sessionId,
      sessionName,
      rpcClient,
      context
    );

    FingerprintPanel._panels.set(sessionId, instance);
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

    if (rpcClient) {
      WaterfallTraceStore.init(rpcClient);
    }

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

    this._panel.webview.html = getFingerprintHtml(
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

  private _scheduleRefresh(delayMs: number = 60) {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      void this._refreshFingerprintData();
    }, delayMs);
  }

  private _bindRpcEvents() {
    if (!this._rpcClient) return;
    const client = this._rpcClient;

    const bind = (event: string) => {
      const handler = (params: any) => {
        if (!params?.session_id || params.session_id === this._sessionId) {
          this._scheduleRefresh(50);
        }
      };
      client.on(event, handler);
      this._rpcDisposables.push(() => client.off(event, handler));
    };

    bind("agent/started");
    bind("waterfall/llmStart");
    bind("waterfall/llmEnd");
    bind("agent/toolStart");
    bind("agent/toolDelta");
    bind("agent/toolEnd");
    bind("agent/toolResult");
    bind("agent/done");
    bind("agent/cancelled");
    bind("agent/error");
    bind("subagent/spawned");
    bind("subagent/progress");
    bind("subagent/done");
    bind("subagent/failed");
    bind("process/started");
    bind("process/exited");
  }

  private async _handleMessage(message: any) {
    if (!message) return;

    switch (message.command || message.type) {
      case "fingerprint_ready": {
        await this._refreshFingerprintData();
        break;
      }

      case "open_file": {
        if (message.filePath) {
          try {
            let fullPath = message.filePath;
            if (!path.isAbsolute(fullPath)) {
              const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
              if (ws) {
                fullPath = path.resolve(ws, fullPath);
              }
            }
            const uri = vscode.Uri.file(fullPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const line = Math.max(0, (message.line || 1) - 1);
            await vscode.window.showTextDocument(doc, {
              selection: new vscode.Range(line, 0, line, 0),
            });
          } catch (err: any) {
            vscode.window.showWarningMessage(`Could not open file ${message.filePath}: ${err.message}`);
          }
        }
        break;
      }

      case "telemetry_feature": {
        if (message.feature) {
          FingerprintPanel.recordFeature(this._sessionId, message.feature, this._rpcClient);
        }
        break;
      }

      case "show_info": {
        if (message.message) {
          vscode.window.showInformationMessage(message.message);
        }
        break;
      }

      case "export_fingerprint": {
        FingerprintPanel.recordFeature(this._sessionId, "fingerprint_export", this._rpcClient);
        try {
          const defaultFileName = `fingerprint-${this._sessionId.slice(0, 8)}-${Date.now()}.json`;
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultFileName),
            filters: { "JSON Files": ["json"] },
          });

          if (saveUri) {
            const buffer = Buffer.from(JSON.stringify(message.data, null, 2), "utf8");
            await vscode.workspace.fs.writeFile(saveUri, buffer);
            vscode.window.showInformationMessage(
              `Fingerprint trace saved to ${saveUri.fsPath}`
            );
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to export fingerprint: ${err.message}`);
        }
        break;
      }
    }
  }

  private async _refreshFingerprintData() {
    let sessionData: any = null;
    if (this._rpcClient) {
      try {
        sessionData = await this._rpcClient.call<any>("session.get", {
          session_id: this._sessionId,
        });
      } catch (err) {
        console.error("[FingerprintPanel] session.get failed:", err);
      }
    }

    const traceData = this._extractTraceData(sessionData);
    this._panel.webview.postMessage({
      type: "fingerprint_init",
      data: traceData,
    });
  }

  private _extractTraceData(sessionData: any): any {
    const nodes: any[] = [];
    const connections: any[] = [];
    let filesModified = 0;
    let filesRead = 0;
    let commandsRun = 0;
    let airgapCount = 0;
    let durationMs = 0;

    const messages = sessionData?.messages || [];

    interface TurnGroup {
      turnId: string;
      turnIndex: number;
      userPrompt: string;
      toolCalls: Array<{
        tc: any;
        resultText: string;
      }>;
    }

    const turns: TurnGroup[] = [];
    let currentTurn: TurnGroup | null = null;
    let userTurnCount = 0;

    // Map tool responses by tool_call_id
    const toolResults = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResults.set(
          msg.tool_call_id,
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
        );
      }
    }

    for (const msg of messages) {
      if (msg.role === "user") {
        userTurnCount++;
        const turnId = `turn-${userTurnCount}`;
        currentTurn = {
          turnId,
          turnIndex: userTurnCount,
          userPrompt: msg.content || `Turn ${userTurnCount}`,
          toolCalls: [],
        };
        turns.push(currentTurn);
      } else if (msg.role === "assistant") {
        if (!currentTurn) {
          userTurnCount = 1;
          currentTurn = {
            turnId: "turn-1",
            turnIndex: 1,
            userPrompt: "Initial Task",
            toolCalls: [],
          };
          turns.push(currentTurn);
        }

        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const toolId = tc.id || `tc-${currentTurn.turnIndex}-${currentTurn.toolCalls.length + 1}`;
            currentTurn.toolCalls.push({
              tc: { ...tc, id: toolId },
              resultText: toolResults.get(toolId) || "",
            });
          }
        }
      }
    }

    // Retrieve historical and in-flight events from WaterfallTraceStore
    const storeEvents: any[] = [];
    try {
      const buffered = WaterfallTraceStore.getEvents(this._sessionId) || [];
      const active = WaterfallTraceStore.getActiveTurnEvents(this._sessionId) || [];
      storeEvents.push(...buffered, ...active);
    } catch {}

    // Merge in-flight active turn events into current turn if in progress
    try {
      const activeEvents = WaterfallTraceStore.getActiveTurnEvents(this._sessionId) || [];
      for (const ev of activeEvents) {
        if (!ev) continue;
        if (ev.type === "tool_start" || ev.type === "subagent_spawned") {
          if (!currentTurn) {
            userTurnCount = 1;
            currentTurn = {
              turnId: "turn-1",
              turnIndex: 1,
              userPrompt: "Active Task",
              toolCalls: [],
            };
            turns.push(currentTurn);
          }
          const toolId = ev.tool_id || ev.id || `active-${ev.type}-${Date.now()}`;
          const existing = currentTurn.toolCalls.find(item => item.tc.id === toolId);
          if (!existing) {
            currentTurn.toolCalls.push({
              tc: {
                id: toolId,
                function: {
                  name: ev.name || ev.tool || (ev.type === "subagent_spawned" ? "spawn_subagent" : "tool"),
                  arguments: ev.args || (ev.type === "subagent_spawned" ? { role: ev.role, task: ev.task, model: ev.model, provider: ev.provider } : {}),
                },
              },
              resultText: ev.result || (ev.type === "subagent_spawned" ? "Subagent running..." : "Running..."),
            });
          }
        } else if (ev.type === "tool_result" && ev.tool_id && currentTurn) {
          const existing = currentTurn.toolCalls.find(item => item.tc.id === ev.tool_id);
          if (existing) {
            existing.resultText = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result || "");
          }
        } else if (ev.type === "subagent_done" && (ev.agent_id || ev.subagent_id || ev.id) && currentTurn) {
          const targetId = ev.agent_id || ev.subagent_id || ev.id;
          const existing = currentTurn.toolCalls.find(item => item.tc.id === targetId || item.tc.id === `subagent-${targetId}` || item.tc.id === ev.tool_id);
          if (existing) {
            existing.resultText = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result || "");
          }
        }
      }
    } catch {}

    // Subagent tracking store: agent_id -> SubagentData
    interface InternalSubagent {
      id: string;
      toolCallId?: string;
      role: string;
      task: string;
      model: string;
      provider: string;
      status: "running" | "done" | "failed";
      summary: string;
      error: string | null;
      durationMs: number;
      tools: Array<{
        id: string;
        name: string;
        args: any;
        result: string;
        status: string;
        durationMs?: number;
      }>;
    }

    const subagentsMap = new Map<string, InternalSubagent>();

    const getOrCreateSubagent = (id: string, initial?: Partial<InternalSubagent>): InternalSubagent => {
      let sub = subagentsMap.get(id);
      if (!sub) {
        sub = {
          id,
          role: initial?.role || "subagent",
          task: initial?.task || "",
          model: initial?.model || "",
          provider: initial?.provider || "",
          status: initial?.status || "running",
          summary: initial?.summary || "",
          error: initial?.error || null,
          durationMs: initial?.durationMs || 0,
          tools: [],
        };
        if (initial?.toolCallId) sub.toolCallId = initial.toolCallId;
        subagentsMap.set(id, sub);
      } else if (initial) {
        if (initial.role && !sub.role) sub.role = initial.role;
        if (initial.task && !sub.task) sub.task = initial.task;
        if (initial.model && !sub.model) sub.model = initial.model;
        if (initial.provider && !sub.provider) sub.provider = initial.provider;
        if (initial.status) sub.status = initial.status;
        if (initial.summary && !sub.summary) sub.summary = initial.summary;
        if (initial.error && !sub.error) sub.error = initial.error;
        if (initial.durationMs && !sub.durationMs) sub.durationMs = initial.durationMs;
        if (initial.toolCallId && !sub.toolCallId) sub.toolCallId = initial.toolCallId;
      }
      return sub;
    };

    // 1. Ingest subagent events from WaterfallTraceStore
    for (const ev of storeEvents) {
      if (!ev) continue;
      if (ev.type === "subagent_spawned") {
        const aid = ev.agent_id || ev.id || (ev.tool_id ? `sub_${ev.tool_id}` : "");
        if (aid) {
          const sub = getOrCreateSubagent(aid, {
            role: ev.role || "subagent",
            task: ev.task || "",
            model: ev.model || "",
            provider: ev.provider || "",
            status: "running",
            toolCallId: ev.tool_id,
          });
          if (ev.tool_id && !sub.toolCallId) sub.toolCallId = ev.tool_id;
        }
      } else if (ev.type === "subagent_progress") {
        const aid = ev.agent_id || ev.id || "";
        if (aid) {
          const sub = getOrCreateSubagent(aid, {
            role: ev.role,
            task: ev.task,
            model: ev.model,
            provider: ev.provider,
          });
          if (ev.tool_id && !sub.toolCallId && !ev.tool_name) sub.toolCallId = ev.tool_id;
          if (ev.duration_ms) sub.durationMs = Math.max(sub.durationMs, ev.duration_ms);

          if (ev.event_type === "completed" || ev.event_type === "done") {
            sub.status = "done";
            if (ev.detail) sub.summary = ev.detail;
          } else if (["failed", "error", "killed", "timeout"].includes(ev.event_type)) {
            sub.status = "failed";
            sub.error = ev.detail || ev.error || "Subagent failed";
          }

          // Tool progress
          if (ev.tool_name || ev.event_type === "tool_result") {
            const tName = ev.tool_name || "tool";
            let tArgs: any = {};
            try {
              tArgs = typeof ev.tool_args === "string" ? JSON.parse(ev.tool_args) : (ev.tool_args || {});
            } catch {
              tArgs = { raw: ev.tool_args };
            }
            const tId = ev.tool_id || `step-${sub.tools.length + 1}`;
            const existingT = sub.tools.find(t => t.id === tId || (t.name === tName && t.status === "running"));
            if (existingT) {
              if (ev.tool_result) existingT.result = typeof ev.tool_result === "string" ? ev.tool_result : JSON.stringify(ev.tool_result);
              if (ev.detail && !existingT.result) existingT.result = ev.detail;
              existingT.status = ev.status === "error" ? "error" : "done";
              if (ev.duration_ms) existingT.durationMs = ev.duration_ms;
            } else {
              sub.tools.push({
                id: tId,
                name: tName,
                args: tArgs,
                result: typeof ev.tool_result === "string" ? ev.tool_result : (ev.detail || ""),
                status: ev.status === "error" ? "error" : (ev.event_type === "tool_result" ? "done" : "running"),
                durationMs: ev.duration_ms || 0,
              });
            }
          }
        }
      } else if (ev.type === "subagent_done") {
        const aid = ev.agent_id || ev.id || "";
        if (aid) {
          const sub = getOrCreateSubagent(aid);
          sub.status = "done";
          if (ev.result) sub.summary = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result);
          if (ev.duration_ms) sub.durationMs = ev.duration_ms;
        }
      } else if (ev.type === "subagent_failed") {
        const aid = ev.agent_id || ev.id || "";
        if (aid) {
          const sub = getOrCreateSubagent(aid);
          sub.status = "failed";
          sub.error = ev.error || "Subagent failed";
          if (ev.duration_ms) sub.durationMs = ev.duration_ms;
        }
      }
    }

    // 2. Ingest subagents from turn tool calls and parse tools_called
    for (const turn of turns) {
      for (const item of turn.toolCalls) {
        const tc = item.tc;
        const fn = tc.function || tc;
        const name = fn.name || tc.name || "";
        if (!/subagent|spawn|delegate/i.test(name)) continue;

        const toolId = tc.id;
        let args: any = {};
        try {
          args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || {});
        } catch {
          args = { raw: fn.arguments };
        }

        let parsed: any = null;
        if (item.resultText) {
          try {
            parsed = typeof item.resultText === "string" ? JSON.parse(item.resultText) : item.resultText;
          } catch {}
        }

        const agentId = parsed?.agent_id || args.agent_id || toolId;
        const sub = getOrCreateSubagent(agentId, {
          toolCallId: toolId,
          role: parsed?.role || args.role || "subagent",
          task: args.task || args.instruction || parsed?.task || "",
          model: args.model_override || args.model || parsed?.model || "",
          provider: args.provider_override || args.provider || parsed?.provider || "",
          status: parsed?.status === "completed" ? "done" : (parsed?.status || (item.resultText ? "done" : "running")),
          summary: parsed?.summary || item.resultText || "",
          durationMs: parsed?.duration_ms || 0,
          error: parsed?.error || null,
        });

        // Always link toolCallId
        sub.toolCallId = toolId;

        // Extract tools_called from SubAgentResult
        if (parsed && Array.isArray(parsed.tools_called) && parsed.tools_called.length > 0) {
          parsed.tools_called.forEach((st: any, sIdx: number) => {
            const stName = st.name || "tool";
            let stArgs: any = {};
            try {
              stArgs = typeof st.args === "string" ? JSON.parse(st.args) : (st.args || {});
            } catch {
              stArgs = { raw: st.args };
            }
            const stId = st.id || `${agentId}-tool-${sIdx}`;
            const existingT = sub.tools.find(t => t.id === stId || (t.name === stName && JSON.stringify(t.args) === JSON.stringify(stArgs)));
            if (!existingT) {
              sub.tools.push({
                id: stId,
                name: stName,
                args: stArgs,
                result: typeof st.result === "string" ? st.result : JSON.stringify(st.result || ""),
                status: st.status === "error" ? "error" : "done",
                durationMs: st.duration_ms || 0,
              });
            }
          });
        }
      }
    }

    // 3. Build Subagent Trace Fingerprints for each subagent
    const subagents: Record<string, any> = {};

    subagentsMap.forEach((sub, aid) => {
      const subNodes: any[] = [];
      const subConnections: any[] = [];
      let subFilesModified = 0;
      let subFilesRead = 0;
      let subCommandsRun = 0;
      let subAirgapCount = 0;

      const subHubId = `${aid}-hub`;
      subNodes.push({
        id: subHubId,
        type: "llm",
        category: "llm",
        title: `Subagent: ${(sub.role || "subagent").toUpperCase()}`,
        sub: sub.task ? (sub.task.length > 80 ? sub.task.slice(0, 80) + "..." : sub.task) : "Autonomous subagent execution",
        badge: `${sub.tools.length} Actions · ${(sub.status || "done").toUpperCase()}`,
        badgeType: sub.status === "running" ? "amber" : (sub.status === "failed" ? "red" : "muted"),
        turn: `${aid}-lineage`,
        isTurnHub: true,
        x: 60,
        y: 220,
        details: {
          summary: sub.task || `Subagent ${sub.role} task`,
          role: sub.role,
          model: sub.model,
          provider: sub.provider,
          status: sub.status,
          durationMs: sub.durationMs,
          actionsCount: sub.tools.length,
          finalSummary: sub.summary,
          error: sub.error,
        },
      });

      sub.tools.forEach((st, sIdx) => {
        const stName = st.name || "tool";
        const stArgs = st.args || {};
        const stFile = stArgs.file_path || stArgs.path || stArgs.target_file || stArgs.file || "";
        const stCmd = stArgs.command || "";
        const stIsEnv = stFile && /\.(env|pem|key)|id_rsa|secret|credential/i.test(stFile);

        let stType = "read";
        if (/write|replace|edit|patch/i.test(stName)) {
          stType = "write";
          subFilesModified++;
        } else if (/shell|command|exec|terminal|bash/i.test(stName)) {
          stType = "shell";
          subCommandsRun++;
        } else if (stIsEnv) {
          stType = "security";
          subAirgapCount++;
        } else {
          subFilesRead++;
        }

        const col = Math.floor(sIdx / 4);
        const row = sIdx % 4;
        const nodeX = 380 + col * 280;
        const nodeY = 40 + row * 115;
        const toolNodeId = `${aid}-tool-${sIdx}`;

        subNodes.push({
          id: toolNodeId,
          type: stType,
          category: stType,
          title: `${stName}: ${stFile || stCmd || "action"}`,
          sub: stCmd || (stFile ? `File: ${stFile}` : `Subagent Action`),
          badge: st.status === "error" ? "Error" : (st.status === "running" ? "Active" : "OK"),
          badgeType: stType === "write" ? "green" : (st.status === "error" ? "red" : (st.status === "running" ? "amber" : "muted")),
          turn: `${aid}-lineage`,
          filePath: stFile || undefined,
          line: stArgs.start_line || stArgs.line || 1,
          x: nodeX,
          y: nodeY,
          details: {
            filePath: stFile,
            cmd: stCmd,
            purpose: `Executed subagent tool ${stName}`,
            stdout: stType === "shell" ? (st.result || "") : undefined,
            summary: stType !== "shell" ? (st.result || "") : undefined,
          },
        });

        subConnections.push({
          from: subHubId,
          to: toolNodeId,
          grad: stType === "write" ? "grad-dag-3" : (stType === "shell" ? "grad-dag-4" : "grad-dag-2"),
          dashed: stIsEnv,
        });
      });

      subagents[aid] = {
        id: aid,
        toolCallId: sub.toolCallId,
        role: sub.role,
        task: sub.task,
        model: sub.model,
        provider: sub.provider,
        status: sub.status,
        summary: sub.summary,
        error: sub.error,
        durationMs: sub.durationMs,
        metrics: {
          durationMs: sub.durationMs,
          filesModified: subFilesModified,
          filesRead: subFilesRead,
          commandsRun: subCommandsRun,
          airgapCount: subAirgapCount,
        },
        nodes: subNodes,
        connections: subConnections,
        tools: sub.tools,
      };

      // Aggregate into main metrics
      filesModified += subFilesModified;
      filesRead += subFilesRead;
      commandsRun += subCommandsRun;
      airgapCount += subAirgapCount;
    });

    // 4. Build Main DAG Nodes & Connections
    let prevTurnHubId: string | null = null;
    let currentTurnX = 40;

    turns.forEach((turn) => {
      const turnHubId = turn.turnId;
      const turnX = currentTurnX;
      const turnY = 220;

      // Add Turn Hub Node
      nodes.push({
        id: turnHubId,
        type: "llm",
        category: "llm",
        title: `Turn ${turn.turnIndex}: User Request`,
        sub: turn.userPrompt ? (turn.userPrompt.slice(0, 80) + (turn.userPrompt.length > 80 ? "..." : "")) : "Turn execution",
        badge: `${turn.toolCalls.length} Actions`,
        badgeType: "muted",
        turn: turnHubId,
        isTurnHub: true,
        x: turnX,
        y: turnY,
        details: {
          summary: `Turn ${turn.turnIndex} prompt: ${turn.userPrompt}`,
          actionsCount: turn.toolCalls.length,
        },
      });

      // Connect Turn Hub sequentially from previous Turn Hub
      if (prevTurnHubId) {
        connections.push({
          from: prevTurnHubId,
          to: turnHubId,
          grad: "grad-dag-1",
        });
      }
      prevTurnHubId = turnHubId;

      let toolColCount = 0;

      // Add Tool Nodes for this Turn
      turn.toolCalls.forEach((item, tcIdx) => {
        const tc = item.tc;
        const fn = tc.function || tc;
        const name = fn.name || tc.name || "tool";
        let args: any = {};
        try {
          args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || {});
        } catch {
          args = { raw: fn.arguments };
        }

        const toolId = tc.id || `tc-${turn.turnIndex}-${tcIdx}`;
        const filePath = args.file_path || args.path || args.target_file || args.file || "";
        const isEnvOrSecret = filePath && /\.(env|pem|key)|id_rsa|secret|credential/i.test(filePath);

        const isSubagent = /subagent|spawn|delegate/i.test(name);

        let nodeType = "read";
        let category = "read";
        if (isSubagent) {
          nodeType = "subagent";
          category = "subagent";
        } else if (/write|replace|edit|patch/i.test(name)) {
          nodeType = "write";
          category = "write";
          filesModified++;
        } else if (/shell|command|exec|terminal|bash/i.test(name)) {
          nodeType = "shell";
          category = "shell";
          commandsRun++;
        } else if (isEnvOrSecret) {
          nodeType = "security";
          category = "security";
          airgapCount++;
        } else {
          filesRead++;
        }

        const col = Math.floor(tcIdx / 4);
        const row = tcIdx % 4;
        if (col + 1 > toolColCount) toolColCount = col + 1;

        const nodeX = turnX + 310 + col * 280;
        const nodeY = 40 + row * 115;

        if (isSubagent) {
          // Find matched subagent data
          let matchedSub: any = null;
          for (const key of Object.keys(subagents)) {
            const s = subagents[key];
            if (s.toolCallId === toolId || s.id === toolId || s.id === args.agent_id) {
              matchedSub = s;
              break;
            }
          }
          if (!matchedSub && args.role) {
            for (const key of Object.keys(subagents)) {
              const s = subagents[key];
              if (s.role === args.role) {
                matchedSub = s;
                break;
              }
            }
          }

          const subRole = (matchedSub?.role || args.role || "subagent").toUpperCase();
          const subActionsCount = matchedSub?.tools?.length || 0;
          const subStatus = matchedSub?.status || (item.resultText ? "done" : "running");
          const subId = matchedSub?.id || toolId;

          nodes.push({
            id: toolId,
            type: "subagent",
            category: "subagent",
            title: `Subagent: ${subRole}`,
            sub: matchedSub?.task ? (matchedSub.task.length > 70 ? matchedSub.task.slice(0, 70) + "..." : matchedSub.task) : (args.task ? (args.task.length > 70 ? args.task.slice(0, 70) + "..." : args.task) : "Autonomous sub-task"),
            badge: `${subActionsCount} Actions · ${subStatus.toUpperCase()}`,
            badgeType: subStatus === "running" ? "amber" : (subStatus === "failed" ? "red" : "muted"),
            turn: turnHubId,
            subagentId: subId,
            hasSubagentDrilldown: true,
            subagentActionCount: subActionsCount,
            x: nodeX,
            y: nodeY,
            details: {
              subagentId: subId,
              role: matchedSub?.role || args.role || "subagent",
              task: matchedSub?.task || args.task,
              model: matchedSub?.model || args.model_override,
              provider: matchedSub?.provider || args.provider_override,
              status: subStatus,
              durationMs: matchedSub?.durationMs || 0,
              actionsCount: subActionsCount,
              summary: matchedSub?.summary || item.resultText,
              error: matchedSub?.error,
              toolsPreview: (matchedSub?.tools || []).slice(0, 8).map((t: any) => ({
                name: t.name,
                desc: t.args?.file_path || t.args?.path || t.args?.target_file || t.args?.command || t.name,
                status: t.status,
              })),
            },
          });

          connections.push({
            from: turnHubId,
            to: toolId,
            grad: "grad-dag-1",
          });
        } else {
          nodes.push({
            id: toolId,
            type: nodeType,
            category: category,
            title: `${name}: ${filePath || args.command || "call"}`,
            sub: args.command || (filePath ? `File: ${filePath}` : (args.title || "Tool Execution")),
            badge: item.resultText ? "OK" : "Active",
            badgeType: nodeType === "write" ? "green" : (item.resultText ? "muted" : "amber"),
            turn: turnHubId,
            filePath: filePath || undefined,
            line: args.start_line || args.line || 1,
            x: nodeX,
            y: nodeY,
            details: {
              filePath: filePath,
              cmd: args.command,
              purpose: `Executed tool ${name}`,
              stdout: nodeType === "shell" ? item.resultText : undefined,
              summary: nodeType !== "shell" ? item.resultText : undefined,
            },
          });

          // Connect from this Turn's Hub to this tool node
          connections.push({
            from: turnHubId,
            to: toolId,
            grad: nodeType === "write" ? "grad-dag-3" : (nodeType === "shell" ? "grad-dag-4" : "grad-dag-2"),
            dashed: isEnvOrSecret,
          });
        }
      });

      // Advance X for next turn with non-overlapping padding
      const maxCols = Math.max(1, toolColCount);
      currentTurnX += 340 + maxCols * 280 + 80;
    });

    if (sessionData?.created_at && sessionData?.updated_at) {
      const start = new Date(sessionData.created_at).getTime();
      const end = new Date(sessionData.updated_at).getTime();
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        durationMs = end - start;
      }
    }

    return {
      session_id: this._sessionId,
      nodes,
      connections,
      metrics: {
        durationMs,
        filesModified,
        filesRead,
        commandsRun,
        airgapCount,
      },
      subagents,
    };
  }

  public dispose() {
    FingerprintPanel._panels.delete(this._sessionId);
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    this._disposeRpcEvents();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
