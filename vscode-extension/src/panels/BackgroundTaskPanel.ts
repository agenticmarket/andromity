import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";

export class BackgroundTaskPanel {
  public static readonly viewType = "andromity.backgroundTaskTab";
  private static _panels = new Map<string, BackgroundTaskPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _processId: string;
  private _command: string;
  private _sessionId: string;
  private _rpcClient: RpcClient | null;
  private _disposables: vscode.Disposable[] = [];
  private _pollTimer: NodeJS.Timeout | null = null;
  private _isExited: boolean = false;
  private _startTime: number = Date.now();

  public static createOrShow(
    extensionUri: vscode.Uri,
    processId: string,
    rpcClient: RpcClient | null,
    command?: string,
    sessionId?: string,
    viewColumn?: vscode.ViewColumn
  ): BackgroundTaskPanel {
    const existing = BackgroundTaskPanel._panels.get(processId);
    if (existing) {
      existing._panel.reveal(viewColumn || vscode.ViewColumn.Beside);
      if (command) existing._command = command;
      if (rpcClient) existing._rpcClient = rpcClient;
      existing._fetchLogs();
      return existing;
    }

    const column = viewColumn || vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(
      BackgroundTaskPanel.viewType,
      `Task: ${processId}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");

    const instance = new BackgroundTaskPanel(
      panel,
      extensionUri,
      processId,
      rpcClient,
      command || "",
      sessionId || ""
    );
    BackgroundTaskPanel._panels.set(processId, instance);
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    processId: string,
    rpcClient: RpcClient | null,
    command: string,
    sessionId: string
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._processId = processId;
    this._rpcClient = rpcClient;
    this._command = command;
    this._sessionId = sessionId;

    this._panel.webview.html = this._getHtml();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case "ready":
            this._fetchLogs();
            break;
          case "kill_process":
            await this._killProcess();
            break;
          case "copy_text":
            if (message.text) {
              await vscode.env.clipboard.writeText(message.text);
              vscode.window.showInformationMessage("Copied to clipboard");
            }
            break;
        }
      },
      null,
      this._disposables
    );

    if (this._rpcClient) {
      const onExit = (params: any) => {
        if (!params || params.process_id === this._processId) {
          this._handleExited(params?.exit_code ?? 0, params?.duration);
        }
      };
      this._rpcClient.on("process/exited", onExit);
      this._disposables.push({
        dispose: () => {
          this._rpcClient?.off("process/exited", onExit);
        },
      });
    }

    this._startPolling();
  }

  private _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => {
      if (!this._isExited) {
        this._fetchLogs();
      }
    }, 1000);
  }

  private _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private async _fetchLogs() {
    if (!this._rpcClient) return;
    try {
      const res = await this._rpcClient.call("process.read", {
        process_id: this._processId,
        lines: 300,
      });
      if (res && typeof res.output === "string") {
        this._panel.webview.postMessage({
          type: "logs_update",
          output: res.output,
          command: this._command,
        });
      }
    } catch {}
  }

  private async _killProcess() {
    if (!this._rpcClient) return;
    try {
      await this._rpcClient.call("process.kill", { process_id: this._processId });
      this._handleExited(1, undefined, true);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to terminate task ${this._processId}: ${err?.message || err}`);
    }
  }

  private _handleExited(exitCode: number, duration?: number, wasKilled: boolean = false) {
    this._isExited = true;
    this._stopPolling();
    this._panel.webview.postMessage({
      type: "process_exited",
      exit_code: exitCode,
      duration: duration,
      was_killed: wasKilled,
    });
  }

  public dispose() {
    BackgroundTaskPanel._panels.delete(this._processId);
    this._stopPolling();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }

  private _getHtml(): string {
    const safePid = this._processId.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const safeCmd = this._command.replace(/</g, "&lt;").replace(/>/g, "&gt;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Task: ${safePid}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #18181b);
      --card-bg: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.03));
      --header-bg: var(--vscode-editorWidget-background, #141416);
      --border: var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
      --border-subtle: rgba(255, 255, 255, 0.03);
      --fg: var(--vscode-editor-foreground, #e4e4e7);
      --fg-muted: var(--vscode-descriptionForeground, #71717a);
      --cyan: #38bdf8;
      --green: #10b981;
      --red: #f85149;
      --font-mono: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Courier New', monospace;
      --font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--font-sans);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-size: 12.5px;
      -webkit-font-smoothing: antialiased;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 16px;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      user-select: none;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .task-icon {
      color: var(--cyan);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .task-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 2px;
    }
    .task-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .task-id {
      font-weight: 600;
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--cyan);
      background: rgba(56, 189, 248, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.18);
      padding: 0px 6px;
      border-radius: 4px;
      letter-spacing: -0.01em;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 9999px;
      background: rgba(56, 189, 248, 0.12);
      color: var(--cyan);
      border: 1px solid rgba(56, 189, 248, 0.22);
    }
    .status-badge.stopped {
      background: rgba(248, 81, 73, 0.12);
      color: var(--red);
      border-color: rgba(248, 81, 73, 0.22);
    }
    .status-badge.done {
      background: rgba(16, 185, 129, 0.12);
      color: var(--green);
      border-color: rgba(16, 185, 129, 0.22);
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .status-badge.running .status-dot {
      animation: pulse-dot 1.4s ease-in-out infinite;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.3; transform: scale(0.75); }
    }
    .timer-text {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--fg-muted);
    }
    .task-cmd {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--fg-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    button {
      background: rgba(255, 255, 255, 0.03);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.12s ease;
    }
    button:hover {
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(255, 255, 255, 0.18);
    }
    button.btn-autoscroll.active {
      background: rgba(56, 189, 248, 0.08);
      color: var(--cyan);
      border-color: rgba(56, 189, 248, 0.25);
    }
    button.btn-stop {
      background: transparent;
      color: var(--red);
      border-color: rgba(248, 81, 73, 0.25);
      opacity: 0.9;
    }
    button.btn-stop:hover {
      background: rgba(248, 81, 73, 0.12);
      border-color: rgba(248, 81, 73, 0.45);
      opacity: 1;
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .terminal-container {
      flex: 1;
      min-height: 0;
      padding: 12px 16px;
      overflow-y: auto;
      background: var(--bg);
      font-family: var(--font-mono);
      font-size: 11.5px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .terminal-container::-webkit-scrollbar {
      width: 7px;
      height: 7px;
    }
    .terminal-container::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
    }
    .terminal-container::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.18);
    }
    .notice-line {
      color: var(--cyan);
      opacity: 0.85;
      font-style: italic;
    }
    .exit-line {
      color: var(--fg-muted);
      border-top: 1px solid var(--border-subtle);
      margin-top: 12px;
      padding-top: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="task-icon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
      </div>
      <div class="task-meta">
        <div class="task-title-row">
          <span class="task-id">${safePid}</span>
          <span class="status-badge running" id="status-badge">
            <span class="status-dot"></span>
            <span id="status-text">RUNNING</span>
          </span>
          <span class="timer-text" id="timer-text">0s</span>
        </div>
        <div class="task-cmd" id="cmd-text" title="${safeCmd}">${safeCmd || 'Background process'}</div>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn-autoscroll active" id="btn-autoscroll" title="Toggle Auto-scroll">Auto-scroll</button>
      <button id="btn-clear" title="Clear View">Clear</button>
      <button id="btn-copy" title="Copy Output to Clipboard">Copy</button>
      <button class="btn-stop" id="btn-stop" title="Stop this background process">
        <span>Stop</span>
      </button>
    </div>
  </div>

  <div class="terminal-container" id="terminal-output">Loading background process output...</div>

  <script>
    const vscode = acquireVsCodeApi();
    const terminalEl = document.getElementById('terminal-output');
    const statusBadge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    const timerText = document.getElementById('timer-text');
    const btnAutoScroll = document.getElementById('btn-autoscroll');
    const btnClear = document.getElementById('btn-clear');
    const btnCopy = document.getElementById('btn-copy');
    const btnStop = document.getElementById('btn-stop');
    const cmdText = document.getElementById('cmd-text');

    let autoScroll = true;
    let startTime = Date.now();
    let isRunning = true;
    let fullOutput = '';

    const timerInterval = setInterval(() => {
      if (isRunning) {
        const secs = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
        timerText.textContent = formatSecs(secs);
      }
    }, 1000);

    function formatSecs(s) {
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      const rem = s % 60;
      return m + 'm ' + rem + 's';
    }

    btnAutoScroll.onclick = () => {
      autoScroll = !autoScroll;
      btnAutoScroll.classList.toggle('active', autoScroll);
      if (autoScroll) {
        terminalEl.scrollTop = terminalEl.scrollHeight;
      }
    };

    btnClear.onclick = () => {
      terminalEl.textContent = '(Logs cleared)';
    };

    btnCopy.onclick = () => {
      vscode.postMessage({ type: 'copy_text', text: fullOutput || terminalEl.textContent });
    };

    btnStop.onclick = () => {
      btnStop.disabled = true;
      btnStop.textContent = 'Stopping...';
      vscode.postMessage({ type: 'kill_process' });
    };

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'logs_update') {
        if (msg.output) {
          fullOutput = msg.output;
          terminalEl.textContent = msg.output;
          if (autoScroll) {
            terminalEl.scrollTop = terminalEl.scrollHeight;
          }
        }
        if (msg.command && cmdText) {
          cmdText.textContent = msg.command;
          cmdText.title = msg.command;
        }
      } else if (msg.type === 'process_exited') {
        isRunning = false;
        clearInterval(timerInterval);
        const code = msg.exit_code !== undefined ? msg.exit_code : 0;
        statusBadge.className = 'status-badge ' + (code === 0 ? 'done' : 'stopped');
        statusText.textContent = msg.was_killed ? 'STOPPED' : (code === 0 ? 'EXITED (0)' : ('EXITED (' + code + ')'));
        btnStop.disabled = true;
        btnStop.remove();

        const exitDiv = document.createElement('div');
        exitDiv.className = 'exit-line';
        exitDiv.textContent = '\\n[Process terminated with exit code ' + code + (msg.duration ? ' in ' + msg.duration + 's' : '') + ']';
        terminalEl.appendChild(exitDiv);
        if (autoScroll) {
          terminalEl.scrollTop = terminalEl.scrollHeight;
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
