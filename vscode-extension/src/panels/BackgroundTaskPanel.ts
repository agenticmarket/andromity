import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { escapeHtml, getNonce } from "../providers/webviewSecurity.js";

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
  private _fetchInFlight = false;
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
    const defaultCol = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const column = viewColumn || defaultCol;
    const existing = BackgroundTaskPanel._panels.get(processId);
    if (existing) {
      existing._panel.reveal(column);
      if (command) existing._command = command;
      if (rpcClient) existing._rpcClient = rpcClient;
      existing._fetchLogs();
      return existing;
    }

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
    // Output is only polled while someone can see it.
    this._panel.onDidChangeViewState(() => {
      if (this._isExited) return;
      if (this._panel.visible) {
        this._fetchLogs();
        this._startPolling();
      } else {
        this._stopPolling();
      }
    }, null, this._disposables);

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
      if (!this._isExited && this._panel.visible) {
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
    if (!this._rpcClient || this._fetchInFlight) return;
    this._fetchInFlight = true;
    try {
      const res = await this._rpcClient.call("process.read", {
        process_id: this._processId,
        session_id: this._sessionId || undefined,
        lines: 300,
      });
      if (res && typeof res.output === "string") {
        this._panel.webview.postMessage({
          type: "logs_update",
          output: res.output,
          command: this._command,
        });
      }
    } catch {
      this._panel.webview.postMessage({ type: "task_error", message: "Connection interrupted. Retrying…" });
    } finally {
      this._fetchInFlight = false;
    }
  }

  private async _killProcess() {
    if (!this._rpcClient) return;
    try {
      await this._rpcClient.call("process.kill", { process_id: this._processId, session_id: this._sessionId || undefined });
      this._handleExited(1, undefined, true);
    } catch {
      this._panel.webview.postMessage({ type: "task_error", message: "Could not stop this task. Try again.", stop_failed: true });
    }
  }

  private _handleExited(exitCode: number, duration?: number, wasKilled: boolean = false) {
    this._isExited = true;
    this._stopPolling();
    void this._fetchLogs();
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
    // The command is model-controlled; it must stay inert in both text and attributes.
    const safePid = escapeHtml(this._processId);
    const safeCmd = escapeHtml(this._command);
    const nonce = getNonce();
    const cspSource = this._panel.webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src ${cspSource} data:; script-src 'nonce-${nonce}';">
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
      --font-mono: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      --font-sans: var(--vscode-font-family, system-ui, sans-serif);
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
      padding: 16px 20px;
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
      gap: 6px;
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
      font-size: 12px;
      font-weight: 600;
      color: var(--cyan);
      letter-spacing: 0.02em;
    }
    .status-badge.stopped {
      color: var(--red);
    }
    .status-badge.done {
      color: var(--green);
    }
    @media (max-width: 600px) {
      .header {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 12px;
      }
      .header-actions {
        width: 100%;
        justify-content: flex-start;
        flex-wrap: wrap;
        gap: 5px;
      }
      .terminal-container {
        padding: 10px 12px;
        font-size: 11px;
      }
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
    .task-heading { font-size: 14px; font-weight: 600; }
    .task-title-row { flex-wrap: wrap; }
    .task-id { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .command-details { padding: 12px 20px; border-bottom: 1px solid var(--border); }
    .command-details summary { cursor: pointer; color: var(--fg-muted); font-size: 12px; overflow-wrap: anywhere; }
    .command-preview { margin-left: 10px; font-family: var(--font-mono); }
    .command-details code { display: block; margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.7 var(--font-mono); user-select: text; }
    .command-details[open] .command-preview { display: none; }
    .output-toolbar, .output-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 20px; color: var(--fg-muted); font-size: 11px; flex-shrink: 0; }
    .output-toolbar { border-bottom: 1px solid var(--border); }
    .output-label { font-weight: 600; color: var(--fg); font-size: 12px; }
    .output-footer { border-top: 1px solid var(--border); min-height: 36px; }
    button:focus-visible, summary:focus-visible, .terminal-container:focus-visible { outline: 1px solid var(--vscode-focusBorder, #38bdf8); outline-offset: 2px; }
    .header { flex-wrap: wrap; }
    .output-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    @media (max-width: 500px) { .output-toolbar { align-items: flex-start; flex-direction: column; } .command-preview { display: none; } }
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
      padding: 5px 10px;
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
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
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
          <span class="task-heading">Background task</span>
          <span class="task-id">${safePid}</span>
        </div>
        <div class="task-title-row">
          <span class="status-badge running" id="status-badge">
            <span id="status-text">Connecting…</span>
          </span>
          <span class="timer-text" id="timer-text">0s</span>
        </div>
      </div>
    </div>
    <div class="header-actions">
      <button class="btn-stop" id="btn-stop" title="Stop this background process">
        <span>Stop task</span>
      </button>
    </div>
  </div>

  <details class="command-details">
    <summary>Command <span class="command-preview" id="command-preview">${escapeHtml(this._command.slice(0, 90))}</span></summary>
    <code id="cmd-text">${safeCmd || 'Waiting for command…'}</code>
  </details>
  <div class="output-toolbar">
    <span class="output-label">Output <span class="timer-text">· latest 300 lines</span></span>
    <div class="output-actions">
      <button class="btn-autoscroll active" id="btn-autoscroll" aria-pressed="true" title="Follow new output">Follow output</button>
      <button id="btn-clear" title="Hide current output until it changes">Clear view</button>
      <button id="btn-copy" title="Copy visible output">Copy output</button>
    </div>
  </div>
  <div class="terminal-container" id="terminal-output" tabindex="0" role="region" aria-label="Background task output">Connecting to task…</div>
  <div class="output-footer"><span id="output-notice" role="status">Waiting for output</span><span id="exit-summary"></span></div>

  <script nonce="${nonce}">
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
    const notice = document.getElementById('output-notice');
    const exitSummary = document.getElementById('exit-summary');

    let autoScroll = true;
    let startTime = Date.now();
    let isRunning = true;
    let fullOutput = '';
    let clearedOutput = null;

    function syncFollow() {
      btnAutoScroll.classList.toggle('active', autoScroll);
      btnAutoScroll.setAttribute('aria-pressed', String(autoScroll));
      btnAutoScroll.textContent = autoScroll ? 'Following output' : 'Follow output';
    }
    terminalEl.addEventListener('scroll', () => {
      autoScroll = terminalEl.scrollHeight - terminalEl.scrollTop - terminalEl.clientHeight < 24;
      syncFollow();
    });

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
      syncFollow();
      if (autoScroll) {
        terminalEl.scrollTop = terminalEl.scrollHeight;
      }
    };

    btnClear.onclick = () => {
      clearedOutput = fullOutput;
      terminalEl.textContent = '';
      notice.textContent = 'View cleared. Waiting for output to change.';
    };

    btnCopy.onclick = () => {
      vscode.postMessage({ type: 'copy_text', text: terminalEl.textContent });
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
        if (typeof msg.output === 'string') {
          const envelope = msg.output.match(/^Process '[^\\n]*' \\| (running|exited \\(code (-?\\d+)\\)) \\| (\\d+)s elapsed\\nCommand: ([\\s\\S]*?)\\n--- last \\d+ lines ---\\n([\\s\\S]*)$/);
          const output = envelope ? envelope[5] : msg.output;
          if (envelope) {
            if (!msg.command) msg.command = envelope[4];
            startTime = Date.now() - Number(envelope[3]) * 1000;
            timerText.textContent = formatSecs(Number(envelope[3]));
            if (isRunning && envelope[1] === 'running') statusText.textContent = 'Running';
            if (isRunning && envelope[2] !== undefined) {
              showExited({ exit_code: Number(envelope[2]) });
            }
          }
          fullOutput = output;
          if (clearedOutput !== output) {
            clearedOutput = null;
            const scrollTop = terminalEl.scrollTop;
            terminalEl.textContent = output === '(no output yet)' ? '' : output;
            if (!autoScroll) terminalEl.scrollTop = scrollTop;
            notice.textContent = output === '(no output yet)' ? 'Task has not written output yet' : (isRunning ? 'Output updates every second' : 'Task finished');
          }
          if (autoScroll) {
            terminalEl.scrollTop = terminalEl.scrollHeight;
          }
        }
        if (msg.command && cmdText) {
          cmdText.textContent = msg.command;
          cmdText.title = msg.command;
          document.getElementById('command-preview').textContent = msg.command.slice(0, 90);
        }
      } else if (msg.type === 'task_error') {
        notice.textContent = msg.message;
        if (msg.stop_failed && isRunning) { btnStop.disabled = false; btnStop.textContent = 'Stop task'; }
      } else if (msg.type === 'process_exited') {
        showExited(msg);
      }
    });

    function showExited(msg) {
        isRunning = false;
        clearInterval(timerInterval);
        const code = msg.exit_code !== undefined ? msg.exit_code : 0;
        statusBadge.className = 'status-badge ' + (code === 0 ? 'done' : 'stopped');
        statusText.textContent = msg.was_killed ? 'Stopped' : (code === 0 ? 'Completed' : 'Failed');
        btnStop.disabled = true;
        btnStop.remove();

        exitSummary.textContent = 'Exit code ' + code;
        notice.textContent = msg.was_killed ? 'Task stopped' : 'Task finished';
        if (msg.duration !== undefined) timerText.textContent = formatSecs(Math.floor(msg.duration));
        if (autoScroll) {
          terminalEl.scrollTop = terminalEl.scrollHeight;
        }
    }

    syncFollow();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
