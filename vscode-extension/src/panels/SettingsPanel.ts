import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { ModelInfo, ProviderInfo } from "../server/types.js";
import { join } from "path";

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  public static readonly viewType = "andromity.settingsPanel";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _rpcClient: RpcClient | null = null;
  private _onConfigChangeCallback?: () => void;

  public static createOrShow(
    extensionUri: vscode.Uri,
    rpcClient: RpcClient | null,
    initialTab: "models" | "skills" | "mcp" | "usage" | "keys" | "general" | "trust" | "about" | "crons" = "models",
    onConfigChange?: () => void
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel._panel.reveal(column);
      SettingsPanel.currentPanel._rpcClient = rpcClient;
      SettingsPanel.currentPanel._onConfigChangeCallback = onConfigChange;
      SettingsPanel.currentPanel.setInitialTab(initialTab);
      SettingsPanel.currentPanel.loadData();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      "Andromity Hub",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    SettingsPanel.currentPanel = new SettingsPanel(
      panel,
      extensionUri,
      rpcClient,
      initialTab,
      onConfigChange
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    rpcClient: RpcClient | null,
    initialTab: string,
    onConfigChange?: () => void
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._rpcClient = rpcClient;
    this._onConfigChangeCallback = onConfigChange;

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, "media", "icon.svg"),
      dark: vscode.Uri.joinPath(this._extensionUri, "media", "icon.svg"),
    };

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables
    );

    setTimeout(() => {
      this.setInitialTab(initialTab);
      this.loadData();
    }, 50);
  }

  public setRpcClient(client: RpcClient) {
    this._rpcClient = client;
    this.loadData();
  }

  public setInitialTab(tab: string) {
    this._panel.webview.postMessage({ type: "switch_tab", tab });
  }

  public async loadData() {
    if (!this._rpcClient) return;
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const [configData, models, providers, skills, mcpServers, usage, systemInfo, trustData, crons] = await Promise.all([
        this._rpcClient.call<any>("config.get", { project_path: workspaceFolder }, 3000).catch(() => ({})),
        this._rpcClient.call<ModelInfo[]>("config.list_models", {}, 3000).catch(() => []),
        this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}, 3000).catch(() => []),
        this._rpcClient.call<any[]>("skills.list", { project_path: workspaceFolder }, 3000).catch(() => []),
        this._rpcClient.call<any[]>("mcp.list", {}, 3000).catch(() => []),
        this._rpcClient.call<any>("usage.get", {}, 3000).catch(() => ({})),
        this._rpcClient.call<any>("system.info", {}, 3000).catch(() => ({})),
        this._rpcClient.call<any>("trust.status", { project_path: workspaceFolder }, 3000).catch(() => ({ is_trusted: true, trusted_projects: [] })),
        this._rpcClient.call<any[]>("cron.list", { project_path: workspaceFolder }, 3000).catch(() => []),
      ]);

      const vscodeConfig = vscode.workspace.getConfiguration("andromity");
      const permissionMode = vscodeConfig.get<string>("permissionMode", configData?.permission_mode || "safe");

      this._panel.webview.postMessage({
        type: "state_loaded",
        config: { ...configData, permission_mode: permissionMode },
        models: models || [],
        providers: providers || [],
        skills: skills || [],
        remoteSkills: [],
        mcpServers: mcpServers || [],
        usage: usage || {},
        systemInfo: systemInfo || {},
        trustData: trustData || { is_trusted: true, trusted_projects: [] },
        crons: crons || [],
        currentWorkspace: workspaceFolder || "",
        soundNotifications: vscodeConfig.get<boolean>("soundNotifications", true),
      });

      // Background-fetch remote skills registry from GitHub without blocking initial UI
      this._rpcClient.call<any[]>("skills.browse", {}, 15000)
        .then((remoteSkills) => {
          if (this._panel && remoteSkills) {
            this._panel.webview.postMessage({
              type: "remote_skills_loaded",
              remoteSkills: remoteSkills || [],
            });
          }
        })
        .catch(() => {});
    } catch (err: any) {
      console.error("[SettingsPanel] Failed to load data:", err);
    }
  }

  private async _handleMessage(message: any) {
    if (!this._rpcClient) {
      vscode.window.showErrorMessage("Andromity daemon is not connected.");
      return;
    }

    switch (message.type) {
      case "ready": {
        await this.loadData();
        break;
      }

      case "refresh_models": {
        try {
          const models = await this._rpcClient.call<ModelInfo[]>("config.refresh_models", {
            provider: message.provider || undefined,
          }, 30000);
          this._panel.webview.postMessage({
            type: "models_refreshed",
            models: models || [],
          });
          vscode.window.showInformationMessage(`Refreshed live model catalog (${models?.length || 0} models available).`);
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to refresh models: ${err.message}`);
          this._panel.webview.postMessage({ type: "refresh_failed" });
        }
        break;
      }

      case "select_model": {
        try {
          await this._rpcClient.call("config.set", {
            section: "default",
            key: "model",
            value: message.modelId,
          });
          if (message.provider) {
            await this._rpcClient.call("config.set", {
              section: "default",
              key: "provider",
              value: message.provider,
            });
          }
          this._panel.webview.postMessage({
            type: "model_selected",
            modelId: message.modelId,
            provider: message.provider,
          });
          vscode.window.showInformationMessage(`Active model set to: ${message.modelId}`);
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to switch model: ${err.message}`);
        }
        break;
      }

      case "set_api_key": {
        try {
          await this._rpcClient.call("config.set_api_key", {
            provider: message.provider,
            api_key: message.apiKey || "",
          });
          const providers = await this._rpcClient.call<ProviderInfo[]>("config.list_providers", {});
          this._panel.webview.postMessage({
            type: "providers_updated",
            providers: providers || [],
            savedProvider: message.provider,
          });
          vscode.window.showInformationMessage(`API key for ${message.provider} updated successfully.`);
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to save API key: ${err.message}`);
        }
        break;
      }

      case "install_skill": {
        try {
          const res = await this._rpcClient.call<any>("skills.install", {
            name: message.name,
            source_id: message.sourceId || "anthropic",
          }, 60000);
          if (res.success) {
            vscode.window.showInformationMessage(`Installed skill '${message.name}' successfully.`);
            await this.loadData();
          } else {
            vscode.window.showErrorMessage(`Failed to install skill: ${res.error || "Unknown error"}`);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to install skill: ${err.message}`);
        }
        break;
      }

      case "trust_folder": {
        try {
          await this._rpcClient.call("trust.set", { project_path: message.path });
          vscode.window.showInformationMessage(`Folder marked as trusted.`);
          await this.loadData();
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to trust folder: ${err.message}`);
        }
        break;
      }

      case "revoke_trust": {
        try {
          await this._rpcClient.call("trust.revoke", { project_path: message.path });
          vscode.window.showInformationMessage(`Folder trust revoked.`);
          await this.loadData();
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to revoke trust: ${err.message}`);
        }
        break;
      }

      case "update_setting": {
        try {
          const keyMap: Record<string, { section: string; key: string }> = {
            profile: { section: "default", key: "profile" },
            mode: { section: "default", key: "permission_mode" },
            reasoningEffort: { section: "default", key: "reasoning_effort" },
            userName: { section: "user", key: "name" },
            userEmail: { section: "user", key: "email" },
            maxSubagents: { section: "subagents", key: "max_parallel" },
            autoCompact: { section: "advanced", key: "auto_compact" },
            maxFileSize: { section: "advanced", key: "max_file_size_kb" },
          };
          const target = keyMap[message.key] || { section: "default", key: message.key };
          await this._rpcClient.call("config.set", {
            section: target.section,
            key: target.key,
            value: message.value,
          });
          if (message.key === "mode") {
            const config = vscode.workspace.getConfiguration("andromity");
            await config.update("permissionMode", message.value, vscode.ConfigurationTarget.Global);
          }
          this._panel.webview.postMessage({
            type: "setting_updated",
            key: message.key,
            value: message.value,
          });
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to update setting: ${err.message}`);
        }
        break;
      }

      case "toggle_sound": {
        const config = vscode.workspace.getConfiguration("andromity");
        await config.update("soundNotifications", message.value, vscode.ConfigurationTarget.Global);
        break;
      }

      case "open_url": {
        if (message.url) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      }

      case "cron_create": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("cron.create", {
            ...message.payload,
            project_path: workspaceFolder,
          });
          vscode.window.showInformationMessage("Scheduled cron job created.");
          await this.loadData();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to create cron job: ${e.message}`);
        }
        break;
      }

      case "cron_toggle": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("cron.toggle", {
            id: message.id,
            project_path: workspaceFolder,
          });
          await this.loadData();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to toggle cron job: ${e.message}`);
        }
        break;
      }

      case "cron_delete": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("cron.delete", {
            id: message.id,
            project_path: workspaceFolder,
          });
          vscode.window.showInformationMessage("Scheduled cron job deleted.");
          await this.loadData();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to delete cron job: ${e.message}`);
        }
        break;
      }

      case "cron_run_now": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          vscode.window.showInformationMessage(`Triggering cron job "${message.name || message.id}"...`);
          // Also dispatch as prompt in Chat if requested
          if (message.prompt) {
            await vscode.commands.executeCommand("andromity.sendPrompt", message.prompt);
          }
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to trigger cron job: ${e.message}`);
        }
        break;
      }
    }
  }

  private _update() {
    this._panel.title = "Andromity Hub";
    this._panel.webview.html = this._getHtmlForWebview();
  }

  public dispose() {
    SettingsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getHtmlForWebview(): string {
    const iconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "sidebar-icon.svg"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Andromity Hub</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --card-border: var(--vscode-widget-border, rgba(255,255,255,0.08));
      --card-hover-border: var(--vscode-focusBorder, #007fd4);
      --text: var(--vscode-editor-foreground, #cccccc);
      --text-muted: var(--vscode-descriptionForeground, #888888);
      --primary: var(--vscode-button-background, #0e639c);
      --primary-hover: var(--vscode-button-hoverBackground, #1177bb);
      --primary-fg: var(--vscode-button-foreground, #ffffff);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --tag-green-bg: rgba(46, 160, 67, 0.15);
      --tag-green-fg: #3fb950;
      --tag-blue-bg: rgba(56, 139, 253, 0.15);
      --tag-blue-fg: #58a6ff;
      --tag-purple-bg: rgba(187, 128, 255, 0.15);
      --tag-purple-fg: #bc8cff;
      --tag-orange-bg: rgba(210, 153, 34, 0.15);
      --tag-orange-fg: #d29922;
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    /* Strict 90-degree rectangle corners across all Settings Page elements */
    button, input, select, textarea, .card, .stat-card, .model-card, .skill-card,
    .mcp-card, .settings-card, .nav-tab, .chip, .badge, .btn, .search-input,
    .custom-model-input, .search-input-wrap, .model-controls, .code-block,
    .key-input, .modal-content, .pill, .filter-chips, .active-model-banner,
    .tools-tag-list, .tool-tag-pill, .cron-card, .cron-form, .stat-val, .table-wrap {
      border-radius: 0px !important;
    }

    /* Cron Jobs Styles */
    .cron-header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .cron-form {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 16px;
      margin-bottom: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .cron-form-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .cron-form-col {
      flex: 1;
      min-width: 220px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .cron-form-col label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .cron-form-col input, .cron-form-col select, .cron-form-col textarea {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      padding: 7px 10px;
      font-size: 12.5px;
      font-family: inherit;
    }

    .cron-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .cron-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 14px 16px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      transition: border-color 0.15s;
    }

    .cron-card:hover {
      border-color: var(--card-hover-border);
    }

    .cron-card-left {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .cron-card-title-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .cron-card-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }

    .cron-interval-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      background: rgba(6, 182, 212, 0.15);
      color: #06b6d4;
      border: 1px solid rgba(6, 182, 212, 0.3);
    }

    .cron-status-pill {
      font-size: 10.5px;
      padding: 2px 6px;
      font-weight: 600;
    }

    .cron-status-pill.active {
      background: rgba(46, 160, 67, 0.15);
      color: #3fb950;
      border: 1px solid rgba(46, 160, 67, 0.3);
    }

    .cron-status-pill.paused {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      border: 1px solid var(--card-border);
    }

    .cron-card-prompt {
      font-size: 12px;
      color: var(--text);
      line-height: 1.4;
      background: rgba(0, 0, 0, 0.2);
      padding: 8px 10px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      font-family: monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .cron-card-meta {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .cron-card-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-family);
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Top Navigation Bar */
    .top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--card-border);
      padding: 8px 20px;
      background: var(--card-bg);
      flex-shrink: 0;
      gap: 12px;
      overflow-x: auto;
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 9px;
      flex-shrink: 0;
    }

    .brand-avatar {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .brand-icon {
      width: 30px;
      height: 30px;
      object-fit: contain;
      display: block;
    }

    .brand-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }

    .nav-tabs {
      display: flex;
      gap: 4px;
      flex-wrap: nowrap;
    }

    .nav-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      border: 1px solid transparent;
      background: transparent;
      white-space: nowrap;
      transition: all 0.15s ease;
    }

    .nav-tab:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.04);
    }

    .nav-tab.active {
      color: var(--text);
      background: var(--bg);
      border-color: var(--card-border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }

    .nav-tab svg {
      width: 14px;
      height: 14px;
    }

    /* Main Container */
    .main-content {
      flex: 1;
      overflow-y: auto;
      padding: 20px 28px 48px;
    }

    .tab-pane {
      display: none;
      max-width: 1200px;
      margin: 0 auto;
    }

    .tab-pane.active {
      display: block;
    }

    .section-header {
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
    }

    .section-title {
      font-size: 18px;
      font-weight: 600;
    }

    .section-desc {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    /* Filter Controls in Model Hub */
    .model-controls {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 18px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 12px 16px;
    }

    .search-row {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .search-input-wrap {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-input-wrap svg {
      position: absolute;
      left: 10px;
      width: 14px;
      height: 14px;
      color: var(--text-muted);
    }

    .search-input {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      padding: 7px 12px 7px 32px;
      border-radius: 4px;
      font-size: 13px;
      outline: none;
    }

    .search-input:focus {
      border-color: var(--card-hover-border);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      border: none;
      background: var(--primary);
      color: var(--primary-fg);
      transition: background 0.15s;
    }

    .btn:hover {
      background: var(--primary-hover);
    }

    .btn-secondary {
      background: rgba(255,255,255,0.08);
      color: var(--text);
      border: 1px solid var(--card-border);
    }

    .btn-secondary:hover {
      background: rgba(255,255,255,0.12);
    }

    .btn-danger {
      background: rgba(248, 81, 73, 0.15);
      color: #f85149;
      border: 1px solid rgba(248, 81, 73, 0.4);
    }

    .btn-danger:hover {
      background: rgba(248, 81, 73, 0.25);
    }

    .btn svg {
      width: 14px;
      height: 14px;
    }

    /* Filter Chips */
    .filter-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    .chip-label {
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--text-muted);
      margin-right: 4px;
      letter-spacing: 0.5px;
    }

    .chip {
      padding: 3px 9px;
      border-radius: 12px;
      font-size: 11px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
      transition: all 0.15s;
    }

    .chip:hover {
      color: var(--text);
      border-color: rgba(255,255,255,0.2);
    }

    .chip.active {
      background: var(--primary);
      color: var(--primary-fg);
      border-color: var(--primary);
    }

    /* Custom Model Input */
    .custom-model-bar {
      display: flex;
      gap: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--card-border);
      align-items: center;
    }

    .custom-model-input {
      flex: 1;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: monospace;
      outline: none;
    }

    /* Models Grid */
    .models-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }

    .model-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 10px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .model-card:hover {
      border-color: var(--card-hover-border);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }

    .model-card.active-model {
      border-color: var(--tag-green-fg);
      background: rgba(46, 160, 67, 0.04);
    }

    .model-card-top {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .model-header-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .model-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      word-break: break-word;
    }

    .model-id {
      font-size: 11px;
      font-family: monospace;
      color: var(--text-muted);
      word-break: break-all;
    }

    .model-desc {
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .model-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 500;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }

    .badge.green { background: var(--tag-green-bg); color: var(--tag-green-fg); }
    .badge.blue { background: var(--tag-blue-bg); color: var(--tag-blue-fg); }
    .badge.purple { background: var(--tag-purple-bg); color: var(--tag-purple-fg); }
    .badge.orange { background: var(--tag-orange-bg); color: var(--tag-orange-fg); }

    .model-card-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 8px;
      border-top: 1px solid var(--card-border);
    }

    .model-pricing {
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .model-pricing.free {
      color: var(--tag-green-fg);
      font-weight: 600;
    }

    .select-btn {
      padding: 4px 10px;
      font-size: 11px;
      border-radius: 4px;
      cursor: pointer;
      border: 1px solid var(--card-border);
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      transition: all 0.15s;
    }

    .select-btn:hover {
      background: var(--primary);
      color: var(--primary-fg);
      border-color: var(--primary);
    }

    .active-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--tag-green-fg);
      background: var(--tag-green-bg);
      border-radius: 4px;
    }

    /* Cards Grid for Keys, Skills, MCP */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 14px;
    }

    .item-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .item-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .item-card-title {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
    }

    .status-dot.connected {
      background: var(--tag-green-fg);
      box-shadow: 0 0 6px rgba(63, 185, 80, 0.6);
    }

    .item-card-desc {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .key-input-row {
      display: flex;
      gap: 8px;
    }

    .key-input {
      flex: 1;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: monospace;
      outline: none;
    }

    .portal-link {
      font-size: 11px;
      color: var(--tag-blue-fg);
      text-decoration: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .portal-link:hover {
      text-decoration: underline;
    }

    /* Usage Stats */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }

    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .stat-val {
      font-size: 22px;
      font-weight: 700;
      color: var(--text);
    }

    .stat-lbl {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    /* General Settings List */
    .settings-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
      max-width: 720px;
    }

    .settings-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .setting-label {
      font-size: 13px;
      font-weight: 600;
    }

    .setting-desc {
      font-size: 12px;
      color: var(--text-muted);
    }

    .setting-input {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      padding: 7px 10px;
      border-radius: 4px;
      font-size: 12px;
      outline: none;
      width: 100%;
    }

    .setting-select {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      padding: 7px 10px;
      border-radius: 4px;
      font-size: 12px;
      outline: none;
      width: 100%;
      cursor: pointer;
    }

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      user-select: none;
    }

    /* Diagnostic Table */
    .diag-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .diag-table td {
      padding: 8px 12px;
      border-bottom: 1px solid var(--card-border);
    }

    .diag-table td:first-child {
      width: 180px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .diag-table td:last-child {
      font-family: monospace;
      color: var(--text);
    }

    .tools-tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    /* Empty state */
    .empty-state {
      padding: 36px;
      text-align: center;
      color: var(--text-muted);
    }

    .empty-state svg {
      width: 32px;
      height: 32px;
      margin-bottom: 10px;
      opacity: 0.5;
    }

    @keyframes spin { 100% { transform: rotate(360deg); } }
    .spinning { animation: spin 1s linear infinite; }
  </style>
</head>
<body>

  <!-- Top Navigation -->
  <div class="top-nav">
    <div class="brand-group">
      <div class="brand-avatar">
        <img class="brand-icon" src="${iconUri}" alt="Andromity" />
      </div>
      <span class="brand-title">Andromity Hub</span>
    </div>

    <div class="nav-tabs">
      <button class="nav-tab active" data-tab="models" id="tab-btn-models">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
        Model Hub (<span id="model-count-badge">0</span>)
      </button>
      <button class="nav-tab" data-tab="crons" id="tab-btn-crons">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        Cron Jobs (<span id="crons-count-badge">0</span>)
      </button>
      <button class="nav-tab" data-tab="keys" id="tab-btn-keys">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>
        API Keys & Connectors
      </button>
      <button class="nav-tab" data-tab="skills" id="tab-btn-skills">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        Skills & Packs (<span id="skills-count-badge">0</span>)
      </button>
      <button class="nav-tab" data-tab="mcp" id="tab-btn-mcp">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M9 9h6v6H9z"></path></svg>
        MCP Servers
      </button>
      <button class="nav-tab" data-tab="usage" id="tab-btn-usage">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
        Usage & Costs
      </button>
      <button class="nav-tab" data-tab="trust" id="tab-btn-trust">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
        Trust & Security
      </button>
      <button class="nav-tab" data-tab="general" id="tab-btn-general">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        Preferences
      </button>
      <button class="nav-tab" data-tab="about" id="tab-btn-about">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
        About & Diagnostics
      </button>
    </div>
  </div>

  <!-- Main Body Content -->
  <div class="main-content">

    <!-- ── TAB 1: MODEL HUB ────────────────────────────────────────── -->
    <div class="tab-pane active" id="pane-models">
      <div class="section-header">
        <div>
          <h2 class="section-title">Live Model Hub</h2>
          <p class="section-desc">Search, filter, and switch between 396+ OpenRouter and provider models in real-time.</p>
        </div>
        <button class="btn btn-secondary" id="btn-refresh-models">
          <svg id="icon-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"></polyline>
            <polyline points="1 20 1 14 7 14"></polyline>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
          <span id="refresh-label">Refresh Catalog</span>
        </button>
      </div>

      <!-- Filter Controls -->
      <div class="model-controls">
        <div class="search-row">
          <div class="search-input-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" class="search-input" id="model-search" placeholder="Search models by name, provider, or model id (e.g. sonnet, deepseek, qwen, llama)...">
          </div>
        </div>

        <div class="filter-chips">
          <span class="chip-label">Category:</span>
          <div class="chip active" data-category="all">All</div>
          <div class="chip" data-category="free">Free Tier</div>
          <div class="chip" data-category="coding">Coding & Agentic</div>
          <div class="chip" data-category="reasoning">Reasoning / Thinking</div>
          <div class="chip" data-category="vision">Vision & Multimodal</div>
          <div class="chip" data-category="flagship">Flagships</div>
        </div>

        <div class="filter-chips">
          <span class="chip-label">Provider:</span>
          <div class="chip active" data-provider="all">All Providers</div>
          <div class="chip" data-provider="openrouter">OpenRouter</div>
          <div class="chip" data-provider="anthropic">Anthropic</div>
          <div class="chip" data-provider="openai">OpenAI</div>
          <div class="chip" data-provider="google">Gemini</div>
          <div class="chip" data-provider="deepseek">DeepSeek</div>
          <div class="chip" data-provider="groq">Groq</div>
          <div class="chip" data-provider="ollama">Ollama (Local)</div>
          <div class="chip" data-provider="nvidia">NVIDIA NIM</div>
        </div>

        <div class="custom-model-bar">
          <span class="chip-label">Custom:</span>
          <input type="text" class="custom-model-input" id="custom-model-id" placeholder="Paste any custom model identifier (e.g. anthropic/claude-3.7-sonnet:thinking or mistralai/mistral-large)">
          <button class="btn" id="btn-use-custom">Use Custom Model</button>
        </div>
      </div>

      <div id="active-model-banner" style="display:none; margin-bottom:14px; padding:12px 14px; background: rgba(46,160,67,0.08); border:1px solid rgba(46,160,67,0.35); border-radius:6px; display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div style="display:flex; flex-direction:column; gap:2px; min-width:0;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span style="font-size:10px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:var(--tag-green-fg);">● Current Active</span>
            <span id="active-banner-provider" class="badge blue" style="font-size:10px;"></span>
          </div>
          <div id="active-banner-name" style="font-size:13px; font-weight:600; color:var(--text); word-break:break-word;"></div>
          <div id="active-banner-id" style="font-size:11px; font-family:monospace; color:var(--text-muted); word-break:break-all;"></div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
          <span id="active-banner-ctx" class="badge purple" style="display:none;"></span>
          <span id="active-banner-pricing" style="font-size:11px; color:var(--text-muted);"></span>
        </div>
      </div>

      <div class="models-grid" id="models-grid"></div>
    </div>

    <!-- ── TAB: CRON JOBS ────────────────────────────────────────────── -->
    <div class="tab-pane" id="pane-crons">
      <div class="section-header">
        <div>
          <h2 class="section-title">Scheduled Cron Jobs</h2>
          <p class="section-desc">Automate recurring agent tasks, diagnostics, test runs, and codebase maintenance on a schedule.</p>
        </div>
        <div class="cron-header-actions">
          <button class="btn btn-secondary" id="btn-refresh-crons">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <span>Refresh</span>
          </button>
          <button class="btn" id="btn-toggle-add-cron">
            <span>+ New Cron Job</span>
          </button>
        </div>
      </div>

      <!-- Add Cron Job Form Drawer -->
      <div class="cron-form" id="cron-create-form" style="display:none;">
        <div style="font-size:14px; font-weight:600; margin-bottom:4px;">Create Scheduled Job</div>
        <div class="cron-form-row">
          <div class="cron-form-col">
            <label>Job Name</label>
            <input type="text" id="cron-name-input" placeholder="e.g. Daily Health & Test Suite">
          </div>
          <div class="cron-form-col">
            <label>Schedule Interval</label>
            <select id="cron-schedule-select">
              <option value="every 15m">Every 15 minutes (every 15m)</option>
              <option value="every 30m">Every 30 minutes (every 30m)</option>
              <option value="every 1h" selected>Every 1 hour (every 1h)</option>
              <option value="every 2h">Every 2 hours (every 2h)</option>
              <option value="every 6h">Every 6 hours (every 6h)</option>
              <option value="every 12h">Every 12 hours (every 12h)</option>
              <option value="every 1d">Every 1 day (every 1d)</option>
            </select>
          </div>
        </div>
        <div class="cron-form-row">
          <div class="cron-form-col" style="flex:100%;">
            <label>Prompt / Agent Instructions</label>
            <textarea id="cron-prompt-input" rows="3" placeholder="e.g. Inspect git status, run unit tests, and summarize any failures or lint issues."></textarea>
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
          <button class="btn btn-secondary" id="btn-cancel-cron">Cancel</button>
          <button class="btn" id="btn-save-cron">Create Job</button>
        </div>
      </div>

      <!-- Cron Jobs List -->
      <div class="cron-list" id="cron-list-container"></div>
    </div>

    <!-- ── TAB 2: API KEYS & CONNECTORS ────────────────────────────── -->
    <div class="tab-pane" id="pane-keys">
      <div class="section-header">
        <div>
          <h2 class="section-title">API Keys & Provider Connectors</h2>
          <p class="section-desc">Manage API credentials securely on your machine. Keys are encrypted and stored in local config.</p>
        </div>
      </div>
      <div class="cards-grid" id="keys-grid"></div>
    </div>

    <!-- ── TAB 3: SKILLS & WORKFLOWS ────────────────────────────────── -->
    <div class="tab-pane" id="pane-skills">
      <div class="section-header">
        <div>
          <h2 class="section-title">Skills & Instruction Packs</h2>
          <p class="section-desc">Modular skills loaded from local workspace, global config, and Anthropic/Community registries.</p>
        </div>
      </div>

      <div class="model-controls">
        <div class="filter-chips">
          <span class="chip-label">View:</span>
          <div class="chip active" id="filter-skills-installed">Installed (<span id="installed-skills-num">0</span>)</div>
          <div class="chip" id="filter-skills-registry">Browse Online Registry (<span id="remote-skills-num">0</span>)</div>
        </div>
      </div>

      <div class="cards-grid" id="skills-grid"></div>
    </div>

    <!-- ── TAB 4: MCP SERVERS ───────────────────────────────────────── -->
    <div class="tab-pane" id="pane-mcp">
      <div class="section-header">
        <div>
          <h2 class="section-title">Model Context Protocol (MCP)</h2>
          <p class="section-desc">External database connectors, tool servers, and enterprise context integrations.</p>
        </div>
      </div>
      <div class="cards-grid" id="mcp-grid"></div>
    </div>

    <!-- ── TAB 5: USAGE & COSTS ─────────────────────────────────────── -->
    <div class="tab-pane" id="pane-usage">
      <div class="section-header">
        <div>
          <h2 class="section-title">Usage & Cost Analytics</h2>
          <p class="section-desc">Monitor token consumption, prompt cache efficiency, and estimated expenditures.</p>
        </div>
      </div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-val" id="stat-tokens">0</div>
          <div class="stat-lbl">Session Tokens</div>
        </div>
        <div class="stat-card">
          <div class="stat-val" id="stat-cost">$0.0000</div>
          <div class="stat-lbl">Estimated Session Cost</div>
        </div>
        <div class="stat-card">
          <div class="stat-val" id="stat-messages">0</div>
          <div class="stat-lbl">Total Interaction Turns</div>
        </div>
      </div>
    </div>

    <!-- ── TAB 6: TRUST & SECURITY ─────────────────────────────────── -->
    <div class="tab-pane" id="pane-trust">
      <div class="section-header">
        <div>
          <h2 class="section-title">Trust & Workspace Governance</h2>
          <p class="section-desc">Manage folder trust permissions, review auto-approved directories, and safety boundaries.</p>
        </div>
      </div>

      <div class="settings-list">
        <div class="settings-card">
          <div class="setting-label">Current Workspace Trust</div>
          <div class="setting-desc" id="trust-current-status-desc">Status of the currently active workspace directory.</div>
          <div style="display: flex; gap: 10px; align-items: center; margin-top: 6px;">
            <span class="badge green" id="trust-status-badge">Trusted Workspace</span>
            <button class="btn btn-danger" id="btn-toggle-current-trust">Revoke Trust</button>
          </div>
        </div>

        <div class="settings-card">
          <div class="setting-label">Trusted Project Directories</div>
          <div class="setting-desc">Directories with permanent write & shell execution trust. Revoke trust to revert to restricted mode.</div>
          <div id="trusted-folders-list" style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px;"></div>
        </div>

        <div class="settings-card">
          <div class="setting-label">Permission Modes Explained</div>
          <table class="diag-table" style="margin-top: 6px;">
            <tr>
              <td style="color: var(--tag-green-fg); font-weight: 600;">SAFE</td>
              <td>Prompts for explicit confirmation before every single file edit and shell command execution.</td>
            </tr>
            <tr>
              <td style="color: var(--tag-blue-fg); font-weight: 600;">TRUST</td>
              <td>Auto-approves direct file writes within trusted project directories; prompts for shell commands.</td>
            </tr>
            <tr>
              <td style="color: var(--tag-purple-fg); font-weight: 600;">FULL</td>
              <td>Auto-approves all tool actions and logs them directly to the UI execution stream.</td>
            </tr>
            <tr>
              <td style="color: var(--tag-orange-fg); font-weight: 600;">YOLO</td>
              <td>Autonomous silent execution with all security confirmations bypassed.</td>
            </tr>
          </table>
        </div>
      </div>
    </div>

    <!-- ── TAB 7: AGENT PREFERENCES ─────────────────────────────────── -->
    <div class="tab-pane" id="pane-general">
      <div class="section-header">
        <div>
          <h2 class="section-title">Agent Preferences & Configuration</h2>
          <p class="section-desc">Configure governance rules, agent profiles, subagent concurrency, and storage thresholds.</p>
        </div>
      </div>

      <div class="settings-list">
        <div class="settings-card">
          <div class="setting-label">Permission Governance Mode</div>
          <div class="setting-desc">Control automated tool execution safety boundaries. Synchronizes across sidebar and Hub.</div>
          <select class="setting-select" id="setting-mode">
            <option value="safe">SAFE — Confirm every file write and shell command</option>
            <option value="trust">TRUST — Auto-approve modifications in workspace directories</option>
            <option value="full">FULL — Auto-approve all actions and log to stream</option>
            <option value="yolo">YOLO — Silent autonomous execution</option>
          </select>
        </div>

        <div class="settings-card">
          <div class="setting-label">Agent Profile</div>
          <div class="setting-desc">Determines how Andromity approaches coding tasks (planning first vs. direct execution).</div>
          <select class="setting-select" id="setting-profile">
            <option value="builder">Builder — Plans architecture first, then implements changes</option>
            <option value="coder">Coder — Direct implementation without mandatory planning</option>
            <option value="reviewer">Reviewer — Read-only code audit and inspection</option>
            <option value="planner">Planner — Architectural design without editing files</option>
          </select>
        </div>

        <div class="settings-card">
          <div class="setting-label">Reasoning Effort</div>
          <div class="setting-desc">Effort level for models supporting extended thinking (o1, o3, Claude 3.7).</div>
          <select class="setting-select" id="setting-reasoning">
            <option value="off">Off — Zero reasoning overhead</option>
            <option value="low">Low — Fast concise reasoning</option>
            <option value="medium">Medium — Balanced depth</option>
            <option value="high">High — In-depth architectural reasoning</option>
          </select>
        </div>

        <div class="settings-card">
          <div class="setting-label">Your Name</div>
          <div class="setting-desc">Name used by the agent when collaborating in multi-user environments.</div>
          <input type="text" class="setting-input" id="setting-user-name" placeholder="e.g. Alex">
        </div>

        <div class="settings-card">
          <div class="setting-label">Your Email</div>
          <div class="setting-desc">Email associated with local configuration and notifications.</div>
          <input type="email" class="setting-input" id="setting-user-email" placeholder="you@example.com">
        </div>

        <div class="settings-card">
          <div class="setting-label">Max Parallel Subagents</div>
          <div class="setting-desc">Maximum concurrent subagents spawned for parallel task execution.</div>
          <select class="setting-select" id="setting-max-subagents">
            <option value="1">1 Subagent (Sequential execution)</option>
            <option value="2">2 Subagents</option>
            <option value="3">3 Subagents (Default)</option>
            <option value="4">4 Subagents</option>
            <option value="6">6 Subagents</option>
            <option value="8">8 Subagents (High Concurrency)</option>
          </select>
        </div>

        <div class="settings-card">
          <label class="checkbox-row">
            <input type="checkbox" id="setting-auto-compact">
            <div>
              <div class="setting-label">Auto-Compact Context</div>
              <div class="setting-desc">Automatically summarize long sessions when reaching context limits.</div>
            </div>
          </label>
        </div>

        <div class="settings-card">
          <label class="checkbox-row">
            <input type="checkbox" id="setting-sound">
            <div>
              <div class="setting-label">Sound Notifications</div>
              <div class="setting-desc">Play subtle audio notification when task completes or approval is required.</div>
            </div>
          </label>
        </div>
      </div>
    </div>

    <!-- ── TAB 8: ABOUT & DIAGNOSTICS ───────────────────────────────── -->
    <div class="tab-pane" id="pane-about">
      <div class="section-header">
        <div>
          <h2 class="section-title">About & System Diagnostics</h2>
          <p class="section-desc">Daemon runtime details, environment paths, and registered tool capabilities.</p>
        </div>
      </div>

      <div class="settings-card" style="max-width: 800px; margin-bottom: 16px;">
        <table class="diag-table">
          <tr>
            <td>Andromity Version</td>
            <td id="diag-version">v0.2.3</td>
          </tr>
          <tr>
            <td>Python Version</td>
            <td id="diag-py-ver">Loading...</td>
          </tr>
          <tr>
            <td>Python Executable</td>
            <td id="diag-py-exe">Loading...</td>
          </tr>
          <tr>
            <td>Operating System</td>
            <td id="diag-os">Loading...</td>
          </tr>
          <tr>
            <td>Daemon PID</td>
            <td id="diag-pid">Loading...</td>
          </tr>
          <tr>
            <td>Available Core Tools</td>
            <td id="diag-tools-count">27 Tools Active</td>
          </tr>
        </table>
      </div>

      <div class="settings-card" style="max-width: 800px;">
        <div class="setting-label">Registered Native Tools</div>
        <div class="tools-tag-list" id="diag-tools-list"></div>
      </div>
    </div>

  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let allModels = [];
    let allProviders = [];
    let allSkills = [];
    let allRemoteSkills = [];
    let allMcpServers = [];
    let currentConfig = {};
    let trustInfo = {};
    let currentWorkspacePath = "";
    let activeModelId = "";
    let activeModelProvider = "";
    let activeCategory = "all";
    let activeProvider = "all";
    let activeSkillsTab = "installed";
    let searchQuery = "";

    // Tabs Navigation
    const tabButtons = document.querySelectorAll(".nav-tab");
    const panes = document.querySelectorAll(".tab-pane");

    tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });

    function switchTab(tab) {
      tabButtons.forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
      panes.forEach(p => p.classList.toggle("active", p.id === "pane-" + tab));
    }

    // Refresh button
    const btnRefresh = document.getElementById("btn-refresh-models");
    const iconRefresh = document.getElementById("icon-refresh");
    const refreshLabel = document.getElementById("refresh-label");

    btnRefresh.addEventListener("click", () => {
      iconRefresh.classList.add("spinning");
      refreshLabel.textContent = "Refreshing…";
      vscode.postMessage({ type: "refresh_models" });
    });

    // Search & Filter Listeners
    const searchInput = document.getElementById("model-search");
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderModels();
    });

    document.querySelectorAll(".chip[data-category]").forEach(chip => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".chip[data-category]").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        activeCategory = chip.dataset.category;
        renderModels();
      });
    });

    document.querySelectorAll(".chip[data-provider]").forEach(chip => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".chip[data-provider]").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        activeProvider = chip.dataset.provider;
        renderModels();
      });
    });

    // Skills Sub-tabs
    const btnSkillsInstalled = document.getElementById("filter-skills-installed");
    const btnSkillsRegistry = document.getElementById("filter-skills-registry");

    btnSkillsInstalled.addEventListener("click", () => {
      btnSkillsInstalled.classList.add("active");
      btnSkillsRegistry.classList.remove("active");
      activeSkillsTab = "installed";
      renderSkills();
    });

    btnSkillsRegistry.addEventListener("click", () => {
      btnSkillsRegistry.classList.add("active");
      btnSkillsInstalled.classList.remove("active");
      activeSkillsTab = "registry";
      renderSkills();
    });

    document.getElementById("btn-use-custom").addEventListener("click", () => {
      const input = document.getElementById("custom-model-id");
      const val = input.value.trim();
      if (val) {
        selectModel(val, "openrouter");
      }
    });

    const selectProfile = document.getElementById("setting-profile");
    const selectMode = document.getElementById("setting-mode");
    const selectReasoning = document.getElementById("setting-reasoning");
    const inputUserName = document.getElementById("setting-user-name");
    const inputUserEmail = document.getElementById("setting-user-email");
    const selectMaxSubagents = document.getElementById("setting-max-subagents");
    const checkAutoCompact = document.getElementById("setting-auto-compact");
    const checkSound = document.getElementById("setting-sound");

    selectProfile.addEventListener("change", () => {
      vscode.postMessage({ type: "update_setting", key: "profile", value: selectProfile.value });
    });
    selectMode.addEventListener("change", () => {
      vscode.postMessage({ type: "update_setting", key: "mode", value: selectMode.value });
    });
    selectReasoning.addEventListener("change", () => {
      vscode.postMessage({ type: "update_setting", key: "reasoningEffort", value: selectReasoning.value });
    });
    inputUserName.addEventListener("change", () => {
      vscode.postMessage({ type: "update_setting", key: "userName", value: inputUserName.value });
    });
    inputUserEmail.addEventListener("change", () => {
      vscode.postMessage({ type: "update_setting", key: "userEmail", value: inputUserEmail.value });
    });
    selectMaxSubagents.addEventListener("change", () => {
      vscode.postMessage({ type: "update_setting", key: "maxSubagents", value: parseInt(selectMaxSubagents.value, 10) });
    });
    checkAutoCompact.addEventListener("change", () => {
      vscode.postMessage({ type: "update_setting", key: "autoCompact", value: checkAutoCompact.checked });
    });
    checkSound.addEventListener("change", () => {
      vscode.postMessage({ type: "toggle_sound", value: checkSound.checked });
    });

    // Trust Toggle
    const btnToggleTrust = document.getElementById("btn-toggle-current-trust");
    btnToggleTrust.addEventListener("click", () => {
      if (trustInfo.is_trusted) {
        vscode.postMessage({ type: "revoke_trust", path: currentWorkspacePath });
      } else {
        vscode.postMessage({ type: "trust_folder", path: currentWorkspacePath });
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "switch_tab": {
          switchTab(msg.tab);
          break;
        }
        case "state_loaded": {
          currentConfig = msg.config || {};
          allModels = msg.models || [];
          allProviders = msg.providers || [];
          allSkills = msg.skills || [];
          allRemoteSkills = msg.remoteSkills || [];
          allMcpServers = msg.mcpServers || [];
          trustInfo = msg.trustData || {};
          currentWorkspacePath = msg.currentWorkspace || trustInfo.project_path || "";
          activeModelId = currentConfig.default_model || "";
          activeModelProvider = (currentConfig.default_provider || "").toLowerCase();

          const setEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
          };

          setEl("model-count-badge", allModels.length);
          setEl("skills-count-badge", allSkills.length);
          setEl("installed-skills-num", allSkills.length);
          setEl("remote-skills-num", allRemoteSkills.length);

          if (currentConfig.default_profile && selectProfile) selectProfile.value = currentConfig.default_profile;
          if (currentConfig.permission_mode && selectMode) selectMode.value = currentConfig.permission_mode.toLowerCase();
          if (currentConfig.reasoning_effort && selectReasoning) selectReasoning.value = currentConfig.reasoning_effort;
          if (currentConfig.user_name && inputUserName) inputUserName.value = currentConfig.user_name;
          if (currentConfig.user_email && inputUserEmail) inputUserEmail.value = currentConfig.user_email;
          if (currentConfig.max_subagents && selectMaxSubagents) selectMaxSubagents.value = String(currentConfig.max_subagents);
          if (checkAutoCompact) checkAutoCompact.checked = currentConfig.auto_compact !== false;
          if (checkSound) checkSound.checked = msg.soundNotifications !== false;

          const usage = msg.usage || {};
          setEl("stat-tokens", (usage.session_tokens || 0).toLocaleString());
          setEl("stat-cost", "$" + (usage.session_cost_usd || 0).toFixed(4));
          setEl("stat-messages", usage.message_count || 0);

          const sys = msg.systemInfo || {};
          if (sys.version) setEl("diag-version", "v" + sys.version);
          if (sys.python_version) setEl("diag-py-ver", sys.python_version);
          if (sys.python_executable) setEl("diag-py-exe", sys.python_executable);
          if (sys.os) setEl("diag-os", sys.os);
          if (sys.pid) setEl("diag-pid", sys.pid);
          if (sys.tools_count) setEl("diag-tools-count", sys.tools_count + " Tools Active");

          const diagTools = document.getElementById("diag-tools-list");
          if (diagTools && sys.tools && sys.tools.length) {
            diagTools.innerHTML = sys.tools.map(t => '<span class="badge blue">' + escapeHtml(t) + '</span>').join('');
          }

          allCrons = msg.crons || [];
          renderModels();
          renderProviders();
          renderSkills();
          renderMcp();
          renderCrons();
          renderTrust();
          break;
        }
        case "models_refreshed": {
          iconRefresh.classList.remove("spinning");
          refreshLabel.textContent = "Refresh Catalog";
          allModels = msg.models || [];
          document.getElementById("model-count-badge").textContent = allModels.length;
          renderModels();
          break;
        }
        case "refresh_failed": {
          iconRefresh.classList.remove("spinning");
          refreshLabel.textContent = "Refresh Catalog";
          break;
        }
        case "model_selected": {
          activeModelId = msg.modelId;
          if (msg.provider) activeModelProvider = msg.provider.toLowerCase();
          renderModels();
          updateActiveBanner();
          break;
        }
        case "setting_updated": {
          if (msg.key === "mode") {
            selectMode.value = msg.value.toLowerCase();
          }
          break;
        }
        case "providers_updated": {
          allProviders = msg.providers || [];
          renderProviders();
          break;
        }
        case "remote_skills_loaded": {
          allRemoteSkills = msg.remoteSkills || [];
          const remoteNumEl = document.getElementById("remote-skills-num");
          if (remoteNumEl) remoteNumEl.textContent = allRemoteSkills.length;
          renderSkills();
          break;
        }
      }
    });

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function formatCtx(limit) {
      if (!limit) return "";
      if (typeof limit === "string") return limit;
      if (limit >= 1000000) return (limit / 1000000).toFixed(1).replace(/\\.0$/, "") + "M ctx";
      if (limit >= 1000) return Math.round(limit / 1000) + "K ctx";
      return limit + " ctx";
    }

    window.selectModel = function(modelId, provider) {
      activeModelId = modelId;
      activeModelProvider = (provider || "").toLowerCase();
      renderModels();
      updateActiveBanner();
      vscode.postMessage({ type: "select_model", modelId, provider });
    };

    window.saveKey = function(providerId) {
      const input = document.getElementById("key-input-" + providerId);
      if (!input) return;
      const key = input.value.trim();
      vscode.postMessage({ type: "set_api_key", provider: providerId, apiKey: key });
      input.value = "";
    };

    window.openExternalUrl = function(url) {
      vscode.postMessage({ type: "open_url", url });
    };

    window.revokeTrustPath = function(path) {
      vscode.postMessage({ type: "revoke_trust", path });
    };

    window.installSkill = function(name, sourceId) {
      vscode.postMessage({ type: "install_skill", name, sourceId });
    };

    function renderTrust() {
      const isTrusted = trustInfo.is_trusted;
      const badge = document.getElementById("trust-status-badge");
      const btn = document.getElementById("btn-toggle-current-trust");
      const desc = document.getElementById("trust-current-status-desc");

      if (isTrusted) {
        badge.className = "badge green";
        badge.textContent = "Trusted Workspace";
        btn.className = "btn btn-danger";
        btn.textContent = "Revoke Trust";
        desc.textContent = "Folder: " + (currentWorkspacePath || "Current Project") + " (Write and shell execution fully enabled)";
      } else {
        badge.className = "badge orange";
        badge.textContent = "Untrusted / Restricted";
        btn.className = "btn";
        btn.textContent = "Trust Folder";
        desc.textContent = "Folder: " + (currentWorkspacePath || "Current Project") + " (Restricted Mode — file writes and shell commands require confirmation)";
      }

      const list = document.getElementById("trusted-folders-list");
      const projects = trustInfo.trusted_projects || [];
      if (projects.length === 0) {
        list.innerHTML = \`<div style="color: var(--text-muted); font-size: 12px;">No trusted folders recorded yet.</div>\`;
        return;
      }

      list.innerHTML = projects.map(p => \`
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); border-radius: 4px;">
          <div>
            <div style="font-size: 12px; font-weight: 500; word-break: break-all;">\${escapeHtml(p.path)}</div>
            <div style="font-size: 10px; color: var(--text-muted);">Trusted at: \${escapeHtml(p.trusted_at ? p.trusted_at.slice(0,10) : 'N/A')}</div>
          </div>
          <button class="btn btn-danger" style="padding: 3px 8px; font-size: 11px;" onclick="revokeTrustPath('\${escapeHtml(p.path)}')">Revoke</button>
        </div>
      \`).join("");
    }

    function updateActiveBanner() {
      const banner = document.getElementById("active-model-banner");
      if (!banner) return;
      if (!activeModelId) { banner.style.display = "none"; return; }
      const foundExact = allModels.find(m => m.id === activeModelId && (m.provider||"").toLowerCase() === activeModelProvider.toLowerCase());
      const fallback = allModels.find(m => m.id === activeModelId);
      const target = foundExact || fallback;
      if (!target) {
        banner.style.display = "flex";
        document.getElementById("active-banner-provider").textContent = activeModelProvider || "unknown";
        document.getElementById("active-banner-name").textContent = activeModelId;
        document.getElementById("active-banner-id").textContent = activeModelId;
        const ctxEl = document.getElementById("active-banner-ctx");
        if (ctxEl) ctxEl.style.display = "none";
        const prEl = document.getElementById("active-banner-pricing");
        if (prEl) prEl.textContent = "";
        return;
      }
      banner.style.display = "flex";
      document.getElementById("active-banner-provider").textContent = target.provider;
      document.getElementById("active-banner-name").textContent = target.name || target.id;
      document.getElementById("active-banner-id").textContent = target.id;
      const ctxStr = target.context || formatCtx(target.context_limit);
      const ctxEl = document.getElementById("active-banner-ctx");
      if (ctxEl) {
        if (ctxStr) { ctxEl.textContent = ctxStr; ctxEl.style.display = "inline-flex"; } else ctxEl.style.display = "none";
      }
      const prEl = document.getElementById("active-banner-pricing");
      if (prEl) prEl.textContent = target.is_free ? "Free Tier" : (target.pricing || "");
    }

    function renderModels() {
      const grid = document.getElementById("models-grid");
      updateActiveBanner();
      const filtered = allModels.filter(m => {
        if (activeProvider !== "all" && m.provider !== activeProvider) {
          return false;
        }

        if (activeCategory !== "all") {
          const tags = m.tags || [];
          if (activeCategory === "free" && !m.is_free && !tags.includes("free")) return false;
          if (activeCategory === "coding" && !tags.includes("coding")) return false;
          if (activeCategory === "reasoning" && !tags.includes("reasoning")) return false;
          if (activeCategory === "vision" && !tags.includes("vision")) return false;
          if (activeCategory === "flagship" && !tags.includes("flagship")) return false;
        }

        if (searchQuery) {
          const hay = ((m.name || "") + " " + (m.id || "") + " " + (m.provider || "") + " " + (m.desc || "")).toLowerCase();
          if (!hay.includes(searchQuery)) return false;
        }

        return true;
      });

      if (filtered.length === 0) {
        grid.innerHTML = \`
          <div class="empty-state" style="grid-column: 1 / -1;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <div>No matching models found. Try clearing filters or refreshing catalog.</div>
          </div>
        \`;
        return;
      }

      grid.innerHTML = filtered.map(m => {
        const isActive = m.id === activeModelId && (m.provider||"").toLowerCase() === activeModelProvider.toLowerCase();
        const ctxStr = m.context || formatCtx(m.context_limit);
        const pricingStr = m.is_free ? "Free Tier" : (m.pricing || "");

        return \`
          <div class="model-card \${isActive ? 'active-model' : ''}">
            <div class="model-card-top">
              <div class="model-header-row">
                <div>
                  <div class="model-name">\${escapeHtml(m.name || m.id)}</div>
                  <div class="model-id">\${escapeHtml(m.id)}</div>
                </div>
                <span class="badge blue">\${escapeHtml(m.provider)}</span>
              </div>
              <div class="model-desc">\${escapeHtml(m.desc || "High-performance AI model.")}</div>
              <div class="model-badges">
                \${ctxStr ? \`<span class="badge purple">\${escapeHtml(ctxStr)}</span>\` : ''}
                \${m.is_free ? \`<span class="badge green">Free Tier</span>\` : ''}
                \${(m.tags || []).includes('coding') ? \`<span class="badge orange">Coding</span>\` : ''}
                \${(m.tags || []).includes('reasoning') ? \`<span class="badge blue">Reasoning</span>\` : ''}
              </div>
            </div>

            <div class="model-card-bottom">
              <div class="model-pricing \${m.is_free ? 'free' : ''}">\${escapeHtml(pricingStr)}</div>
              \${isActive
                ? \`<span class="active-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg> Active</span>\`
                : \`<button class="select-btn" onclick="selectModel('\${escapeHtml(m.id)}', '\${escapeHtml(m.provider)}')">Select Model</button>\`
              }
            </div>
          </div>
        \`;
      }).join("");
    }

    function renderProviders() {
      const grid = document.getElementById("keys-grid");
      const providerMeta = {
        openrouter: { name: "OpenRouter", desc: "Access 396+ models across Claude, GPT, Gemini, Llama, DeepSeek with unified billing.", portal: "https://openrouter.ai/keys" },
        anthropic: { name: "Anthropic", desc: "Direct access to Claude Opus 4.6, Claude Sonnet 4.6/3.7, and Claude Haiku.", portal: "https://console.anthropic.com/settings/keys" },
        openai: { name: "OpenAI", desc: "Direct access to GPT-4o, GPT-4.1, o1, o3, and o4-mini models.", portal: "https://platform.openai.com/api-keys" },
        google: { name: "Google Gemini", desc: "Direct access to Gemini 2.5 Pro, 2.5 Flash, and Gemini 2.0 Flash.", portal: "https://aistudio.google.com/app/apikey" },
        deepseek: { name: "DeepSeek", desc: "DeepSeek V3 and DeepSeek R1 reasoning models.", portal: "https://platform.deepseek.com/api_keys" },
        groq: { name: "Groq Cloud", desc: "Ultra-low-latency inference for Llama 3.3 70B and Mixtral.", portal: "https://console.groq.com/keys" },
        nvidia: { name: "NVIDIA NIM", desc: "NVIDIA GPU cloud hardware accelerated open models.", portal: "https://build.nvidia.com/" },
        ollama: { name: "Ollama (Local)", desc: "Local offline models running on your machine.", portal: "https://ollama.com" }
      };

      grid.innerHTML = allProviders.map(p => {
        const meta = providerMeta[p.id] || { name: p.name || p.id, desc: "AI Provider API", portal: p.portal || "" };
        const hasKey = p.has_key || p.id === "ollama";

        return \`
          <div class="item-card">
            <div class="item-card-top">
              <div class="item-card-title">
                <span class="status-dot \${hasKey ? 'connected' : ''}"></span>
                <span>\${escapeHtml(meta.name)}</span>
              </div>
              <span class="badge \${hasKey ? 'green' : ''}">\${hasKey ? 'Connected' : 'Missing Key'}</span>
            </div>

            <div class="item-card-desc">\${escapeHtml(meta.desc)}</div>

            \${p.id !== 'ollama' ? \`
              <div class="key-input-row">
                <input type="password" class="key-input" id="key-input-\${p.id}" placeholder="\${hasKey ? '•••••••••••••••• (Configured)' : 'Paste API Key here…'}">
                <button class="btn" onclick="saveKey('\${p.id}')">Save</button>
              </div>
              \${meta.portal ? \`<a class="portal-link" onclick="openExternalUrl('\${meta.portal}')">Get API Key &rarr;</a>\` : ''}
            \` : \`
              <div class="item-card-desc" style="color: var(--tag-green-fg); font-weight: 500;">Ready (No key required for local Ollama daemon)</div>
            \`}
          </div>
        \`;
      }).join("");
    }

    function renderSkills() {
      const grid = document.getElementById("skills-grid");
      if (activeSkillsTab === "installed") {
        if (allSkills.length === 0) {
          grid.innerHTML = \`
            <div class="empty-state" style="grid-column: 1 / -1;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
              <div>No skills installed yet. Switch to "Browse Online Registry" to install instruction packs.</div>
            </div>
          \`;
          return;
        }
        grid.innerHTML = allSkills.map(s => \`
          <div class="item-card">
            <div class="item-card-top">
              <div class="item-card-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                <span>\${escapeHtml(s.name)}</span>
              </div>
              <span class="badge purple">\${escapeHtml(s.scope || 'skill')}</span>
            </div>
            <div class="item-card-desc">\${escapeHtml(s.description || 'Custom agent workflow skill.')}</div>
            <div style="font-size: 11px; font-family: monospace; color: var(--text-muted); word-break: break-all;">\${escapeHtml(s.path || '')}</div>
          </div>
        \`).join("");
      } else {
        if (allRemoteSkills.length === 0) {
          grid.innerHTML = \`
            <div class="empty-state" style="grid-column: 1 / -1;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
              <div>Connecting to GitHub registries (Anthropic & Community)...</div>
            </div>
          \`;
          return;
        }
        grid.innerHTML = allRemoteSkills.map(r => \`
          <div class="item-card">
            <div class="item-card-top">
              <div class="item-card-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                <span>\${escapeHtml(r.name)}</span>
              </div>
              <span class="badge blue">\${escapeHtml(r.source_label || r.source_id)}</span>
            </div>
            <div class="item-card-desc">\${escapeHtml(r.description || 'Remote instruction pack from ' + r.repo)}</div>
            <div style="display: flex; justify-content: flex-end; margin-top: 6px;">
              <button class="btn" style="padding: 3px 8px; font-size: 11px;" onclick="installSkill('\${escapeHtml(r.name)}', '\${escapeHtml(r.source_id)}')">Install Skill</button>
            </div>
          </div>
        \`).join("");
      }
    }

    function renderMcp() {
      const grid = document.getElementById("mcp-grid");
      if (allMcpServers.length === 0) {
        grid.innerHTML = \`
          <div class="empty-state" style="grid-column: 1 / -1;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M9 9h6v6H9z"></path></svg>
            <div>No external MCP servers configured. Add servers in your config.toml or mcp_config.json.</div>
          </div>
        \`;
        return;
      }
      grid.innerHTML = allMcpServers.map(s => \`
        <div class="item-card">
          <div class="item-card-top">
            <div class="item-card-title">
              <span class="status-dot connected"></span>
              <span>\${escapeHtml(s.name)}</span>
            </div>
            <span class="badge blue">\${s.tools_count || 0} tools</span>
          </div>
          <div class="item-card-desc"><code>\${escapeHtml(s.command)} \${(s.args || []).join(' ')}</code></div>
        </div>
      \`).join("");
    }

    let allCrons = [];

    // Crons Management
    const btnToggleAddCron = document.getElementById("btn-toggle-add-cron");
    const cronCreateForm = document.getElementById("cron-create-form");
    const btnCancelCron = document.getElementById("btn-cancel-cron");
    const btnSaveCron = document.getElementById("btn-save-cron");
    const btnRefreshCrons = document.getElementById("btn-refresh-crons");

    if (btnToggleAddCron && cronCreateForm) {
      btnToggleAddCron.addEventListener("click", () => {
        const isHidden = cronCreateForm.style.display === "none";
        cronCreateForm.style.display = isHidden ? "flex" : "none";
        btnToggleAddCron.textContent = isHidden ? "✕ Close Form" : "+ New Cron Job";
      });
    }

    if (btnCancelCron && cronCreateForm) {
      btnCancelCron.addEventListener("click", () => {
        cronCreateForm.style.display = "none";
        if (btnToggleAddCron) btnToggleAddCron.textContent = "+ New Cron Job";
      });
    }

    if (btnSaveCron) {
      btnSaveCron.addEventListener("click", () => {
        const nameInput = document.getElementById("cron-name-input");
        const scheduleSelect = document.getElementById("cron-schedule-select");
        const promptInput = document.getElementById("cron-prompt-input");
        const name = (nameInput ? nameInput.value : "").trim();
        const schedule = scheduleSelect ? scheduleSelect.value : "every 1h";
        const prompt = (promptInput ? promptInput.value : "").trim();

        if (!prompt) {
          alert("Please enter a prompt or instruction for the cron job.");
          return;
        }

        vscode.postMessage({
          type: "cron_create",
          payload: {
            name: name || "Scheduled Job",
            schedule: schedule,
            prompt: prompt,
            model: activeModelId,
            provider: activeModelProvider,
          }
        });

        if (nameInput) nameInput.value = "";
        if (promptInput) promptInput.value = "";
        if (cronCreateForm) cronCreateForm.style.display = "none";
        if (btnToggleAddCron) btnToggleAddCron.textContent = "+ New Cron Job";
      });
    }

    if (btnRefreshCrons) {
      btnRefreshCrons.addEventListener("click", () => {
        vscode.postMessage({ type: "ready" });
      });
    }

    window.toggleCron = function(id) {
      vscode.postMessage({ type: "cron_toggle", id });
    };

    const cronContainer = document.getElementById("cron-list-container");
    if (cronContainer) {
      cronContainer.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === "toggle") {
          vscode.postMessage({ type: "cron_toggle", id });
        } else if (action === "run") {
          const name = btn.dataset.name || "";
          const prompt = decodeURIComponent(btn.dataset.prompt || "");
          vscode.postMessage({ type: "cron_run_now", id, name, prompt });
        } else if (action === "delete") {
          if (confirm("Are you sure you want to delete this scheduled cron job?")) {
            vscode.postMessage({ type: "cron_delete", id });
          }
        }
      });
    }

    function renderCrons() {
      const container = document.getElementById("cron-list-container");
      const badge = document.getElementById("crons-count-badge");
      if (badge) badge.textContent = allCrons.length;
      if (!container) return;

      if (!allCrons || allCrons.length === 0) {
        container.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg><div>No scheduled cron jobs configured yet. Click <strong>+ New Cron Job</strong> above to automate background tests, reviews, or diagnostics.</div></div>';
        return;
      }

      container.innerHTML = allCrons.map(job => {
        const isEnabled = job.enabled !== false;
        const lastStatus = job.last_status || "never";
        const statusClass = isEnabled ? "active" : "paused";
        const statusLabel = isEnabled ? "Active" : "Paused";
        const lastRun = job.last_run ? new Date(job.last_run).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Never run";
        const promptEnc = encodeURIComponent(job.prompt || '');

        return '<div class="cron-card">' +
          '<div class="cron-card-left">' +
            '<div class="cron-card-title-row">' +
              '<span class="cron-card-name">' + escapeHtml(job.name || job.id) + '</span>' +
              '<span class="cron-interval-pill">' + escapeHtml(job.schedule || 'every 1h') + '</span>' +
              '<span class="cron-status-pill ' + statusClass + '">' + statusLabel + '</span>' +
            '</div>' +
            '<div class="cron-card-prompt">' + escapeHtml(job.prompt || '') + '</div>' +
            '<div class="cron-card-meta">' +
              '<span>Runs: ' + (job.run_count || 0) + '</span>' +
              '<span>Last: ' + escapeHtml(lastRun) + ' (' + escapeHtml(lastStatus) + ')</span>' +
              (job.model ? ('<span>Model: ' + escapeHtml(job.model) + '</span>') : '') +
            '</div>' +
          '</div>' +
          '<div class="cron-card-actions">' +
            '<button class="btn btn-secondary" data-action="toggle" data-id="' + escapeHtml(job.id) + '">' + (isEnabled ? 'Pause' : 'Enable') + '</button>' +
            '<button class="btn" data-action="run" data-id="' + escapeHtml(job.id) + '" data-name="' + escapeHtml(job.name || '') + '" data-prompt="' + promptEnc + '">Run Now</button>' +
            '<button class="btn btn-danger" data-action="delete" data-id="' + escapeHtml(job.id) + '">✕</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
