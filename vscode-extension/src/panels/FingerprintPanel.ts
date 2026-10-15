import * as vscode from "vscode";
import { allowOpenPath } from "../server/securityPolicy.js";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "../server/RpcClient.js";
import { getFingerprintHtml } from "../providers/fingerprint/fingerprintHtml.js";
import { buildFingerprintTrace } from "../providers/fingerprint/fingerprintTrace.js";
import { DOCS } from "../docsLinks.js";
import { WaterfallTraceStore } from "./WaterfallPanel.js";

export class FingerprintPanel {
  public static readonly viewType = "andromity.fingerprint";
  private static _panels = new Map<string, FingerprintPanel>();
  private static _sessionRecordedFeatures = new Map<string, Set<string>>();
  private static readonly REFRESH_INTERVAL_MS = 750;
  private static readonly NOTICE_DISMISSED_KEY = "andromity.fingerprintNoticeDismissed";

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
  private _refreshing = false;
  private _refreshQueued = false;
  private _lastRefreshAt = 0;

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
        // A static report rebuilt from the daemon on fingerprint_ready, so it
        // need not stay resident while hidden.
        retainContextWhenHidden: false,
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
      this._extensionUri,
      this._context?.globalState?.get<boolean>(FingerprintPanel.NOTICE_DISMISSED_KEY, false) || false
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

  // Live events arrive many times a second and each refresh re-reads the whole session,
  // so refresh at most once per interval.
  private _scheduleRefresh() {
    if (this._refreshTimer) return;
    const wait = Math.max(0, this._lastRefreshAt + FingerprintPanel.REFRESH_INTERVAL_MS - Date.now());
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      void this._refreshFingerprintData();
    }, wait);
  }

  private _bindRpcEvents() {
    if (!this._rpcClient) return;
    const client = this._rpcClient;

    const bind = (event: string) => {
      const handler = (params: any) => {
        if (!params?.session_id || params.session_id === this._sessionId) {
          this._scheduleRefresh();
        }
      };
      client.on(event, handler);
      this._rpcDisposables.push(() => client.off(event, handler));
    };

    bind("agent/started");
    bind("waterfall/llmStart");
    bind("waterfall/llmEnd");
    bind("agent/toolStart");
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
        if (typeof message.filePath === "string" && message.filePath) {
          try {
            if (!(await allowOpenPath(message.filePath))) break;
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

      case "open_docs": {
        void vscode.env.openExternal(vscode.Uri.parse(DOCS.fingerprint));
        break;
      }

      case "dismiss_notice": {
        void this._context?.globalState?.update(FingerprintPanel.NOTICE_DISMISSED_KEY, true);
        break;
      }

      case "export_fingerprint": {
        FingerprintPanel.recordFeature(this._sessionId, "fingerprint_export", this._rpcClient);
        try {
          const defaultFileName = `fingerprint-${this._sessionId.slice(0, 8)}-${Date.now()}.json`;
          const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri: folder ? vscode.Uri.joinPath(folder, defaultFileName) : vscode.Uri.file(path.join(os.homedir(), defaultFileName)),
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
    // A hidden webview is discarded; it asks again with fingerprint_ready when shown.
    if (!this._panel.visible) return;
    if (this._refreshing) {
      this._refreshQueued = true;
      return;
    }
    this._refreshing = true;
    this._lastRefreshAt = Date.now();
    try {
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
      this._panel.webview.postMessage({
        type: "fingerprint_init",
        data: this._extractTraceData(sessionData),
      });
    } finally {
      this._refreshing = false;
      if (this._refreshQueued) {
        this._refreshQueued = false;
        this._scheduleRefresh();
      }
    }
  }

  private _extractTraceData(sessionData: any): any {
    let storeEvents: any[] = [];
    let activeEvents: any[] = [];
    try {
      storeEvents = WaterfallTraceStore.getEvents(this._sessionId) || [];
      activeEvents = WaterfallTraceStore.getActiveTurnEvents(this._sessionId) || [];
    } catch {}
    return buildFingerprintTrace(sessionData, {
      sessionId: this._sessionId,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      storeEvents,
      activeEvents,
    });
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
