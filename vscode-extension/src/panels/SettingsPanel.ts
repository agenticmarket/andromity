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
        this._rpcClient.call<any>("config.get", { project_path: workspaceFolder }, 15000).catch(() => ({})),
        this._rpcClient.call<ModelInfo[]>("config.list_models", {}, 15000).catch(() => []),
        this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}, 15000).catch(() => []),
        this._rpcClient.call<any[]>("skills.list", { project_path: workspaceFolder }, 15000).catch(() => []),
        this._rpcClient.call<any[]>("mcp.list", { project_path: workspaceFolder }, 15000).catch(() => []),
        this._rpcClient.call<any>("usage.get", { project_path: workspaceFolder, time_range: "all" }, 15000).catch(() => ({})),
        this._rpcClient.call<any>("system.info", {}, 15000).catch(() => ({})),
        this._rpcClient.call<any>("trust.status", { project_path: workspaceFolder }, 15000).catch(() => ({ is_trusted: true, trusted_projects: [] })),
        this._rpcClient.call<any[]>("cron.list", { project_path: workspaceFolder }, 15000).catch(() => []),
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
        soundNotifications: vscodeConfig.get<boolean>("soundNotifications", true) && configData?.sound_done !== false,
        telemetry: vscodeConfig.get<boolean>("telemetry", true) && configData?.telemetry !== false,
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
        try {
          await this._rpcClient?.call("config.set", {
            section: "default",
            key: "sound_done",
            value: message.value,
          });
          await this._rpcClient?.call("config.set", {
            section: "default",
            key: "sound_attention",
            value: message.value,
          });
        } catch (e) {}
        this._panel.webview.postMessage({
          type: "setting_updated",
          key: "soundNotifications",
          value: message.value,
        });
        this._onConfigChangeCallback?.();
        break;
      }

      case "toggle_telemetry": {
        const config = vscode.workspace.getConfiguration("andromity");
        await config.update("telemetry", message.value, vscode.ConfigurationTarget.Global);
        try {
          await this._rpcClient?.call("config.set", {
            section: "default",
            key: "telemetry",
            value: message.value,
          });
        } catch (e) {}
        this._panel.webview.postMessage({
          type: "setting_updated",
          key: "telemetry",
          value: message.value,
        });
        this._onConfigChangeCallback?.();
        break;
      }

      case "open_url": {
        if (message.url && typeof message.url === "string" && message.url.startsWith("https://")) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      }

      case "check_setup": {
        vscode.commands.executeCommand("andromity.checkSetup");
        break;
      }

      case "restartDaemon": {
        vscode.commands.executeCommand("andromity.restartServer");
        break;
      }

      case "configure_python_path": {
        // Keep for backwards compat but open settings instead
        vscode.commands.executeCommand("workbench.action.openSettings", "andromity.pythonPath");
        break;
      }

      case "fetch_usage": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const usage = await this._rpcClient.call<any>("usage.get", {
            time_range: message.timeRange || "all",
            project_path: workspaceFolder,
          }, 3000).catch(() => ({}));
          this._panel.webview.postMessage({
            type: "usage_loaded",
            usage: usage || {},
            timeRange: message.timeRange || "all",
          });
        } catch (err: any) {
          console.error("[SettingsPanel] Failed to fetch usage:", err);
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
          const confirm = await vscode.window.showWarningMessage(
            "Are you sure you want to delete this scheduled cron job?",
            { modal: true },
            "Delete"
          );
          if (confirm !== "Delete") break;

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
          await this._rpcClient.call("cron.run_now", {
            id: message.id,
            project_path: workspaceFolder,
          });
          await this.loadData();
          if (message.prompt) {
            await vscode.commands.executeCommand("andromity.sendPrompt", message.prompt);
          }
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to trigger cron job: ${e.message}`);
        }
        break;
      }

      case "fetch_cron_runs": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const runs = await this._rpcClient.call<any[]>("cron.runs", {
            id: message.id,
            project_path: workspaceFolder,
          });
          this._panel.webview.postMessage({
            type: "cron_runs_loaded",
            jobId: message.id,
            runs: runs || [],
          });
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to fetch cron history: ${e.message}`);
        }
        break;
      }

      case "mcp_restart": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const name = message.name || message.server_name;
          if (!name) throw new Error("Server name missing");
          vscode.window.showInformationMessage(`Restarting MCP server '${name}'...`);
          const res = await this._rpcClient.call<any>("mcp.restart", { name, project_path: workspaceFolder }, 30000);
          if (res && res.success !== false) {
            vscode.window.showInformationMessage(`MCP '${name}' restarted (${res.status || 'running'}).`);
          } else {
            vscode.window.showWarningMessage(`MCP '${name}' restart returned: ${res?.error || 'unknown'}`);
          }
          const mcpServers = await this._rpcClient.call<any[]>("mcp.list", { project_path: workspaceFolder }, 10000).catch(() => []);
          this._panel.webview.postMessage({ type: "mcp_refreshed", mcpServers: mcpServers || [] });
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to restart MCP server: ${e.message}`);
          this._panel.webview.postMessage({ type: "mcp_refresh_failed" });
        }
        break;
      }

      case "mcp_toggle":
      case "mcp_enable":
      case "mcp_disable": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const name = message.name || message.server_name;
          if (!name) throw new Error("Server name missing");
          // Determine desired disabled state: message.disabled true => disable, false => enable
          // For explicit enable/disable messages, infer from type
          let shouldDisable: boolean;
          if (message.type === "mcp_enable") shouldDisable = false;
          else if (message.type === "mcp_disable") shouldDisable = true;
          else shouldDisable = !!message.disabled;
          const method = shouldDisable ? "mcp.disable" : "mcp.enable";
          const res = await this._rpcClient.call<any>(method, { name, project_path: workspaceFolder }, 30000);
          if (res && res.success !== false) {
            vscode.window.showInformationMessage(`MCP '${name}' ${shouldDisable ? 'disabled' : 'enabled'} (${res.status || ''}).`);
          } else {
            vscode.window.showWarningMessage(`MCP toggle failed: ${res?.error || 'unknown'}`);
          }
          const mcpServers = await this._rpcClient.call<any[]>("mcp.list", { project_path: workspaceFolder }, 10000).catch(() => []);
          this._panel.webview.postMessage({ type: "mcp_refreshed", mcpServers: mcpServers || [] });
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to toggle MCP server: ${e.message}`);
          this._panel.webview.postMessage({ type: "mcp_refresh_failed" });
        }
        break;
      }

      case "mcp_auth":
      case "mcp_authenticate": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const name = message.name || message.server_name;
          if (!name) throw new Error("Server name missing");
          vscode.window.showInformationMessage(`Starting OAuth authentication for '${name}' in browser...`);
          const res = await this._rpcClient.call<any>("mcp.authenticate", { name, project_path: workspaceFolder }, 130000);
          if (res && res.success !== false) {
            vscode.window.showInformationMessage(`MCP '${name}' authenticated successfully!`);
          } else {
            vscode.window.showWarningMessage(`MCP auth failed: ${res?.error || 'Unknown error'}`);
          }
          const mcpServers = await this._rpcClient.call<any[]>("mcp.list", { project_path: workspaceFolder }, 10000).catch(() => []);
          this._panel.webview.postMessage({ type: "mcp_refreshed", mcpServers: mcpServers || [] });
        } catch (e: any) {
          vscode.window.showErrorMessage(`OAuth auth error: ${e.message}`);
          this._panel.webview.postMessage({ type: "mcp_refresh_failed" });
        }
        break;
      }

      case "refresh_mcp":
      case "fetch_mcp": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const mcpServers = await this._rpcClient.call<any[]>("mcp.list", { project_path: workspaceFolder }, 10000).catch(() => []);
          this._panel.webview.postMessage({ type: "mcp_refreshed", mcpServers: mcpServers || [] });
        } catch (e: any) {
          this._panel.webview.postMessage({ type: "mcp_refresh_failed" });
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

    /* Usage Analytics Styles */
    .usage-progress-bar-wrap {
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 4px;
    }
    .usage-progress-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.4s ease;
    }
    .usage-item-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid var(--card-border);
      border-radius: 6px;
    }
    .usage-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
    }
    .usage-chart-svg {
      width: 100%;
      height: 160px;
      display: block;
    }
    .chart-bar {
      fill: #2ea043;
      rx: 2;
      ry: 2;
      transition: fill 0.15s, opacity 0.15s;
      cursor: pointer;
    }
    .chart-bar:hover {
      fill: #3fb950;
      opacity: 0.9;
    }
    .chart-axis {
      font-size: 10px;
      fill: var(--text-muted);
      text-anchor: middle;
      font-family: var(--font-family);
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

    /* ─── Interactive Usage Analytics Chart & Tooltip ───────────────────────── */
    .chart-wrapper {
      position: relative;
      width: 100%;
      min-height: 180px;
    }

    .usage-chart-svg {
      width: 100%;
      height: auto;
      display: block;
      overflow: visible;
    }

    .chart-grid-line {
      stroke: rgba(255, 255, 255, 0.06);
      stroke-dasharray: 4 4;
      stroke-width: 1;
    }

    .chart-grid-label {
      font-size: 10px;
      fill: var(--text-muted, #71717a);
      font-family: var(--font, sans-serif);
      font-variant-numeric: tabular-nums;
    }

    .chart-col-bg {
      fill: transparent;
      transition: fill 0.15s ease;
      cursor: pointer;
    }

    .chart-col-group:hover .chart-col-bg,
    .chart-col-group.active .chart-col-bg {
      fill: rgba(255, 255, 255, 0.05);
    }

    .chart-bar {
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      cursor: pointer;
    }

    .chart-col-group:hover .chart-bar,
    .chart-col-group.active .chart-bar {
      filter: drop-shadow(0 0 10px rgba(9, 249, 148, 0.6));
      opacity: 1 !important;
    }

    .chart-axis-label {
      font-size: 10.5px;
      fill: var(--text-muted, #888888);
      font-family: var(--font, sans-serif);
      text-anchor: middle;
      font-weight: 500;
      transition: fill 0.15s ease;
    }

    .chart-col-group:hover .chart-axis-label,
    .chart-col-group.active .chart-axis-label {
      fill: var(--text, #ffffff);
      font-weight: 600;
    }

    /* Floating Interactive Tooltip */
    .chart-tooltip {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      background: rgba(18, 18, 22, 0.96);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 9px;
      padding: 10px 14px;
      font-size: 12px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.3);
      z-index: 1000;
      opacity: 0;
      transform: translate(-50%, -100%) translateY(-8px);
      transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      white-space: nowrap;
      min-width: 175px;
    }

    .chart-tooltip.visible {
      opacity: 1;
      transform: translate(-50%, -100%) translateY(-12px);
    }

    .chart-tooltip-header {
      font-weight: 600;
      color: #f4f4f5;
      font-size: 12px;
      margin-bottom: 6px;
      padding-bottom: 5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .chart-tooltip-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .chart-tooltip-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 11.5px;
    }

    .chart-tooltip-row .label {
      color: #a1a1aa;
    }

    .chart-tooltip-row .val {
      font-weight: 600;
      color: #f4f4f5;
      font-variant-numeric: tabular-nums;
    }

    .chart-tooltip-row .val.green {
      color: #09F994;
    }

    /* Usage Breakdown Rows */
    .usage-item-row {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 6px;
      padding: 10px 12px;
      transition: all 0.15s ease;
    }

    .usage-item-row:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(9, 249, 148, 0.25);
    }

    .usage-item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .usage-progress-bar-wrap {
      width: 100%;
      height: 5px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 3px;
      overflow: hidden;
    }

    .usage-progress-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
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
              <option value="custom">Custom Schedule Expression...</option>
            </select>
            <input type="text" id="cron-custom-schedule" style="display:none; margin-top:6px;" placeholder="e.g. every 45m or every 3h">
          </div>
        </div>
        <div class="cron-form-row">
          <div class="cron-form-col">
            <label>AI Model</label>
            <select id="cron-model-select">
              <option value="">Default Active Model</option>
            </select>
          </div>
          <div class="cron-form-col">
            <label>Allowed Shell Commands (Optional)</label>
            <input type="text" id="cron-commands-input" placeholder="e.g. pytest, npm test, git status">
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
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btn-secondary" id="btn-refresh-mcp">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <span>Refresh</span>
          </button>
        </div>
      </div>
      <div class="cards-grid" id="mcp-grid"></div>
    </div>

    <!-- ── TAB 5: USAGE & COSTS ─────────────────────────────────────── -->
    <div class="tab-pane" id="pane-usage">
      <div class="section-header">
        <div>
          <h2 class="section-title">Usage & Cost Analytics</h2>
          <p class="section-desc">Track token volume, estimated API expenditure, model usage share, and session history.</p>
        </div>
        <div class="filter-chips" id="usage-range-chips" style="margin: 0;">
          <div class="chip active" data-usage-range="all">All Time</div>
          <div class="chip" data-usage-range="month">30 Days</div>
          <div class="chip" data-usage-range="week">7 Days</div>
          <div class="chip" data-usage-range="today">Today</div>
        </div>
      </div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-val" id="stat-usage-tokens">0</div>
          <div class="stat-lbl">Total Tokens</div>
        </div>
        <div class="stat-card">
          <div class="stat-val" id="stat-usage-cost">$0.0000</div>
          <div class="stat-lbl">Estimated Cost (USD)</div>
        </div>
        <div class="stat-card">
          <div class="stat-val" id="stat-usage-sessions">0</div>
          <div class="stat-lbl">Total Sessions</div>
        </div>
        <div class="stat-card">
          <div class="stat-val" id="stat-usage-avg">0</div>
          <div class="stat-lbl">Avg Tokens / Session</div>
        </div>
      </div>

      <!-- GitHub-Style Daily Activity Chart -->
      <div class="settings-card" style="margin-top: 14px;">
        <div class="setting-label" style="display:flex; justify-content:space-between; align-items:center;">
          <span>Daily Token Activity (GitHub Style)</span>
          <span style="font-size:11px; font-weight:normal; color:var(--text-muted);">Last 14 Days</span>
        </div>
        <div id="usage-chart-container" style="margin-top: 12px; overflow-x: auto;"></div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin-top: 14px;">
        <!-- Model Distribution Breakdown -->
        <div class="settings-card">
          <div class="setting-label">Model Distribution</div>
          <div class="setting-desc">Token consumption breakdown across AI models</div>
          <div id="usage-models-breakdown" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
        </div>

        <!-- Provider Distribution Breakdown -->
        <div class="settings-card">
          <div class="setting-label">Provider Distribution</div>
          <div class="setting-desc">Token share across configured API providers</div>
          <div id="usage-providers-breakdown" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
        </div>
      </div>

      <!-- Recent Sessions Table -->
      <div class="settings-card" style="margin-top: 14px;">
        <div class="setting-label">Recent Session Activity</div>
        <div class="setting-desc">Detailed log of past agent conversations and token volume</div>
        <div style="overflow-x: auto; margin-top: 10px;">
          <table class="diag-table" id="usage-sessions-table">
            <thead>
              <tr style="background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--card-border);">
                <th style="text-align:left; padding:8px 12px; font-size:11px; color:var(--text-muted);">Session Name</th>
                <th style="text-align:left; padding:8px 12px; font-size:11px; color:var(--text-muted);">Model / Provider</th>
                <th style="text-align:right; padding:8px 12px; font-size:11px; color:var(--text-muted);">Tokens</th>
                <th style="text-align:right; padding:8px 12px; font-size:11px; color:var(--text-muted);">Cost (USD)</th>
                <th style="text-align:right; padding:8px 12px; font-size:11px; color:var(--text-muted);">Date</th>
              </tr>
            </thead>
            <tbody id="usage-sessions-body"></tbody>
          </table>
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
            <button class="btn btn-danger" id="btn-toggle-current-trust" data-action="toggle-current-trust">Revoke Trust</button>
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

        <div class="settings-card">
          <label class="checkbox-row">
            <input type="checkbox" id="setting-telemetry">
            <div>
              <div class="setting-label">Anonymous Telemetry</div>
              <div class="setting-desc">Anonymous ping on first launch to count users and edge performance. No code, keys, or file paths are ever transmitted.</div>
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
          <p class="section-desc">AI Engine runtime details, environment paths, and registered tool capabilities.</p>
        </div>
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px;">
        <button class="btn" data-action="run-setup-check">Run Diagnostics</button>
        <button class="btn btn-secondary" data-action="restart-daemon">Restart Engine</button>
      </div>

      <div class="settings-card" style="max-width: 800px; margin-bottom: 16px;">
        <table class="diag-table">
          <tr>
            <td>Andromity Version</td>
            <td id="diag-version">v0.2.3</td>
          </tr>
          <tr>
            <td>Engine Mode</td>
            <td id="diag-engine-mode">Loading...</td>
          </tr>
          <tr>
            <td>Runtime Version</td>
            <td id="diag-py-ver">Loading...</td>
          </tr>
          <tr>
            <td>AI Engine Executable</td>
            <td id="diag-py-exe" style="font-size:11px; word-break:break-all;">Loading...</td>
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

    window.onerror = function(msg, url, lineNo, columnNo, error) {
      console.error("[Andromity Settings Error]", msg, lineNo, columnNo, error);
      try {
        vscode.postMessage({
          type: "webview_error",
          message: String(msg),
          line: lineNo,
          col: columnNo,
          stack: error ? error.stack : ""
        });
      } catch(e) {}
    };
    window.addEventListener("unhandledrejection", function(event) {
      console.error("[Andromity Settings Unhandled Rejection]", event.reason);
    });

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
    let usageData = {};
    let currentUsageRange = "all";

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
    const checkTelemetry = document.getElementById("setting-telemetry");

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
    if (checkTelemetry) {
      checkTelemetry.addEventListener("change", () => {
        vscode.postMessage({ type: "toggle_telemetry", value: checkTelemetry.checked });
      });
    }

    // Delegated actions
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      
      if (action === "select-model") {
        selectModel(btn.dataset.id, btn.dataset.provider);
      } else if (action === "save-key") {
        saveKey(btn.dataset.id);
      } else if (action === "open-portal") {
        openExternalUrl(btn.dataset.url);
      } else if (action === "revoke-trust") {
        revokeTrustPath(btn.dataset.path);
      } else if (action === "toggle-current-trust") {
        const isTrusted = trustInfo.is_trusted;
        const targetPath = currentWorkspacePath || (trustInfo && trustInfo.project_path) || "";
        if (!targetPath) return;
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-block; width:9px; height:9px; border:1.5px solid currentColor; border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; margin-right:4px;"></span> Updating...';
        if (isTrusted) {
          vscode.postMessage({ type: "revoke_trust", path: targetPath });
        } else {
          vscode.postMessage({ type: "trust_folder", path: targetPath });
        }
      } else if (action === "restart-daemon") {
        vscode.postMessage({ command: "restartDaemon" });
      } else if (action === "run-setup-check") {
        vscode.postMessage({ type: "check_setup" });
      } else if (action === "configure-python-path") {
        vscode.postMessage({ type: "configure_python_path" });
      } else if (action === "install-python-web") {
        vscode.postMessage({ type: "install_python" });
      } else if (action === "install-skill") {
        const name = btn.dataset.skillName;
        const sourceId = btn.dataset.sourceId;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinning-loader"></span> Installing...';
        vscode.postMessage({ type: "install_skill", name, sourceId });
      } else if (action === "history") {
        vscode.postMessage({ type: "cron_run_history", id: btn.dataset.id });
      } else if (action === "mcp_restart") {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinning-loader"></span> Restarting...';
        vscode.postMessage({ type: "mcp_restart", name: btn.dataset.name });
      } else if (action === "mcp_toggle") {
        const disabled = btn.dataset.disabled === "true";
        btn.disabled = true;
        btn.innerHTML = '<span class="spinning-loader"></span> Working...';
        vscode.postMessage({ type: "mcp_toggle", name: btn.dataset.name, disabled });
      } else if (action === "mcp_auth") {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinning-loader"></span> Authenticating in browser...';
        vscode.postMessage({ type: "mcp_auth", name: btn.dataset.name });
      }
    });

    const usageRangeChips = document.getElementById("usage-range-chips");
    if (usageRangeChips) {
      usageRangeChips.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-usage-range]");
        if (!chip) return;
        usageRangeChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        currentUsageRange = chip.dataset.usageRange || "all";
        renderUsage();
        vscode.postMessage({ type: "fetch_usage", timeRange: currentUsageRange });
      });
    }

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
          usageData = msg.usage || {};
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
          if (checkTelemetry) checkTelemetry.checked = msg.telemetry !== false;

          const sys = msg.systemInfo || {};
          if (sys.version) setEl("diag-version", "v" + sys.version);

          // Engine mode: show badge style
          if (sys.engine_mode) {
            const modeEl = document.getElementById("diag-engine-mode");
            if (modeEl) {
              const isBundled = sys.is_bundled;
              modeEl.innerHTML = isBundled
                ? '<span style="color:#4ade80;font-weight:600;">⚡ ' + sys.engine_mode + ' (Zero-Python)</span>'
                : '<span style="color:#60a5fa;">' + sys.engine_mode + '</span>';
            }
          }

          if (sys.python_version) setEl("diag-py-ver", sys.python_version);
          if (sys.python_executable) setEl("diag-py-exe", sys.python_executable);
          if (sys.os) setEl("diag-os", sys.os);
          if (sys.pid) setEl("diag-pid", sys.pid);
          if (sys.tools_count) setEl("diag-tools-count", sys.tools_count + " Tools Active");

          const diagTools = document.getElementById("diag-tools-list");
          if (diagTools && sys.tools && sys.tools.length) {
            diagTools.innerHTML = sys.tools.map(t => '<span class="badge blue">' + escapeHtml(t) + '</span>').join('');
          }

          const cronModelSel = document.getElementById("cron-model-select");
          if (cronModelSel && allModels && allModels.length > 0) {
            cronModelSel.innerHTML = '<option value="">Default Active Model (' + escapeHtml(activeModelId) + ')</option>' +
              allModels.map(m => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name || m.id) + ' (' + escapeHtml(m.provider || '') + ')</option>').join('');
          }

          allCrons = msg.crons || [];
          renderModels();
          renderProviders();
          renderSkills();
          renderMcp();
          renderCrons();
          renderTrust();
          renderUsage();
          break;
        }
        case "usage_loaded": {
          usageData = msg.usage || {};
          renderUsage();
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
        case "mcp_refreshed": {
          allMcpServers = msg.mcpServers || [];
          renderMcp();
          break;
        }
        case "mcp_refresh_failed": {
          renderMcp();
          break;
        }
        case "remote_skills_loaded": {
          allRemoteSkills = msg.remoteSkills || [];
          const remoteNumEl = document.getElementById("remote-skills-num");
          if (remoteNumEl) remoteNumEl.textContent = allRemoteSkills.length;
          renderSkills();
          break;
        }
        case "cron_runs_loaded": {
          const runsDiv = document.getElementById("cron-runs-" + msg.jobId);
          if (runsDiv) {
            const runs = msg.runs || [];
            if (runs.length === 0) {
              runsDiv.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:4px 0;">No recorded runs yet for this job. Click "Run Now" to trigger.</div>';
            } else {
              runsDiv.innerHTML = '<div style="font-size:11px; font-weight:600; margin-bottom:8px; color:var(--fg); display:flex; justify-content:space-between; align-items:center;"><span>Execution History (' + runs.length + ' runs):</span><button class="btn btn-secondary" style="padding:1px 6px; font-size:10px;" data-action="history" data-id="' + escapeHtml(msg.jobId) + '">Refresh</button></div>' +
                runs.map(r => {
                  const runTime = r.started_at ? new Date(r.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown time';
                  const isOk = r.status === 'success';
                  const stClass = isOk ? 'active' : (r.status === 'running' ? 'badge blue' : 'paused');
                  const dur = r.duration_ms ? ((r.duration_ms / 1000).toFixed(1) + 's') : '';
                  const toolsStr = r.tools_used && r.tools_used.length > 0 ? r.tools_used.join(', ') : '';
                  const outText = r.output || r.output_preview || '';

                  return '<div style="display:flex; flex-direction:column; gap:4px; padding:8px 10px; background:rgba(255,255,255,0.03); margin-bottom:6px; font-size:11.5px; border:1px solid var(--border); border-radius:6px;">' +
                    '<div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">' +
                      '<div style="display:flex; align-items:center; gap:6px;">' +
                        '<span class="cron-status-pill ' + stClass + '" style="font-size:9.5px; padding:2px 6px;">' + escapeHtml((r.status || 'unknown').toUpperCase()) + '</span>' +
                        '<span style="font-weight:500;">' + escapeHtml(runTime) + '</span>' +
                      '</div>' +
                      '<div style="display:flex; align-items:center; gap:6px;">' +
                        (r.model ? ('<span style="color:var(--text-muted); font-size:10px;">' + escapeHtml(r.model) + '</span>') : '') +
                        (dur ? ('<span style="color:var(--accent); font-size:10.5px; font-weight:600;">' + escapeHtml(dur) + '</span>') : '') +
                      '</div>' +
                    '</div>' +
                    (toolsStr ? ('<div style="font-size:10.5px; color:var(--text-muted); margin-top:2px;"><span style="font-weight:600;">Tools:</span> ' + escapeHtml(toolsStr) + '</div>') : '') +
                    (outText ? (
                      '<details style="margin-top:4px; background:rgba(0,0,0,0.25); border:1px solid var(--border); border-radius:4px; padding:4px 8px;">' +
                        '<summary style="font-size:11px; font-weight:600; color:var(--accent); cursor:pointer; user-select:none;">AI Model Response Output</summary>' +
                        '<div style="font-family:var(--vscode-editor-font-family, monospace); font-size:11px; color:var(--fg); white-space:pre-wrap; line-height:1.5; margin-top:6px; max-height:220px; overflow-y:auto; padding-top:4px; border-top:1px solid rgba(255,255,255,0.06);">' + escapeHtml(outText) + '</div>' +
                      '</details>'
                    ) : '') +
                    (r.error ? ('<div style="color:var(--red); font-size:11px; margin-top:2px; padding:4px 6px; background:rgba(239,68,68,0.1); border-radius:4px; border:1px solid rgba(239,68,68,0.25);">Error: ' + escapeHtml(r.error) + '</div>') : '') +
                  '</div>';
                }).join('');
            }
          }
          break;
        }
        case "mcp_refreshed": {
          allMcpServers = msg.mcpServers || [];
          renderMcp();
          // reset refresh button if present
          const btn = document.getElementById("btn-refresh-mcp");
          if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg><span>Refresh</span>'; }
          break;
        }
        case "mcp_refresh_failed": {
          const btn2 = document.getElementById("btn-refresh-mcp");
          if (btn2) { btn2.disabled = false; }
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

    function formatTokens(n) {
      if (!n || isNaN(n)) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + 'k';
      return Number(n).toLocaleString();
    }

    function formatCtx(limit) {
      if (!limit) return "";
      if (typeof limit === "string") return limit;
      if (limit >= 1000000) return (limit / 1000000).toFixed(1).replace(/\.0$/, "") + "M ctx";
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

    function renderTrust() {
      const isTrusted = trustInfo.is_trusted;
      const badge = document.getElementById("trust-status-badge");
      const btn = document.getElementById("btn-toggle-current-trust");
      const desc = document.getElementById("trust-current-status-desc");

      if (btn) btn.disabled = false;

      if (isTrusted) {
        if (badge) { badge.className = "badge green"; badge.textContent = "Trusted Workspace"; }
        if (btn) {
          btn.className = "btn btn-danger";
          btn.textContent = "Revoke Trust";
          btn.setAttribute("data-action", "toggle-current-trust");
        }
        if (desc) desc.textContent = "Folder: " + (currentWorkspacePath || "Current Project") + " (Write and shell execution fully enabled)";
      } else {
        if (badge) { badge.className = "badge orange"; badge.textContent = "Untrusted / Restricted"; }
        if (btn) {
          btn.className = "btn";
          btn.textContent = "Trust Workspace";
          btn.setAttribute("data-action", "toggle-current-trust");
        }
        if (desc) desc.textContent = "Folder: " + (currentWorkspacePath || "Current Project") + " (Restricted Mode — file writes and shell commands require confirmation)";
      }

      const list = document.getElementById("trusted-folders-list");
      if (!list) return;
      const projects = trustInfo.trusted_projects || [];
      if (projects.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">No trusted folders recorded yet.</div>';
        return;
      }

      list.innerHTML = projects.map(p => 
        '<div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); border-radius: 4px;">' +
          '<div>' +
            '<div style="font-size: 12px; font-weight: 500; word-break: break-all;">' + escapeHtml(p.path) + '</div>' +
            '<div style="font-size: 10px; color: var(--text-muted);">Trusted at: ' + escapeHtml(p.trusted_at ? p.trusted_at.slice(0,10) : 'N/A') + '</div>' +
          '</div>' +
          '<button class="btn btn-danger" style="padding: 3px 8px; font-size: 11px;" data-action="revoke-trust" data-path="' + escapeHtml(p.path) + '">Revoke</button>' +
        '</div>'
      ).join("");
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
        const provEl = document.getElementById("active-banner-provider");
        if (provEl) provEl.textContent = activeModelProvider || "unknown";
        const nameEl = document.getElementById("active-banner-name");
        if (nameEl) nameEl.textContent = activeModelId;
        const idEl = document.getElementById("active-banner-id");
        if (idEl) idEl.textContent = activeModelId;
        const ctxEl = document.getElementById("active-banner-ctx");
        if (ctxEl) ctxEl.style.display = "none";
        const prEl = document.getElementById("active-banner-pricing");
        if (prEl) prEl.textContent = "";
        return;
      }
      banner.style.display = "flex";
      const provEl = document.getElementById("active-banner-provider");
      if (provEl) provEl.textContent = target.provider || "";
      const nameEl = document.getElementById("active-banner-name");
      if (nameEl) nameEl.textContent = target.name || target.id;
      const idEl = document.getElementById("active-banner-id");
      if (idEl) idEl.textContent = target.id;
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
      if (!grid) return;
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
        grid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<circle cx="11" cy="11" r="8"></circle>' +
            '<line x1="21" y1="21" x2="16.65" y2="16.65"></line>' +
          '</svg>' +
          '<div>No matching models found. Try clearing filters or refreshing catalog.</div>' +
        '</div>';
        return;
      }

      grid.innerHTML = filtered.map(m => {
        const isActive = m.id === activeModelId && (m.provider||"").toLowerCase() === activeModelProvider.toLowerCase();
        const ctxStr = m.context || formatCtx(m.context_limit);
        const pricingStr = m.is_free ? "Free Tier" : (m.pricing || "");

        return '<div class="model-card ' + (isActive ? 'active-model' : '') + '">' +
          '<div class="model-card-top">' +
            '<div class="model-header-row">' +
              '<div>' +
                '<div class="model-name">' + escapeHtml(m.name || m.id) + '</div>' +
                '<div class="model-id">' + escapeHtml(m.id) + '</div>' +
              '</div>' +
              '<span class="badge blue">' + escapeHtml(m.provider) + '</span>' +
            '</div>' +
            '<div class="model-desc">' + escapeHtml(m.desc || "High-performance AI model.") + '</div>' +
            '<div class="model-badges">' +
              (ctxStr ? '<span class="badge purple">' + escapeHtml(ctxStr) + '</span>' : '') +
              (m.is_free ? '<span class="badge green">Free Tier</span>' : '') +
              ((m.tags || []).includes('coding') ? '<span class="badge orange">Coding</span>' : '') +
              ((m.tags || []).includes('reasoning') ? '<span class="badge blue">Reasoning</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="model-card-bottom">' +
            '<div class="model-pricing ' + (m.is_free ? 'free' : '') + '">' + escapeHtml(pricingStr) + '</div>' +
            (isActive
              ? '<span class="active-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg> Active</span>'
              : '<button class="select-btn" data-action="select-model" data-id="' + escapeHtml(m.id) + '" data-provider="' + escapeHtml(m.provider) + '">Select Model</button>'
            ) +
          '</div>' +
        '</div>';
      }).join("");
    }

    function renderProviders() {
      const grid = document.getElementById("keys-grid");
      if (!grid) return;
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

        return '<div class="item-card">' +
          '<div class="item-card-top">' +
            '<div class="item-card-title">' +
              '<span class="status-dot ' + (hasKey ? 'connected' : '') + '"></span>' +
              '<span>' + escapeHtml(meta.name) + '</span>' +
            '</div>' +
            '<span class="badge ' + (hasKey ? 'green' : '') + '">' + (hasKey ? 'Connected' : 'Missing Key') + '</span>' +
          '</div>' +
          '<div class="item-card-desc">' + escapeHtml(meta.desc) + '</div>' +
          (p.id !== 'ollama'
            ? '<div class="key-input-row">' +
                '<input type="password" class="key-input" id="key-input-' + escapeHtml(p.id) + '" placeholder="' + (hasKey ? '•••••••••••••••• (Configured)' : 'Paste API Key here…') + '">' +
                '<button class="btn" data-action="save-key" data-id="' + escapeHtml(p.id) + '">Save</button>' +
              '</div>' +
              (meta.portal ? '<a class="portal-link" data-action="open-portal" data-url="' + escapeHtml(meta.portal) + '">Get API Key &rarr;</a>' : '')
            : '<div class="item-card-desc" style="color: var(--tag-green-fg); font-weight: 500;">Ready (No key required for local Ollama daemon)</div>'
          ) +
        '</div>';
      }).join("");
    }

    function getFilteredSessions(sessions, range) {
      if (!Array.isArray(sessions)) return [];
      if (range === "all") return sessions;
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      let limitMs = 30 * dayMs;
      if (range === "month") limitMs = 30 * dayMs;
      else if (range === "week") limitMs = 7 * dayMs;
      else if (range === "today") limitMs = 1 * dayMs;

      return sessions.filter(s => {
        const d = new Date(s.updated_at || s.created_at || 0).getTime();
        return (now - d) <= limitMs;
      });
    }

    function renderUsage() {
      const allSessionsList = usageData.sessions || [];
      const filteredSessions = getFilteredSessions(allSessionsList, currentUsageRange);

      const totalTokens = filteredSessions.reduce((acc, s) => acc + (s.token_total || s.tokens || 0), 0) || (currentUsageRange === "all" ? (usageData.total_tokens || 0) : 0);
      const totalCost = filteredSessions.reduce((acc, s) => acc + (s.cost_usd || 0), 0) || (currentUsageRange === "all" ? (usageData.total_cost_usd || 0) : 0);
      const totalSessions = filteredSessions.length || (currentUsageRange === "all" ? (usageData.total_sessions || 0) : 0);
      const avgTokens = totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0;

      const tokensEl = document.getElementById("stat-usage-tokens");
      const costEl = document.getElementById("stat-usage-cost");
      const sessionsEl = document.getElementById("stat-usage-sessions");
      const avgEl = document.getElementById("stat-usage-avg");

      if (tokensEl) tokensEl.textContent = formatTokens(totalTokens);
      if (costEl) costEl.textContent = '$' + Number(totalCost).toFixed(4);
      if (sessionsEl) sessionsEl.textContent = totalSessions;
      if (avgEl) avgEl.textContent = formatTokens(avgTokens);

      renderUsageChart(filteredSessions, currentUsageRange);
      renderModelBreakdown(filteredSessions);
      renderProviderBreakdown(filteredSessions);
      renderSessionsTable(filteredSessions);
    }

    function renderUsageChart(sessions, range) {
      const container = document.getElementById("usage-chart-container");
      if (!container) return;

      const slots = [];
      const now = new Date();
      const numSlots = range === "today" ? 12 : (range === "week" ? 7 : (range === "month" ? 14 : 14));

      if (range === "today") {
        for (let i = 0; i < 12; i++) {
          const slotHour = i * 2;
          const label = String(slotHour).padStart(2, '0') + ':00';
          slots.push({
            idx: i,
            label: label,
            fullDate: 'Today, ' + label,
            tokens: 0,
            cost: 0,
            count: 0
          });
        }
        if (Array.isArray(sessions)) {
          sessions.forEach(s => {
            const d = new Date(s.created_at || s.updated_at || 0);
            if (d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
              const hour = d.getHours();
              const slotIdx = Math.min(11, Math.floor(hour / 2));
              slots[slotIdx].tokens += (s.token_total || s.tokens || 0);
              slots[slotIdx].cost += (s.cost_usd || 0);
              slots[slotIdx].count += 1;
            }
          });
        }
      } else {
        const dailyMap = {};
        for (let i = numSlots - 1; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          const iso = d.toISOString().slice(0, 10);
          const fullDate = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          const label = (d.getMonth() + 1) + '/' + d.getDate();
          const slot = {
            idx: numSlots - 1 - i,
            dateIso: iso,
            label: label,
            fullDate: fullDate,
            dayName: d.toLocaleDateString([], { weekday: 'short' }),
            tokens: 0,
            cost: 0,
            count: 0
          };
          slots.push(slot);
          dailyMap[iso] = slot;
        }

        if (Array.isArray(sessions)) {
          sessions.forEach(s => {
            const sDate = (s.created_at || s.updated_at || "").slice(0, 10);
            if (dailyMap[sDate]) {
              dailyMap[sDate].tokens += (s.token_total || s.tokens || 0);
              dailyMap[sDate].cost += (s.cost_usd || 0);
              dailyMap[sDate].count += 1;
            }
          });
        }
      }

      const totalTokensInChart = slots.reduce((acc, s) => acc + s.tokens, 0);
      slots.forEach(s => {
        s.pct = totalTokensInChart > 0 ? Math.round((s.tokens / totalTokensInChart) * 100) : 0;
      });

      const maxTokens = Math.max(...slots.map(d => d.tokens), 1000);
      const chartHeight = 110;
      const svgWidth = 640;
      const leftPad = 48;
      const rightPad = 16;
      const availableWidth = svgWidth - leftPad - rightPad;
      const barWidth = Math.max(16, Math.min(36, Math.floor((availableWidth / numSlots) * 0.65)));
      const colStep = availableWidth / numSlots;

      // 3 dashed gridlines (Max, 50%, 0)
      let gridSvg = '';
      [1, 0.5, 0].forEach(ratio => {
        const y = chartHeight * (1 - ratio) + 15;
        const valLabel = ratio === 0 ? '0' : formatTokens(Math.round(maxTokens * ratio));
        gridSvg += '<line class="chart-grid-line" x1="' + leftPad + '" y1="' + y + '" x2="' + (svgWidth - rightPad) + '" y2="' + y + '" />' +
          '<text class="chart-grid-label" x="' + (leftPad - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' + valLabel + '</text>';
      });

      let colsSvg = '';
      slots.forEach((d, idx) => {
        const centerX = leftPad + idx * colStep + (colStep / 2);
        const x = centerX - (barWidth / 2);
        const colBgX = leftPad + idx * colStep;
        const barH = d.tokens > 0 ? Math.max(8, Math.round((d.tokens / maxTokens) * chartHeight)) : 3;
        const y = chartHeight - barH + 15;
        const opacity = d.tokens > 0 ? Math.min(1, 0.55 + (d.tokens / maxTokens) * 0.45) : 0.2;

        colsSvg += '<g class="chart-col-group" data-slot-idx="' + idx + '">' +
          '<rect class="chart-col-bg" x="' + colBgX + '" y="10" width="' + colStep + '" height="' + (chartHeight + 10) + '" rx="4" />' +
          '<rect class="chart-bar" x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + barH + '" rx="4" ry="4" fill="url(#usageBarGrad)" opacity="' + opacity + '" />' +
          '<text class="chart-axis-label" x="' + centerX + '" y="' + (chartHeight + 32) + '">' + escapeHtml(d.label) + '</text>' +
        '</g>';
      });

      container.innerHTML = '<div class="chart-wrapper">' +
        '<svg class="usage-chart-svg" viewBox="0 0 ' + svgWidth + ' 160" preserveAspectRatio="xMidYMid meet">' +
          '<defs>' +
            '<linearGradient id="usageBarGrad" x1="0" y1="0" x2="0" y2="1">' +
              '<stop offset="0%" stop-color="#09F994" />' +
              '<stop offset="100%" stop-color="#06b6d4" />' +
            '</linearGradient>' +
          '</defs>' +
          gridSvg +
          colsSvg +
        '</svg>' +
        '<div class="chart-tooltip" id="chart-tooltip"></div>' +
      '</div>';

      const wrapper = container.querySelector(".chart-wrapper");
      const tooltip = container.querySelector("#chart-tooltip");
      const colGroups = container.querySelectorAll(".chart-col-group");

      if (wrapper && tooltip && colGroups.length > 0) {
        colGroups.forEach(grp => {
          grp.addEventListener("mouseenter", () => {
            const idx = parseInt(grp.getAttribute("data-slot-idx") || "0", 10);
            const slot = slots[idx];
            if (!slot) return;

            colGroups.forEach(g => g.classList.remove("active"));
            grp.classList.add("active");

            const wrapRect = wrapper.getBoundingClientRect();
            const grpRect = grp.getBoundingClientRect();
            const posX = (grpRect.left + grpRect.width / 2) - wrapRect.left;
            const posY = grpRect.top - wrapRect.top + 30;

            tooltip.style.left = posX + 'px';
            tooltip.style.top = posY + 'px';

            tooltip.innerHTML = 
              '<div class="chart-tooltip-header">' +
                '<span>' + escapeHtml(slot.fullDate) + '</span>' +
                (slot.pct > 0 ? ('<span style="color:#09F994; font-size:10px; font-weight:700;">' + slot.pct + '%</span>') : '') +
              '</div>' +
              '<div class="chart-tooltip-body">' +
                '<div class="chart-tooltip-row">' +
                  '<span class="label">Tokens</span>' +
                  '<span class="val green">' + Number(slot.tokens).toLocaleString() + ' tok</span>' +
                '</div>' +
                '<div class="chart-tooltip-row">' +
                  '<span class="label">Est. Cost</span>' +
                  '<span class="val">$' + Number(slot.cost).toFixed(4) + ' USD</span>' +
                '</div>' +
                '<div class="chart-tooltip-row">' +
                  '<span class="label">Sessions</span>' +
                  '<span class="val">' + slot.count + ' session' + (slot.count === 1 ? '' : 's') + '</span>' +
                '</div>' +
              '</div>';

            tooltip.classList.add("visible");
          });
        });

        wrapper.addEventListener("mouseleave", () => {
          colGroups.forEach(g => g.classList.remove("active"));
          tooltip.classList.remove("visible");
        });
      }
    }

    function renderModelBreakdown(filteredSessions) {
      const container = document.getElementById("usage-models-breakdown");
      if (!container) return;

      const modelMap = {};
      if (Array.isArray(filteredSessions) && filteredSessions.length > 0) {
        filteredSessions.forEach(s => {
          const m = s.model || 'default';
          if (!modelMap[m]) modelMap[m] = { tokens: 0, cost: 0, provider: s.provider || '' };
          modelMap[m].tokens += (s.token_total || s.tokens || 0);
          modelMap[m].cost += (s.cost_usd || 0);
        });
      } else if (currentUsageRange === "all" && usageData.by_model) {
        Object.assign(modelMap, usageData.by_model);
      }

      const entries = Object.entries(modelMap);
      if (entries.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:6px 0;">No model usage recorded in this timeframe.</div>';
        return;
      }

      entries.sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0));
      const totalTokens = entries.reduce((acc, [, data]) => acc + (data.tokens || 0), 0) || 1;

      container.innerHTML = entries.map(([modelId, data]) => {
        const tokens = data.tokens || 0;
        const cost = data.cost || 0;
        const pct = Math.min(100, Math.round((tokens / totalTokens) * 100));
        const provider = data.provider || '';

        return '<div class="usage-item-row" title="' + escapeHtml(modelId) + ': ' + Number(tokens).toLocaleString() + ' tokens ($' + Number(cost).toFixed(4) + ')">' +
          '<div class="usage-item-header">' +
            '<div style="display:flex; align-items:center; gap:6px; min-width:0;">' +
              '<span style="font-weight:600; font-size:11.5px; word-break:break-all;">' + escapeHtml(modelId) + '</span>' +
              (provider ? '<span class="badge blue" style="font-size:9.5px;">' + escapeHtml(provider) + '</span>' : '') +
            '</div>' +
            '<div style="display:flex; align-items:center; gap:8px; font-size:11.5px; font-weight:600; flex-shrink:0;">' +
              '<span>' + formatTokens(tokens) + '</span>' +
              '<span style="color:var(--text-muted); font-weight:normal;">(' + pct + '%)</span>' +
              '<span style="color:var(--tag-green-fg); font-size:10.5px;">$' + Number(cost).toFixed(4) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="usage-progress-bar-wrap">' +
            '<div class="usage-progress-bar-fill" style="width: ' + pct + '%; background: linear-gradient(90deg, #388bfd, #06b6d4);"></div>' +
          '</div>' +
        '</div>';
      }).join("");
    }

    function renderProviderBreakdown(filteredSessions) {
      const container = document.getElementById("usage-providers-breakdown");
      if (!container) return;

      const provMap = {};
      if (Array.isArray(filteredSessions) && filteredSessions.length > 0) {
        filteredSessions.forEach(s => {
          const p = s.provider || (s.model && s.model.includes('/') ? s.model.split('/')[0] : 'openrouter');
          if (!provMap[p]) provMap[p] = { tokens: 0, cost: 0, sessions: 0 };
          provMap[p].tokens += (s.token_total || s.tokens || 0);
          provMap[p].cost += (s.cost_usd || 0);
          provMap[p].sessions += 1;
        });
      } else if (currentUsageRange === "all" && usageData.by_provider) {
        Object.assign(provMap, usageData.by_provider);
      }

      const entries = Object.entries(provMap);
      if (entries.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:6px 0;">No provider activity recorded in this timeframe.</div>';
        return;
      }

      entries.sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0));
      const totalTokens = entries.reduce((acc, [, data]) => acc + (data.tokens || 0), 0) || 1;

      container.innerHTML = entries.map(([provId, data]) => {
        const tokens = data.tokens || 0;
        const cost = data.cost || 0;
        const pct = Math.min(100, Math.round((tokens / totalTokens) * 100));

        return '<div class="usage-item-row" title="' + escapeHtml(provId) + ': ' + Number(tokens).toLocaleString() + ' tokens ($' + Number(cost).toFixed(4) + ')">' +
          '<div class="usage-item-header">' +
            '<div style="display:flex; align-items:center; gap:6px;">' +
              '<span style="font-weight:600; font-size:11.5px; text-transform:capitalize;">' + escapeHtml(provId) + '</span>' +
              '<span class="badge purple" style="font-size:9.5px;">' + (data.sessions || 0) + ' sessions</span>' +
            '</div>' +
            '<div style="display:flex; align-items:center; gap:8px; font-size:11.5px; font-weight:600;">' +
              '<span>' + formatTokens(tokens) + '</span>' +
              '<span style="color:var(--text-muted); font-weight:normal;">(' + pct + '%)</span>' +
              '<span style="color:var(--tag-green-fg); font-size:10.5px;">$' + Number(cost).toFixed(4) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="usage-progress-bar-wrap">' +
            '<div class="usage-progress-bar-fill" style="width: ' + pct + '%; background: linear-gradient(90deg, #a371f7, #c084fc);"></div>' +
          '</div>' +
        '</div>';
      }).join("");
    }

    function renderSessionsTable(sessions) {
      const tbody = document.getElementById("usage-sessions-body");
      if (!tbody) return;

      const list = sessions || usageData.sessions || [];
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">No recent session history recorded yet.</td></tr>';
        return;
      }

      tbody.innerHTML = list.slice(0, 25).map(s => {
        const sName = s.name || s.id || "Untitled Session";
        const modelStr = (s.model || "default") + (s.provider ? ' (' + s.provider + ')' : "");
        const tokens = s.token_total || s.tokens || 0;
        const cost = s.cost_usd || 0;
        const dStr = s.updated_at || s.created_at || "";
        const dateFormatted = dStr ? new Date(dStr).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "N/A";

        return '<tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">' +
          '<td style="padding:8px 12px; font-weight:500; font-size:12px; word-break:break-all;">' + escapeHtml(sName) + '</td>' +
          '<td style="padding:8px 12px; font-size:11px; color:var(--text-muted);">' + escapeHtml(modelStr) + '</td>' +
          '<td style="padding:8px 12px; text-align:right; font-size:12px; font-weight:600; font-family:monospace;">' + Number(tokens).toLocaleString() + '</td>' +
          '<td style="padding:8px 12px; text-align:right; font-size:11.5px; color:var(--tag-green-fg); font-family:monospace;">$' + Number(cost).toFixed(4) + '</td>' +
          '<td style="padding:8px 12px; text-align:right; font-size:11px; color:var(--text-muted);">' + escapeHtml(dateFormatted) + '</td>' +
        '</tr>';
      }).join("");
    }

    function renderSkills() {
      const grid = document.getElementById("skills-grid");
      if (!grid) return;
      if (activeSkillsTab === "installed") {
        if (allSkills.length === 0) {
          grid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>' +
            '<div>No skills installed yet. Switch to "Browse Online Registry" to install instruction packs.</div>' +
          '</div>';
          return;
        }
        grid.innerHTML = allSkills.map(s => 
          '<div class="item-card">' +
            '<div class="item-card-top">' +
              '<div class="item-card-title">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>' +
                '<span>' + escapeHtml(s.name) + '</span>' +
              '</div>' +
              '<span class="badge purple">' + escapeHtml(s.scope || 'skill') + '</span>' +
            '</div>' +
            '<div class="item-card-desc">' + escapeHtml(s.description || 'Custom agent workflow skill.') + '</div>' +
            '<div style="font-size: 11px; font-family: monospace; color: var(--text-muted); word-break: break-all;">' + escapeHtml(s.path || '') + '</div>' +
          '</div>'
        ).join("");
      } else {
        if (allRemoteSkills.length === 0) {
          grid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>' +
            '<div>Connecting to GitHub registries (Anthropic & Community)...</div>' +
          '</div>';
          return;
        }
        grid.innerHTML = allRemoteSkills.map(r => {
          const isInstalled = allSkills.some(s => (s.name || "").toLowerCase() === (r.name || "").toLowerCase());
          return '<div class="item-card">' +
            '<div class="item-card-top">' +
              '<div class="item-card-title">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>' +
                '<span>' + escapeHtml(r.name) + '</span>' +
              '</div>' +
              '<span class="badge blue">' + escapeHtml(r.source_label || r.source_id) + '</span>' +
            '</div>' +
            '<div class="item-card-desc">' + escapeHtml(r.description || 'Remote instruction pack from ' + r.repo) + '</div>' +
            '<div style="display: flex; align-items: center; justify-content: space-between; margin-top: 8px;">' +
              (isInstalled ? '<span class="badge green" style="font-size:10px; font-weight:600;">✓ Installed</span>' : '<span></span>') +
              '<button class="btn ' + (isInstalled ? 'btn-secondary' : '') + '" style="padding: 4px 10px; font-size: 11px;" data-action="install-skill" data-skill-name="' + escapeHtml(r.name) + '" data-source-id="' + escapeHtml(r.source_id || 'anthropic') + '">' +
                (isInstalled ? 'Reinstall' : 'Install Skill') +
              '</button>' +
            '</div>' +
          '</div>';
        }).join("");
      }
    }

    function renderMcp() {
      const grid = document.getElementById("mcp-grid");
      if (!grid) return;
      if (allMcpServers.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M9 9h6v6H9z"></path></svg>' +
          '<div>No MCP servers configured. Add servers to <code>.andromity/mcp.json</code> or <code>.vscode/mcp.json</code>.</div>' +
        '</div>';
        return;
      }

      grid.innerHTML = allMcpServers.map(s => {
        const status = (s.status || 'unknown').toLowerCase();
        const isRunning = status === 'running';
        const isError   = status === 'error';
        const isAuth    = status === 'needs_auth';
        const isDisabled = s.disabled || status === 'disabled';

        // Status dot colour
        const dotClass  = isRunning  ? 'connected'
                        : isDisabled ? ''
                        : '';            // error/auth/unknown → no extra class (red below)
        const dotStyle  = isError    ? 'background:#f85149;'
                        : isAuth     ? 'background:#d29922;'
                        : isDisabled ? 'background:rgba(255,255,255,0.2);'
                        : '';

        // Status badge
        const badgeColor = isRunning  ? 'green'
                         : isError    ? ''
                         : isAuth     ? 'orange'
                         : isDisabled ? ''
                         : '';
        const badgeStyle = isError   ? 'background:rgba(248,81,73,0.15); color:#f85149; border:1px solid rgba(248,81,73,0.3);'
                         : isDisabled ? 'background:rgba(255,255,255,0.06); color:var(--text-muted);'
                         : '';
        const badgeLabel = isRunning  ? (s.tools_count > 0 ? s.tools_count + ' tools' : 'running')
                         : isError    ? 'error'
                         : isAuth     ? 'needs auth'
                         : isDisabled ? 'disabled'
                         : 'not started';

        const cmdStr = s.command ? escapeHtml(s.command) + (s.args && s.args.length ? ' ' + s.args.map(escapeHtml).join(' ') : '') : '<span style="color:var(--text-muted)">no command</span>';

        return '<div class="item-card">' +
          '<div class="item-card-top">' +
            '<div class="item-card-title">' +
              '<span class="status-dot ' + dotClass + '" style="' + dotStyle + '"></span>' +
              '<span>' + escapeHtml(s.name) + '</span>' +
            '</div>' +
            '<span class="badge ' + badgeColor + '" style="' + badgeStyle + '">' + escapeHtml(badgeLabel) + '</span>' +
          '</div>' +
          '<div class="item-card-desc"><code>' + cmdStr + '</code></div>' +
          (isError && s.error ? '<div style="font-size:11px; color:#f85149; margin-top:6px; padding:5px 8px; background:rgba(248,81,73,0.08); border:1px solid rgba(248,81,73,0.2);">' + escapeHtml(s.error) + '</div>' : '') +
          (isError && s.error_detail ? '<div style="font-size:10.5px; color:var(--text-muted); margin-top:4px; padding:5px 8px; background:rgba(255,255,255,0.03); border:1px solid var(--card-border); max-height:80px; overflow:auto; white-space:pre-wrap; word-break:break-word;">' + escapeHtml(s.error_detail) + '</div>' : '') +
          (isAuth ? '<div style="margin-top:8px;"><button class="btn" style="font-size:11px; padding:4px 10px;" data-action="mcp_auth" data-name="' + escapeHtml(s.name) + '">🔑 Connect / Authenticate</button></div>' : '') +
          '<div style="display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;">' +
            '<button class="btn btn-secondary" style="padding:4px 8px; font-size:11px;" data-action="mcp_restart" data-name="' + escapeHtml(s.name) + '"' + (isDisabled ? ' disabled title="Enable first to restart"' : '') + '>↺ Restart</button>' +
            (isDisabled
              ? '<button class="btn" style="padding:4px 8px; font-size:11px;" data-action="mcp_toggle" data-name="' + escapeHtml(s.name) + '" data-disabled="false">▶ Enable</button>'
              : '<button class="btn btn-secondary" style="padding:4px 8px; font-size:11px;" data-action="mcp_toggle" data-name="' + escapeHtml(s.name) + '" data-disabled="true">⏸ Disable</button>'
            ) +
          '</div>' +
        '</div>';
      }).join("");
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

    const cronScheduleSelect = document.getElementById("cron-schedule-select");
    const cronCustomScheduleInput = document.getElementById("cron-custom-schedule");
    if (cronScheduleSelect) {
      cronScheduleSelect.addEventListener("change", () => {
        if (cronCustomScheduleInput) {
          cronCustomScheduleInput.style.display = cronScheduleSelect.value === "custom" ? "block" : "none";
          if (cronScheduleSelect.value === "custom") cronCustomScheduleInput.focus();
        }
      });
    }

    if (btnSaveCron) {
      btnSaveCron.addEventListener("click", () => {
        const nameInput = document.getElementById("cron-name-input");
        const scheduleSelect = document.getElementById("cron-schedule-select");
        const customScheduleInput = document.getElementById("cron-custom-schedule");
        const modelSelect = document.getElementById("cron-model-select");
        const commandsInput = document.getElementById("cron-commands-input");
        const promptInput = document.getElementById("cron-prompt-input");

        const name = (nameInput ? nameInput.value : "").trim();
        let schedule = scheduleSelect ? scheduleSelect.value : "every 1h";
        if (schedule === "custom" && customScheduleInput && customScheduleInput.value.trim()) {
          schedule = customScheduleInput.value.trim();
        }
        const prompt = (promptInput ? promptInput.value : "").trim();
        const model = (modelSelect ? modelSelect.value : "") || activeModelId;
        const allowedCommands = (commandsInput ? commandsInput.value : "").trim();

        if (!prompt) {
          if (promptInput) {
            promptInput.focus();
            promptInput.placeholder = "Please enter a prompt or instruction first...";
          }
          return;
        }

        vscode.postMessage({
          type: "cron_create",
          payload: {
            name: name || "Scheduled Job",
            schedule: schedule,
            prompt: prompt,
            model: model,
            provider: activeModelProvider,
            allowed_commands: allowedCommands,
          }
        });

        if (nameInput) nameInput.value = "";
        if (promptInput) promptInput.value = "";
        if (commandsInput) commandsInput.value = "";
        if (cronCreateForm) cronCreateForm.style.display = "none";
        if (btnToggleAddCron) btnToggleAddCron.textContent = "+ New Cron Job";
      });
    }

    if (btnRefreshCrons) {
      btnRefreshCrons.addEventListener("click", () => {
        vscode.postMessage({ type: "ready" });
      });
    }

    const skillsGrid = document.getElementById("skills-grid");
    if (skillsGrid) {
      skillsGrid.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action='install-skill']");
        if (!btn) return;
        const name = btn.dataset.skillName;
        const sourceId = btn.dataset.sourceId || "anthropic";
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-block; width:9px; height:9px; border:1.5px solid currentColor; border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; margin-right:4px;"></span> Installing...';
        vscode.postMessage({ type: "install_skill", name, sourceId });
      });
    }

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
          vscode.postMessage({ type: "cron_delete", id });
        } else if (action === "history") {
          const runsDiv = document.getElementById("cron-runs-" + id);
          if (runsDiv) {
            if (runsDiv.style.display === "block") {
              runsDiv.style.display = "none";
            } else {
              runsDiv.style.display = "block";
              runsDiv.innerHTML = '<div style="padding:6px; color:var(--text-muted); font-size:11px;">Loading execution history...</div>';
              vscode.postMessage({ type: "fetch_cron_runs", id: id });
            }
          }
        }
      });
    }

    // ── MCP Server Controls (Restart / Enable-Disable / Refresh) ──
    const mcpGrid = document.getElementById("mcp-grid");
    if (mcpGrid) {
      mcpGrid.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const name = btn.dataset.name;
        if (action === "mcp_restart") {
          btn.disabled = true;
          const orig = btn.textContent;
          btn.textContent = "↺ Restarting...";
          vscode.postMessage({ type: "mcp_restart", name });
          setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 4000);
        } else if (action === "mcp_toggle") {
          const disabled = btn.dataset.disabled === "true";
          btn.disabled = true;
          const orig = btn.textContent;
          btn.textContent = disabled ? "⏸ Disabling..." : "▶ Enabling...";
          vscode.postMessage({ type: "mcp_toggle", name, disabled });
          setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 4000);
        }
      });
    }
    const btnRefreshMcp = document.getElementById("btn-refresh-mcp");
    if (btnRefreshMcp) {
      btnRefreshMcp.addEventListener("click", () => {
        btnRefreshMcp.disabled = true;
        const origHtml = btnRefreshMcp.innerHTML;
        btnRefreshMcp.textContent = "Refreshing...";
        vscode.postMessage({ type: "refresh_mcp" });
        setTimeout(() => { btnRefreshMcp.disabled = false; btnRefreshMcp.innerHTML = origHtml; }, 2500);
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
        const cmds = job.allowed_commands && job.allowed_commands.length > 0
          ? (Array.isArray(job.allowed_commands) ? job.allowed_commands.join(", ") : String(job.allowed_commands))
          : "";

        return '<div class="cron-card">' +
          '<div class="cron-card-left">' +
            '<div class="cron-card-title-row">' +
              '<span class="cron-card-name">' + escapeHtml(job.name || job.id) + '</span>' +
              '<span class="cron-interval-pill">' + escapeHtml(job.schedule || 'every 1h') + '</span>' +
              '<span class="cron-status-pill ' + statusClass + '">' + statusLabel + '</span>' +
              (job.model ? ('<span class="badge blue" style="font-size:10px;">' + escapeHtml(job.model) + '</span>') : '') +
            '</div>' +
            '<div class="cron-card-prompt">' + escapeHtml(job.prompt || '') + '</div>' +
            (cmds ? ('<div style="font-size:11px; color:var(--text-muted); margin-top:4px;"><span style="font-weight:600;">Allowed Commands:</span> <code style="background:rgba(255,255,255,0.06); padding:1px 4px;">' + escapeHtml(cmds) + '</code></div>') : '') +
            '<div class="cron-card-meta">' +
              '<span>Runs: ' + (job.run_count || 0) + '</span>' +
              '<span>Last: ' + escapeHtml(lastRun) + ' (' + escapeHtml(lastStatus) + ')</span>' +
            '</div>' +
            '<div id="cron-runs-' + escapeHtml(job.id) + '" class="cron-runs-container" style="display:none; margin-top:8px; padding-top:8px; border-top:1px solid var(--border);"></div>' +
          '</div>' +
          '<div class="cron-card-actions">' +
            '<button class="btn btn-secondary" data-action="toggle" data-id="' + escapeHtml(job.id) + '">' + (isEnabled ? 'Pause' : 'Enable') + '</button>' +
            '<button class="btn" data-action="run" data-id="' + escapeHtml(job.id) + '" data-name="' + escapeHtml(job.name || '') + '" data-prompt="' + promptEnc + '">Run Now</button>' +
            '<button class="btn btn-secondary" data-action="history" data-id="' + escapeHtml(job.id) + '">History</button>' +
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
