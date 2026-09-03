import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";

export class PlanViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "andromity.planView";
  private _view?: vscode.WebviewView;
  private _rpcClient: RpcClient | null = null;
  private _currentPlan: any = null;
  private _planActionHandler: ((approved: boolean, feedback: string) => void) | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public setRpcClient(client: RpcClient) {
    this._rpcClient = client;
    this._rpcClient.on("agent/planApproval", (params: any) => {
      if (params.plan) {
        this.updatePlan(params.plan);
        this._reveal();
      }
    });
    this._rpcClient.on("agent/planUpdated", (params: any) => {
      if (params.plan) {
        this.updatePlan(params.plan);
      }
    });
  }

  /** Called by extension.ts — routes approve/reject through the chat queue. */
  public setPlanActionHandler(handler: (approved: boolean, feedback: string) => void) {
    this._planActionHandler = handler;
  }

  private _reveal() {
    vscode.commands.executeCommand("andromity.planView.focus");
  }

  public updatePlan(plan: any) {
    this._currentPlan = plan;
    if (this._view) {
      this._view.webview.postMessage({ type: "plan_updated", plan });
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "webview_ready":
          if (this._currentPlan) {
            this.updatePlan(this._currentPlan);
          } else {
            const loaded = await this._loadPlanFromDisk();
            if (loaded) {
              this.updatePlan(loaded);
            }
          }
          break;
        case "approve_plan":
          this._planActionHandler?.(true, message.feedback || "");
          break;
        case "reject_plan":
          this._planActionHandler?.(false, message.feedback || "");
          break;
      }
    });

    if (this._currentPlan) {
      this.updatePlan(this._currentPlan);
    } else {
      this._loadPlanFromDisk().then(p => { if (p) this.updatePlan(p); });
    }
  }

  private async _loadPlanFromDisk(): Promise<any | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const rootUri = folders[0].uri;

    // 1. Try .andromity/plan.json
    try {
      const jsonUri = vscode.Uri.joinPath(rootUri, ".andromity", "plan.json");
      const bytes = await vscode.workspace.fs.readFile(jsonUri);
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text);
      if (parsed) {
        if (!parsed.steps || parsed.steps.length === 0) {
          try {
            const todosUri = vscode.Uri.joinPath(rootUri, ".andromity", "todos.md");
            const mdBytes = await vscode.workspace.fs.readFile(todosUri);
            const mdText = new TextDecoder().decode(mdBytes);
            const lines = mdText.split("\n");
            const steps: any[] = [];
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
            if (steps.length > 0) {
              parsed.steps = steps;
              parsed.todos = steps;
            }
          } catch {}
        }
        return parsed;
      }
    } catch {}

    // 2. Try .andromity/PLAN.md
    try {
      const mdUri = vscode.Uri.joinPath(rootUri, ".andromity", "PLAN.md");
      const bytes = await vscode.workspace.fs.readFile(mdUri);
      const text = new TextDecoder().decode(bytes);
      if (text) {
        return {
          title: "Implementation Plan",
          body: text,
          status: "approved"
        };
      }
    } catch {}

    return null;
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const embeddedPlanJson = JSON.stringify(this._currentPlan || null);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} https://fonts.gstatic.com data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Plan Tracker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,300..700&family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,300..700&family=JetBrains+Mono:ital,wght@0,400..700;1,400..700&display=swap');

    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-foreground);
      --border: var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
      --card-bg: var(--vscode-editor-background);
      --accent: #06b6d4;
      --done-fg: #10b981;
      --active-fg: #38bdf8;
      --failed-fg: #ef4444;
      --pending-fg: #94a3b8;
      --font-ui: 'Inter', 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      --font-mono: 'JetBrains Mono', 'Geist Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, 'Courier New', monospace;
    }
    body {
      font-family: var(--font-ui);
      font-feature-settings: "cv02", "cv03", "cv04", "cv11", "ss01", "ss02";
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
      letter-spacing: -0.011em;
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      margin: 0;
      padding: 12px;
      line-height: 1.5;
    }
    .plan-header {
      font-weight: 600;
      font-size: 13.5px;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--accent);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 8px;
      border-radius: 10px;
      margin-bottom: 12px;
    }
    .status-pending { background: rgba(148, 163, 184, 0.15); color: var(--pending-fg); border: 1px solid rgba(148, 163, 184, 0.3); }
    .status-approved { background: rgba(16, 185, 129, 0.15); color: var(--done-fg); border: 1px solid rgba(16, 185, 129, 0.3); }
    .status-rejected { background: rgba(239, 68, 68, 0.15); color: var(--failed-fg); border: 1px solid rgba(239, 68, 68, 0.3); }
    .empty-state {
      padding: 28px 12px;
      text-align: center;
      color: var(--pending-fg);
      font-size: 12px;
      line-height: 1.6;
    }

    /* Steps Tracker */
    .steps-section {
      margin: 10px 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card-bg);
      overflow: hidden;
    }
    .steps-header {
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--pending-fg);
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
    }
    .steps-list {
      list-style: none;
      margin: 0;
      padding: 6px 0;
    }
    .step-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 6px 12px;
      font-size: 12px;
      transition: background 0.1s;
    }
    .step-item:hover {
      background: rgba(255, 255, 255, 0.03);
    }
    .step-icon {
      flex-shrink: 0;
      margin-top: 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
    }
    .step-text {
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }
    .step-item.step-done .step-text {
      color: var(--pending-fg);
      text-decoration: line-through;
      opacity: 0.8;
    }
    .step-item.step-active {
      background: rgba(6, 182, 212, 0.08);
      font-weight: 500;
      color: var(--active-fg);
    }
    .step-item.step-failed .step-text {
      color: var(--failed-fg);
    }

    .plan-md {
      margin-top: 10px;
      padding: 12px;
      background: var(--card-bg);
      border-radius: 8px;
      border: 1px solid var(--border);
      font-size: 11.5px;
      white-space: pre-wrap;
      max-height: 280px;
      overflow-y: auto;
      line-height: 1.5;
    }
    .plan-questions {
      margin: 8px 0;
      padding-left: 16px;
      font-size: 11.5px;
      color: var(--pending-fg);
    }
    .approval-box {
      margin-top: 12px;
      padding: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      background: var(--card-bg);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    }
    .approval-box input {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15));
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 11.5px;
      margin-bottom: 10px;
      outline: none;
    }
    .approval-box input:focus {
      border-color: var(--accent);
    }
    .approval-buttons {
      display: flex;
      gap: 8px;
    }
    .btn-approve, .btn-reject {
      flex: 1;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 7px 0;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .btn-approve {
      background: #059669;
      color: #fff;
    }
    .btn-approve:hover {
      background: #10b981;
      box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35);
    }
    .btn-reject {
      background: rgba(255, 255, 255, 0.06);
      color: var(--fg);
      border-color: var(--border);
    }
    .btn-reject:hover {
      background: rgba(239, 68, 68, 0.15);
      color: var(--failed-fg);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .plan-decided {
      margin-top: 10px;
      font-size: 11.5px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="empty-state">No active plan in this session.<br>Plans generated with <code>write_plan</code> will display live progress here.</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    window.embeddedPlan = ${embeddedPlanJson};

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'plan_updated' && msg.plan) {
        renderPlan(msg.plan);
      }
    });

    if (window.embeddedPlan) {
      renderPlan(window.embeddedPlan);
    }
    vscode.postMessage({ type: 'webview_ready' });

    function renderPlan(plan) {
      if (!plan || !plan.title) {
        app.innerHTML = '<div class="empty-state">No active plan in this session.<br>Plans generated with <code>write_plan</code> will display live progress here.</div>';
        return;
      }

      const status = (plan.status || 'pending').toLowerCase();
      var questionsHtml = '';
      if (plan.questions && plan.questions.length > 0) {
        questionsHtml = '<div style="margin-top:10px; font-weight:600; font-size:11px; color:var(--pending-fg);">OPEN QUESTIONS</div><ul class="plan-questions">' +
          plan.questions.map(function(q) { return '<li>' + escapeHtml(q) + '</li>'; }).join('') +
          '</ul>';
      }

      var stepsHtml = '';
      var steps = plan.steps || [];
      if (steps && steps.length > 0) {
        var completedCount = steps.filter(function(s) { return s.status === 'done'; }).length;
        stepsHtml = '<div class="steps-section">' +
          '<div class="steps-header">' +
            '<span>Checklist</span>' +
            '<span>' + completedCount + '/' + steps.length + ' done</span>' +
          '</div>' +
          '<ul class="steps-list">' +
          steps.map(function(step) {
            var st = (step.status || 'pending').toLowerCase();
            var iconHtml = '○';
            var stepClass = 'step-' + st;
            if (st === 'done') {
              iconHtml = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            } else if (st === 'active' || st === 'in_progress') {
              iconHtml = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.5"><circle cx="12" cy="12" r="9" stroke-dasharray="32" stroke-dashoffset="16"></circle></svg>';
            } else if (st === 'failed') {
              iconHtml = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            } else {
              iconHtml = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><circle cx="12" cy="12" r="8"></circle></svg>';
            }
            var text = step.title || step.text || String(step);
            return '<li class="step-item ' + stepClass + '">' +
              '<span class="step-icon">' + iconHtml + '</span>' +
              '<span class="step-text">' + escapeHtml(text) + '</span>' +
            '</li>';
          }).join('') +
          '</ul>' +
        '</div>';
      }

      var mdHtml = '';
      var bodyContent = plan.body || plan.plan_md || plan.description || '';
      if (bodyContent) {
        mdHtml = '<div class="plan-md">' + renderMarkdown(bodyContent) + '</div>';
      }

      var approvalHtml = '';
      if (status === 'pending') {
        approvalHtml = '<div class="approval-box">' +
          '<input type="text" id="plan-feedback" placeholder="Optional notes/feedback for the agent…" />' +
          '<div class="approval-buttons">' +
            '<button class="btn-approve" data-action="decide-plan" data-approved="true">✓ Approve Plan</button>' +
            '<button class="btn-reject" data-action="decide-plan" data-approved="false">✕ Reject</button>' +
          '</div>' +
        '</div>';
      } else if (status === 'approved') {
        approvalHtml = '<div class="plan-decided" style="color:var(--done-fg);">✓ Plan approved — agent is executing steps.</div>';
      } else {
        approvalHtml = '<div class="plan-decided" style="color:var(--failed-fg);">✕ Plan rejected — waiting for revision.</div>';
      }

      var html = '<div class="plan-header">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>' +
        '<span>' + escapeHtml(plan.title) + '</span>' +
      '</div>' +
      '<span class="status-badge status-' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
      stepsHtml +
      mdHtml +
      questionsHtml +
      approvalHtml;

      app.innerHTML = html;
    }

    function renderInline(str) {
      if (!str) return '';
      var parts = str.split(String.fromCharCode(96));
      var out = '';
      for (var i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          out += '<code>' + escapeHtml(parts[i]) + '</code>';
        } else {
          var t = escapeHtml(parts[i]);
          t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
          t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
          t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
          t = t.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
          t = t.replace(/_([^_]+)_/g, '<em>$1</em>');
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
        var nl = String.fromCharCode(10);
        if (i % 2 === 1) {
          var lines = codeParts[i].split(nl);
          var code = lines.slice(1).join(nl);
          html += '<pre style="background:rgba(0,0,0,0.3); padding:8px 10px; border-radius:4px; border:1px solid var(--border); overflow-x:auto; margin:6px 0;"><code style="background:transparent; padding:0; color:#e4e4e7; font-family:var(--vscode-editor-font-family, monospace); font-size:11px;">' + escapeHtml(code.trim()) + '</code></pre>';
        } else {
          var rawLines = codeParts[i].split(nl);
          for (var l = 0; l < rawLines.length; l++) {
            var line = rawLines[l];
            var trimmed = line.trim();

            if (!trimmed) {
              html += '<div style="height:6px;"></div>';
              continue;
            }

            if (/^(?:---|\\*\\*\\*|___)\\s*$/.test(trimmed)) {
              html += '<hr style="border:none; border-top:1px solid var(--border); margin:8px 0;">';
              continue;
            }

            if (/^####\\s+/.test(trimmed)) {
              html += '<h4 style="font-size:11px; font-weight:600; color:var(--pending-fg); text-transform:uppercase; margin:8px 0 2px;">' + renderInline(trimmed.replace(/^####\\s+/, '')) + '</h4>';
            } else if (/^###\\s+/.test(trimmed)) {
              html += '<h3 style="font-size:12px; font-weight:600; margin:10px 0 4px; color:var(--fg);">' + renderInline(trimmed.replace(/^###\\s+/, '')) + '</h3>';
            } else if (/^##\\s+/.test(trimmed)) {
              html += '<h2 style="font-size:13px; font-weight:600; margin:12px 0 4px; border-bottom:1px solid var(--border); padding-bottom:2px; color:var(--fg);">' + renderInline(trimmed.replace(/^##\\s+/, '')) + '</h2>';
            } else if (/^#\\s+/.test(trimmed)) {
              html += '<h1 style="font-size:14px; font-weight:700; margin:14px 0 6px; border-bottom:1px solid var(--border); padding-bottom:4px; color:var(--fg);">' + renderInline(trimmed.replace(/^#\\s+/, '')) + '</h1>';
            } else if (/^[-*•]\\s+/.test(trimmed)) {
              var itemText = trimmed.replace(/^[-*•]\\s+/, '');
              html += '<div style="display:flex; align-items:flex-start; gap:6px; margin:2px 0 2px 4px;"><span style="color:var(--accent); font-size:12px; line-height:1.2;">•</span><span style="flex:1;">' + renderInline(itemText) + '</span></div>';
            } else if (/^\\d+\\.\\s+/.test(trimmed)) {
              var numMatch = trimmed.match(/^(\\d+)\\.\\s+(.*)$/);
              var num = numMatch ? numMatch[1] : '1';
              var numText = numMatch ? numMatch[2] : trimmed;
              html += '<div style="display:flex; align-items:flex-start; gap:6px; margin:2px 0 2px 4px;"><span style="color:var(--accent); font-weight:600; min-width:12px;">' + num + '.</span><span style="flex:1;">' + renderInline(numText) + '</span></div>';
            } else if (/^>\\s+/.test(trimmed)) {
              var quoteText = trimmed.replace(/^>\\s+/, '');
              html += '<div style="border-left:2px solid var(--accent); padding:4px 8px; margin:6px 0; background:rgba(6,182,212,0.06); border-radius:0 4px 4px 0; color:var(--pending-fg);">' + renderInline(quoteText) + '</div>';
            } else {
              html += '<div style="margin:2px 0; line-height:1.5;">' + renderInline(line) + '</div>';
            }
          }
        }
      }
      return html;
    }

    window.decidePlan = function(approved) {
      const inp = document.getElementById('plan-feedback');
      vscode.postMessage({
        type: approved ? 'approve_plan' : 'reject_plan',
        feedback: inp ? inp.value.trim() : ''
      });
    };

    document.addEventListener('click', function(e) {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      if (action === 'decide-plan') {
        decidePlan(target.getAttribute('data-approved') === 'true');
      }
    });

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
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
