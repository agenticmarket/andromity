import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";

export class PlanEditorPanel {
  public static currentPanel: PlanEditorPanel | undefined;
  public static readonly viewType = "andromity.planEditorPanel";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _rpcClient: RpcClient | null = null;
  private _currentPlan: any = null;
  private _onPlanActionHandler?: (approved: boolean, feedback: string) => void;

  public static createOrShow(
    extensionUri: vscode.Uri,
    plan: any,
    rpcClient: RpcClient | null,
    onPlanAction?: (approved: boolean, feedback: string) => void
  ): PlanEditorPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (PlanEditorPanel.currentPanel) {
      PlanEditorPanel.currentPanel._panel.reveal(column);
      PlanEditorPanel.currentPanel._rpcClient = rpcClient;
      PlanEditorPanel.currentPanel._onPlanActionHandler = onPlanAction;
      if (plan) {
        PlanEditorPanel.currentPanel.updatePlan(plan);
      }
      return PlanEditorPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      PlanEditorPanel.viewType,
      "Implementation Plan",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");

    PlanEditorPanel.currentPanel = new PlanEditorPanel(
      panel,
      extensionUri,
      plan,
      rpcClient,
      onPlanAction
    );

    return PlanEditorPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    plan: any,
    rpcClient: RpcClient | null,
    onPlanAction?: (approved: boolean, feedback: string) => void
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._rpcClient = rpcClient;
    this._currentPlan = plan;
    this._onPlanActionHandler = onPlanAction;

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
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
          case "proceed_plan":
          case "approve_plan":
            this._handleApproval(true, message.feedback || "");
            break;
          case "reject_plan":
            this._handleApproval(false, message.feedback || "");
            break;
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public setRpcClient(client: RpcClient | null) {
    this._rpcClient = client;
  }

  public setPlanActionHandler(handler: (approved: boolean, feedback: string) => void) {
    this._onPlanActionHandler = handler;
  }

  public updatePlan(plan: any) {
    this._currentPlan = plan;
    if (this._panel) {
      this._panel.webview.postMessage({ type: "plan_updated", plan });
    }
  }

  private async _handleApproval(approved: boolean, feedback: string) {
    if (this._onPlanActionHandler) {
      this._onPlanActionHandler(approved, feedback);
    }
    if (this._panel && this._currentPlan) {
      this._currentPlan.status = approved ? "approved" : "rejected";
      this._panel.webview.postMessage({
        type: "plan_updated",
        plan: this._currentPlan,
      });
    }
  }

  public dispose() {
    PlanEditorPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
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
        try {
          const todoUri = vscode.Uri.joinPath(rootUri, ".andromity", "todo.json");
          const todoBytes = await vscode.workspace.fs.readFile(todoUri);
          const todoParsed = JSON.parse(new TextDecoder().decode(todoBytes));
          if (todoParsed && Array.isArray(todoParsed.items)) {
            parsed.steps = todoParsed.items;
          }
        } catch {}
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
    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "marked.min.js"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Implementation Plan</title>
  <script nonce="${nonce}" src="${markedUri}"></script>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background, rgba(255, 255, 255, 0.03));
      --border: var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
      --accent: #06b6d4;
      --accent-blue: #0284c7;
      --blue-hover: #0369a1;
      --done-fg: #10b981;
      --active-fg: #38bdf8;
      --failed-fg: #ef4444;
      --pending-fg: #94a3b8;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      margin: 0;
      padding: 0;
      line-height: 1.6;
    }

    /* Antigravity-Style Top Action Bar */
    .top-action-bar {
      position: sticky;
      top: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 20px;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(8px);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .doc-icon {
      width: 18px;
      height: 18px;
      color: var(--accent);
    }
    .plan-title-text {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.2px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 8px;
      border-radius: 12px;
    }
    .status-pending { background: rgba(148, 163, 184, 0.15); color: var(--pending-fg); border: 1px solid rgba(148, 163, 184, 0.3); }
    .status-approved { background: rgba(16, 185, 129, 0.15); color: var(--done-fg); border: 1px solid rgba(16, 185, 129, 0.3); }
    .status-rejected { background: rgba(239, 68, 68, 0.15); color: var(--failed-fg); border: 1px solid rgba(239, 68, 68, 0.3); }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn-review-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.05);
      color: var(--fg);
      cursor: pointer;
      transition: background 0.12s;
    }
    .btn-review-toggle:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .btn-proceed {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 4px;
      border: none;
      background: var(--accent-blue);
      color: #ffffff;
      cursor: pointer;
      transition: background 0.15s;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }
    .btn-proceed:hover {
      background: var(--blue-hover);
    }
    .btn-proceed:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Feedback Drawer */
    .feedback-drawer {
      padding: 12px 20px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border);
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .feedback-drawer.open {
      display: flex;
    }
    .feedback-input {
      width: 100%;
      padding: 7px 10px;
      background: var(--vscode-input-background, rgba(0,0,0,0.2));
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 12px;
      outline: none;
    }
    .feedback-input:focus {
      border-color: var(--accent);
    }
    .feedback-buttons {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .btn-reject {
      padding: 4px 12px;
      font-size: 11.5px;
      font-weight: 500;
      border-radius: 4px;
      border: 1px solid rgba(239, 68, 68, 0.35);
      background: rgba(239, 68, 68, 0.1);
      color: var(--failed-fg);
      cursor: pointer;
    }
    .btn-reject:hover {
      background: rgba(239, 68, 68, 0.2);
    }

    /* Plan Content */
    .plan-body-container {
      max-width: 900px;
      margin: 0 auto;
      padding: 24px 28px 60px;
    }

    .plan-desc {
      font-size: 13.5px;
      color: var(--fg);
      margin-bottom: 20px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }

    /* Step Checklist */
    .steps-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 20px 0;
      overflow: hidden;
    }
    .steps-card-header {
      padding: 10px 16px;
      font-size: 11.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--pending-fg);
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
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
      gap: 12px;
      padding: 8px 16px;
      font-size: 12.5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);
      transition: background 0.1s;
    }
    .step-item:last-child {
      border-bottom: none;
    }
    .step-item:hover {
      background: rgba(255, 255, 255, 0.02);
    }
    .step-item.step-done {
      color: var(--pending-fg);
    }
    .step-item.step-done .step-text {
      text-decoration: line-through;
      opacity: 0.75;
    }
    .step-item.step-active {
      background: rgba(6, 182, 212, 0.06);
      color: var(--active-fg);
      font-weight: 500;
    }
    .step-icon-wrap {
      margin-top: 2px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
    }

    /* Open Questions */
    .questions-box {
      margin: 20px 0;
      padding: 14px 18px;
      background: rgba(234, 179, 8, 0.06);
      border: 1px solid rgba(234, 179, 8, 0.25);
      border-radius: 8px;
    }
    .questions-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #eab308;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .questions-list {
      margin: 0;
      padding-left: 18px;
      font-size: 12.5px;
      color: var(--fg);
    }
    .questions-list li {
      margin-bottom: 4px;
    }

    /* Markdown Text */
    .plan-markdown {
      margin-top: 24px;
      font-size: 13px;
      line-height: 1.7;
    }
    .plan-markdown h1, .plan-markdown h2, .plan-markdown h3 {
      color: var(--fg);
      margin-top: 20px;
      margin-bottom: 8px;
      font-weight: 600;
    }
    .plan-markdown h2 { font-size: 15px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
    .plan-markdown h3 { font-size: 13.5px; }
    .plan-markdown code {
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
    }
    .plan-markdown pre {
      background: rgba(0, 0, 0, 0.25);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      border: 1px solid var(--border);
    }
    .empty-state {
      padding: 60px 20px;
      text-align: center;
      color: var(--pending-fg);
    }
  </style>
</head>
<body>
  <!-- Top Action Bar -->
  <div class="top-action-bar">
    <div class="header-left">
      <svg class="doc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
      </svg>
      <span class="plan-title-text" id="header-plan-title">Implementation Plan</span>
      <span class="status-badge status-pending" id="header-plan-badge">Pending Review</span>
    </div>
    <div class="header-actions">
      <button class="btn-review-toggle" id="btn-toggle-review" title="Provide notes or feedback">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        <span>Review / Notes</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <button class="btn-proceed" id="btn-proceed-plan" title="Approve plan and begin execution">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
        <span>Proceed</span>
      </button>
    </div>
  </div>

  <!-- Collapsible Feedback Drawer -->
  <div class="feedback-drawer" id="feedback-drawer">
    <input type="text" class="feedback-input" id="feedback-input" placeholder="Enter notes or revision instructions for the agent..." />
    <div class="feedback-buttons">
      <button class="btn-reject" id="btn-reject-plan">Reject & Revise</button>
      <button class="btn-proceed" id="btn-proceed-with-notes">Proceed with Notes</button>
    </div>
  </div>

  <!-- Plan Content Container -->
  <div class="plan-body-container" id="plan-content">
    <div class="empty-state">
      <p>No active plan in this session.</p>
      <p style="font-size:12px;">When the agent designs an implementation plan, it will be displayed here for interactive review and approval.</p>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const titleEl = document.getElementById('header-plan-title');
    const badgeEl = document.getElementById('header-plan-badge');
    const contentEl = document.getElementById('plan-content');
    const drawerEl = document.getElementById('feedback-drawer');
    const feedbackInput = document.getElementById('feedback-input');
    const btnToggleReview = document.getElementById('btn-toggle-review');
    const btnProceed = document.getElementById('btn-proceed-plan');
    const btnProceedWithNotes = document.getElementById('btn-proceed-with-notes');
    const btnReject = document.getElementById('btn-reject-plan');

    btnToggleReview.addEventListener('click', () => {
      drawerEl.classList.toggle('open');
      if (drawerEl.classList.contains('open')) {
        feedbackInput.focus();
      }
    });

    btnProceed.addEventListener('click', () => {
      vscode.postMessage({ type: 'proceed_plan', feedback: '' });
      badgeEl.className = 'status-badge status-approved';
      badgeEl.textContent = 'Approved — Executing';
      btnProceed.disabled = true;
    });

    btnProceedWithNotes.addEventListener('click', () => {
      const text = feedbackInput.value.trim();
      vscode.postMessage({ type: 'proceed_plan', feedback: text });
      badgeEl.className = 'status-badge status-approved';
      badgeEl.textContent = 'Approved — Executing';
      drawerEl.classList.remove('open');
      btnProceed.disabled = true;
    });

    btnReject.addEventListener('click', () => {
      const text = feedbackInput.value.trim();
      vscode.postMessage({ type: 'reject_plan', feedback: text });
      badgeEl.className = 'status-badge status-rejected';
      badgeEl.textContent = 'Rejected';
      drawerEl.classList.remove('open');
      btnProceed.disabled = true;
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'plan_updated' && msg.plan) {
        renderPlan(msg.plan);
      }
    });

    function escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderPlan(plan) {
      if (!plan) return;
      titleEl.textContent = plan.title || 'Implementation Plan';

      const status = (plan.status || 'pending').toLowerCase();
      if (status === 'approved' || status === 'executing' || status === 'completed') {
        badgeEl.className = 'status-badge status-approved';
        badgeEl.textContent = status === 'completed' ? 'Completed' : (status === 'executing' ? 'Executing' : 'Approved');
        btnProceed.disabled = (status === 'completed');
      } else if (status === 'rejected') {
        badgeEl.className = 'status-badge status-rejected';
        badgeEl.textContent = 'Rejected';
      } else {
        badgeEl.className = 'status-badge status-pending';
        badgeEl.textContent = 'Pending Review';
        btnProceed.disabled = false;
      }

      let html = '';
      if (plan.description) {
        html += '<div class="plan-desc">' + escapeHtml(plan.description) + '</div>';
      }

      // Steps/Todos Checklist
      const steps = plan.steps || plan.todos || [];
      if (steps.length > 0) {
        let completedCount = 0;
        const stepsItemsHtml = steps.map((s, idx) => {
          const sText = typeof s === 'string' ? s : (s.title || s.description || ('Step ' + (idx + 1)));
          const sStatus = (s.status || 'pending').toLowerCase();
          let iconSvg = '';
          let itemClass = 'step-item';

          if (sStatus === 'done' || sStatus === 'completed') {
            completedCount++;
            itemClass += ' step-done';
            iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
          } else if (sStatus === 'active' || sStatus === 'in_progress' || sStatus === 'running') {
            itemClass += ' step-active';
            iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
          } else if (sStatus === 'failed') {
            itemClass += ' step-failed';
            iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
          } else {
            iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect></svg>';
          }

          return '<li class="' + itemClass + '">' +
            '<div class="step-icon-wrap">' + iconSvg + '</div>' +
            '<div class="step-text">' + escapeHtml(sText) + '</div>' +
          '</li>';
        }).join('');

        html += '<div class="steps-card">' +
          '<div class="steps-card-header">' +
            '<span>Task Checklist (' + completedCount + '/' + steps.length + ' completed)</span>' +
          '</div>' +
          '<ul class="steps-list">' + stepsItemsHtml + '</ul>' +
        '</div>';
      }

      // Open Questions
      if (plan.questions && plan.questions.length > 0) {
        html += '<div class="questions-box">' +
          '<div class="questions-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' +
            '<span>Open Questions</span>' +
          '</div>' +
          '<ul class="questions-list">' +
            plan.questions.map(q => '<li>' + escapeHtml(q) + '</li>').join('') +
          '</ul>' +
        '</div>';
      }

      // Markdown / Plan body
      const mdContent = plan.body || plan.plan_md || plan.markdown || '';
      if (mdContent) {
        html += '<div class="plan-markdown">' + renderMarkdown(mdContent) + '</div>';
      }

      contentEl.innerHTML = html;
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
          t = t.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img class="md-image" src="$2" alt="$1" title="$1" loading="lazy" style="max-width:100%; border-radius:6px; margin:8px 0;" />');
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

    try {
      if (typeof marked !== 'undefined') {
        const markedRenderer = {
          code(token) {
            const text = token && typeof token === 'object' ? (token.text || '') : String(token || '');
            return '<pre style="background:rgba(0,0,0,0.3); padding:12px; border-radius:6px; border:1px solid var(--border); overflow-x:auto; margin:10px 0;"><code style="background:transparent; padding:0; color:#e4e4e7; font-family:var(--vscode-editor-font-family, monospace); font-size:12px;">' + escapeHtml(text) + '</code></pre>';
          },
          table(token) {
            let headerHtml = '';
            let bodyHtml = '';
            const self = this;
            if (token && token.header) {
              headerHtml = '<thead><tr>' + token.header.map(cell => {
                const align = cell.align ? ' style="text-align:' + cell.align + ';"' : '';
                const content = cell.tokens && self.parser ? self.parser.parseInline(cell.tokens) : (cell.text || '');
                return '<th style="padding:8px 12px; background:rgba(255,255,255,0.06); border-bottom:1px solid var(--border); font-weight:600;' + (cell.align ? ' text-align:' + cell.align + ';' : '') + '">' + content + '</th>';
              }).join('') + '</tr></thead>';
            }
            if (token && token.rows) {
              bodyHtml = '<tbody>' + token.rows.map(row => {
                return '<tr>' + row.map(cell => {
                  const content = cell.tokens && self.parser ? self.parser.parseInline(cell.tokens) : (cell.text || '');
                  return '<td style="padding:6px 12px; border-bottom:1px solid rgba(255,255,255,0.04);' + (cell.align ? ' text-align:' + cell.align + ';' : '') + '">' + content + '</td>';
                }).join('') + '</tr>';
              }).join('') + '</tbody>';
            }
            return '<div style="overflow-x:auto; margin:10px 0; border:1px solid var(--border); border-radius:6px;"><table style="width:100%; border-collapse:collapse; font-size:12px;">' + headerHtml + bodyHtml + '</table></div>';
          }
        };
        marked.use({ renderer: markedRenderer, gfm: true, breaks: true });
      }
    } catch (e) {}

    function renderMarkdown(md) {
      if (!md) return '';
      if (typeof marked !== 'undefined' && marked.parse) {
        try {
          return marked.parse(md);
        } catch (e) {
          console.warn('[PlanEditorPanel] marked.parse failed:', e);
        }
      }
      var codeParts = md.split(String.fromCharCode(96, 96, 96));
      var html = '';

      for (var i = 0; i < codeParts.length; i++) {
        var nl = String.fromCharCode(10);
        if (i % 2 === 1) {
          var lines = codeParts[i].split(nl);
          var lang = lines[0].trim() || '';
          var code = lines.slice(1).join(nl);
          html += '<pre style="background:rgba(0,0,0,0.3); padding:12px; border-radius:6px; border:1px solid var(--border); overflow-x:auto; margin:10px 0;"><code style="background:transparent; padding:0; color:#e4e4e7; font-family:var(--vscode-editor-font-family, monospace); font-size:12px;">' + escapeHtml(code.trim()) + '</code></pre>';
        } else {
          var rawLines = codeParts[i].split(nl);
          for (var l = 0; l < rawLines.length; l++) {
            var line = rawLines[l];
            var trimmed = line.trim();

            if (!trimmed) {
              html += '<div style="height:8px;"></div>';
              continue;
            }

            if (/^(?:---|\\*\\*\\*|___)\\s*$/.test(trimmed)) {
              html += '<hr style="border:none; border-top:1px solid var(--border); margin:12px 0;">';
              continue;
            }

            // GFM Table (with or without edge pipes)
            var isTableSep = function(str) { return /^\\s*\\|?(?:\\s*:?-+:?\\s*\\|?)+\\s*$/.test(str) && str.indexOf('-') !== -1; };
            if (trimmed.indexOf('|') !== -1 && l + 1 < rawLines.length && isTableSep(rawLines[l+1].trim())) {
              var tableLines = [trimmed];
              var sepLine = rawLines[l+1].trim();
              l++;
              while (l + 1 < rawLines.length && rawLines[l+1].trim().indexOf('|') !== -1 && !rawLines[l+1].trim().startsWith(String.fromCharCode(96, 96, 96))) {
                l++;
                tableLines.push(rawLines[l].trim());
              }
              var rawAligns = sepLine.replace(/^\|/, '').replace(/\|$/, '').split('|');
              var aligns = rawAligns.map(function(s) {
                var st = s.trim();
                if (st.startsWith(':') && st.endsWith(':')) return 'center';
                if (st.endsWith(':')) return 'right';
                return 'left';
              });
              var headers = tableLines[0].replace(/^\|/, '').replace(/\|$/, '').split('|');
              var tableHtml = '<div style="overflow-x:auto; margin:10px 0; border:1px solid var(--border); border-radius:6px;"><table style="width:100%; border-collapse:collapse; font-size:12px;"><thead><tr>';
              for (var h = 0; h < headers.length; h++) {
                tableHtml += '<th style="text-align:' + (aligns[h] || 'left') + '; padding:8px 12px; background:rgba(255,255,255,0.06); border-bottom:1px solid var(--border); font-weight:600;">' + renderInline(headers[h].trim()) + '</th>';
              }
              tableHtml += '</tr></thead><tbody>';
              for (var r = 1; r < tableLines.length; r++) {
                var cells = tableLines[r].replace(/^\|/, '').replace(/\|$/, '').split('|');
                tableHtml += '<tr>';
                for (var c = 0; c < headers.length; c++) {
                  tableHtml += '<td style="text-align:' + (aligns[c] || 'left') + '; padding:6px 12px; border-bottom:1px solid rgba(255,255,255,0.04);">' + renderInline((cells[c] || '').trim()) + '</td>';
                }
                tableHtml += '</tr>';
              }
              tableHtml += '</tbody></table></div>';
              html += tableHtml;
              continue;
            }

            // Task list item
            var taskMatch = trimmed.match(/^[-*•]\\s+\\[([ xX])\\]\\s*(.*)$/);
            if (taskMatch) {
              var isChecked = taskMatch[1].toLowerCase() === 'x';
              html += '<div style="display:flex; align-items:center; gap:8px; margin:4px 0 4px 4px;"><input type="checkbox" ' + (isChecked ? 'checked' : '') + ' disabled style="accent-color:var(--accent);"><span style="' + (isChecked ? 'text-decoration:line-through; opacity:0.6;' : '') + '">' + renderInline(taskMatch[2]) + '</span></div>';
              continue;
            }

            if (/^####\\s+/.test(trimmed)) {
              html += '<h4 style="font-size:12.5px; font-weight:600; color:var(--pending-fg); text-transform:uppercase; letter-spacing:0.5px; margin:12px 0 4px;">' + renderInline(trimmed.replace(/^####\\s+/, '')) + '</h4>';
            } else if (/^###\\s+/.test(trimmed)) {
              html += '<h3 style="font-size:14px; font-weight:600; margin:14px 0 6px; color:var(--fg);">' + renderInline(trimmed.replace(/^###\\s+/, '')) + '</h3>';
            } else if (/^##\\s+/.test(trimmed)) {
              html += '<h2 style="font-size:15.5px; font-weight:600; margin:18px 0 6px; border-bottom:1px solid var(--border); padding-bottom:4px; color:var(--fg);">' + renderInline(trimmed.replace(/^##\\s+/, '')) + '</h2>';
            } else if (/^#\\s+/.test(trimmed)) {
              html += '<h1 style="font-size:18px; font-weight:700; margin:20px 0 8px; border-bottom:1px solid var(--border); padding-bottom:6px; color:var(--fg);">' + renderInline(trimmed.replace(/^#\\s+/, '')) + '</h1>';
            } else if (/^[-*•]\\s+/.test(trimmed)) {
              var itemText = trimmed.replace(/^[-*•]\\s+/, '');
              html += '<div style="display:flex; align-items:flex-start; gap:8px; margin:3px 0 3px 6px;"><span style="color:var(--accent); font-size:14px; line-height:1.2;">•</span><span style="flex:1;">' + renderInline(itemText) + '</span></div>';
            } else if (/^\\d+\\.\\s+/.test(trimmed)) {
              var numMatch = trimmed.match(/^(\\d+)\\.\\s+(.*)$/);
              var num = numMatch ? numMatch[1] : '1';
              var numText = numMatch ? numMatch[2] : trimmed;
              html += '<div style="display:flex; align-items:flex-start; gap:8px; margin:3px 0 3px 6px;"><span style="color:var(--accent); font-weight:600; min-width:14px;">' + num + '.</span><span style="flex:1;">' + renderInline(numText) + '</span></div>';
            } else if (/^>\\s+/.test(trimmed)) {
              var quoteText = trimmed.replace(/^>\\s+/, '');
              html += '<div style="border-left:3px solid var(--accent); padding:6px 12px; margin:8px 0; background:rgba(6,182,212,0.06); border-radius:0 4px 4px 0; color:var(--pending-fg);">' + renderInline(quoteText) + '</div>';
            } else {
              html += '<div style="margin:3px 0; line-height:1.6;">' + renderInline(line) + '</div>';
            }
          }
        }
      }
      return html;
    }

    // Render embedded initial plan if available
    var embeddedPlan = ${JSON.stringify(this._currentPlan || null)};
    if (embeddedPlan) {
      renderPlan(embeddedPlan);
    }
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
