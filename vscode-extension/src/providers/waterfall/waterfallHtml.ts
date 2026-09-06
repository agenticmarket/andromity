import * as vscode from "vscode";
import { getWaterfallStyles } from "./waterfallStyles.js";
import { getWaterfallScript } from "./waterfallScript.js";

export function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getWaterfallHtml(
  webview: vscode.Webview,
  sessionId: string,
  sessionName: string,
  extensionUri?: vscode.Uri
): string {
  const nonce = getNonce();
  const styles = getWaterfallStyles();
  const script = getWaterfallScript(sessionId);
  const markedScriptUri = extensionUri
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "marked.min.js"))
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} https://fonts.gstatic.com data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Waterfall — ${sessionName}</title>
  <style>
    ${styles}
  </style>
</head>
<body>
  <!-- Header Bar -->
  <header class="wf-header">
    <div class="wf-header-row1">
      <div class="wf-title-area">
        <span class="wf-logo">🌊 Waterfall Trace</span>
        <span class="wf-session-pill" title="${sessionName}">${sessionName}</span>
        <div class="wf-live-status">
          <span class="wf-live-dot" id="wf-live-dot"></span>
          <span id="wf-live-text">IDLE</span>
        </div>
      </div>
      <div class="wf-actions">
        <button class="wf-btn" id="btn-guide" title="Developer Guide & Metrics Glossary">? Guide</button>
        <button class="wf-btn active" id="btn-autoscroll" title="Toggle Auto Scroll">Auto-scroll</button>
        <button class="wf-btn" id="btn-clear" title="Clear Trace History">Clear</button>
        <button class="wf-btn" id="btn-export" title="Export Full Execution Trace as JSON">Export JSON</button>
      </div>
    </div>

    <!-- Summary Metrics -->
    <div class="wf-metrics-row">
      <div class="wf-metric" title="Total wall-clock duration of the session">
        <span class="wf-metric-label">Duration</span>
        <span class="wf-metric-value accent" id="wf-total-duration">0.00s</span>
      </div>
      <div class="wf-metric" title="Total wall time the AI model was generating tokens (network latency + prefill + inference streaming)">
        <span class="wf-metric-label">LLM Latency</span>
        <span class="wf-metric-value purple" id="wf-total-llm">0.00s</span>
      </div>
      <div class="wf-metric" title="Total execution time spent running local tools (filesystem, shell, search)">
        <span class="wf-metric-label">Tool Runtime</span>
        <span class="wf-metric-value green" id="wf-total-tools">0.00s</span>
      </div>
      <div class="wf-metric" title="Total context tokens processed across all model inferences (Prompt/Input + Completion/Output)">
        <span class="wf-metric-label">Tokens</span>
        <span class="wf-metric-value" id="wf-total-tokens">0</span>
      </div>
    </div>

    <!-- Controls, Tabs & Filters -->
    <div class="wf-controls">
      <div class="wf-tabs">
        <button class="wf-tab active" data-tab="timeline">Timeline</button>
        <button class="wf-tab" data-tab="log">Stream Log</button>
        <button class="wf-tab" data-tab="stats">Stats & Profiling</button>
      </div>
      <div class="wf-filters">
        <button class="wf-filter-pill active" data-filter="all">All</button>
        <button class="wf-filter-pill" data-filter="llm">LLM</button>
        <button class="wf-filter-pill" data-filter="tool">Tools</button>
        <button class="wf-filter-pill" data-filter="subagent">Subagents</button>
        <button class="wf-filter-pill" data-filter="error">Errors</button>
        <input type="text" class="wf-search-input" id="wf-search" placeholder="Filter spans...">
      </div>
    </div>
  </header>

  <!-- Views -->
  <main class="wf-view-container" id="wf-view-container">
    <!-- Timeline Waterfall View -->
    <div class="wf-timeline-view" id="wf-timeline-container">
      <div class="wf-empty-state" id="wf-empty-state">
        <div class="wf-empty-icon">⚡</div>
        <p>No agent events recorded for this session yet.</p>
        <p style="font-size: 11px;">Send a prompt in the chat or invoke an agent action to see real-time waterfall timing tracks.</p>
      </div>
    </div>

    <!-- Stream Log View -->
    <div class="wf-log-view" id="wf-log-container"></div>

    <!-- Stats & Profiler View -->
    <div class="wf-stats-view" id="wf-stats-container"></div>
  </main>

  <!-- Developer Guide & Help Modal -->
  <div class="wf-modal-backdrop" id="wf-guide-modal" style="display: none;">
    <div class="wf-modal-card">
      <div class="wf-modal-header">
        <div class="wf-modal-title">🌊 Waterfall Trace — Developer Guide & Glossary</div>
        <button class="wf-modal-close" id="wf-guide-close" title="Close Guide (Esc)">&times;</button>
      </div>
      <div class="wf-modal-body">
        <div>
          <div class="wf-guide-section-title">Execution Layers & Colors</div>
          <div class="wf-guide-grid">
            <div class="wf-guide-item">
              <strong style="color: var(--purple);">🟣 LLM Call (Purple)</strong>
              <p>Model reasoning & token generation. The light purple bar segment highlights <strong>TTFB</strong> (prompt processing delay before first token).</p>
            </div>
            <div class="wf-guide-item">
              <strong style="color: var(--cyan);">🟢 Tool Execution (Cyan / Green)</strong>
              <p>Local commands run by the agent (file edits, read_file, shell_exec, git operations, searches).</p>
            </div>
            <div class="wf-guide-item">
              <strong style="color: var(--amber);">🟡 Subagent (Amber / Blue)</strong>
              <p>Autonomous delegated child agent. Click to expand and inspect its inner tool waterfall and final result.</p>
            </div>
            <div class="wf-guide-item">
              <strong style="color: var(--red);">🔴 Error / Blocked (Red)</strong>
              <p>Failed tool executions, permission denials, or model timeouts.</p>
            </div>
          </div>
        </div>

        <div>
          <div class="wf-guide-section-title">Latency & Timing Metrics</div>
          <div class="wf-guide-grid">
            <div class="wf-guide-item">
              <strong>TTFB (Time To First Byte)</strong>
              <p>Network latency + prompt prefill time before the LLM emitted its very first token.</p>
            </div>
            <div class="wf-guide-item">
              <strong>LLM Latency</strong>
              <p>Total time spent waiting on model inference across turns.</p>
            </div>
            <div class="wf-guide-item">
              <strong>Tool Runtime</strong>
              <p>Total time spent executing local system tools and processes.</p>
            </div>
            <div class="wf-guide-item">
              <strong>Speed (tok/s)</strong>
              <p>Output generation throughput = <code>Completion Tokens / Duration</code>.</p>
            </div>
          </div>
        </div>

        <div>
          <div class="wf-guide-section-title">Token Accounting: P / C</div>
          <div class="wf-guide-grid">
            <div class="wf-guide-item">
              <strong>P: Prompt Tokens</strong>
              <p>Context sent to the model (system prompt, conversation history, active workspace context, tool outputs).</p>
            </div>
            <div class="wf-guide-item">
              <strong>C: Completion Tokens</strong>
              <p>Tokens produced by the model (chain-of-thought reasoning, tool arguments, final prose responses).</p>
            </div>
          </div>
        </div>

        <div>
          <div class="wf-guide-section-title">Observability Features</div>
          <div class="wf-guide-grid">
            <div class="wf-guide-item">
              <strong>Subagent Drill-Down</strong>
              <p>Expand any Subagent row to see its internal tool execution sequence, individual step timings, arguments, and full summary.</p>
            </div>
            <div class="wf-guide-item">
              <strong>Export Trace JSON</strong>
              <p>Download complete raw execution timelines, spans, tokens, and logs for benchmarking or debugging.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  ${markedScriptUri ? `<script nonce="${nonce}" src="${markedScriptUri}"></script>` : ""}
  <script nonce="${nonce}">
    ${script}
  </script>
</body>
</html>`;
}
