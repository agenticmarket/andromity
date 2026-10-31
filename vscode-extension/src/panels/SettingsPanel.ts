import * as vscode from "vscode";
import { confirmTurnOnAirGap, currentAirGap } from "../airgapState.js";
import { getNonce } from "../providers/webviewSecurity.js";
import {
  confirmAndromityTrust,
  confirmPermissionMode,
  requireWorkspaceTrust,
  resolveWebviewConfigWrite,
} from "../server/securityPolicy.js";
import { RpcClient } from "../server/RpcClient.js";
import { ModelInfo, ProviderInfo, IntegrationResult, McpServerConfig, ConnectorInfo, ConnectorConnectResult, KeyCheckResult } from "../server/types.js";
import { KEY_TESTS_UNSUPPORTED, PROVIDER_ID_PATTERN, refreshProviderModels, runKeyCheck, supportsKeyTests } from "../server/keyCheck.js";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { getUsageScript } from "./usage/usageScript.js";
import { decodeUsagePng } from "./usage/usageImage.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import type { WaitlistController } from "../engagement/waitlistController.js";
import { DOCS, INTEGRATIONS_URL } from "../docsLinks.js";
import { CONNECTOR_ICONS } from "./connectorIcons.js";
import { CONNECTOR_GUIDE_SLUGS } from "./connectorGuides.js";

// Hub actions recorded as anonymous feature use (the action name only, never the values).
const HUB_FEATURES: Record<string, string> = {
  select_model: "model_selected", toggle_pin: "model_pinned",
  save_provider: "provider_saved", delete_provider: "provider_deleted", test_provider: "provider_tested",
  set_api_key: "api_key_saved", test_key: "api_key_tested", refresh_provider_models: "provider_models_refreshed",
  install_skill: "skill_installed", skill_read: "skill_viewed", remove_skill: "skill_removed",
  trust_folder: "trust_granted", revoke_trust: "trust_revoked", toggle_airgap: "airgap_toggled",
  toggle_sound: "sound_toggled", toggle_next_steps: "next_steps_toggled", toggle_coauthor: "coauthor_toggled", configure_python_path: "python_path_set",
  cron_create: "cron_created", cron_delete: "cron_deleted", fetch_cron_runs: "cron_history_viewed", open_cron_session: "cron_session_opened",
  mcp_add: "mcp_added", mcp_remove: "mcp_removed", mcp_restart: "mcp_restarted",
  mcp_toggle: "mcp_toggled", mcp_enable: "mcp_toggled", mcp_disable: "mcp_toggled",
  mcp_auth: "mcp_auth_started", mcp_authenticate: "mcp_auth_started",
  connector_connect: "connector_connected",
};
// Browsing actions people repeat; counted once per session.
const HUB_ONCE = new Set(["skill_viewed", "cron_history_viewed"]);

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  public static readonly viewType = "andromity.settingsPanel";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _rpcClient: RpcClient | null = null;
  private _cronEventDisposers: Array<() => void> = [];
  private _onConfigChangeCallback?: () => void;
  private _initialTab: string = "models";
  private _loadingPromise: Promise<void> | null = null;
  private _disposed = false;

  public static extensionContext?: vscode.ExtensionContext;
  public static chatProvider?: any;
  public static waitlist?: WaitlistController;
  public static _cachedState: any = null;
  private static _prewarmPromise: Promise<void> | null = null;
  private static _prewarmTimer: NodeJS.Timeout | null = null;
  /** Latest result of the extension's startup mcp.list, reused so prewarm doesn't repeat it. */
  private static _lastMcpServers: unknown[] | null = null;
  public static readonly PREWARM_DELAY_MS = 10_000;

  /** Prewarm once startup traffic has settled, so the Hub opens instantly
   *  without competing with the chat view's own initial load. */
  public static schedulePrewarm(rpcClient: RpcClient | null, delayMs = SettingsPanel.PREWARM_DELAY_MS): void {
    if (SettingsPanel._prewarmTimer) clearTimeout(SettingsPanel._prewarmTimer);
    SettingsPanel._prewarmTimer = setTimeout(() => {
      SettingsPanel._prewarmTimer = null;
      if (!SettingsPanel.currentPanel) void SettingsPanel.prewarm(rpcClient);
    }, delayMs);
  }

  public static async prewarm(rpcClient: RpcClient | null): Promise<void> {
    if (!rpcClient) return;
    if (SettingsPanel._prewarmPromise) return SettingsPanel._prewarmPromise;

    SettingsPanel._prewarmPromise = (async () => {
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let account = { isAuthenticated: false, username: "", email: "", plan: "free" };
        if (SettingsPanel.extensionContext) {
          await SettingsPanel.chatProvider?.fetchUsage();
          const token = await SettingsPanel.extensionContext.secrets.get("andromity.authToken");
          const username = await SettingsPanel.extensionContext.secrets.get("andromity.userName");
          const email = await SettingsPanel.extensionContext.secrets.get("andromity.userEmail");
          const plan = await SettingsPanel.extensionContext.secrets.get("andromity.userPlan");
          account = {
            isAuthenticated: !!token,
            username: username || "",
            email: email || "",
            plan: plan || "free"
          };
        }

        const [configData, models, providers, skills, mcpServers, usage, systemInfo, trustData, crons, connectors] = await Promise.all([
          rpcClient.call<any>("config.get", { project_path: workspaceFolder }, 8000).catch(() => ({})),
          rpcClient.call<ModelInfo[]>("config.list_models", {}, 8000).catch(() => []),
          rpcClient.call<ProviderInfo[]>("config.list_providers", {}, 8000).catch(() => []),
          rpcClient.call<any[]>("skills.list", { project_path: workspaceFolder }, 8000).catch(() => []),
          SettingsPanel._lastMcpServers
            ? Promise.resolve(SettingsPanel._lastMcpServers as any[])
            : rpcClient.call<any[]>("mcp.list", { project_path: workspaceFolder }, 120000).catch(() => []),
          rpcClient.call<any>("usage.get", { project_path: null, time_range: "all" }, 8000).catch(() => ({})),
          rpcClient.call<any>("system.info", {}, 8000).catch(() => ({})),
          rpcClient.call<any>("trust.status", { project_path: workspaceFolder }, 8000).catch(() => ({ is_trusted: false, trusted_projects: [] })),
          rpcClient.call<any[]>("cron.list", { project_path: workspaceFolder }, 8000).catch(() => []),
          rpcClient.call<ConnectorInfo[]>("connectors.list", { project_path: workspaceFolder }, 8000).catch(() => []),
        ]);

        const vscodeConfig = vscode.workspace.getConfiguration("andromity");
        const permissionMode = vscodeConfig.get<string>("permissionMode", configData?.permission_mode || "safe");

        SettingsPanel._cachedState = {
          type: "state_loaded",
          config: { ...configData, permission_mode: permissionMode },
          models: models || [],
          pinnedModels: configData?.pinned_models || [],
          providers: providers || [],
          account,
          waitlistJoined: SettingsPanel._waitlistJoined(),
          waitlistOffered: SettingsPanel._waitlistOffered(),
          skills: skills || [],
          remoteSkills: SettingsPanel._cachedState?.remoteSkills || [],
          mcpServers: mcpServers || [],
          connectors: connectors || [],
          usage: usage || {},
          systemInfo: systemInfo || {},
          trustData: trustData || { is_trusted: false, trusted_projects: [] },
          crons: crons || [],
          currentWorkspace: workspaceFolder || "",
          startupSession: vscodeConfig.get<string>("startupSession", "last"),
          waterfallAutoOpen: vscodeConfig.get<boolean>("waterfallAutoOpen", true),
          soundNotifications: vscodeConfig.get<boolean>("soundNotifications", true) && configData?.sound_done !== false,
          nextStepSuggestions: configData?.next_step_suggestions !== false,
          telemetry: (vscode.env.isTelemetryEnabled ?? true) && vscodeConfig.get<boolean>("telemetry", true) && configData?.telemetry !== false,
          airGap: { ...currentAirGap(), engine: configData?.airgap || null },
          includeCoAuthor: vscodeConfig.get<boolean>("includeCoAuthor", true),
          wallpaper: {
            enabled: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("enabled", false),
            rippleIntensity: vscode.workspace.getConfiguration("andromity.wallpaper").get<string>("rippleIntensity", "medium"),
            floatingAsterisks: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("floatingAsterisks", true),
            cursorLightAura: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("cursorLightAura", true),
          },
        };

        if (SettingsPanel.currentPanel) {
          SettingsPanel.currentPanel._panel.webview.postMessage(SettingsPanel._cachedState);
        }
      } catch (err: any) {
        console.warn("[SettingsPanel] Pre-warm notice:", err?.message || err);
      } finally {
        SettingsPanel._prewarmPromise = null;
      }
    })();

    return SettingsPanel._prewarmPromise;
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    rpcClient: RpcClient | null,
    initialTab: "models" | "skills" | "mcp" | "usage" | "keys" | "general" | "trust" | "about" | "crons" | "personalisation" = "models",
    onConfigChange?: () => void,
    context?: vscode.ExtensionContext,
    chatProvider?: any
  ) {
    if (context) SettingsPanel.extensionContext = context;
    if (chatProvider) SettingsPanel.chatProvider = chatProvider;
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel._panel.reveal(column);
      SettingsPanel.currentPanel._rpcClient = rpcClient;
      SettingsPanel.currentPanel._onConfigChangeCallback = onConfigChange;
      SettingsPanel.currentPanel.setInitialTab(initialTab);
      if (SettingsPanel._cachedState) {
        SettingsPanel.currentPanel._panel.webview.postMessage(SettingsPanel._cachedState);
      }
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
    this._initialTab = initialTab;

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, "media", "icon.svg"),
      dark: vscode.Uri.joinPath(this._extensionUri, "media", "icon.svg"),
    };

    this._update();
    this._bindCronEvents();
    recordFeatureUse("settings_opened", { client: this._rpcClient });

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables
    );
  }

  public setRpcClient(client: RpcClient) {
    this._rpcClient = client;
    this._bindCronEvents();
    this.loadData();
  }

  private static _waitlistJoined(): boolean {
    return SettingsPanel.waitlist?.joined() === true;
  }

  private static _waitlistOffered(): boolean {
    return SettingsPanel.waitlist?.offered() === true;
  }

  public static postWaitlistState(): void {
    const joined = SettingsPanel._waitlistJoined();
    const offered = SettingsPanel._waitlistOffered();
    if (SettingsPanel._cachedState) Object.assign(SettingsPanel._cachedState, { waitlistJoined: joined, waitlistOffered: offered });
    SettingsPanel.currentPanel?._panel.webview.postMessage({ type: "waitlist_state", joined, offered });
  }

  public static updateMcpServers(mcpServers: unknown[]): void {
    SettingsPanel._lastMcpServers = mcpServers;
    if (SettingsPanel._cachedState) SettingsPanel._cachedState.mcpServers = mcpServers;
    SettingsPanel.currentPanel?._panel.webview.postMessage({ type: "mcp_refreshed", mcpServers });
  }

  public setInitialTab(tab: string) {
    this._initialTab = tab;
    this._panel.webview.postMessage({ type: "switch_tab", tab });
  }

  public async loadData(force: boolean = false): Promise<void> {
    if (!this._rpcClient) {
      if (SettingsPanel._cachedState) {
        this._panel.webview.postMessage(SettingsPanel._cachedState);
      } else {
        this._panel.webview.postMessage({ type: "daemon_status", connected: false });
      }
      return;
    }

    if (this._loadingPromise && !force) {
      return this._loadingPromise;
    }

    this._loadingPromise = (async () => {
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        let account = { isAuthenticated: false, username: "", email: "", plan: "free" };
        if (SettingsPanel.extensionContext) {
          await SettingsPanel.chatProvider?.fetchUsage();
          const token = await SettingsPanel.extensionContext.secrets.get("andromity.authToken");
          const username = await SettingsPanel.extensionContext.secrets.get("andromity.userName");
          const email = await SettingsPanel.extensionContext.secrets.get("andromity.userEmail");
          const plan = await SettingsPanel.extensionContext.secrets.get("andromity.userPlan");
          account = {
            isAuthenticated: !!token,
            username: username || "",
            email: email || "",
            plan: plan || "free"
          };
        }

        const fastPromise = Promise.all([
          this._rpcClient!.call<any>("config.get", { project_path: workspaceFolder }, 6000).catch(() => ({})),
          this._rpcClient!.call<ProviderInfo[]>("config.list_providers", {}, 6000).catch(() => []),
          this._rpcClient!.call<any>("system.info", {}, 6000).catch(() => ({})),
          this._rpcClient!.call<any>("trust.status", { project_path: workspaceFolder }, 6000).catch(() => ({ is_trusted: false, trusted_projects: [] })),
        ]).then(([configData, providers, systemInfo, trustData]) => {
          const vscodeConfig = vscode.workspace.getConfiguration("andromity");
          const permissionMode = vscodeConfig.get<string>("permissionMode", configData?.permission_mode || "safe");

          this._panel.webview.postMessage({
            type: "fast_state_loaded",
            config: { ...configData, permission_mode: permissionMode },
            providers: providers || [],
            account,
            waitlistJoined: SettingsPanel._waitlistJoined(),
          waitlistOffered: SettingsPanel._waitlistOffered(),
            systemInfo: systemInfo || {},
            trustData: trustData || { is_trusted: false, trusted_projects: [] },
            currentWorkspace: workspaceFolder || "",
            startupSession: vscodeConfig.get<string>("startupSession", "last"),
            waterfallAutoOpen: vscodeConfig.get<boolean>("waterfallAutoOpen", true),
            soundNotifications: vscodeConfig.get<boolean>("soundNotifications", true) && configData?.sound_done !== false,
            nextStepSuggestions: configData?.next_step_suggestions !== false,
            telemetry: (vscode.env.isTelemetryEnabled ?? true) && vscodeConfig.get<boolean>("telemetry", true) && configData?.telemetry !== false,
          airGap: { ...currentAirGap(), engine: configData?.airgap || null },
            includeCoAuthor: vscodeConfig.get<boolean>("includeCoAuthor", true),
            wallpaper: {
              enabled: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("enabled", false),
              rippleIntensity: vscode.workspace.getConfiguration("andromity.wallpaper").get<string>("rippleIntensity", "medium"),
              floatingAsterisks: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("floatingAsterisks", true),
              cursorLightAura: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("cursorLightAura", true),
            },
            mascotEnabled: vscodeConfig.get<boolean>("mascotEnabled", true),
          });

          return { configData, providers, systemInfo, trustData, permissionMode, vscodeConfig };
        });

        // 2. HEAVY PATH (models, skills, mcpServers, usage, crons)
        const heavyPromise = Promise.all([
          this._rpcClient!.call<ModelInfo[]>("config.list_models", {}, 10000).catch(() => []),
          this._rpcClient!.call<any[]>("skills.list", { project_path: workspaceFolder }, 10000).catch(() => []),
          this._rpcClient!.call<any[]>("mcp.list", { project_path: workspaceFolder }, 10000).catch(() => []),
          this._rpcClient!.call<any>("usage.get", { project_path: null, time_range: "all" }, 10000).catch(() => ({})),
          this._rpcClient!.call<any[]>("cron.list", { project_path: workspaceFolder }, 10000).catch(() => []),
          this._rpcClient!.call<ConnectorInfo[]>("connectors.list", { project_path: workspaceFolder }, 10000).catch(() => []),
        ]);

        const [fastRes, [models, skills, mcpServers, usage, crons, connectors]] = await Promise.all([fastPromise, heavyPromise]);

        const fullState = {
          type: "state_loaded",
          config: { ...fastRes.configData, permission_mode: fastRes.permissionMode },
          models: models || [],
          providers: fastRes.providers || [],
          account,
          waitlistJoined: SettingsPanel._waitlistJoined(),
          waitlistOffered: SettingsPanel._waitlistOffered(),
          skills: skills || [],
          remoteSkills: SettingsPanel._cachedState?.remoteSkills || [],
          mcpServers: mcpServers || [],
          connectors: connectors || [],
          usage: usage || {},
          systemInfo: fastRes.systemInfo || {},
          trustData: fastRes.trustData || { is_trusted: false, trusted_projects: [] },
          crons: crons || [],
          currentWorkspace: workspaceFolder || "",
          startupSession: fastRes.vscodeConfig.get<string>("startupSession", "last"),
          waterfallAutoOpen: fastRes.vscodeConfig.get<boolean>("waterfallAutoOpen", true),
          soundNotifications: fastRes.vscodeConfig.get<boolean>("soundNotifications", true) && fastRes.configData?.sound_done !== false,
          nextStepSuggestions: fastRes.configData?.next_step_suggestions !== false,
          telemetry: (vscode.env.isTelemetryEnabled ?? true) && fastRes.vscodeConfig.get<boolean>("telemetry", true) && fastRes.configData?.telemetry !== false,
          airGap: { ...currentAirGap(), engine: fastRes.configData?.airgap || null },
          includeCoAuthor: fastRes.vscodeConfig.get<boolean>("includeCoAuthor", true),
          wallpaper: {
            enabled: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("enabled", false),
            rippleIntensity: vscode.workspace.getConfiguration("andromity.wallpaper").get<string>("rippleIntensity", "medium"),
            floatingAsterisks: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("floatingAsterisks", true),
            cursorLightAura: vscode.workspace.getConfiguration("andromity.wallpaper").get<boolean>("cursorLightAura", true),
          },
          mascotEnabled: fastRes.vscodeConfig.get<boolean>("mascotEnabled", true),
        };

        SettingsPanel._cachedState = fullState;
        this._panel.webview.postMessage(fullState);

        // Background-fetch remote skills registry from GitHub without blocking initial UI
        this._rpcClient!.call<any[]>("skills.browse", {}, 10000)
          .then((remoteSkills) => {
            if (this._panel && remoteSkills) {
              if (SettingsPanel._cachedState) {
                SettingsPanel._cachedState.remoteSkills = remoteSkills;
              }
              this._panel.webview.postMessage({
                type: "remote_skills_loaded",
                remoteSkills: remoteSkills || [],
              });
            }
          })
          .catch(() => {});
      } catch (err: any) {
        console.error("[SettingsPanel] Failed to load data:", err);
      } finally {
        this._loadingPromise = null;
      }
    })();

    return this._loadingPromise;
  }

  /** Air-gap controls work without the engine, so the mode can be turned off even if it stops the engine from starting. */
  private async _handleAirGapMessage(message: any): Promise<void> {
    if (message.type === "toggle_airgap") {
      const airGap = currentAirGap();
      const turnOn = message.value === true;
      if (!turnOn && airGap.locked) {
        void vscode.window.showInformationMessage("Air-gap mode was turned on by your organization (ANDROMITY_AIRGAP) and can't be turned off here.");
      } else if (!turnOn && airGap.source === "workspace") {
        void vscode.window.showInformationMessage("This project's settings turn air-gap mode on (andromity.airGap.enabled in .vscode/settings.json). Change it there to turn it off.");
      } else if (turnOn !== airGap.enabled) {
        const chat = SettingsPanel.chatProvider;
        const confirmed = turnOn
          ? await confirmTurnOnAirGap({ provider: chat?.getCurrentProvider(), model: chat?.getCurrentModel(), running: chat?.hasRunningSessions() })
          : (await vscode.window.showWarningMessage(
          "Turn off air-gap mode? Andromity will be able to use the internet again, including cloud models.",
          { modal: true }, "Turn Off")) === "Turn Off";
        if (confirmed) {
          await vscode.workspace.getConfiguration("andromity").update("airGap.enabled", turnOn, vscode.ConfigurationTarget.Global);
        }
      }
      this._panel.webview.postMessage({ type: "airgap_state", airGap: { ...currentAirGap(), engine: null } });
      return;
    }

    if (message.type === "save_airgap_hosts") {
      const hosts = String(message.hosts || "").split(/[\s,;]+/).map((host) => host.trim()).filter(Boolean);
      await vscode.workspace.getConfiguration("andromity").update("airGap.allowedHosts", [...new Set(hosts)], vscode.ConfigurationTarget.Global);
      this._panel.webview.postMessage({ type: "airgap_state", airGap: { ...currentAirGap(), engine: null } });
      return;
    }

    if (message.type === "airgap_self_test") {
      const result = this._rpcClient
        ? await this._rpcClient.call<any>("airgap.self_test", {}, 60000).catch(() => null)
        : null;
      this._panel.webview.postMessage({ type: "airgap_self_test_result", result });
      return;
    }
  }

  private _postIfOpen(message: unknown): void {
    if (!this._disposed) void this._panel.webview.postMessage(message);
  }

  /** Tests a saved key with a tiny request; a passing key also gets its live model list. */
  private async _testKey(provider: unknown, requested = false, providers?: ProviderInfo[]): Promise<KeyCheckResult | null> {
    const rpc = this._rpcClient;
    if (!rpc || typeof provider !== "string" || !PROVIDER_ID_PATTERN.test(provider)) return null;
    if (!(await supportsKeyTests(rpc, providers))) {
      if (requested) this._postIfOpen({ type: "key_test_result", provider, ...KEY_TESTS_UNSUPPORTED });
      return requested ? KEY_TESTS_UNSUPPORTED : null;
    }
    const result = await runKeyCheck(rpc, provider, () => this._postIfOpen({ type: "key_test_started", provider }));
    this._postIfOpen({ type: "key_test_result", provider, ...result });
    if (result.ok) {
      const refreshed = await refreshProviderModels(rpc, provider);
      if (refreshed.models) {
        this._postIfOpen({ type: "provider_models_refreshed", ...refreshed });
        this._onConfigChangeCallback?.();
      }
    }
    return result;
  }

  private async _providerNeedingKey(provider: unknown): Promise<ProviderInfo | null> {
    if (typeof provider !== "string" || !provider || !this._rpcClient) return null;
    const providers = await this._rpcClient.call<ProviderInfo[]>("config.list_providers", {}, 5000).catch(() => null);
    const info = Array.isArray(providers) ? providers.find((p) => p.id === provider) : undefined;
    return info && info.key_required === true && !info.has_key ? info : null;
  }

  private async _handleMessage(message: any) {
    const hubFeature = HUB_FEATURES[message?.type];
    if (hubFeature) recordFeatureUse(hubFeature, { oncePerSession: HUB_ONCE.has(hubFeature) });
    if (message?.type === "update_setting" && typeof message.key === "string") recordFeatureUse("pref_" + message.key);
    if (message.type === "open_url" && ["https://ollama.com/download", "https://docs.ollama.com/quickstart"].includes(message.url)) {
      await vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    }
    if (["check_ollama_status", "start_ollama_server", "pull_ollama_model"].includes(message.type)) {
      try {
        if (message.type === "start_ollama_server") {
          const started = await SettingsPanel.chatProvider?.startOllamaServer();
          if (!started) vscode.window.showWarningMessage("Ollama did not start. Open the Ollama app or run 'ollama serve', then check again.");
        } else if (message.type === "pull_ollama_model") {
          await SettingsPanel.chatProvider?.pullOllamaModel("qwen2.5-coder:7b");
        }
        const status = await SettingsPanel.chatProvider?.probeOllama();
        this._panel.webview.postMessage({type:"ollama_status_updated", status:status || null});
      } catch {
        this._panel.webview.postMessage({type:"ollama_status_updated", status:null});
      }
      return;
    }
    if (message.type === "export_usage_image") {
      try {
        const bytes = decodeUsagePng(message.image);
        const format = ["square", "landscape", "story"].includes(message.format) ? message.format : "square";
        const kind = ["activity", "daily"].includes(message.kind) ? message.kind : "recap";
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(join(homedir(), `andromity-${kind}-${format}-${new Date().toISOString().slice(0, 10)}.png`)),
          filters: { "PNG image": ["png"] },
          saveLabel: "Save usage image",
        });
        if (target) {
          await vscode.workspace.fs.writeFile(target, bytes);
          vscode.window.showInformationMessage("Exported usage image.");
        }
        this._panel.webview.postMessage({ type: "usage_export_result", success: !!target, cancelled: !target });
      } catch {
        this._panel.webview.postMessage({ type: "usage_export_result", success: false });
        vscode.window.showErrorMessage("Could not save the usage image. Try again and choose a writable folder.");
      }
      return;
    }
    if (message.type === "copy_usage_caption") {
      try {
        if (typeof message.caption !== "string" || message.caption.length > 2000) return;
        await vscode.env.clipboard.writeText(message.caption);
        this._panel.webview.postMessage({ type: "usage_caption_copied", success: true });
      } catch {
        this._panel.webview.postMessage({ type: "usage_caption_copied", success: false });
      }
      return;
    }
    if (message.type === "login_account") {
      try {
        if (SettingsPanel.chatProvider) {
          await SettingsPanel.chatProvider.openLogin();
        } else {
          await vscode.commands.executeCommand("andromity.login");
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open login: ${err.message}`);
      }
      return;
    }

    if (message.type === "open_waitlist") {
      await SettingsPanel.chatProvider?.openWaitlistForm?.();
      return;
    }

    if (message.type === "waitlist_offer_shown") {
      SettingsPanel.waitlist?.offerShown();
      return;
    }

    if (message.type === "logout_account") {
      try {
        if (SettingsPanel.chatProvider) {
          await SettingsPanel.chatProvider.logout();
        } else if (SettingsPanel.extensionContext) {
          await SettingsPanel.extensionContext.secrets.delete("andromity.authToken");
          await SettingsPanel.extensionContext.secrets.delete("andromity.userName");
          await SettingsPanel.extensionContext.secrets.delete("andromity.userEmail");
          await SettingsPanel.extensionContext.secrets.delete("andromity.userPlan");
        }
        await this.loadData(true);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to sign out: ${err.message}`);
      }
      return;
    }

    if (message.type === "refresh_auth") {
      await this.loadData(true);
      return;
    }

    if (message.type === "toggle_airgap" || message.type === "save_airgap_hosts" || message.type === "airgap_self_test") {
      await this._handleAirGapMessage(message);
      return;
    }

    if (!this._rpcClient) {
      if (message.type === "ready") {
        this.setInitialTab(this._initialTab);
        if (SettingsPanel._cachedState) {
          this._panel.webview.postMessage(SettingsPanel._cachedState);
        } else {
          this._panel.webview.postMessage({ type: "daemon_status", connected: false });
        }
        return;
      }
      if (message.type === "fetch_usage") {
        this._panel.webview.postMessage({ type: "usage_load_failed", requestId: message.requestId });
      }
      if (message.type === "webview_error") {
        console.error("[SettingsPanel Webview Error]", message);
        return;
      }
      vscode.window.showErrorMessage("Andromity daemon is not connected.");
      return;
    }

    switch (message.type) {
      case "ready": {
        this.setInitialTab(this._initialTab);
        if (SettingsPanel._cachedState) {
          this._panel.webview.postMessage(SettingsPanel._cachedState);
        }
        await this.loadData();
        break;
      }

      case "webview_error": {
        console.error("[SettingsPanel Webview Error]", message);
        break;
      }

      case "refresh_models": {
        try {
          if (!this._rpcClient) {
            vscode.window.showWarningMessage("Andromity daemon is not connected yet.");
            this._panel.webview.postMessage({ type: "refresh_failed" });
            break;
          }
          let models: ModelInfo[] = [];
          try {
            models = await this._rpcClient.call<ModelInfo[]>("config.refresh_models", {
              provider: message.provider || undefined,
            }, 8000);
          } catch (refreshErr) {
            // Gracefully fall back to local cached catalog if network refresh times out
            models = await this._rpcClient.call<ModelInfo[]>("config.list_models", {
              provider: message.provider || undefined,
            }, 3000).catch(() => []);
          }

          const filtered = models || [];
          this._panel.webview.postMessage({
            type: "models_refreshed",
            models: filtered,
          });
          vscode.window.showInformationMessage(`Refreshed live model catalog (${filtered.length} models available).`);
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showWarningMessage("Unable to refresh models. Please verify your connection.");
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
          const keyless = await this._providerNeedingKey(message.provider);
          if (keyless) {
            SettingsPanel.chatProvider?.showKeyRequiredNote?.({ id: keyless.id, name: keyless.name, portal: keyless.portal || "" });
            void Promise.resolve(vscode.window.showWarningMessage(
              `Active model set to ${message.modelId}. Set your ${keyless.name} API key to use it.`, "Open API keys",
            )).then((choice) => {
              if (choice && !this._disposed) this.setInitialTab("keys");
            });
          } else {
            vscode.window.showInformationMessage(`Active model set to: ${message.modelId}`);
          }
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to switch model: ${err.message}`);
        }
        break;
      }

      case "toggle_pin": {
        try {
          const res = await this._rpcClient.call<any>("config.toggle_pin", {
            modelId: message.modelId,
            provider: message.provider,
            name: message.name,
          });
          const updatedPinned = res?.pinned || [];
          this._panel.webview.postMessage({
            type: "update_pinned_models",
            pinnedModels: updatedPinned,
          });
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to update pinned model: ${err.message}`);
        }
        break;
      }

      case "save_provider":
      case "delete_provider":
      case "test_provider": {
        try {
          if (message.type === "test_provider") {
            const result = await this._rpcClient.call<{ success: boolean; message: string }>("config.test_provider", {
              provider: message.provider,
            }, 35000);
            this._panel.webview.postMessage({ type: "provider_result", ...result });
          } else {
            if (message.type === "delete_provider") {
              const choice = await vscode.window.showWarningMessage(
                `Remove provider '${message.provider}'? Its base URL, model and API key will be deleted.`, { modal: true }, "Remove");
              if (choice !== "Remove") break;
            }
            const result = await this._rpcClient.call<{ provider: string; providers: ProviderInfo[] }>(
              message.type === "save_provider" ? "config.save_provider" : "config.delete_provider",
              message.type === "save_provider" ? message.connection : { provider: message.provider });
            this._panel.webview.postMessage({ type: "providers_updated", providers: result.providers });
            this._panel.webview.postMessage({ type: "provider_result", success: true, saved: message.type === "save_provider", message: "Connection updated." });
            this._onConfigChangeCallback?.();
            const provider = result.provider || message.provider;
            if (message.type === "save_provider") {
              const models = await this._rpcClient.call<ModelInfo[]>("config.refresh_models", { provider }, 10000).catch(() => []);
              this._panel.webview.postMessage({ type: "models_refreshed", provider, models });
            } else {
              this._panel.webview.postMessage({ type: "models_refreshed", provider, models: [] });
            }
          }
        } catch (error: unknown) {
          const text = error instanceof Error ? error.message : String(error);
          this._panel.webview.postMessage({ type: "provider_result", success: false,
            message: text.includes("-32601") ? "Update the Andromity server to configure custom providers." : text });
        }
        break;
      }

      case "set_api_key": {
        let savedProviders: ProviderInfo[] = [];
        if (typeof message.apiKey !== "string" || !message.apiKey.trim()) {
          vscode.window.showWarningMessage("Paste an API key before saving. The current key was not changed.");
          break;
        }
        try {
          await this._rpcClient.call("config.set_api_key", {
            provider: message.provider,
            api_key: message.apiKey.trim(),
          });
          savedProviders = await this._rpcClient.call<ProviderInfo[]>("config.list_providers", {});
          this._panel.webview.postMessage({
            type: "providers_updated",
            providers: savedProviders || [],
            savedProvider: message.provider,
          });
          vscode.window.showInformationMessage(`API key for ${message.provider} saved.`);
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to save API key: ${err.message}`);
          break;
        }
        await this._testKey(message.provider, false, savedProviders);
        break;
      }

      case "test_key": {
        if (!(await this._testKey(message.provider, true))) {
          this._postIfOpen({ type: "key_test_result", provider: String(message.provider ?? "").slice(0, 64), ok: false, tone: "error", label: "Couldn't verify the key" });
        }
        break;
      }

      case "refresh_provider_models": {
        const provider = typeof message.provider === "string" ? message.provider : "";
        if (!PROVIDER_ID_PATTERN.test(provider)) break;
        const refreshed = await refreshProviderModels(this._rpcClient, provider);
        this._postIfOpen({ type: "provider_models_refreshed", ...refreshed });
        if (refreshed.models) this._onConfigChangeCallback?.();
        break;
      }

      case "install_skill": {
        const scope = message.scope === "project" ? "project" : "user";
        const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
          if (scope === "project" && !projectPath) {
            vscode.window.showWarningMessage("Open a folder before installing a skill for this project only.");
            break;
          }
          if (scope === "project" && !vscode.workspace.isTrusted) {
            vscode.window.showWarningMessage("Trust this workspace before installing project skills.");
            break;
          }
          const res = await this._rpcClient.call<any>("skills.install", {
            name: message.name,
            source_id: message.sourceId || "anthropic",
            ref: message.ref || undefined,
            scope,
            project_path: projectPath,
          }, 60000);
          if (res.success) {
            vscode.window.showInformationMessage(`Installed skill '${message.name}' successfully.`);
            await this.loadData();
            this._onConfigChangeCallback?.();
          } else {
            vscode.window.showErrorMessage(`Failed to install skill: ${res.error || "Unknown error"}`);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to install skill: ${err.message}`);
        } finally {
          this._panel?.webview.postMessage({ type: "skill_install_finished" });
        }
        break;
      }

      case "skill_read": {
        let result: { content?: string; error?: string };
        try {
          result = await this._rpcClient.call<{ content?: string; error?: string }>("skills.read", {
            name: message.name,
            source_id: message.sourceId || undefined,
            path: message.path || undefined,
            project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          }, 20000);
        } catch {
          result = { error: "Could not load this skill's instructions. Reconnect to an updated Andromity server and retry." };
        }
        this._panel?.webview.postMessage({ type: "skill_detail_loaded", key: message.key, content: result.content, error: result.error });
        break;
      }

      case "remove_skill": {
        try {
          if (!vscode.workspace.isTrusted) {
            vscode.window.showWarningMessage("Trust this workspace before removing skills.");
            break;
          }
          const choice = await vscode.window.showWarningMessage(
            `Remove skill '${message.name}' from ${message.path}?`, { modal: true }, "Remove");
          if (choice !== "Remove") break;
          const res = await this._rpcClient.call<IntegrationResult>("skills.remove", {
            name: message.name, path: message.path,
            project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          });
          if (!res.success) vscode.window.showWarningMessage(res.error || "Could not remove the skill.");
          else this._onConfigChangeCallback?.();
        } catch {
          vscode.window.showErrorMessage("Could not remove the skill. Reconnect to an updated Andromity server and retry.");
        } finally {
          await this.loadData(true);
        }
        break;
      }

      case "trust_folder": {
        try {
          const folder = await confirmAndromityTrust(message.path);
          if (!folder) {
            await this.loadData();
            break;
          }
          await this._rpcClient.call("trust.set", { project_path: folder });
          vscode.window.showInformationMessage(`Folder marked as trusted.`);
          await this.loadData();
          this._onConfigChangeCallback?.();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to trust folder: ${err.message}`);
        }
        break;
      }

      case "forget_approval": {
        const key = message.kind === "command" ? "allowed_commands" : message.kind === "domain" ? "allowed_domains" : null;
        if (!key || typeof message.value !== "string") break;
        try {
          const current = await this._rpcClient.call<any>("config.get", {});
          const remembered = current?.config?.default?.[key];
          const next = Array.isArray(remembered) ? remembered.filter((entry: unknown) => entry !== message.value) : [];
          await this._rpcClient.call("config.set", { section: "default", key, value: next });
          await this.loadData(true);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Could not remove the remembered approval: ${err.message}`);
          await this.loadData(true);
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
          let target: { section: string; key: string; value: unknown } | null;
          if (message.key === "mode") {
            const current = (await this._rpcClient.call<any>("config.get", {}).catch(() => null))?.permission_mode || "safe";
            const mode = await confirmPermissionMode(message.value, current);
            target = mode ? { section: "default", key: "permission_mode", value: mode } : null;
            if (!mode) {
              await this.loadData(true);
              break;
            }
            message.value = mode;
          } else {
            target = resolveWebviewConfigWrite(message.key, message.value);
          }
          if (!target) {
            vscode.window.showWarningMessage(`Andromity ignored an invalid value for "${String(message.key)}".`);
            break;
          }
          await this._rpcClient.call("config.set", target);
          if (message.key === "mode") {
            const config = vscode.workspace.getConfiguration("andromity");
            await config.update("permissionMode", message.value, vscode.ConfigurationTarget.Global);
          } else if (message.key === "startupSession") {
            const config = vscode.workspace.getConfiguration("andromity");
            await config.update("startupSession", message.value, vscode.ConfigurationTarget.Global);
          } else if (message.key === "waterfallAutoOpen") {
            const config = vscode.workspace.getConfiguration("andromity");
            await config.update("waterfallAutoOpen", message.value, vscode.ConfigurationTarget.Global);
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

      case "toggle_next_steps": {
        try {
          await this._rpcClient?.call("config.set", {
            section: "default",
            key: "next_step_suggestions",
            value: message.value === true,
          });
        } catch (err: any) {
          vscode.window.showWarningMessage("Andromity couldn't save this setting. Try again in a moment.");
        }
        this._panel.webview.postMessage({
          type: "setting_updated",
          key: "nextStepSuggestions",
          value: message.value === true,
        });
        break;
      }

      case "toggle_coauthor": {
        const config = vscode.workspace.getConfiguration("andromity");
        await config.update("includeCoAuthor", message.value, vscode.ConfigurationTarget.Global);
        this._panel.webview.postMessage({
          type: "setting_updated",
          key: "includeCoAuthor",
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

      case "tab_switched": {
        const tab = message.tab;
        if (tab && typeof tab === "string") {
          recordFeatureUse(`settings_tab_${tab.slice(0, 18)}`, { client: this._rpcClient });
        }
        break;
      }

      case "update_wallpaper_setting": {
        const config = vscode.workspace.getConfiguration("andromity.wallpaper");
        await config.update(message.key, message.value, vscode.ConfigurationTarget.Global);
        this._panel.webview.postMessage({
          type: "wallpaper_setting_updated",
          key: message.key,
          value: message.value,
        });
        this._onConfigChangeCallback?.();
        if (message.key === "enabled") {
          recordFeatureUse(message.value ? "wallpaper_enabled" : "wallpaper_disabled", { client: this._rpcClient });
        }
        break;
      }

      case "update_mascot_setting": {
        const config = vscode.workspace.getConfiguration("andromity");
        await config.update("mascotEnabled", !!message.enabled, vscode.ConfigurationTarget.Global);
        this._onConfigChangeCallback?.();
        recordFeatureUse(message.enabled ? "mascot_enabled" : "mascot_disabled", { client: this._rpcClient });
        try {
          const { ChatViewProvider } = await import("../providers/ChatViewProvider.js");
          ChatViewProvider.currentProvider?.broadcastMascotConfig();
        } catch {}
        break;
      }

      case "open_url": {
        if (message.url && typeof message.url === "string" && message.url.startsWith("https://")) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      }

      case "open_license_file": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localLicense = workspaceFolder ? join(workspaceFolder, "LICENSE") : null;
        if (localLicense && existsSync(localLicense)) {
          const uri = vscode.Uri.file(localLicense);
          vscode.commands.executeCommand("vscode.open", uri);
        } else {
          vscode.env.openExternal(vscode.Uri.parse("https://github.com/agenticmarket/andromity/blob/main/LICENSE"));
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
          const isGlobal = (message.scope || "global") === "global";
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const projectPath = isGlobal ? null : (workspaceFolder || null);
          const usage = await this._rpcClient.call<any>("usage.get", {
            time_range: message.timeRange || "all",
            project_path: projectPath,
            offset: Math.max(0, Math.floor(Number(message.offset) || 0)),
            limit: 10,
          }, 15000);
          this._panel.webview.postMessage({
            type: "usage_loaded",
            usage: usage || {},
            timeRange: message.timeRange || "all",
            scope: message.scope || "global",
            requestId: message.requestId,
          });
        } catch (err: any) {
          console.error("[SettingsPanel] Failed to fetch usage:", err);
          this._panel.webview.postMessage({ type: "usage_load_failed", requestId: message.requestId });
        }
        break;
      }

      case "cron_create":
      case "cron_update": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
          if (message.type === "cron_create") {
            await this._rpcClient.call("cron.create", { ...message.payload, project_path: workspaceFolder });
          } else {
            await this._rpcClient.call("cron.update", { ...message.payload, id: message.id, project_path: workspaceFolder });
            if (message.runNow) {
              await this._rpcClient.call("cron.run_now", { id: message.id, project_path: workspaceFolder });
            }
          }
          this._panel.webview.postMessage({ type: "cron_saved", id: message.id || null });
          vscode.window.showInformationMessage(message.type === "cron_create" ? "Scheduled job created." : "Scheduled job saved.");
          await this._refreshCronList();
        } catch (e: any) {
          this._panel.webview.postMessage({ type: "cron_save_failed", error: e?.message || "The job could not be saved." });
        }
        break;
      }

      case "cron_duplicate": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this._rpcClient.call("cron.duplicate", { id: message.id, project_path: workspaceFolder });
          vscode.window.showInformationMessage("Job duplicated. The copy is paused until you resume it.");
          await this._refreshCronList();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to duplicate the job: ${e.message}`);
        }
        break;
      }

      case "cron_preview": {
        try {
          const result = await this._rpcClient.call<any>("cron.preview", { schedule: message.schedule, count: 5 }, 5000);
          this._panel.webview.postMessage({ type: "cron_preview_result", requestId: message.requestId, ...result });
        } catch {
          // Older engines have no preview; the form then validates on save.
          this._panel.webview.postMessage({ type: "cron_preview_result", requestId: message.requestId, unavailable: true });
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
          await this._refreshCronList();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to toggle cron job: ${e.message}`);
        }
        break;
      }

      case "cron_delete": {
        try {
          const confirm = await vscode.window.showWarningMessage(
            "Delete this scheduled job and its run history?",
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
          await this._refreshCronList();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to delete cron job: ${e.message}`);
        }
        break;
      }

      case "cron_run_now": {
        try {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          // Progress arrives as cron/run_started and cron/run_completed events.
          await this._rpcClient.call("cron.run_now", {
            id: message.id,
            project_path: workspaceFolder,
          });
        } catch (e: any) {
          this._panel.webview.postMessage({ type: "cron_run_event", phase: "completed", job_id: message.id });
          vscode.window.showErrorMessage(`Failed to trigger cron job: ${e.message}`);
        }
        break;
      }

      case "refresh_crons": {
        try {
          await this._refreshCronList();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to refresh cron jobs: ${err.message}`);
        }
        break;
      }

      case "open_cron_session": {
        if (message.sessionId) {
          if (message.target === "tab") {
            await vscode.commands.executeCommand("andromity.openSessionInTab", {
              session: { id: message.sessionId, name: message.sessionName || "Cron Session" }
            });
          } else {
            await vscode.commands.executeCommand("andromity.switchSessionById", message.sessionId);
          }
        }
        break;
      }

      case "show_info": {
        if (message.text) {
          vscode.window.showInformationMessage(message.text);
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

      case "mcp_add":
      case "mcp_remove": {
        try {
          const project_path = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!vscode.workspace.isTrusted || !project_path) {
            vscode.window.showWarningMessage("Open a trusted workspace before managing MCP servers.");
            break;
          }
          let res: IntegrationResult;
          if (message.type === "mcp_add") {
            const name = await vscode.window.showInputBox({ title: "Add MCP server", prompt: "Server name", ignoreFocusOut: true,
              validateInput: value => value.trim() ? undefined : "Enter a server name." });
            if (!name) break;
            const kind = await vscode.window.showQuickPick(["Remote HTTP (OAuth or access token)", "Remote SSE (legacy)", "Local command (stdio)", "Advanced JSON configuration"],
              { title: "MCP connection type", ignoreFocusOut: true });
            if (!kind) break;
            let serverConfig: McpServerConfig;
            if (kind === "Advanced JSON configuration") {
              const raw = await vscode.window.showInputBox({ title: "MCP server configuration", password: true, ignoreFocusOut: true,
                prompt: "Paste one server object. Supports headers, env, and oauth.client_id.",
                validateInput: value => { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "Enter a JSON object."; } catch { return "Enter valid JSON."; } } });
              if (raw === undefined) break;
              serverConfig = JSON.parse(raw) as McpServerConfig;
            } else if (kind === "Local command (stdio)") {
              const command = await vscode.window.showInputBox({ title: "MCP command", prompt: "Executable, such as npx, uvx, or python", ignoreFocusOut: true });
              if (!command?.trim()) break;
              const raw = await vscode.window.showInputBox({ title: "Command arguments", value: "[]", prompt: 'JSON array of arguments, such as ["-y", "@modelcontextprotocol/server-filesystem", "."]', ignoreFocusOut: true,
                validateInput: value => { try { const args: unknown = JSON.parse(value); return Array.isArray(args) && args.every(arg => typeof arg === "string") ? undefined : "Enter an array of strings."; } catch { return "Enter valid JSON."; } } });
              if (raw === undefined) break;
              serverConfig = { command: command.trim(), args: JSON.parse(raw) as string[] };
            } else {
              const url = await vscode.window.showInputBox({ title: "Remote MCP URL", prompt: "For Supabase: https://mcp.supabase.com/mcp?project_ref=YOUR_PROJECT_REF", ignoreFocusOut: true,
                validateInput: value => { try { const parsed = new URL(value); return ["https:", "http:"].includes(parsed.protocol) ? undefined : "Use HTTP or HTTPS."; } catch { return "Enter a valid URL."; } } });
              if (!url) break;
              const token = await vscode.window.showInputBox({ title: "Access token (optional)", prompt: "Leave empty to authenticate in your browser after adding the server.", password: true, ignoreFocusOut: true });
              if (token === undefined) break;
              serverConfig = { url, type: kind === "Remote SSE (legacy)" ? "sse" : "http" };
              if (token.trim()) serverConfig.headers = { Authorization: `Bearer ${token.trim()}` };
            }
            res = await this._rpcClient.call<IntegrationResult>("mcp.add", { name: name.trim(), config: serverConfig, project_path }, 60000);
          } else {
            const choice = await vscode.window.showWarningMessage(`Remove MCP server '${message.name}' and its saved authentication?`, { modal: true }, "Remove");
            if (choice !== "Remove") break;
            res = await this._rpcClient.call<IntegrationResult>("mcp.remove", { name: message.name, project_path }, 60000);
          }
          if (!res.success) vscode.window.showWarningMessage(res.error || "Could not update MCP servers.");
          else this._onConfigChangeCallback?.();
        } catch {
          vscode.window.showErrorMessage("Could not update MCP servers. Reconnect to an updated Andromity server and retry.");
        } finally {
          await this.loadData(true);
        }
        break;
      }

      case "mcp_restart": {
        if (!requireWorkspaceTrust("start MCP servers")) break;
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
        if (message.type !== "mcp_disable" && message.disabled !== true && !requireWorkspaceTrust("start MCP servers")) break;
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
          if (!vscode.workspace.isTrusted) {
            vscode.window.showWarningMessage("Trust this workspace before authenticating MCP servers.");
            break;
          }
          const method = await vscode.window.showQuickPick(["Sign in with browser (OAuth)", "Use access token / PAT"],
            { title: `Authenticate ${name}`, ignoreFocusOut: true });
          if (!method) {
            this._panel.webview.postMessage({ type: "mcp_refresh_failed" });
            break;
          }
          let access_token: string | undefined;
          if (method === "Use access token / PAT") {
            access_token = await vscode.window.showInputBox({ title: `Access token for ${name}`, password: true, ignoreFocusOut: true,
              validateInput: value => value.trim() ? undefined : "Enter an access token." });
            if (!access_token) {
              this._panel.webview.postMessage({ type: "mcp_refresh_failed" });
              break;
            }
          }
          vscode.window.showInformationMessage(access_token ? `Saving access token for '${name}'...` : `Starting authentication for '${name}' in browser...`);
          const res = await this._rpcClient.call<IntegrationResult>("mcp.authenticate", { name, project_path: workspaceFolder, access_token }, 240000);
          if (res && res.success !== false) {
            if (res.status === "running") vscode.window.showInformationMessage(`MCP '${name}' authenticated and connected.`);
            else vscode.window.showWarningMessage(`Authentication saved for '${name}'. Connection status: ${res.status || "unknown"}. Check the server card and retry.`);
          } else {
            vscode.window.showWarningMessage(`MCP auth failed: ${res?.error || 'Unknown error'}`);
          }
          const mcpServers = await this._rpcClient.call<any[]>("mcp.list", { project_path: workspaceFolder }, 10000).catch(() => []);
          this._panel.webview.postMessage({ type: "mcp_refreshed", mcpServers: mcpServers || [] });
        } catch (e: any) {
          vscode.window.showErrorMessage("Authentication could not finish. Reconnect and try Authenticate again.");
          this._panel.webview.postMessage({ type: "mcp_refresh_failed" });
        }
        break;
      }

      case "connector_connect": {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const connector = (SettingsPanel._cachedState?.connectors as ConnectorInfo[] | undefined)?.find(c => c.id === message.id);
        try {
          if (!connector || !workspaceFolder || !requireWorkspaceTrust("connect apps")) break;
          let client_id = "";
          let client_secret = "";
          let access_token = "";
          if (connector.auth === "token") {
            const pick = await vscode.window.showInformationMessage(
              `${connector.name} connects with an access token you create in your ${connector.name} account.`,
              { modal: true }, "Enter token", "Create a token");
            if (pick === "Create a token") {
              await vscode.env.openExternal(vscode.Uri.parse(connector.setup_url));
              break;
            }
            if (pick !== "Enter token") break;
            access_token = (await vscode.window.showInputBox({ title: `${connector.name}: access token`, password: true, ignoreFocusOut: true,
              validateInput: value => value.trim() ? undefined : "Enter the access token." })) || "";
            if (!access_token) break;
          }
          if (connector.needs_client) {
            const pick = await vscode.window.showInformationMessage(
              `${connector.name} is in the Google Workspace Developer Preview and needs your own Google OAuth client. ` +
              `Create a "Web application" client, tick "Use this client for an AI-powered agent", add the redirect URI http://127.0.0.1:54321/callback, then paste its ID and secret.`,
              { modal: true }, "Enter client", "Open setup guide");
            if (pick === "Open setup guide") {
              await vscode.env.openExternal(vscode.Uri.parse(connector.setup_url));
              break;
            }
            if (pick !== "Enter client") break;
            client_id = (await vscode.window.showInputBox({ title: `${connector.name}: OAuth client ID`, ignoreFocusOut: true,
              validateInput: value => value.trim() ? undefined : "Enter the client ID." })) || "";
            if (!client_id) break;
            client_secret = (await vscode.window.showInputBox({ title: `${connector.name}: OAuth client secret`, password: true, ignoreFocusOut: true,
              validateInput: value => value.trim() ? undefined : "Enter the client secret." })) || "";
            if (!client_secret) break;
          }
          vscode.window.showInformationMessage(access_token ? `Checking the token with ${connector.name}...` : `Sign in to ${connector.name} in your browser...`);
          const res = await this._rpcClient.call<ConnectorConnectResult>("connectors.connect",
            { id: connector.id, project_path: workspaceFolder, client_id, client_secret, access_token }, 240000);
          if (res?.success) {
            vscode.window.showInformationMessage(res.status === "running"
              ? `${connector.name} connected.`
              : `${connector.name} signed in. Connection status: ${res.status || "unknown"}. Check its card below.`);
            this._onConfigChangeCallback?.();
          } else {
            vscode.window.showWarningMessage(res?.error || `Could not connect ${connector.name}. Retry.`);
          }
        } catch {
          vscode.window.showErrorMessage("Could not connect the app. Reconnect to an updated Andromity server and retry.");
        } finally {
          const [mcpServers, connectors] = await Promise.all([
            this._rpcClient.call<any[]>("mcp.list", { project_path: workspaceFolder }, 10000).catch(() => null),
            this._rpcClient.call<ConnectorInfo[]>("connectors.list", { project_path: workspaceFolder }, 10000).catch(() => null),
          ]);
          if (SettingsPanel._cachedState) {
            if (mcpServers) SettingsPanel._cachedState.mcpServers = mcpServers;
            if (connectors) SettingsPanel._cachedState.connectors = connectors;
          }
          if (mcpServers) this._panel.webview.postMessage({ type: "mcp_refreshed", mcpServers });
          this._panel.webview.postMessage({ type: "connectors_refreshed", connectors: connectors || SettingsPanel._cachedState?.connectors || [] });
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

  private async _refreshCronList(): Promise<void> {
    if (!this._rpcClient) return;
    const crons = await this._rpcClient.call<any[]>("cron.list", {
      project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
    if (SettingsPanel._cachedState) SettingsPanel._cachedState.crons = crons || [];
    this._panel.webview.postMessage({ type: "crons_refreshed", crons: crons || [] });
  }

  // Live run state for the Cron Jobs page: a card shows Running until its run completes.
  private _bindCronEvents(): void {
    this._cronEventDisposers.forEach((off) => off());
    this._cronEventDisposers = [];
    const client = this._rpcClient;
    if (!client) return;
    const forward = (phase: "started" | "completed") => (params: any) => {
      this._panel.webview.postMessage({ type: "cron_run_event", phase, job_id: params?.job_id, run: params?.run, job: params?.job });
    };
    const started = forward("started");
    const completed = forward("completed");
    client.on("cron/run_started", started);
    client.on("cron/run_completed", completed);
    this._cronEventDisposers.push(() => client.off("cron/run_started", started), () => client.off("cron/run_completed", completed));
  }

  public dispose() {
    this._disposed = true;
    this._cronEventDisposers.forEach((off) => off());
    this._cronEventDisposers = [];
    SettingsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _getNonce(): string {
    return getNonce();
  }

  private _getHtmlForWebview(): string {
    const logoPath = join(this._extensionUri.fsPath, "media", "icon.png");
    const usageLogoData = existsSync(logoPath) ? "data:image/png;base64," + readFileSync(logoPath).toString("base64") : "";
    const iconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "sidebar-icon.svg"));
    const nonce = typeof this._getNonce === "function" ? this._getNonce() : "mock-nonce";
    let extVersion = "0.2.15";
    try {
      const ext = vscode.extensions.getExtension("agenticmarket.andromity-agent") ||
                  SettingsPanel.extensionContext?.extension;
      if (ext?.packageJSON?.version) {
        extVersion = ext.packageJSON.version;
      }
    } catch {}
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${this._panel.webview.cspSource}; img-src ${this._panel.webview.cspSource} data:; font-src ${this._panel.webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Andromity Hub</title>
  <style>

    :root:has(> body.vscode-light), :root:has(> body.vscode-high-contrast-light) {
      --tint: 0, 0, 0;
    }
    :root {
      --tint: 255, 255, 255;
      --bg: var(--vscode-editor-background, #1e1e1e);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --card-border: var(--vscode-widget-border, rgba(var(--tint), 0.08));
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
      --font-ui: 'Inter', 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      --font-mono: 'JetBrains Mono', 'Geist Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Consolas, 'Courier New', monospace;
      --font-family: var(--font-ui);
      --font: var(--font-ui);
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

    #connection-editor .cron-form-col { min-width: min(220px, 100%); }
    #connection-editor input {
      box-sizing: border-box;
      width: 100%;
      min-height: 34px;
      border-radius: 4px;
      outline: none;
    }
    #connection-editor input:focus {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    #connection-editor .setting-desc { margin: 0; }

    .cron-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .cron-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-left: 3px solid var(--tag-green-fg);
      padding: 12px 14px 10px;
      display: flex;
      flex-direction: column;
      gap: 9px;
      transition: border-color 0.15s;
    }
    .cron-card.paused { border-left-color: var(--card-border); }
    .cron-card.running { border-left-color: var(--tag-blue-fg); }
    .cron-card:hover { border-color: var(--card-hover-border); }
    .cron-card.paused .cron-card-name, .cron-card.paused .cron-card-prompt { opacity: 0.75; }

    /* Usage Analytics Styles */
    .usage-progress-bar-wrap {
      width: 100%;
      height: 6px;
      background: rgba(var(--tint), 0.08);
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
      background: rgba(var(--tint), 0.025);
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

    .cron-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
      font-size: 12px;
      color: var(--text-muted);
      margin: -6px 0 14px;
    }
    .cron-summary strong { color: var(--text); font-weight: 600; }
    .section-desc .docs-link { color: var(--tag-blue-fg); text-decoration: underline; text-underline-offset: 2px; }

    .cron-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .cron-card-heading { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
    .cron-card-name { font-size: 13.5px; font-weight: 600; color: var(--text); }

    .cron-interval-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 1px 6px;
      background: rgba(6, 182, 212, 0.12);
      color: #06b6d4;
      border: 1px solid rgba(6, 182, 212, 0.3);
      font-family: var(--font-mono);
    }
    .cron-status-pill { font-size: 10.5px; padding: 1px 6px; font-weight: 600; border: 1px solid transparent; }
    .cron-status-pill.active { background: var(--tag-green-bg); color: var(--tag-green-fg); border-color: rgba(46, 160, 67, 0.3); }
    .cron-status-pill.paused { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text-muted); border-color: var(--card-border); }
    .cron-status-pill.running { background: var(--tag-blue-bg); color: var(--tag-blue-fg); border-color: rgba(56, 139, 253, 0.35); }
    .cron-status-pill.running::before {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-right: 5px;
      border-radius: 50%;
      background: currentColor;
      vertical-align: 1px;
      animation: cronPulse 1.2s ease-in-out infinite;
    }
    @keyframes cronPulse { 50% { opacity: 0.3; } }

    .cron-card-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .cron-card-actions .btn { padding: 4px 10px; font-size: 12px; }
    .btn-icon-danger {
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 4px 7px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
    }
    .btn-icon-danger:hover { color: #f85149; border-color: rgba(248, 81, 73, 0.5); }

    .cron-card-prompt {
      font-size: 12px;
      color: var(--text);
      line-height: 1.45;
      background: color-mix(in srgb, var(--text) 4%, transparent);
      padding: 7px 10px;
      border: 1px solid var(--card-border);
      font-family: var(--font-mono);
      white-space: pre-wrap;
      word-break: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .cron-facts {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 6px 14px;
      margin: 0;
    }
    .cron-fact { min-width: 0; }
    .cron-fact dt { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 1px; }
    .cron-fact dd { margin: 0; font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cron-outcome.success { color: var(--tag-green-fg); }
    .cron-outcome.failed, .cron-outcome.timeout { color: #f85149; }
    .cron-outcome.interrupted, .cron-outcome.needs_attention { color: var(--tag-orange-fg); }
    .cron-outcome.skipped, .cron-outcome.missed { color: var(--text-muted); }
    .cron-card.error { border-left-color: var(--tag-orange-fg); }
    .cron-status-pill.error { background: color-mix(in srgb, var(--tag-orange-fg) 14%, transparent); color: var(--tag-orange-fg); border-color: color-mix(in srgb, var(--tag-orange-fg) 40%, transparent); }
    .cron-notice {
      font-size: 11.5px;
      color: var(--text);
      background: color-mix(in srgb, var(--tag-orange-fg) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--tag-orange-fg) 35%, transparent);
      padding: 6px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .cron-notice .btn, .cron-last-error .btn { padding: 2px 8px; font-size: 11px; }
    .cron-last-error.with-fix { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .cron-schedule-preview { font-size: 11.5px; color: var(--text-muted); display: flex; flex-direction: column; gap: 2px; min-height: 16px; }
    .cron-schedule-preview.valid strong { color: var(--text); font-weight: 600; }
    .cron-schedule-preview.invalid { color: #f85149; }
    .cron-form-hint { font-size: 11px; color: var(--text-muted); margin-top: 3px; }
    .cron-form-error { font-size: 12px; color: #f85149; background: rgba(248, 81, 73, 0.08); border: 1px solid rgba(248, 81, 73, 0.25); padding: 6px 8px; }
    .cron-form-error[hidden] { display: none; }
    .cron-trigger-badge { font-size: 10px; padding: 0 5px; border: 1px solid var(--card-border); color: var(--text-muted); margin-left: 4px; }
    .cron-last-error {
      font-size: 11.5px;
      color: #f85149;
      background: rgba(248, 81, 73, 0.08);
      border: 1px solid rgba(248, 81, 73, 0.25);
      padding: 5px 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .cron-history-toggle {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: none;
      border: 0;
      padding: 2px 0;
      color: var(--text-muted);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .cron-history-toggle:hover { color: var(--text); }
    .cron-history-toggle svg { transition: transform 0.15s ease; }
    .cron-history-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }

    .cron-runs-container { border-top: 1px solid var(--card-border); padding-top: 8px; }
    .cron-runs-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11.5px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .cron-runs-head .btn { padding: 2px 8px; font-size: 11px; }
    .cron-runs-empty, .cron-runs-loading { font-size: 11.5px; color: var(--text-muted); padding: 4px 0; }
    .cron-runs { display: flex; flex-direction: column; border: 1px solid var(--card-border); }
    .cron-run + .cron-run { border-top: 1px solid var(--card-border); }
    .cron-run-summary {
      display: grid;
      grid-template-columns: 14px 128px 82px 1fr 12px;
      align-items: center;
      gap: 8px;
      width: 100%;
      background: none;
      border: 0;
      padding: 6px 9px;
      color: var(--text);
      font: inherit;
      font-size: 11.5px;
      text-align: left;
      cursor: pointer;
    }
    .cron-run-summary:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
    .cron-run-icon { font-weight: 700; }
    .cron-run.success .cron-run-icon, .cron-run.success .cron-run-status { color: var(--tag-green-fg); }
    .cron-run.failed .cron-run-icon, .cron-run.failed .cron-run-status,
    .cron-run.timeout .cron-run-icon, .cron-run.timeout .cron-run-status { color: #f85149; }
    .cron-run.interrupted .cron-run-icon, .cron-run.interrupted .cron-run-status,
    .cron-run.needs_attention .cron-run-icon, .cron-run.needs_attention .cron-run-status { color: var(--tag-orange-fg); }
    .cron-run.skipped .cron-run-icon, .cron-run.skipped .cron-run-status,
    .cron-run.missed .cron-run-icon, .cron-run.missed .cron-run-status { color: var(--text-muted); }
    .cron-run.running .cron-run-icon, .cron-run.running .cron-run-status { color: var(--tag-blue-fg); }
    .cron-run-meta { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cron-run-summary svg { transition: transform 0.15s ease; color: var(--text-muted); }
    .cron-run-summary[aria-expanded="true"] svg { transform: rotate(90deg); }
    .cron-run-detail { padding: 2px 9px 9px 31px; display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; }
    .cron-run-detail[hidden], .cron-runs-container[hidden] { display: none; }
    .cron-run-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .cron-run-output {
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 240px;
      overflow: auto;
      background: color-mix(in srgb, var(--text) 4%, transparent);
      border: 1px solid var(--card-border);
      padding: 6px 8px;
      margin: 0;
      user-select: text;
    }
    .cron-run-actions { display: flex; align-items: center; gap: 6px; }
    .cron-run-actions .btn { padding: 2px 8px; font-size: 11px; }
    .cron-run-session { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-family);
      font-feature-settings: "cv02", "cv03", "cv04", "cv11", "ss01", "ss02";
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
      letter-spacing: -0.011em;
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      flex-direction: row;
      height: 100vh;
      overflow: hidden;
    }

    /* Vertical Navigation Sidebar */
    .side-nav {
      display: flex;
      flex-direction: column;
      width: 228px;
      height: 100vh;
      background: var(--card-bg);
      border-right: 1px solid var(--card-border);
      flex-shrink: 0;
      transition: width 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
      z-index: 50;
      overflow: hidden;
      position: relative;
    }

    .sidebar-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--card-border);
      flex-shrink: 0;
      min-height: 52px;
      overflow: hidden;
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
      min-width: 0;
      cursor: default;
    }

    .brand-avatar {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .brand-icon {
      width: 24px;
      height: 24px;
      object-fit: contain;
      display: block;
    }

    .brand-info {
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
    }

    .brand-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text);
      line-height: 1.2;
    }

    .brand-subtitle {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      white-space: nowrap;
      line-height: 1.2;
    }

    .nav-tabs {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 10px 8px;
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .nav-tabs::-webkit-scrollbar {
      width: 4px;
    }
    .nav-tabs::-webkit-scrollbar-thumb {
      background: rgba(var(--tint), 0.1);
      border-radius: 4px;
    }

    .nav-tab {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      border: 1px solid transparent;
      background: transparent;
      white-space: nowrap;
      transition: all 0.15s ease;
      text-align: left;
      width: 100%;
      box-sizing: border-box;
      position: relative;
    }

    .nav-tab:hover {
      color: var(--text);
      background: rgba(var(--tint), 0.05);
    }

    .nav-tab.active {
      color: var(--text);
      background: var(--bg);
      border-color: var(--card-border);
      box-shadow: inset 2px 0 0 var(--card-hover-border), 0 1px 3px rgba(0,0,0,0.15);
      font-weight: 600;
    }

    .nav-tab svg {
      width: 15px;
      height: 15px;
      flex-shrink: 0;
      transition: transform 0.15s ease;
    }

    .nav-tab:hover svg {
      transform: scale(1.05);
    }

    .nav-tab-label {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .nav-tab-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(var(--tint), 0.08);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-weight: 600;
      margin-left: auto;
      flex-shrink: 0;
      transition: background 0.15s;
    }

    .nav-tab.active .nav-tab-badge {
      background: rgba(var(--tint), 0.15);
      color: var(--text);
    }

    /* Sidebar Footer with collapse toggle */
    .sidebar-footer {
      padding: 8px;
      border-top: 1px solid var(--card-border);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .sidebar-toggle-btn {
      color: var(--text-muted);
      font-size: 11px;
    }

    .sidebar-toggle-btn:hover {
      color: var(--text);
    }

    .sidebar-toggle-icon {
      width: 14px;
      height: 14px;
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* Collapsed / Low Space Styles */
    .side-nav.collapsed,
    .side-nav.auto-compact {
      width: 52px;
    }

    .side-nav.collapsed .sidebar-header,
    .side-nav.auto-compact .sidebar-header {
      padding: 14px 0;
      justify-content: center;
    }

    .side-nav.collapsed .brand-info,
    .side-nav.auto-compact .brand-info,
    .side-nav.collapsed .nav-tab-label,
    .side-nav.auto-compact .nav-tab-label,
    .side-nav.collapsed .nav-tab-badge,
    .side-nav.auto-compact .nav-tab-badge {
      display: none !important;
    }

    .side-nav.collapsed .nav-tabs,
    .side-nav.auto-compact .nav-tabs {
      padding: 10px 6px;
    }

    .side-nav.collapsed .nav-tab,
    .side-nav.auto-compact .nav-tab {
      justify-content: center;
      padding: 9px 0;
      gap: 0;
    }

    .side-nav.collapsed .nav-tab svg,
    .side-nav.auto-compact .nav-tab svg {
      margin: 0;
    }

    .side-nav.collapsed .sidebar-toggle-icon,
    .side-nav.auto-compact .sidebar-toggle-icon {
      transform: rotate(180deg);
    }

    /* Pure CSS Media Query for narrow viewports */
    @media (max-width: 820px) {
      .side-nav {
        width: 52px !important;
      }
      .side-nav .sidebar-header {
        padding: 14px 0 !important;
        justify-content: center !important;
      }
      .side-nav .brand-info,
      .side-nav .nav-tab-label,
      .side-nav .nav-tab-badge {
        display: none !important;
      }
      .side-nav .nav-tabs {
        padding: 10px 6px !important;
      }
      .side-nav .nav-tab {
        justify-content: center !important;
        padding: 9px 0 !important;
        gap: 0 !important;
      }
      .side-nav .nav-tab svg {
        margin: 0 !important;
      }
      .side-nav .sidebar-toggle-icon {
        transform: rotate(180deg);
      }
    }

    /* Floating Tooltip */
    .nav-floating-tooltip {
      position: fixed;
      z-index: 99999;
      pointer-events: none;
      background: var(--card-bg, #252526);
      color: var(--text, #cccccc);
      border: 1px solid var(--card-hover-border, #007fd4);
      padding: 6px 11px;
      font-size: 11.5px;
      font-weight: 500;
      white-space: nowrap;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      border-radius: 4px !important;
      opacity: 0;
      visibility: hidden;
      transform: translateX(-6px);
      transition: opacity 0.12s ease, transform 0.12s ease, visibility 0.12s ease;
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .nav-floating-tooltip.visible {
      opacity: 1;
      visibility: visible;
      transform: translateX(0);
    }

    .nav-floating-tooltip::before {
      content: '';
      position: absolute;
      left: -5px;
      top: 50%;
      transform: translateY(-50%) rotate(45deg);
      width: 8px;
      height: 8px;
      background: var(--card-bg, #252526);
      border-left: 1px solid var(--card-hover-border, #007fd4);
      border-bottom: 1px solid var(--card-hover-border, #007fd4);
    }

    .nav-floating-tooltip .tooltip-badge {
      font-size: 10px;
      background: rgba(var(--tint), 0.12);
      padding: 1px 5px;
      border-radius: 3px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    /* Main Container */
    .main-content {
      flex: 1;
      min-width: 0;
      height: 100vh;
      overflow-y: auto;
      padding: 24px 32px 56px;
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
      background: rgba(var(--tint), 0.08);
      color: var(--text);
      border: 1px solid var(--card-border);
    }

    .btn-secondary:hover {
      background: rgba(var(--tint), 0.12);
    }

    .btn-danger {
      background: rgba(248, 81, 73, 0.15);
      color: #f85149;
      border: 1px solid rgba(248, 81, 73, 0.4);
    }

    .btn-danger:hover {
      background: rgba(248, 81, 73, 0.25);
    }

    .btn.waitlist-offer {
      align-self: flex-start;
      padding: 4px 10px;
      font-size: 11px;
    }

    .btn.waitlist-offer:disabled {
      cursor: default;
      color: var(--tag-green-fg);
      background: rgba(var(--tint), 0.08);
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

    .airgap-hosts {
      margin-top: 10px;
      padding-left: 26px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .airgap-hosts textarea {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .airgap-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .airgap-state:empty { display: none; }
    .airgap-results { display: flex; flex-direction: column; gap: 4px; }
    .airgap-result { font-size: 12px; }
    .airgap-result.pass strong { color: var(--vscode-testing-iconPassed, #1a7f37); }
    .airgap-result.fail strong { color: var(--vscode-errorForeground, #cf222e); }

    .chip {
      font-family: inherit;
      line-height: inherit;
      padding: 3px 9px;
      border-radius: 4px;
      font-size: 11px;
      background: rgba(var(--tint), 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
      transition: all 0.15s;
    }

    .chip:hover {
      color: var(--text);
      border-color: rgba(var(--tint), 0.2);
    }

    .chip.active {
      background: var(--primary);
      color: var(--primary-fg);
      border-color: var(--primary);
    }

    .chip .chip-count {
      opacity: 0.65;
      margin-left: 3px;
    }

    .skill-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      justify-content: flex-end;
    }

    .skill-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 8px;
    }

    .skill-tag {
      font-size: 10.5px;
      color: var(--text-muted);
      cursor: pointer;
    }

    .skill-tag:hover {
      color: var(--text);
    }

    .item-card[data-action="skill-open"] {
      cursor: pointer;
    }

    .skill-detail-overlay {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.55);
    }

    .skill-detail {
      width: min(720px, 100%);
      max-height: 100%;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 18px 20px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
    }

    .skill-detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .skill-detail-title {
      margin: 0;
      font-size: 16px;
      word-break: break-word;
    }

    .skill-detail-desc {
      margin: 0;
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--text);
    }

    .skill-detail-meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
    }

    .skill-detail-row {
      display: flex;
      gap: 10px;
    }

    .skill-detail-label {
      flex: 0 0 96px;
      color: var(--text-muted);
    }

    .skill-detail-doc {
      margin: 0;
      max-height: 260px;
      overflow: auto;
      padding: 10px 12px;
      font-family: var(--font-mono);
      font-size: 11.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--card-border);
      border-radius: 6px;
    }

    .skill-detail-doc-note {
      font-size: 12px;
      color: var(--text-muted);
    }

    .skill-detail-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding-top: 4px;
    }

    .skills-footer {
      grid-column: 1 / -1;
      display: flex;
      justify-content: center;
      padding: 6px 0 2px;
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
      font-family: var(--font-mono);
      font-feature-settings: "calt", "zero";
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
      font-family: var(--font-mono);
      font-feature-settings: "calt", "zero";
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

    .pin-card-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 2px 6px;
      font-size: 10.5px;
      border-radius: 4px;
      border: 1px solid var(--card-border);
      background: rgba(var(--tint), 0.03);
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .pin-card-btn:hover {
      background: rgba(var(--tint), 0.08);
      color: #f59e0b;
      border-color: rgba(245, 158, 11, 0.35);
    }
    .pin-card-btn.pinned {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.35);
      color: #f59e0b;
      font-weight: 500;
    }
    .pin-card-btn.pinned:hover {
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(239, 68, 68, 0.35);
      color: #ef4444;
    }

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
      background: rgba(var(--tint), 0.08);
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
    }

    .item-card-desc {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .connector-icon { width: 28px; height: 28px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid var(--card-border); }
    .connector-icon svg { width: 16px; height: 16px; }
    .connector-icon-letter { background: var(--primary-hover); font-size: 13px; font-weight: 700; }
    .connector-icon.small { width: 20px; height: 20px; border-radius: 4px; }
    .connector-icon.small svg { width: 12px; height: 12px; }
    .connector-icon.small.connector-icon-letter { font-size: 10px; }
    .connector-category { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin: 12px 0 6px; }
    .connector-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
    .connector-tile { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--card-border); border-radius: 4px; min-width: 0; }
    .connector-text { flex: 1; min-width: 0; }
    .connector-name { font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .connector-desc { font-size: 11px; color: var(--text-muted); overflow-wrap: anywhere; }
    .connector-tile .btn { flex-shrink: 0; font-size: 11px; padding: 4px 10px; }
    .connector-guide { display: inline-block; margin-top: 3px; font-size: 11px; color: var(--tag-blue-fg); text-decoration: underline; text-underline-offset: 2px; }
    #mcp-grid {
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr));
    }
    .mcp-card { min-width: 0; }
    .mcp-card .item-card-top { gap: 8px; flex-wrap: wrap; }
    .mcp-card .item-card-title { min-width: 0; overflow-wrap: anywhere; }
    .mcp-card .status-dot { flex-shrink: 0; }
    .mcp-endpoint, .mcp-endpoint code {
      min-width: 0;
      max-width: 100%;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .mcp-tools { min-width: 0; border: 1px solid var(--card-border); border-radius: 4px; }
    .mcp-tools summary {
      cursor: pointer;
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--primary-fg);
      background: var(--primary);
      border-radius: 4px;
    }
    .mcp-tools summary:hover { background: var(--primary-hover); }
    .mcp-tools summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .mcp-tools-list { max-height: 280px; overflow: auto; padding: 0 10px; }
    .mcp-tool { padding: 10px 0; border-bottom: 1px solid var(--card-border); }
    .mcp-tool:last-child { border-bottom: 0; }
    .mcp-tool-name { font-family: var(--font-mono); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .mcp-tool-description { font-size: 12px; line-height: 1.5; color: var(--text-muted); overflow-wrap: anywhere; margin: 4px 0; }

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
      font-family: var(--font-mono);
      font-feature-settings: "calt", "zero";
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

    .key-actions-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .btn-test-key {
      padding: 4px 12px;
      font-size: 11px;
    }

    .btn-test-key:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .key-test-status {
      font-size: 11px;
      line-height: 1.4;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .key-test-status:empty { display: none; }
    .key-test-status.ok { color: var(--tag-green-fg); }
    .key-test-status.warn { color: var(--tag-orange-fg); }
    .key-test-status.error { color: #f85149; }

    .models-source-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 16px;
      margin-bottom: 12px;
      font-size: 11.5px;
      color: var(--text-muted);
    }

    .models-source-bar[hidden] { display: none; }
    .source-item { display: inline-flex; align-items: center; gap: 6px; }
    .source-name { color: var(--text); }
    .source-reason { color: var(--tag-orange-fg); }

    .source-refresh {
      background: none;
      border: none;
      padding: 0;
      font-size: 11.5px;
      color: var(--tag-blue-fg);
      cursor: pointer;
    }

    .source-refresh:hover { text-decoration: underline; }
    .source-refresh:disabled { color: var(--text-muted); cursor: default; text-decoration: none; }

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
      min-height: 190px;
      overflow: visible !important;
      z-index: 100;
    }

    .usage-chart-svg {
      width: 100%;
      height: auto;
      display: block;
      overflow: visible;
    }

    .chart-grid-line {
      stroke: rgba(var(--tint), 0.06);
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
      fill: rgba(var(--tint), 0.05);
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
      background: rgba(18, 18, 24, 0.98);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(var(--tint), 0.18);
      border-radius: 9px;
      padding: 10px 14px;
      font-size: 12px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.85), 0 4px 12px rgba(0, 0, 0, 0.5);
      z-index: 99999 !important;
      opacity: 0;
      transform: translate(-50%, -100%) translateY(-10px);
      transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      white-space: nowrap;
      min-width: 180px;
    }

    .chart-tooltip.visible {
      opacity: 1;
      transform: translate(-50%, -100%) translateY(-14px);
    }

    .chart-tooltip-header {
      font-weight: 600;
      color: #f4f4f5;
      font-size: 12px;
      margin-bottom: 6px;
      padding-bottom: 5px;
      border-bottom: 1px solid rgba(var(--tint), 0.08);
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
      background: rgba(var(--tint), 0.02);
      border: 1px solid rgba(var(--tint), 0.05);
      border-radius: 6px;
      padding: 10px 12px;
      transition: all 0.15s ease;
    }

    .usage-item-row:hover {
      background: rgba(var(--tint), 0.04);
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
      background: rgba(var(--tint), 0.06);
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
      font-family: var(--font-mono);
      font-feature-settings: "calt", "zero";
      color: var(--text);
    }

    .shimmer-text {
      color: var(--text-muted, #71717a);
      font-size: 11.5px;
      font-style: italic;
      opacity: 0.8;
      display: inline-block;
      animation: pulseShimmer 1.8s ease-in-out infinite alternate;
    }

    @keyframes pulseShimmer {
      from { opacity: 0.35; }
      to { opacity: 0.85; }
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

    .usage-share-bar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-top:16px; }
    .usage-share-bar h2 { margin:0; }
    .usage-pagination { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-top:14px; color:var(--text-muted); font-size:11px; }
    .usage-pagination button:disabled { opacity:.4; cursor:default; }
    .usage-day:hover, .usage-day:focus { stroke:var(--text, #fff); stroke-width:1.5; outline:none; }
    .usage-share-dialog { background:var(--card-bg, #161b22); color:var(--text, #eee); border:1px solid var(--card-border); border-radius:12px; padding:20px; width:min(720px, calc(100vw - 48px)); max-height:90vh; overflow-y:auto; }
    .usage-share-dialog::backdrop { background:rgba(0,0,0,.7); }
    .usage-share-controls { display:flex; flex-wrap:wrap; gap:14px; margin:16px 0; align-items:center; }
    .usage-share-controls label { font-size:12px; display:flex; gap:8px; align-items:center; }
    .usage-share-controls select { background:var(--input-bg, #111); color:inherit; border:1px solid var(--card-border); border-radius:5px; padding:7px; max-width:100%; }
    .usage-share-preview-wrap { padding:16px; background:rgba(0,0,0,.15); border-radius:8px; text-align:center; }
    #usage-share-preview { max-width:100%; max-height:420px; object-fit:contain; border-radius:8px; }
  </style>
</head>
<body>

  <!-- Vertical Navigation Sidebar -->
  <aside class="side-nav" id="side-nav">
    <div class="sidebar-header">
      <div class="brand-group" id="brand-group" data-tooltip="Andromity Hub v${extVersion}">
        <div class="brand-avatar">
          <img class="brand-icon" src="${iconUri}" alt="Andromity" />
        </div>
        <div class="brand-info">
          <span class="brand-title">Andromity Hub</span>
          <span class="brand-subtitle">v${extVersion}</span>
        </div>
      </div>
    </div>

    <div class="nav-tabs" id="nav-tabs-container">
      <button class="nav-tab active" data-tab="models" id="tab-btn-models" data-tooltip="Model Hub" aria-label="Model Hub">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
        <span class="nav-tab-label">Model Hub</span>
        <span class="nav-tab-badge" id="model-count-badge">0</span>
      </button>
      <button class="nav-tab" data-tab="crons" id="tab-btn-crons" data-tooltip="Cron Jobs" aria-label="Cron Jobs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        <span class="nav-tab-label">Cron Jobs</span>
        <span class="nav-tab-badge" id="crons-count-badge">0</span>
      </button>
      <button class="nav-tab" data-tab="keys" id="tab-btn-keys" data-tooltip="API Keys & Connectors" aria-label="API Keys & Connectors">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>
        <span class="nav-tab-label">API Keys & Connectors</span>
      </button>
      <button class="nav-tab" data-tab="skills" id="tab-btn-skills" data-tooltip="Skills & Packs" aria-label="Skills & Packs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        <span class="nav-tab-label">Skills & Packs</span>
        <span class="nav-tab-badge" id="skills-count-badge">0</span>
      </button>
      <button class="nav-tab" data-tab="mcp" id="tab-btn-mcp" data-tooltip="MCP Servers" aria-label="MCP Servers">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M9 9h6v6H9z"></path></svg>
        <span class="nav-tab-label">MCP Servers</span>
      </button>
      <button class="nav-tab" data-tab="usage" id="tab-btn-usage" data-tooltip="Usage & Costs" aria-label="Usage & Costs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
        <span class="nav-tab-label">Usage & Costs</span>
      </button>
      <button class="nav-tab" data-tab="trust" id="tab-btn-trust" data-tooltip="Trust & Security" aria-label="Trust & Security">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
        <span class="nav-tab-label">Trust & Security</span>
      </button>
      <button class="nav-tab" data-tab="general" id="tab-btn-general" data-tooltip="Preferences" aria-label="Preferences">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        <span class="nav-tab-label">Preferences</span>
      </button>
      <button class="nav-tab" data-tab="personalisation" id="tab-btn-personalisation" data-tooltip="Personalisation" aria-label="Personalisation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"></circle><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"></circle><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"></circle><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"></circle><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2z"></path></svg>
        <span class="nav-tab-label">Personalisation</span>
      </button>
      <button class="nav-tab" data-tab="about" id="tab-btn-about" data-tooltip="About & Diagnostics" aria-label="About & Diagnostics">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
        <span class="nav-tab-label">About & Diagnostics</span>
      </button>
    </div>

    <div class="sidebar-footer">
      <button class="nav-tab sidebar-toggle-btn" id="sidebar-toggle-btn" data-tooltip="Toggle Navigation" aria-label="Toggle Navigation">
        <svg class="sidebar-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="11 17 6 12 11 7"></polyline><polyline points="18 17 13 12 18 7"></polyline></svg>
        <span class="nav-tab-label">Collapse Sidebar</span>
      </button>
    </div>
  </aside>

  <!-- Floating Tooltip Container -->
  <div class="nav-floating-tooltip" id="nav-floating-tooltip"></div>

  <!-- Main Body Content -->
  <div class="main-content">

    <!-- ── TAB 1: MODEL HUB ────────────────────────────────────────── -->
    <div class="tab-pane active" id="pane-models">
      <div class="section-header">
        <div>
          <h2 class="section-title">Live Model Hub</h2>
          <p class="section-desc">Discover models from your connected providers. Filter free routes or choose an exact model ID. <a href="#" class="docs-link" data-docs-url="${DOCS.modelHub}">How the Model Hub works</a></p>
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
          <button type="button" class="chip active" data-category="all">All</button>
          <button type="button" class="chip" data-category="pinned">📌 Pinned</button>
          <button type="button" class="chip" data-category="free">Free Tier</button>
          <button type="button" class="chip" data-category="coding">Coding & Agentic</button>
          <button type="button" class="chip" data-category="reasoning">Reasoning / Thinking</button>
          <button type="button" class="chip" data-category="vision">Vision & Multimodal</button>
          <button type="button" class="chip" data-category="flagship">Flagships</button>
        </div>

        <div class="filter-chips">
          <span class="chip-label">Provider:</span>
          <button type="button" class="chip active" data-provider="all">All Providers</button>
          <button type="button" class="chip" data-provider="andromity">Andromity</button>
          <button type="button" class="chip" data-provider="openrouter">OpenRouter</button>
          <button type="button" class="chip" data-provider="anthropic">Anthropic</button>
          <button type="button" class="chip" data-provider="openai">OpenAI</button>
          <button type="button" class="chip" data-provider="google">Gemini</button>
          <button type="button" class="chip" data-provider="deepseek">DeepSeek</button>
          <button type="button" class="chip" data-provider="groq">Groq</button>
          <button type="button" class="chip" data-provider="ollama">Ollama (Local)</button>
          <span id="custom-provider-chips" style="display:contents;"></span>
          <button type="button" class="chip" data-provider="nvidia">NVIDIA NIM</button>
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

      <div class="models-source-bar" id="models-source-bar" role="status" aria-live="polite" hidden></div>
      <div class="models-grid" id="models-grid"></div>
    </div>

    <!-- ── TAB: CRON JOBS ────────────────────────────────────────────── -->
    <div class="tab-pane" id="pane-crons">
      <div class="section-header">
        <div>
          <h2 class="section-title">Scheduled Cron Jobs</h2>
          <p class="section-desc">Automate recurring agent tasks, diagnostics, test runs, and codebase maintenance on a schedule. <a href="#" class="docs-link" data-docs-url="${DOCS.cron}">How cron jobs work</a></p>
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
      <div class="cron-summary" id="cron-summary"></div>

      <!-- Add / Edit Cron Job Form Drawer -->
      <div class="cron-form" id="cron-create-form" style="display:none;">
        <div style="font-size:14px; font-weight:600; margin-bottom:4px;" id="cron-form-title">Create Scheduled Job</div>
        <div class="cron-form-row">
          <div class="cron-form-col">
            <label for="cron-name-input">Job Name</label>
            <input type="text" id="cron-name-input" placeholder="e.g. Daily Health & Test Suite">
          </div>
          <div class="cron-form-col">
            <label for="cron-schedule-select">Schedule</label>
            <select id="cron-schedule-select">
              <option value="every 15m">Every 15 minutes</option>
              <option value="every 30m">Every 30 minutes</option>
              <option value="every 1h" selected>Every hour</option>
              <option value="every 2h">Every 2 hours</option>
              <option value="every 6h">Every 6 hours</option>
              <option value="every 12h">Every 12 hours</option>
              <option value="daily at 09:00">Every day at 9:00</option>
              <option value="weekdays at 09:00">Weekdays at 9:00</option>
              <option value="mondays at 09:00">Every Monday at 9:00</option>
              <option value="daily at 18:00">Every day at 18:00</option>
              <option value="custom">Custom schedule…</option>
            </select>
            <input type="text" id="cron-custom-schedule" style="display:none; margin-top:6px;" aria-label="Custom schedule" placeholder="every 45m · weekdays at 08:30 · 2026-12-01 14:00 · 0 9 * * 1-5">
          </div>
        </div>
        <div class="cron-schedule-preview" id="cron-schedule-preview" aria-live="polite"></div>
        <div class="cron-form-row">
          <div class="cron-form-col">
            <label for="cron-model-select">AI Model</label>
            <select id="cron-model-select">
              <option value="">Default Active Model</option>
            </select>
          </div>
          <div class="cron-form-col">
            <label for="cron-mode-select">Permission Mode</label>
            <select id="cron-mode-select">
              <option value="safe">SAFE · reads files, no edits</option>
              <option value="trust">TRUST · edits files</option>
              <option value="full">FULL</option>
              <option value="yolo">YOLO · approves everything</option>
            </select>
          </div>
        </div>
        <div class="cron-form-row">
          <div class="cron-form-col" style="flex:100%;">
            <label for="cron-commands-input">Allowed Shell Commands</label>
            <input type="text" id="cron-commands-input" placeholder="e.g. pytest, npm test, git status">
            <div class="cron-form-hint">Nobody approves commands during a scheduled run. Commands not on this list are blocked, and the run is marked Needs attention.</div>
          </div>
        </div>
        <div class="cron-form-row">
          <div class="cron-form-col">
            <label for="cron-timeout-select">Time Limit</label>
            <select id="cron-timeout-select">
              <option value="300">5 minutes</option>
              <option value="600" selected>10 minutes</option>
              <option value="900">15 minutes</option>
              <option value="1800">30 minutes</option>
              <option value="3600">1 hour</option>
              <option value="7200">2 hours</option>
            </select>
          </div>
          <div class="cron-form-col">
            <label for="cron-onfail-select">When a Run Fails</label>
            <select id="cron-onfail-select">
              <option value="retry">Retry temporary errors</option>
              <option value="notify">Record it and wait</option>
              <option value="disable">Pause the job</option>
            </select>
          </div>
          <div class="cron-form-col">
            <label for="cron-notify-select">Notify Me</label>
            <select id="cron-notify-select">
              <option value="failures">When a run needs attention</option>
              <option value="always">After every run</option>
              <option value="never">Never</option>
            </select>
          </div>
          <div class="cron-form-col">
            <label for="cron-catchup-select">Missed Runs</label>
            <select id="cron-catchup-select">
              <option value="once">Run once when Andromity is back (within 24h)</option>
              <option value="skip">Skip them</option>
            </select>
          </div>
        </div>
        <div class="cron-form-row">
          <div class="cron-form-col" style="flex:100%;">
            <label for="cron-prompt-input">Prompt / Agent Instructions</label>
            <textarea id="cron-prompt-input" rows="3" placeholder="e.g. Inspect git status, run unit tests, and summarize any failures or lint issues."></textarea>
          </div>
        </div>
        <div class="cron-form-hint" id="cron-form-folder"></div>
        <div class="cron-form-error" id="cron-form-error" role="alert" hidden></div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
          <button class="btn btn-secondary" id="btn-cancel-cron">Cancel</button>
          <button class="btn btn-secondary" id="btn-save-run-cron">Save and run now</button>
          <button class="btn" id="btn-save-cron">Create job</button>
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
          <p class="section-desc">Manage provider connections and credentials in your local configuration. <a href="#" class="docs-link" data-docs-url="${DOCS.apiKeys}">API keys and environment variables</a> &middot; <a href="#" class="docs-link" data-docs-url="${DOCS.customProviders}">Custom providers</a></p>
        </div>
        <button class="btn btn-secondary" data-action="add-provider">Add custom provider</button>
      </div>
      <div class="cron-form" id="connection-editor" style="display:none; margin-bottom:16px;">
        <div class="cron-form-row">
          <div class="cron-form-col"><label for="connection-id">Connection ID</label><input id="connection-id" placeholder="local-models"></div>
          <div class="cron-form-col"><label for="connection-name">Display name</label><input id="connection-name" placeholder="Local models"></div>
        </div>
        <div class="cron-form-row">
          <div class="cron-form-col"><label for="connection-url">Base URL</label><input id="connection-url" placeholder="http://localhost:1234/v1"></div>
          <div class="cron-form-col"><label for="connection-model">Model ID</label><input id="connection-model" placeholder="provider/model-name"></div>
        </div>
        <p class="setting-desc">Use the API root, for example https://your-provider/v1. Pasted /chat/completions endpoints are converted automatically.</p>
        <div class="cron-form-row">
          <div class="cron-form-col">
            <label for="connection-key">API key</label>
            <input type="password" id="connection-key" autocomplete="off" spellcheck="false" placeholder="Enter API key" aria-describedby="connection-key-hint">
            <p class="setting-desc" id="connection-key-hint">Optional. Leave blank to keep the saved key.</p>
          </div>
        </div>
        <details style="margin:12px 0;"><summary>Advanced</summary>
          <div class="cron-form-row" style="margin-top:10px;">
            <div class="cron-form-col"><label for="connection-type">LiteLLM provider type</label><input id="connection-type" value="openai" placeholder="openai"></div>
            <div class="cron-form-col"><label for="connection-version">API version · optional</label><input id="connection-version"></div>
          </div>
          <p class="setting-desc">OpenAI-compatible is the default. Other adapters can use the runtime's standard environment credentials.</p>
        </details>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button class="btn btn-secondary" data-action="cancel-provider">Cancel</button>
          <button class="btn" data-action="save-provider">Save connection</button>
        </div>
      </div>
      <div id="provider-status" role="status" aria-live="polite" class="setting-desc" style="margin-bottom:10px;"></div>
      <div class="cards-grid" id="keys-grid"></div>
    </div>

    <!-- ── TAB 3: SKILLS & WORKFLOWS ────────────────────────────────── -->
    <div class="tab-pane" id="pane-skills">
      <div class="section-header">
        <div>
          <h2 class="section-title">Skills & Instruction Packs</h2>
          <p class="section-desc">Modular skills loaded from local workspace, global config, and the Andromity skills catalog. Browse by category and search by name or tag. <a href="#" class="docs-link" data-docs-url="${DOCS.skills}">Writing and installing skills</a></p>
        </div>
      </div>

      <div class="model-controls">
        <div class="filter-chips">
          <span class="chip-label">View:</span>
          <button type="button" class="chip active" id="filter-skills-installed">Installed (<span id="installed-skills-num">0</span>)</button>
          <button type="button" class="chip" id="filter-skills-registry">Browse Online Registry (<span id="remote-skills-num">0</span>)</button>
        </div>

        <div class="search-row">
          <div class="search-input-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" class="search-input" id="skills-search" placeholder="Search skills by name, description, or tag (e.g. pdf, testing, deploy)...">
          </div>
        </div>

        <div class="filter-chips" id="skills-category-chips" style="display:none;"></div>
        <div class="filter-chips" id="skills-source-chips" style="display:none;"></div>
        <div class="filter-chips" id="skills-scope-chips" style="display:none;">
          <span class="chip-label">Install to:</span>
          <button type="button" class="chip active" data-action="skills-scope" data-value="user">All projects</button>
          <button type="button" class="chip" data-action="skills-scope" data-value="project">This project only</button>
        </div>
      </div>

      <div class="cards-grid" id="skills-grid"></div>
      <div class="skill-detail-overlay" id="skill-detail-overlay"></div>
    </div>

    <!-- ── TAB 4: MCP SERVERS ───────────────────────────────────────── -->
    <div class="tab-pane" id="pane-mcp">
      <div class="section-header">
        <div>
          <h2 class="section-title">Model Context Protocol (MCP)</h2>
          <p class="section-desc">External database connectors, tool servers, and enterprise context integrations. <a href="#" class="docs-link" data-docs-url="${DOCS.mcp}">Connecting MCP servers</a></p>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn" data-action="mcp_add">Add MCP Server</button>
          <button class="btn btn-secondary" id="btn-refresh-mcp">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <span>Refresh</span>
          </button>
        </div>
      </div>
      <div class="model-controls">
        <div class="filter-chips">
          <span class="chip-label">View:</span>
          <button type="button" class="chip active" id="filter-mcp-yours">Yours (<span id="mcp-yours-num">0</span>)</button>
          <button type="button" class="chip" id="filter-mcp-discover">Discover (<span id="mcp-discover-num">0</span>)</button>
        </div>
        <div class="search-row" id="connectors-search-row" style="display:none;">
          <div class="search-input-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" class="search-input" id="connectors-search" placeholder="Search apps by name or category (e.g. email, issues, payments)...">
          </div>
        </div>
      </div>
      <div id="mcp-view-yours">
        <div class="cards-grid" id="mcp-grid"></div>
      </div>
      <div id="mcp-view-discover" style="display:none;">
        <p class="section-desc">Official servers from each app. Sign in once in your browser; connected apps are saved to ~/.andromity/mcp.json and work in every trusted workspace. <a href="#" class="docs-link" data-docs-url="${INTEGRATIONS_URL}">Setup guides for every app</a></p>
        <div id="connectors-list"></div>
      </div>
    </div>

    <!-- ── TAB 5: USAGE & COSTS ─────────────────────────────────────── -->
    <div class="tab-pane" id="pane-usage">
      <div class="section-header">
        <div>
          <h2 class="section-title">Usage & Cost Analytics</h2>
          <p class="section-desc">Track token volume, estimated API expenditure, model usage share, and session history.</p>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <div class="filter-chips" id="usage-scope-chips" style="margin: 0;">
            <button type="button" class="chip active" data-usage-scope="global">All Projects (Global)</button>
            <button type="button" class="chip" data-usage-scope="project">This Project</button>
          </div>
          <div class="filter-chips" id="usage-range-chips" style="margin: 0;">
            <button type="button" class="chip active" data-usage-range="all">All Time</button>
            <button type="button" class="chip" data-usage-range="month">30 Days</button>
            <button type="button" class="chip" data-usage-range="week">7 Days</button>
            <button type="button" class="chip" data-usage-range="today">Today</button>
          </div>
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

      <div class="usage-share-bar">
        <p class="setting-desc">Your progress, ready to share. Create a branded image for X or Instagram.</p>
        <button class="btn" id="usage-share-open">Share usage ↗</button>
      </div>
      <p id="usage-status" class="setting-desc" role="status" aria-live="polite"></p>

      <div class="settings-card" style="margin-top:14px; position:relative; overflow:visible;">
        <div class="setting-label" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <span>Daily Token Activity</span>
          <div style="display:flex;gap:12px;align-items:center;"><span id="usage-bar-period" class="setting-desc">Last 14 Days</span><button class="btn btn-secondary" data-usage-share-kind="daily">Export chart</button></div>
        </div>
        <div id="usage-bar-chart-container" style="margin-top:12px;overflow:visible;"></div>
      </div>

      <!-- GitHub-Style Daily Activity Chart -->
      <div class="settings-card" style="margin-top: 14px; position: relative; z-index: 30; overflow: visible;">
        <div class="setting-label" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <span>Daily Session Activity</span><button class="btn btn-secondary" data-usage-share-kind="activity">Export graph</button>
          <span id="usage-activity-period" style="font-size:11px; font-weight:normal; color:var(--text-muted);"></span>
        </div>
        <p id="usage-activity-summary" class="setting-desc"></p>
        <div id="usage-chart-container" style="margin-top: 12px; overflow-x: auto;"></div>
        <p class="setting-desc">Color shows token volume. Session totals are grouped by their last activity date (UTC); this is not a per-day token ledger. Streaks use days with recorded tokens.</p>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 14px; margin-top: 14px;">
        <!-- Model Distribution Breakdown -->
        <div class="settings-card">
          <div class="setting-label">Model Distribution</div>
          <div class="setting-desc">Token consumption breakdown across AI models</div>
          <div id="usage-models-breakdown" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
          <div id="usage-models-pagination" class="usage-pagination"></div>
        </div>

        <!-- Provider Distribution Breakdown -->
        <div class="settings-card">
          <div class="setting-label">Provider Distribution</div>
          <div class="setting-desc">Token share across configured API providers</div>
          <div id="usage-providers-breakdown" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
          <div id="usage-providers-pagination" class="usage-pagination"></div>
        </div>
      </div>

      <!-- Recent Sessions Table -->
      <div class="settings-card" style="margin-top: 14px;">
        <div class="setting-label">Recent Session Activity</div>
        <div class="setting-desc">Detailed log of past agent conversations and token volume</div>
        <div style="overflow-x: auto; margin-top: 10px;">
          <table class="diag-table" id="usage-sessions-table">
            <thead>
              <tr style="background: rgba(var(--tint), 0.03); border-bottom: 1px solid var(--card-border);">
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
        <div id="usage-sessions-pagination" class="usage-pagination"></div>
      </div>
      <dialog id="usage-share-dialog" class="usage-share-dialog" aria-labelledby="usage-share-title">
        <img id="usage-brand-logo" src="${usageLogoData}" alt="" hidden>
        <div class="usage-share-bar"><h2 id="usage-share-title">Share your progress</h2><button class="btn btn-secondary" id="usage-share-close" aria-label="Close share preview">Close</button></div>
        <p class="setting-desc">Only aggregate stats appear. Session names, project paths, prompts, and account details stay private.</p>
        <div class="usage-share-controls">
          <label>Card <select id="usage-share-kind"><option value="recap">Usage recap</option><option value="activity">Activity & streaks</option><option value="daily">Daily token chart</option></select></label>
          <label>Format <select id="usage-share-format"><option value="square">Square · 1080 × 1080</option><option value="landscape">X · 1200 × 675</option><option value="story">Story · 1080 × 1920</option></select></label>
          <label><input type="checkbox" id="usage-share-cost"> Include estimated cost</label>
        </div>
        <div class="usage-share-preview-wrap"><img id="usage-share-preview" alt="Preview of your Andromity usage image"></div>
        <div class="usage-share-bar"><span class="setting-desc">Save the PNG, then attach it to your post.</span><div><button class="btn btn-secondary" id="usage-share-caption">Copy caption</button> <button class="btn" id="usage-share-save">Save PNG</button></div></div>
        <p id="usage-share-status" class="setting-desc" role="status" aria-live="polite"></p>
      </dialog>
    </div>

    <!-- ── TAB 6: TRUST & SECURITY ─────────────────────────────────── -->
    <div class="tab-pane" id="pane-trust">
      <div class="section-header">
        <div>
          <h2 class="section-title">Trust & Workspace Governance</h2>
          <p class="section-desc">Manage folder trust permissions, review auto-approved directories, and safety boundaries. <a href="#" class="docs-link" data-docs-url="${DOCS.security}">How folder trust works</a></p>
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
          <div class="setting-label">Remembered approvals</div>
          <div class="setting-desc">Commands and web domains you chose to always allow. In TRUST mode they run without asking. Remove any you no longer want.</div>
          <div id="remembered-approvals-list" style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px;"></div>
        </div>

        <div class="settings-card">
          <div class="setting-label">Permission Modes Explained</div>
          <table class="diag-table" style="margin-top: 6px;">
            <tr>
              <td style="color: var(--tag-green-fg); font-weight: 600;">SAFE</td>
              <td>Asks before file edits, commands, web and MCP actions, subagents and messages to other sessions. Reading and searching files runs without asking.</td>
            </tr>
            <tr>
              <td style="color: var(--tag-blue-fg); font-weight: 600;">TRUST</td>
              <td>Edits files and runs allowlisted commands without asking. Asks before other commands, unlisted domains, MCP tools that change things, and edits to sensitive or execution-control files.</td>
            </tr>
            <tr>
              <td style="color: var(--tag-purple-fg); font-weight: 600;">FULL</td>
              <td>Nothing asks for approval. Folder trust, profile limits and Andromity's file protections still apply.</td>
            </tr>
            <tr>
              <td style="color: var(--tag-orange-fg); font-weight: 600;">YOLO</td>
              <td>The same as FULL in VS Code. In the terminal app, YOLO lasts for the current session only.</td>
            </tr>
          </table>
          <p class="section-desc" style="margin-top: 8px;"><a href="#" class="docs-link" data-docs-url="${DOCS.permissionModes}">Full rules, allowlists and approval choices</a></p>
        </div>
      </div>
    </div>

    <!-- ── TAB 7: AGENT PREFERENCES ─────────────────────────────────── -->
    <div class="tab-pane" id="pane-general">
      <div class="section-header">
        <div>
          <h2 class="section-title">Agent Preferences & Configuration</h2>
          <p class="section-desc">Configure governance rules, agent profiles, subagent concurrency, and storage thresholds. <a href="#" class="docs-link" data-docs-url="${DOCS.preferences}">Every preference explained</a></p>
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
          <div class="setting-label">Startup Session Restoration</div>
          <div class="setting-desc">Control whether to resume the previous conversation or always open a fresh empty session on IDE relaunch.</div>
          <select class="setting-select" id="setting-startup-session">
            <option value="fresh">Fresh Session — Always start empty, history stays in the drawer (Default)</option>
            <option value="last">Last Session — Resume the previous active session</option>
          </select>
        </div>

        <div class="settings-card">
          <div class="setting-label">Live Waterfall Auto-Open</div>
          <div class="setting-desc">Automatically open the real-time execution waterfall panel for every agent session. You can also open it on demand anytime from the chat top bar.</div>
          <select class="setting-select" id="setting-waterfall-auto-open">
            <option value="enabled">Enabled — Auto-open waterfall on session start (Default)</option>
            <option value="disabled">Disabled — Only open waterfall manually</option>
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
          <div class="setting-desc">Controls supported by the selected model. Auto uses the provider default.</div>
          <select class="setting-select" id="setting-reasoning">
            <option value="auto">Auto — Provider default</option>
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
            <option value="3">3 Subagents</option>
            <option value="4">4 Subagents</option>
            <option value="5">5 Subagents (Default)</option>
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
            <input type="checkbox" id="setting-next-steps">
            <div>
              <div class="setting-label">Suggested Next Steps</div>
              <div class="setting-desc">After a reply, Andromity may suggest one follow-up you can start with a click or put in the input with Tab. Also applies to the terminal app.</div>
            </div>
          </label>
        </div>

        <div class="settings-card">
          <label class="checkbox-row">
            <input type="checkbox" id="setting-telemetry">
            <div>
              <div class="setting-label">Usage Telemetry</div>
              <div class="setting-desc">Sends usage data linked to a random installation ID to help improve Andromity: OS, app version, country, provider and model name, reasoning mode, session and task outcomes, error categories and the names of features you use. <strong>No prompts, code, file paths, or API keys are ever transmitted.</strong> Opt out anytime here or with <code>DO_NOT_TRACK=1</code>.</div>
            </div>
          </label>
        </div>

        <div class="settings-card airgap-card">
          <label class="checkbox-row">
            <input type="checkbox" id="setting-airgap">
            <div>
              <div class="setting-label">Air-gap Mode</div>
              <div class="setting-desc">Andromity makes no network connections except to this machine and the private hosts you list below. Cloud models, web search, remote MCP servers, sign-in and telemetry turn off, and commands the agent runs are blocked from the internet where possible. For complete isolation, also use your firewall. <a href="#" class="docs-link" data-docs-url="${DOCS.airGap}">How air-gap mode works</a></div>
              <div class="setting-desc airgap-state" id="airgap-state" aria-live="polite"></div>
            </div>
          </label>
          <div class="airgap-hosts">
            <label class="setting-label" for="airgap-hosts">Allowed private hosts</label>
            <textarea id="airgap-hosts" class="custom-model-input" rows="2" spellcheck="false" placeholder="10.0.0.5, gpu-box.lan, 10.0.0.0/8"></textarea>
            <div class="setting-desc">For a model server on your network. Separate with commas or new lines. Public addresses are ignored, and only your user settings can add hosts.</div>
            <div class="airgap-actions">
              <button type="button" class="btn btn-secondary" data-action="airgap-save-hosts">Save hosts</button>
              <button type="button" class="btn btn-secondary" data-action="airgap-self-test">Run self-test</button>
            </div>
            <div id="airgap-results" class="airgap-results" aria-live="polite"></div>
          </div>
        </div>

        <div class="settings-card">
          <label class="checkbox-row">
            <input type="checkbox" id="setting-coauthor">
            <div>
              <div class="setting-label">Git Co-Author Attribution</div>
              <div class="setting-desc">Append <code>Co-authored-by: Andromity &lt;333054755+andromity-bot@users.noreply.github.com&gt;</code> trailer to AI-generated commit messages and to commits the agent creates.</div>
            </div>
          </label>
        </div>
      </div>
    </div>

    <!-- ── TAB: PERSONALISATION ───────────────────────────────────── -->
    <div class="tab-pane" id="pane-personalisation">
      <div class="section-header">
        <div>
          <h2 class="section-title">Personalisation & Visual Atmosphere</h2>
          <p class="section-desc">Customize ambient background atmosphere, real-time fluid ripple dynamics, retro matrix dither, and cursor spotlight aura. <a href="#" class="docs-link" data-docs-url="${DOCS.personalisation}">Personalisation guide</a></p>
        </div>
      </div>

      <div class="settings-list">
        <!-- 0. Mascot Companion ("Andro-Pet") -->
        <div class="settings-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
            <div>
              <div class="setting-label">Mascot Companion ("Andro-Pet")</div>
              <div class="setting-desc">An interactive pixel-art companion that perches on your prompt box, hops between chat turns, and reacts to agent thinking and tool execution.</div>
            </div>
            <span class="badge green" id="mascot-status-badge">Active</span>
          </div>
          <div style="margin-top: 10px;">
            <label class="checkbox-row">
              <input type="checkbox" id="setting-mascot-enabled" checked>
              <div>
                <div class="setting-label" style="font-weight: 500;">Enable Mascot Companion</div>
                <div class="setting-desc">Toggle the animated pixel-art pet on/off in the chat sidebar. Click the pet in chat to interact with it! (Shortcut: type <code>/pet</code> in chat).</div>
              </div>
            </label>
          </div>
        </div>

        <!-- 1. Ambient Wallpaper Atmosphere -->
        <div class="settings-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
            <div>
              <div class="setting-label">Wallpaper Atmosphere</div>
              <div class="setting-desc">Enables an interactive ambient backdrop behind the editor sidebar using the bundled Wildcat Panther Dusk artwork with real-time fluid simulation.</div>
            </div>
            <span class="badge" id="wallpaper-status-badge">Disabled</span>
          </div>
          <div style="margin-top: 10px;">
            <label class="checkbox-row">
              <input type="checkbox" id="setting-wallpaper-enabled">
              <div>
                <div class="setting-label" style="font-weight: 500;">Enable Ambient Wallpaper</div>
                <div class="setting-desc">Toggle wallpaper and particle physics on/off. (Note: May increase battery consumption on portable devices).</div>
              </div>
            </label>
          </div>
        </div>

        <!-- 2. Water Ripple Physics -->
        <div class="settings-card">
          <div class="setting-label">Water Ripple Wave Dynamics</div>
          <div class="setting-desc">Simulates interactive 2D fluid wave equations reacting dynamically to mouse movement across the viewport.</div>
          <select class="setting-select" id="setting-wallpaper-ripple" style="margin-top: 6px;">
            <option value="off">Off — Still water (Zero ripple computation)</option>
            <option value="light">Light — Gentle, subtle ripples</option>
            <option value="medium">Medium — Balanced organic fluid ripples (Default)</option>
            <option value="strong">Strong — Energetic, high-amplitude wake waves</option>
          </select>
        </div>

        <!-- 3. Floating Retro Asterisks -->
        <div class="settings-card">
          <label class="checkbox-row">
            <input type="checkbox" id="setting-wallpaper-asterisks">
            <div>
              <div class="setting-label">Floating Asterisk Particles</div>
              <div class="setting-desc">Subtle retro matrix glyphs drifting through the viewport that deflect away from the cursor.</div>
            </div>
          </label>
        </div>

        <!-- 4. Cursor Spotlight Aura -->
        <div class="settings-card">
          <label class="checkbox-row">
            <input type="checkbox" id="setting-wallpaper-aura">
            <div>
              <div class="setting-label">Cursor Radial Spotlight</div>
              <div class="setting-desc">Soft atmospheric spotlight aura that follows your mouse cursor across the editor window.</div>
            </div>
          </label>
        </div>

        <!-- 5. Accessibility & Motion Safety Notice -->
        <div class="settings-card" style="border-left: 3px solid var(--tag-blue-fg); background: rgba(56, 139, 253, 0.04);">
          <div class="setting-label" style="display: flex; align-items: center; gap: 6px; color: var(--tag-blue-fg);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            Accessibility & Motion Safety
          </div>
          <div class="setting-desc" style="margin-top: 4px;">
            Andromity automatically honors your operating system's <code>prefers-reduced-motion</code> setting. When reduced motion is enabled, ripple physics and floating particles are automatically paused to prevent discomfort.
          </div>
        </div>
      </div>
    </div>

    <!-- ── TAB 8: ABOUT & DIAGNOSTICS ───────────────────────────────── -->
    <div class="tab-pane" id="pane-about">
      <div class="section-header">
        <div>
          <h2 class="section-title">About Andromity</h2>
          <p class="section-desc">Open-source software license, Git repository information, and AI Engine runtime diagnostics.</p>
        </div>
      </div>

      <!-- 1. Hero Software Branding Card -->
      <div class="settings-card" style="max-width: 800px; margin-bottom: 16px; background: linear-gradient(135deg, rgba(9, 249, 148, 0.04) 0%, rgba(6, 182, 212, 0.05) 50%, rgba(168, 85, 247, 0.04) 100%), var(--card-bg); border-color: rgba(9, 249, 148, 0.18);">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 44px; height: 44px; border-radius: 10px; background: rgba(9, 249, 148, 0.1); border: 1px solid rgba(9, 249, 148, 0.25); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0;">
              <img src="${iconUri}" alt="Andromity Logo" style="width: 32px; height: 32px; object-fit: contain;" />
            </div>
            <div>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span style="font-size: 16px; font-weight: 700; color: var(--text); letter-spacing: -0.2px;">Andromity AI Coding Agent</span>
                <span class="badge green" style="font-weight: 600;">v${extVersion}</span>
                <span class="badge blue">Production Build</span>
              </div>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                Autonomous multi-agent pair programmer for VS Code • Built by AgenticMarket
              </div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button class="btn" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity" title="Open GitHub Repository">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
              GitHub Repo
            </button>
          </div>
        </div>

        <div style="font-size: 12px; color: var(--text-muted); line-height: 1.5; padding-top: 6px; border-top: 1px solid var(--card-border);">
          Andromity is a professional autonomous coding agent engineered with background subagents, live plans &amp; diffs, full Model Context Protocol (MCP) integrations, and Bring-Your-Own-Key (BYOK) support for Claude 3.7 Sonnet, GPT-4o, DeepSeek R1, Gemini 2.0 Flash, and local Ollama.
        </div>
      </div>

      <!-- 2. Software License Card -->
      <div class="settings-card" style="max-width: 800px; margin-bottom: 16px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; flex-wrap: wrap; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#09F994" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            <span class="setting-label" style="font-size: 13.5px;">Open Source Software License</span>
          </div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <span class="badge green">MIT License</span>
            <span class="badge blue">OSI Approved</span>
            <span class="badge purple">Free &amp; Commercial Use</span>
          </div>
        </div>

        <table class="diag-table" style="margin-top: 4px; margin-bottom: 10px;">
          <tr>
            <td>License Name</td>
            <td>MIT License (The Massachusetts Institute of Technology)</td>
          </tr>
          <tr>
            <td>SPDX Identifier</td>
            <td><code>MIT</code></td>
          </tr>
          <tr>
            <td>Copyright Notice</td>
            <td>Copyright &copy; 2026 Andromity Contributors &amp; AgenticMarket</td>
          </tr>
          <tr>
            <td>Permissions</td>
            <td><span style="color:var(--tag-green-fg); font-weight:600;">Commercial use</span> &nbsp;&bull;&nbsp; <span style="color:var(--tag-green-fg); font-weight:600;">Modification</span> &nbsp;&bull;&nbsp; <span style="color:var(--tag-green-fg); font-weight:600;">Distribution</span> &nbsp;&bull;&nbsp; <span style="color:var(--tag-green-fg); font-weight:600;">Private use</span></td>
          </tr>
          <tr>
            <td>Conditions &amp; Limits</td>
            <td>License and copyright notice must be included in all copies. No warranty or liability is assumed by authors.</td>
          </tr>
        </table>

        <!-- Collapsible Full License Text -->
        <details style="background: rgba(0, 0, 0, 0.2); border: 1px solid var(--card-border); border-radius: 6px; padding: 8px 12px;">
          <summary style="font-size: 12px; font-weight: 600; color: var(--accent); cursor: pointer; user-select: none; display: flex; align-items: center; justify-content: space-between;">
            <span>View Full MIT License Text</span>
            <span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">Click to expand</span>
          </summary>
          <pre style="margin-top: 10px; margin-bottom: 4px; font-family: var(--font-mono); font-size: 11px; line-height: 1.5; color: var(--text); white-space: pre-wrap; background: rgba(0,0,0,0.15); padding: 10px; border-radius: 4px; border: 1px solid rgba(var(--tint), 0.05); user-select: text;">MIT License

Copyright (c) 2026 Andromity Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.</pre>
          <div style="display: flex; gap: 8px; margin-top: 8px;">
            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" data-action="open-license-file">Open Local LICENSE File</button>
            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity/blob/main/LICENSE">View on GitHub</button>
          </div>
        </details>
      </div>

      <!-- 3. Git Repository & Community Links Card -->
      <div class="settings-card" style="max-width: 800px; margin-bottom: 16px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; flex-wrap: wrap; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#38bdf8" stroke-width="2"><circle cx="12" cy="12" r="4"></circle><line x1="1.05" y1="12" x2="7" y2="12"></line><line x1="17.01" y1="12" x2="22.96" y2="12"></line></svg>
            <span class="setting-label" style="font-size: 13.5px;">Git Repository &amp; Community Resources</span>
          </div>
          <span class="badge blue">Public Open Source</span>
        </div>

        <table class="diag-table" style="margin-top: 4px; margin-bottom: 12px;">
          <tr>
            <td>Git Repository</td>
            <td>
              <a href="#" style="color:var(--accent); text-decoration:none; font-weight:500;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity">
                https://github.com/agenticmarket/andromity
              </a>
            </td>
          </tr>
          <tr>
            <td>Default Branch</td>
            <td><code>main</code></td>
          </tr>
          <tr>
            <td>Issue Tracker</td>
            <td>
              <a href="#" style="color:var(--accent); text-decoration:none;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity/issues">
                github.com/agenticmarket/andromity/issues (Bug reports &amp; feature proposals)
              </a>
            </td>
          </tr>
          <tr>
            <td>Documentation</td>
            <td>
              <a href="#" style="color:var(--accent); text-decoration:none;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity#readme">
                README Architecture, MCP Setup &amp; Custom Skills Guide
              </a>
            </td>
          </tr>
          <tr>
            <td>Release Changelog</td>
            <td>
              <a href="#" style="color:var(--accent); text-decoration:none;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity/blob/main/CHANGELOG.md">
                CHANGELOG.md (Full version history &amp; release notes)
              </a>
            </td>
          </tr>
          <tr>
            <td>Contributing</td>
            <td>
              <a href="#" style="color:var(--accent); text-decoration:none;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity/blob/main/CONTRIBUTING.md">
                CONTRIBUTING.md (Pair-programming guidelines &amp; PR process)
              </a>
            </td>
          </tr>
        </table>

        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          <button class="btn btn-secondary" style="font-size: 11.5px; padding: 5px 12px;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
            Open on GitHub
          </button>
          <button class="btn btn-secondary" style="font-size: 11.5px; padding: 5px 12px;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity/issues/new/choose">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            Submit Bug Report
          </button>
          <button class="btn btn-secondary" style="font-size: 11.5px; padding: 5px 12px;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity/discussions">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            Community Discussions
          </button>
        </div>
      </div>

      <!-- 4. System Diagnostics & AI Engine Runtime Details -->
      <div class="section-header" style="margin-top: 24px;">
        <div>
          <h2 class="section-title" style="font-size: 15px;">AI Engine Diagnostics &amp; Runtime</h2>
          <p class="section-desc">Active daemon status, execution environment, and registered capabilities.</p>
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
            <td id="diag-version"><span class="shimmer-text">Detecting version...</span></td>
          </tr>
          <tr>
            <td>Engine Mode</td>
            <td id="diag-engine-mode"><span class="shimmer-text">Detecting engine mode...</span></td>
          </tr>
          <tr>
            <td>Runtime Version</td>
            <td id="diag-py-ver"><span class="shimmer-text">Detecting runtime...</span></td>
          </tr>
          <tr>
            <td>AI Engine Executable</td>
            <td id="diag-py-exe" style="font-size:11px; word-break:break-all;"><span class="shimmer-text">Detecting executable...</span></td>
          </tr>
          <tr>
            <td>Operating System</td>
            <td id="diag-os"><span class="shimmer-text">Detecting OS...</span></td>
          </tr>
          <tr>
            <td>Daemon PID</td>
            <td id="diag-pid"><span class="shimmer-text">Detecting PID...</span></td>
          </tr>
          <tr>
            <td>Available Core Tools</td>
            <td id="diag-tools-count"><span class="shimmer-text">Detecting active tools...</span></td>
          </tr>
        </table>
      </div>

      <div class="settings-card" style="max-width: 800px;">
        <div class="setting-label">Registered Native Tools</div>
        <div class="tools-tag-list" id="diag-tools-list">
          <span class="shimmer-text">Loading tool capabilities...</span>
        </div>
      </div>
    </div>

  </div>

  <script nonce="${nonce}">
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
    let ollamaStatus = null;
    let ollamaChecked = false;
    let allProviders = [];
    let pinnedModels = [];
    let allSkills = [];
    let allRemoteSkills = [];
    let allMcpServers = [];
    let allConnectors = [];
    const CONNECTOR_ICONS = ${JSON.stringify(CONNECTOR_ICONS)};
    const CONNECTOR_GUIDE_SLUGS = ${JSON.stringify(CONNECTOR_GUIDE_SLUGS)};
    const INTEGRATIONS_URL = ${JSON.stringify(INTEGRATIONS_URL)};
    let mcpView = "";
    let connectorQuery = "";
    let currentConfig = {};
    let trustInfo = {};
    let currentWorkspacePath = "";
    let activeModelId = "";
    let activeModelProvider = "";
    let activeCategory = "all";
    let activeProvider = "all";
    let activeSkillsTab = "installed";
    const SKILLS_PAGE_SIZE = 60;
    let skillsQuery = "";
    let skillsCategory = "all";
    let skillsSource = "all";
    let skillsInstallScope = "user";
    let skillsLimit = SKILLS_PAGE_SIZE;
    let skillDetail = null;
    const skillDocs = {};
    let searchQuery = "";
    let usageData = {};
    let currentUsageRange = "all";
    let currentUsageScope = "global";
    let currentAccount = { isAuthenticated: false, username: "", email: "", plan: "free" };
    const keyTests = Object.create(null);
    const modelRefresh = Object.create(null);
    let keyTestRunning = "";
    let keyTestTimer = 0;
    let waitlistJoined = false;
    let waitlistOffered = false;
    let waitlistOfferNoted = false;

    function noteWaitlistOffer() {
      if (waitlistOfferNoted || waitlistJoined) return;
      const pane = document.getElementById("pane-keys");
      if (!pane || !pane.classList.contains("active") || !pane.querySelector(".waitlist-offer")) return;
      waitlistOfferNoted = true;
      vscode.postMessage({ type: "waitlist_offer_shown" });
    }

    // Tabs Navigation
    const sideNav = document.getElementById("side-nav");
    const tabButtons = document.querySelectorAll(".nav-tab");
    const panes = document.querySelectorAll(".tab-pane");
    const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
    const toggleLabel = sidebarToggleBtn ? sidebarToggleBtn.querySelector(".nav-tab-label") : null;
    const navTooltip = document.getElementById("nav-floating-tooltip");

    tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        if (tab) {
          switchTab(tab, true);
        }
      });
    });

    function switchTab(tab, fromUser) {
      tabButtons.forEach(b => {
        if (b.dataset.tab) {
          b.classList.toggle("active", b.dataset.tab === tab);
        }
      });
      panes.forEach(p => p.classList.toggle("active", p.id === "pane-" + tab));
      if (tab === "keys") noteWaitlistOffer();
      if (fromUser) {
        try {
          vscode.postMessage({ type: "tab_switched", tab: tab });
        } catch (e) {}
      }
    }

    // Sidebar Manual Collapse & Auto Low-Space Detection
    function setSidebarCollapsed(collapsed) {
      if (!sideNav) return;
      if (collapsed) {
        sideNav.classList.add("collapsed");
        if (toggleLabel) toggleLabel.textContent = "Expand Sidebar";
        if (sidebarToggleBtn) sidebarToggleBtn.setAttribute("data-tooltip", "Expand Sidebar");
      } else {
        sideNav.classList.remove("collapsed");
        if (toggleLabel) toggleLabel.textContent = "Collapse Sidebar";
        if (sidebarToggleBtn) sidebarToggleBtn.setAttribute("data-tooltip", "Collapse Sidebar");
      }
    }

    if (sidebarToggleBtn) {
      sidebarToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextState = !sideNav.classList.contains("collapsed");
        setSidebarCollapsed(nextState);
        try {
          const state = (typeof vscode !== "undefined" && vscode.getState) ? (vscode.getState() || {}) : {};
          state.settingsNavCollapsed = nextState;
          if (typeof vscode !== "undefined" && vscode.setState) vscode.setState(state);
        } catch (e) {}
      });
    }

    // Restore saved collapse state
    try {
      const savedState = (typeof vscode !== "undefined" && vscode.getState) ? vscode.getState() : null;
      if (savedState && savedState.settingsNavCollapsed) {
        setSidebarCollapsed(true);
      }
    } catch (e) {}

    // Auto-detect low space on resize
    function handleNavResize() {
      if (!sideNav) return;
      if (window.innerWidth < 820) {
        sideNav.classList.add("auto-compact");
      } else {
        sideNav.classList.remove("auto-compact");
      }
    }
    window.addEventListener("resize", handleNavResize);
    handleNavResize();

    // Floating Tooltip on hover (especially when low space / collapsed)
    if (navTooltip) {
      const tooltipTargets = document.querySelectorAll("[data-tooltip]");
      tooltipTargets.forEach(el => {
        el.addEventListener("mouseenter", () => {
          const isCompact = sideNav && (
            sideNav.classList.contains("collapsed") ||
            sideNav.classList.contains("auto-compact") ||
            window.innerWidth < 820
          );
          if (!isCompact && !el.classList.contains("sidebar-toggle-btn")) {
            return;
          }
          const text = el.getAttribute("data-tooltip");
          if (!text) return;
          const badgeEl = el.querySelector(".nav-tab-badge");
          const count = badgeEl && badgeEl.textContent && badgeEl.textContent !== "0"
            ? ' <span class="tooltip-badge">' + badgeEl.textContent + '</span>'
            : "";
          navTooltip.innerHTML = text + count;
          const rect = el.getBoundingClientRect();
          navTooltip.style.left = (rect.right + 10) + "px";
          navTooltip.style.top = Math.round(rect.top + (rect.height / 2) - 13) + "px";
          navTooltip.classList.add("visible");
        });

        el.addEventListener("mouseleave", () => {
          navTooltip.classList.remove("visible");
        });

        el.addEventListener("click", () => {
          navTooltip.classList.remove("visible");
        });
      });

      const navContainer = document.getElementById("nav-tabs-container");
      if (navContainer) {
        navContainer.addEventListener("scroll", () => {
          navTooltip.classList.remove("visible");
        });
      }
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
        if (activeProvider === 'ollama') {
          ollamaChecked = false;
          vscode.postMessage({type:'check_ollama_status'});
        }
        renderModels();
      });
    });

    // Skills Sub-tabs
    document.getElementById("filter-mcp-yours")?.addEventListener("click", () => setMcpView("yours"));
    document.getElementById("filter-mcp-discover")?.addEventListener("click", () => setMcpView("discover"));
    document.getElementById("connectors-search")?.addEventListener("input", e => {
      connectorQuery = e.target.value || "";
      renderConnectors();
    });

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

    document.getElementById("skill-detail-overlay").addEventListener("click", (e) => {
      if (e.target.id === "skill-detail-overlay") closeSkillDetail();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && skillDetail) closeSkillDetail();
    });

    document.getElementById("skills-search").addEventListener("input", (e) => {
      skillsQuery = e.target.value.toLowerCase().trim();
      skillsLimit = SKILLS_PAGE_SIZE;
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
    const selectStartupSession = document.getElementById("setting-startup-session");
    const selectWaterfallAutoOpen = document.getElementById("setting-waterfall-auto-open");
    const selectReasoning = document.getElementById("setting-reasoning");
    const inputUserName = document.getElementById("setting-user-name");
    const inputUserEmail = document.getElementById("setting-user-email");
    const selectMaxSubagents = document.getElementById("setting-max-subagents");
    const checkAutoCompact = document.getElementById("setting-auto-compact");
    const checkSound = document.getElementById("setting-sound");
    const checkNextSteps = document.getElementById("setting-next-steps");
    const checkTelemetry = document.getElementById("setting-telemetry");
    const checkAirGap = document.getElementById("setting-airgap");
    const airGapHosts = document.getElementById("airgap-hosts");
    const airGapStateEl = document.getElementById("airgap-state");
    const airGapResults = document.getElementById("airgap-results");

    function renderAirGap(state) {
      if (!state || !checkAirGap) return;
      checkAirGap.checked = !!state.enabled;
      checkAirGap.disabled = !!state.locked;
      const engine = state.engine || {};
      const parts = [];
      if (state.enabled) {
        parts.push(state.source === "organization" ? "On, set by your organization."
          : state.source === "workspace" ? "On, turned on by this project's settings."
          : engine.sources && engine.sources.indexOf("config") !== -1 && state.source === "off" ? "On from config.toml."
          : "On.");
        if (engine.blocked_count) parts.push("Blocked " + engine.blocked_count + " connection attempt" + (engine.blocked_count === 1 ? "" : "s") + " since the engine started.");
      } else if (engine.enabled) {
        parts.push("On from config.toml ([default] airgap = true). Edit that file to turn it off.");
      }
      if (engine.ignored_hosts && engine.ignored_hosts.length) {
        parts.push("Ignored (public): " + engine.ignored_hosts.join(", ") + ".");
      }
      if (airGapStateEl) airGapStateEl.textContent = parts.join(" ");
      if (airGapHosts && document.activeElement !== airGapHosts) airGapHosts.value = (state.allowedHosts || []).join(", ");
    }

    function renderAirGapResults(result) {
      if (!airGapResults) return;
      if (!result) {
        airGapResults.innerHTML = '<div class="airgap-result fail">The self-test could not run. Check that the engine is running, then try again.</div>';
        return;
      }
      if (!result.enabled) {
        airGapResults.innerHTML = '<div class="airgap-result">Turn on air-gap mode first. The self-test only runs while it is on, so it never makes a real connection.</div>';
        return;
      }
      airGapResults.innerHTML = result.checks.map(function(c) {
        return '<div class="airgap-result ' + (c.ok ? "pass" : "fail") + '"><strong>' + (c.ok ? "PASS" : "FAIL") + '</strong> ' +
          escapeHtml(c.check) + ' <span class="setting-desc">' + escapeHtml(c.detail) + '</span></div>';
      }).join("");
    }
    const checkCoAuthor = document.getElementById("setting-coauthor");

    if (selectStartupSession) {
      selectStartupSession.addEventListener("change", () => {
        vscode.postMessage({ type: "update_setting", key: "startupSession", value: selectStartupSession.value });
      });
    }

    if (selectWaterfallAutoOpen) {
      selectWaterfallAutoOpen.addEventListener("change", () => {
        const isEnabled = selectWaterfallAutoOpen.value === "enabled";
        vscode.postMessage({ type: "update_setting", key: "waterfallAutoOpen", value: isEnabled });
      });
    }

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
    checkNextSteps?.addEventListener("change", () => {
      vscode.postMessage({ type: "toggle_next_steps", value: checkNextSteps.checked });
    });
    checkSound.addEventListener("change", () => {
      vscode.postMessage({ type: "toggle_sound", value: checkSound.checked });
    });
    if (checkAirGap) {
      checkAirGap.addEventListener("change", () => {
        vscode.postMessage({ type: "toggle_airgap", value: checkAirGap.checked });
      });
    }
    if (checkTelemetry) {
      checkTelemetry.addEventListener("change", () => {
        vscode.postMessage({ type: "toggle_telemetry", value: checkTelemetry.checked });
      });
    }
    if (checkCoAuthor) {
      checkCoAuthor.addEventListener("change", () => {
        vscode.postMessage({ type: "toggle_coauthor", value: checkCoAuthor.checked });
      });
    }

    const checkMascotEnabled = document.getElementById("setting-mascot-enabled");
    const mascotStatusBadge = document.getElementById("mascot-status-badge");

    function updateMascotStatusBadge(enabled) {
      if (mascotStatusBadge) {
        if (enabled) {
          mascotStatusBadge.className = "badge green";
          mascotStatusBadge.textContent = "Active";
        } else {
          mascotStatusBadge.className = "badge";
          mascotStatusBadge.textContent = "Disabled (Off)";
        }
      }
    }

    try {
      const isMascotOn = localStorage.getItem("andromity_mascot_enabled") !== "false";
      if (checkMascotEnabled) checkMascotEnabled.checked = isMascotOn;
      updateMascotStatusBadge(isMascotOn);
    } catch {}

    if (checkMascotEnabled) {
      checkMascotEnabled.addEventListener("change", () => {
        updateMascotStatusBadge(checkMascotEnabled.checked);
        try {
          localStorage.setItem("andromity_mascot_enabled", checkMascotEnabled.checked ? "true" : "false");
        } catch {}
        vscode.postMessage({ type: "update_mascot_setting", enabled: checkMascotEnabled.checked });
      });
    }

    const checkWpEnabled = document.getElementById("setting-wallpaper-enabled");
    const selectWpRipple = document.getElementById("setting-wallpaper-ripple");
    const checkWpAsterisks = document.getElementById("setting-wallpaper-asterisks");
    const checkWpAura = document.getElementById("setting-wallpaper-aura");
    const wpStatusBadge = document.getElementById("wallpaper-status-badge");

    function updateWpStatusBadge(enabled) {
      if (wpStatusBadge) {
        if (enabled) {
          wpStatusBadge.className = "badge green";
          wpStatusBadge.textContent = "Active";
        } else {
          wpStatusBadge.className = "badge";
          wpStatusBadge.textContent = "Disabled (Off)";
        }
      }
    }

    if (checkWpEnabled) {
      checkWpEnabled.addEventListener("change", () => {
        updateWpStatusBadge(checkWpEnabled.checked);
        vscode.postMessage({ type: "update_wallpaper_setting", key: "enabled", value: checkWpEnabled.checked });
      });
    }
    if (selectWpRipple) {
      selectWpRipple.addEventListener("change", () => {
        vscode.postMessage({ type: "update_wallpaper_setting", key: "rippleIntensity", value: selectWpRipple.value });
      });
    }
    if (checkWpAsterisks) {
      checkWpAsterisks.addEventListener("change", () => {
        vscode.postMessage({ type: "update_wallpaper_setting", key: "floatingAsterisks", value: checkWpAsterisks.checked });
      });
    }
    if (checkWpAura) {
      checkWpAura.addEventListener("change", () => {
        vscode.postMessage({ type: "update_wallpaper_setting", key: "cursorLightAura", value: checkWpAura.checked });
      });
    }

    // Delegated actions
    // Non-button controls (cards, tags) marked role="button" activate on Enter/Space.
    document.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || (e.key !== "Enter" && e.key !== " ")) return;
      const target = e.target;
      if (!target || target.getAttribute?.("role") !== "button" || ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      e.preventDefault();
      target.click();
    });

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.tagName === "A") e.preventDefault();
      const action = btn.dataset.action;
      if (action === "airgap-save-hosts") {
        vscode.postMessage({ type: "save_airgap_hosts", hosts: airGapHosts ? airGapHosts.value : "" });
        return;
      }
      if (action === "airgap-self-test") {
        if (airGapResults) airGapResults.innerHTML = '<div class="airgap-result">Running the self-test…</div>';
        vscode.postMessage({ type: "airgap_self_test" });
        return;
      }
      
      if (action === "select-model") {
        selectModel(btn.dataset.id, btn.dataset.provider);
      } else if (action === "start-ollama" || action === "check-ollama" || action === "pull-ollama") {
        btn.disabled = true;
        vscode.postMessage({type: action === 'start-ollama' ? 'start_ollama_server' : action === 'pull-ollama' ? 'pull_ollama_model' : 'check_ollama_status'});
      } else if (action === "ollama-download" || action === "ollama-docs") {
        vscode.postMessage({type:'open_url',url:action === 'ollama-download' ? 'https://ollama.com/download' : 'https://docs.ollama.com/quickstart'});
      } else if (action === "toggle-pin") {
        togglePin(btn.dataset.id, btn.dataset.provider, btn.dataset.name);
      } else if (action === "save-key") {
        saveKey(btn.dataset.id);
      } else if (action === "test-key") {
        if (keyTestRunning || btn.disabled || !btn.dataset.id) return;
        startKeyTest(btn.dataset.id);
        vscode.postMessage({ type: "test_key", provider: btn.dataset.id });
      } else if (action === "refresh-provider-models") {
        const pid = btn.dataset.provider;
        if (!pid || (modelRefresh[pid] && modelRefresh[pid].running)) return;
        modelRefresh[pid] = { running: true, message: "" };
        renderModels();
        vscode.postMessage({ type: "refresh_provider_models", provider: pid });
        setTimeout(() => {
          if (!modelRefresh[pid] || !modelRefresh[pid].running) return;
          modelRefresh[pid] = { running: false, message: "Couldn't refresh models." };
          renderModels();
        }, 20000);
      } else if (action === "add-provider" || action === "edit-provider") {
        editProvider(action === "edit-provider" ? btn.dataset.id : "");
      } else if (action === "cancel-provider") {
        document.getElementById("connection-editor").style.display = "none";
        document.getElementById("connection-key").value = "";
      } else if (action === "save-provider") {
        const value = (id) => document.getElementById(id).value.trim();
        const connection = { id: value("connection-id"), display_name: value("connection-name"),
          base_url: value("connection-url"), model: value("connection-model"),
          type: value("connection-type") || "openai", api_version: value("connection-version") };
        if (value("connection-key")) connection.api_key = value("connection-key");
        vscode.postMessage({ type: "save_provider", connection });
      } else if (action === "test-provider") {
        document.getElementById("provider-status").textContent = "Testing connection…";
        vscode.postMessage({ type: "test_provider", provider: btn.dataset.id });
      } else if (action === "delete-provider") {
        vscode.postMessage({ type: "delete_provider", provider: btn.dataset.id });
      } else if (action === "use-provider") {
        const provider = allProviders.find(p => p.id === btn.dataset.id);
        if (provider && provider.model) selectModel(provider.model, provider.id);
      } else if (action === "open-portal" || action === "open-url") {
        openExternalUrl(btn.dataset.url);
      } else if (action === "open-license-file") {
        vscode.postMessage({ type: "open_license_file" });
      } else if (action === "revoke-trust") {
        revokeTrustPath(btn.dataset.path);
      } else if (action === "forget-approval") {
        btn.disabled = true;
        vscode.postMessage({ type: "forget_approval", kind: btn.dataset.kind, value: btn.dataset.value });
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
        vscode.postMessage({ type: "restartDaemon" });
      } else if (action === "run-setup-check") {
        vscode.postMessage({ type: "check_setup" });
      } else if (action === "configure-python-path") {
        vscode.postMessage({ type: "configure_python_path" });
      } else if (action === "install-python-web") {
        vscode.postMessage({ type: "install_python" });
      } else if (action === "install-skill") {
        const name = btn.dataset.skillName;
        const sourceId = btn.dataset.sourceId;
        const ref = btn.dataset.skillRef || "";
        const scope = btn.dataset.skillScope || skillsInstallScope;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinning-loader"></span> Installing...';
        vscode.postMessage({ type: "install_skill", name, sourceId, ref, scope });
      } else if (action === "skills-category") {
        skillsCategory = btn.dataset.value || "all";
        skillsLimit = SKILLS_PAGE_SIZE;
        renderSkills();
      } else if (action === "skills-source") {
        skillsSource = btn.dataset.value || "all";
        skillsLimit = SKILLS_PAGE_SIZE;
        renderSkills();
      } else if (action === "skills-scope") {
        skillsInstallScope = btn.dataset.value === "project" ? "project" : "user";
        document.querySelectorAll("#skills-scope-chips .chip").forEach(c => c.classList.toggle("active", c.dataset.value === skillsInstallScope));
        renderSkillDetail();
      } else if (action === "skill-open") {
        openSkillDetail(btn.dataset.skillName, btn.dataset.sourceId, btn.dataset.skillPath);
      } else if (action === "skill-close") {
        closeSkillDetail();
      } else if (action === "skills-tag") {
        skillDetail = null;
        skillsQuery = (btn.dataset.value || "").toLowerCase();
        skillsCategory = "all";
        skillsLimit = SKILLS_PAGE_SIZE;
        document.getElementById("skills-search").value = skillsQuery;
        renderSkills();
      } else if (action === "skills-show-more") {
        skillsLimit += SKILLS_PAGE_SIZE;
        renderSkills();
      } else if (action === "open-session") {
        const sId = btn.dataset.sessionId;
        const sName = btn.dataset.sessionName || "Cron Session";
        if (!sId) {
          vscode.postMessage({ type: "show_info", text: "This cron job has not run yet. Click 'Run Now' to execute it and create a session." });
        } else {
          vscode.postMessage({ type: "open_cron_session", sessionId: sId, sessionName: sName, target: "sidebar" });
        }
      } else if (action === "open-session-tab") {
        const sId = btn.dataset.sessionId;
        const sName = btn.dataset.sessionName || "Cron Session";
        if (!sId) {
          vscode.postMessage({ type: "show_info", text: "This cron job has not run yet. Click 'Run Now' to execute it and create a session." });
        } else {
          vscode.postMessage({ type: "open_cron_session", sessionId: sId, sessionName: sName, target: "tab" });
        }
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
      } else if (action === "open_connector_guide") {
        e.preventDefault();
        vscode.postMessage({ type: "open_url", url: INTEGRATIONS_URL + "/" + encodeURIComponent(btn.dataset.slug || "") });
      } else if (action === "mcp_show_discover") {
        setMcpView("discover");
      } else if (action === "connector_connect") {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinning-loader"></span> Connecting...';
        vscode.postMessage({ type: "connector_connect", id: btn.dataset.id });
      } else if (action === "mcp_add" || action === "mcp_remove") {
        vscode.postMessage({ type: action, name: btn.dataset.name });
      } else if (action === "remove-skill") {
        vscode.postMessage({ type: "remove_skill", name: btn.dataset.skillName, path: btn.dataset.skillPath });
      } else if (action === "login-account") {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinning-loader"></span> Connecting...';
        vscode.postMessage({ type: "login_account" });
        setTimeout(() => {
          if (btn && (!currentAccount || !currentAccount.isAuthenticated)) {
            btn.disabled = false;
            btn.innerHTML = 'Sign In with AgenticMarket';
          }
        }, 15000);
      } else if (action === "logout-account") {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinning-loader"></span> Signing out...';
        vscode.postMessage({ type: "logout_account" });
      } else if (action === "join-waitlist") {
        if (!waitlistJoined) vscode.postMessage({ type: "open_waitlist" });
      }
    });

    window.addEventListener("focus", () => {
      vscode.postMessage({ type: "refresh_auth" });
    });

    const usageScopeChips = document.getElementById("usage-scope-chips");
    if (usageScopeChips) {
      usageScopeChips.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-usage-scope]");
        if (!chip) return;
        usageScopeChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        currentUsageScope = chip.dataset.usageScope || "global";
        requestUsage();
      });
    }

    const usageRangeChips = document.getElementById("usage-range-chips");
    if (usageRangeChips) {
      usageRangeChips.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-usage-range]");
        if (!chip) return;
        usageRangeChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        currentUsageRange = chip.dataset.usageRange || "all";
        requestUsage();
      });
    }

    function applySystemAndConfig(msg) {
      if (msg.config) currentConfig = msg.config;
      if (msg.providers) allProviders = msg.providers;
      if (msg.trustData) trustInfo = msg.trustData;
      if (msg.currentWorkspace || trustInfo.project_path) currentWorkspacePath = msg.currentWorkspace || trustInfo.project_path || "";
      if (currentConfig.default_model) activeModelId = currentConfig.default_model;
      if (currentConfig.default_provider) activeModelProvider = (currentConfig.default_provider || "").toLowerCase();
      if (msg.account) currentAccount = msg.account;
      if (typeof msg.waitlistJoined === "boolean") waitlistJoined = msg.waitlistJoined;
      if (typeof msg.waitlistOffered === "boolean") waitlistOffered = msg.waitlistOffered;

      const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };

      if (currentConfig.default_profile && selectProfile) selectProfile.value = currentConfig.default_profile;
      if (currentConfig.permission_mode && selectMode) selectMode.value = currentConfig.permission_mode.toLowerCase();
      if (msg.startupSession && selectStartupSession) selectStartupSession.value = msg.startupSession;
      if (typeof msg.waterfallAutoOpen !== "undefined" && selectWaterfallAutoOpen) {
        selectWaterfallAutoOpen.value = msg.waterfallAutoOpen !== false ? "enabled" : "disabled";
      }
      if (selectReasoning) {
        selectReasoning.innerHTML = '';
        const efforts = ['auto', ...(currentConfig.available_reasoning_efforts || []).filter(value => value !== 'auto')];
        const ascending = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'on'];
        const rank = value => ascending.includes(value) ? ascending.indexOf(value) : ascending.length;
        efforts.sort((a, b) => rank(a) - rank(b));
        efforts.forEach(value => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value === 'auto' ? 'Auto — Provider default' : value.charAt(0).toUpperCase() + value.slice(1);
          selectReasoning.appendChild(option);
        });
        const selected = currentConfig.reasoning_effort;
        if (selected && selected.startsWith('budget:')) {
          const option = document.createElement('option');
          option.value = selected;
          option.textContent = selected.slice(7) + ' thinking tokens';
          selectReasoning.appendChild(option);
        }
        selectReasoning.value = efforts.includes(selected) || (selected && selected.startsWith('budget:')) ? selected : 'auto';
      }
      if (currentConfig.user_name && inputUserName) inputUserName.value = currentConfig.user_name;
      if (currentConfig.user_email && inputUserEmail) inputUserEmail.value = currentConfig.user_email;
      if (currentConfig.max_subagents && selectMaxSubagents) selectMaxSubagents.value = String(currentConfig.max_subagents);
      if (checkAutoCompact) checkAutoCompact.checked = currentConfig.auto_compact !== false;
      if (checkSound) checkSound.checked = msg.soundNotifications !== false;
      if (checkNextSteps) checkNextSteps.checked = msg.nextStepSuggestions !== false;
      if (checkTelemetry) checkTelemetry.checked = msg.telemetry !== false;
      renderAirGap(msg.airGap);
      if (checkCoAuthor) checkCoAuthor.checked = msg.includeCoAuthor !== false;

      const wp = msg.wallpaper || {};
      if (checkWpEnabled) {
        checkWpEnabled.checked = !!wp.enabled;
        updateWpStatusBadge(checkWpEnabled.checked);
      }
      if (selectWpRipple && wp.rippleIntensity) selectWpRipple.value = wp.rippleIntensity;
      if (checkWpAsterisks) checkWpAsterisks.checked = wp.floatingAsterisks !== false;
      if (checkWpAura) checkWpAura.checked = wp.cursorLightAura !== false;

      if (typeof msg.mascotEnabled === 'boolean' && checkMascotEnabled) {
        checkMascotEnabled.checked = msg.mascotEnabled;
        updateMascotStatusBadge(msg.mascotEnabled);
      }

      const sys = msg.systemInfo || {};
      if (sys.version) setEl("diag-version", "v" + sys.version);

      if (sys.engine_mode) {
        const modeEl = document.getElementById("diag-engine-mode");
        if (modeEl) {
          const isBundled = sys.is_bundled;
          modeEl.innerHTML = isBundled
            ? '<span style="color:#09f994;font-weight:600;">' + escapeHtml(sys.engine_mode) + ' (Zero-Python)</span>'
            : '<span style="color:#38bdf8;font-weight:600;">' + escapeHtml(sys.engine_mode) + '</span>';
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
    }

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "ollama_status_updated": {
          ollamaStatus = msg.status;
          ollamaChecked = true;
          if (ollamaStatus?.running) {
            const installed = ollamaStatus.models || [];
            const existing = allModels.filter(m => m.provider === 'ollama' && installed.includes(m.id));
            allModels = allModels.filter(m => m.provider !== 'ollama').concat(installed.map(id => existing.find(m => m.id === id) || {id,name:id,provider:'ollama',desc:'Installed in Ollama',tags:['local'],is_free:true}));
          }
          renderModels();
          renderProviders();
          break;
        }
        case "switch_tab": {
          switchTab(msg.tab);
          break;
        }
        case "waitlist_state": {
          waitlistJoined = msg.joined === true;
          waitlistOffered = msg.offered === true;
          renderProviders();
          break;
        }
        case "daemon_status": {
          if (!msg.connected) {
            const modeEl = document.getElementById("diag-engine-mode");
            if (modeEl) {
              modeEl.innerHTML = '<span style="color:#d29922;font-weight:600;">Connecting to Andromity Engine...</span>';
            }
          }
          break;
        }
        case "fast_state_loaded": {
          applySystemAndConfig(msg);
          renderProviders();
          renderTrust();
          break;
        }
        case "state_loaded": {
          vscode.postMessage({type:'check_ollama_status'});
          allModels = msg.models || [];
          allProviders = msg.providers || [];
          pinnedModels = msg.pinnedModels || (msg.config && msg.config.pinned_models) || [];
          allSkills = msg.skills || [];
          allRemoteSkills = msg.remoteSkills || [];
          allMcpServers = msg.mcpServers || [];
          allConnectors = msg.connectors || [];
          if (usageRequestId === 0 && !usagePending && currentUsageRange === "all" && currentUsageScope === "global") usageData = msg.usage || {};
          allCrons = msg.crons || [];

          applySystemAndConfig(msg);

          const setEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
          };

          setEl("model-count-badge", allModels.length);
          setEl("skills-count-badge", allSkills.length);
          setEl("installed-skills-num", allSkills.length);
          setEl("remote-skills-num", allRemoteSkills.length);

          const cronModelSel = document.getElementById("cron-model-select");
          if (cronModelSel && allModels && allModels.length > 0) {
            cronModelSel.innerHTML = '<option value="">Default Active Model (' + escapeHtml(activeModelId) + ')</option>' +
              allModels.map(m => '<option value="' + escapeHtml(m.id) + '" data-provider="' + escapeHtml(m.provider || '') + '">' + escapeHtml(m.name || m.id) + ' (' + escapeHtml(m.provider || '') + ')</option>').join('');
          }

          renderModels();
          renderProviders();
          renderSkills();
          renderMcp();
          renderConnectors();
          renderMcpCounts();
          renderCrons();
          renderTrust();
          renderUsage();
          break;
        }
        case "update_pinned_models": {
          pinnedModels = msg.pinnedModels || [];
          renderModels();
          break;
        }
        case "usage_loaded": {
          if (msg.requestId !== usageRequestId || msg.timeRange !== currentUsageRange || msg.scope !== currentUsageScope) break;
          usagePending = false;
          if (msg.usage && msg.usage.error) {
            document.getElementById('usage-status').textContent = 'Could not load usage. Select a range to retry.';
            break;
          }
          usageData = msg.usage || {};
          usageSessionPage = Math.floor((usageData.sessions_offset || 0) / usagePageSize);
          renderUsage();
          break;
        }
        case "usage_load_failed": {
          if (msg.requestId !== usageRequestId) break;
          usagePending = false;
          document.getElementById('usage-status').textContent = 'Could not load usage. Select a range to retry.';
          break;
        }
        case "usage_export_result": {
          document.getElementById('usage-share-save').disabled = false;
          if (msg.success) document.getElementById('usage-share-dialog').close();
          document.getElementById('usage-share-status').textContent = msg.success ? 'PNG saved. Ready to post!' : msg.cancelled ? 'Save cancelled.' : 'Could not save the PNG. Try another folder.';
          break;
        }
        case "usage_caption_copied": {
          document.getElementById('usage-share-status').textContent = msg.success ? 'Caption copied. Paste it into your post.' : 'Could not copy the caption. Try again.';
          break;
        }
        case "models_refreshed": {
          iconRefresh.classList.remove("spinning");
          refreshLabel.textContent = "Refresh Catalog";
          const incoming = msg.models || [];
          allModels = msg.provider ? allModels.filter(m => m.provider !== msg.provider).concat(incoming) : incoming;
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
        case "airgap_state":
          renderAirGap(msg.airGap);
          break;
        case "airgap_self_test_result":
          renderAirGapResults(msg.result);
          break;
        case "setting_updated": {
          if (msg.key === "mode") {
            selectMode.value = msg.value.toLowerCase();
          } else if (msg.key === "startupSession" && selectStartupSession) {
            selectStartupSession.value = msg.value;
          }
          break;
        }
        case "provider_result": {
          document.getElementById("provider-status").textContent = msg.message || "";
          if (msg.success && msg.saved) {
            document.getElementById("connection-editor").style.display = "none";
            document.getElementById("connection-key").value = "";
          }
          break;
        }
        case "providers_updated": {
          allProviders = msg.providers || [];
          if (msg.savedProvider) {
            delete keyTests[msg.savedProvider];
            delete modelRefresh[msg.savedProvider];
          }
          renderProviders();
          break;
        }
        case "key_test_started": {
          startKeyTest(msg.provider || "");
          break;
        }
        case "key_test_result": {
          finishKeyTest(msg);
          break;
        }
        case "provider_models_refreshed": {
          const pid = msg.provider || "";
          modelRefresh[pid] = { running: false, message: msg.ok ? "" : (msg.message || "Couldn't refresh models.") };
          if (Array.isArray(msg.models)) {
            allModels = allModels.filter(m => m.provider !== pid).concat(msg.models);
            const countBadge = document.getElementById("model-count-badge");
            if (countBadge) countBadge.textContent = allModels.length;
          }
          renderModels();
          break;
        }
        case "mcp_refreshed": {
          allMcpServers = msg.mcpServers || [];
          renderMcp();
          renderMcpCounts();
          break;
        }
        case "mcp_refresh_failed": {
          renderMcp();
          break;
        }
        case "connectors_refreshed": {
          allConnectors = msg.connectors || [];
          renderConnectors();
          renderMcp();
          renderMcpCounts();
          break;
        }
        case "skill_detail_loaded": {
          skillDocs[msg.key] = msg.error ? { error: msg.error } : { content: msg.content || "" };
          renderSkillDetail();
          break;
        }
        case "skill_install_finished": {
          renderSkills();
          break;
        }
        case "remote_skills_loaded": {
          allRemoteSkills = msg.remoteSkills || [];
          const remoteNumEl = document.getElementById("remote-skills-num");
          if (remoteNumEl) remoteNumEl.textContent = allRemoteSkills.length;
          renderSkills();
          break;
        }
        case "crons_refreshed": {
          allCrons = msg.crons || [];
          allCrons.forEach(j => { if (j.running === false) cronRunning.delete(String(j.id)); });
          renderCrons();
          const btn = document.getElementById("btn-refresh-crons");
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg><span>Refresh</span>';
          }
          break;
        }
        case "cron_preview_result": {
          renderCronPreview(msg);
          break;
        }
        case "cron_saved": {
          closeCronForm();
          break;
        }
        case "cron_save_failed": {
          cronSaving = false;
          syncCronSaveButtons();
          setCronFormError(msg.error || "The job could not be saved.");
          break;
        }
        case "cron_runs_loaded": {
          cronRunsCache[msg.jobId] = msg.runs || [];
          renderCronRuns(msg.jobId);
          break;
        }
        case "cron_run_event": {
          const jobId = String(msg.job_id || "");
          if (!jobId) break;
          if (msg.phase === "started") cronRunning.add(jobId);
          else cronRunning.delete(jobId);
          if (msg.job) {
            const index = allCrons.findIndex(j => String(j.id) === jobId);
            if (index >= 0) allCrons[index] = Object.assign({}, allCrons[index], msg.job);
          }
          if (msg.run && cronRunsCache[jobId]) {
            const runs = cronRunsCache[jobId].filter(r => r.id !== msg.run.id);
            runs.unshift(msg.run);
            cronRunsCache[jobId] = runs;
          }
          renderCrons();
          if (msg.phase === "completed") vscode.postMessage({ type: "refresh_crons" });
          break;
        }
        case "mcp_refreshed": {
          allMcpServers = msg.mcpServers || [];
          renderMcp();
          renderMcpCounts();
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
      if ((provider || '').toLowerCase() === 'ollama' && (!ollamaStatus?.running || !(ollamaStatus.models || []).includes(modelId))) {
        activeProvider = 'ollama';
        renderModels();
        vscode.postMessage({type:'check_ollama_status'});
        return;
      }
      activeModelId = modelId;
      activeModelProvider = (provider || "").toLowerCase();
      renderModels();
      updateActiveBanner();
      vscode.postMessage({ type: "select_model", modelId, provider });
    };

    window.togglePin = function(modelId, provider, name) {
      if (!modelId) return;
      const idx = pinnedModels.findIndex(p => p.id === modelId && (!provider || !p.provider || p.provider === provider));
      if (idx >= 0) {
        pinnedModels.splice(idx, 1);
      } else {
        pinnedModels.push({ id: modelId, provider: provider || "openrouter", name: name || modelId });
      }
      vscode.postMessage({ type: "toggle_pin", modelId, provider, name });
      renderModels();
    };

    window.saveKey = function(providerId) {
      const input = document.getElementById("key-input-" + providerId);
      if (!input) return;
      const key = input.value.trim();
      if (!key) {
        input.value = "";
        input.focus();
        return;
      }
      vscode.postMessage({ type: "set_api_key", provider: providerId, apiKey: key });
      input.value = "";
    };

    window.openExternalUrl = function(url) {
      vscode.postMessage({ type: "open_url", url });
    };

    window.revokeTrustPath = function(path) {
      vscode.postMessage({ type: "revoke_trust", path });
    };

    function renderRememberedApprovals() {
      const list = document.getElementById("remembered-approvals-list");
      if (!list) return;
      const defaults = (currentConfig && currentConfig.config && currentConfig.config.default) || {};
      const group = (title, kind, values) => {
        const items = Array.isArray(values) ? values.map(String).filter(Boolean) : [];
        return '<div style="font-size: 11px; font-weight: 600; color: var(--text-muted); margin-top: 4px;">' + title + ' (' + items.length + ')</div>' +
          (items.length ? items.map(value =>
            '<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 10px; background: rgba(var(--tint), 0.03); border: 1px solid var(--card-border); border-radius: 4px;">' +
              '<code style="font-size: 12px; word-break: break-all;">' + escapeHtml(value) + '</code>' +
              '<button class="btn btn-danger" style="padding: 3px 8px; font-size: 11px; flex-shrink: 0;" data-action="forget-approval" data-kind="' + kind + '" data-value="' + escapeHtml(value) + '" aria-label="Stop always allowing ' + escapeHtml(value) + '">Remove</button>' +
            '</div>').join('') : '<div style="color: var(--text-muted); font-size: 12px;">None</div>');
      };
      list.innerHTML = group("Commands", "command", defaults.allowed_commands) + group("Web domains", "domain", defaults.allowed_domains);
    }

    function renderTrust() {
      renderRememberedApprovals();
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
        if (desc) desc.textContent = "Folder: " + (currentWorkspacePath || "Current Project") + " (Restricted: Andromity can't read or edit files or run commands here until you trust it)";
      }

      const list = document.getElementById("trusted-folders-list");
      if (!list) return;
      const projects = trustInfo.trusted_projects || [];
      if (projects.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">No trusted folders recorded yet.</div>';
        return;
      }

      list.innerHTML = projects.map(p => 
        '<div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(var(--tint), 0.03); border: 1px solid var(--card-border); border-radius: 4px;">' +
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
      if (activeModelProvider.toLowerCase() === 'ollama' && (!ollamaStatus?.running || !(ollamaStatus.models || []).includes(activeModelId))) {
        banner.style.display = "none";
        return;
      }
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

    function providerName(pid) {
      const found = allProviders.find(p => p.id === pid);
      return (found && found.name) || pid;
    }

    function showsCatalogLabel(pid) {
      const found = allProviders.find(p => p.id === pid);
      return pid !== "andromity" && pid !== "ollama" && !(found && found.custom);
    }

    function renderSourceBar(visibleModels) {
      const bar = document.getElementById("models-source-bar");
      if (!bar) return;
      const ids = [];
      visibleModels.forEach(m => {
        if (m.source === "catalog" && m.provider && !ids.includes(m.provider) && showsCatalogLabel(m.provider)) ids.push(m.provider);
      });
      bar.hidden = ids.length === 0;
      bar.innerHTML = ids.map(pid => {
        const state = modelRefresh[pid] || {};
        return '<span class="source-item">' +
          '<span class="badge" title="Listed from the built-in catalog, not fetched from the provider">Catalog</span>' +
          '<span class="source-name">' + escapeHtml(providerName(pid)) + ' models are from the built-in catalog, not your live list.</span>' +
          '<button type="button" class="source-refresh" data-action="refresh-provider-models" data-provider="' + escapeHtml(pid) + '"' + (state.running ? ' disabled' : '') + '>' + (state.running ? 'Refreshing…' : 'Refresh') + '</button>' +
          (state.message ? '<span class="source-reason">' + escapeHtml(state.message) + '</span>' : '') +
        '</span>';
      }).join("");
    }

    function renderModels() {
      const grid = document.getElementById("models-grid");
      if (!grid) return;
      updateActiveBanner();
      renderSourceBar([]);
      if (activeProvider === 'ollama' && (!ollamaStatus?.running || !(ollamaStatus.models || []).length)) {
        const title = !ollamaChecked ? 'Checking Ollama…' : !ollamaStatus ? 'Could not check Ollama' : ollamaStatus.running ? 'No models installed' : 'Ollama is not running';
        const detail = !ollamaChecked ? 'Checking the configured Ollama server before showing installed models.' : ollamaStatus?.running ? 'Download a model first, then check again. Catalog models are not installed automatically.' : 'Start Ollama to see models installed on your server. Models from the catalog are not ready to use.';
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;text-align:left;align-items:flex-start;">' +
          '<h3>' + title + '</h3><p>' + detail + '</p><div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          (ollamaStatus?.installed && !ollamaStatus.running ? '<button class="btn" data-action="start-ollama">Start Ollama</button>' : '') +
          (ollamaStatus?.running ? '<button class="btn" data-action="pull-ollama">Download qwen2.5-coder:7b</button>' : '<button class="btn" data-action="ollama-download">Install Ollama</button>') +
          '<button class="btn" data-action="check-ollama">Check again</button><button class="btn" data-action="ollama-docs">Setup documentation</button></div></div>';
        return;
      }
      const filtered = allModels.filter(m => {
        if (m.provider === 'ollama' && (!ollamaStatus?.running || !(ollamaStatus.models || []).includes(m.id))) return false;
        if (activeProvider !== "all" && m.provider !== activeProvider) {
          return false;
        }

        if (activeCategory !== "all") {
          if (activeCategory === "pinned") {
            const isPinned = pinnedModels.some(p => p.id === m.id && (!p.provider || p.provider === m.provider));
            if (!isPinned) return false;
          } else {
            const tags = m.tags || [];
            if (activeCategory === "free" && !m.is_free && !tags.includes("free")) return false;
            if (activeCategory === "coding" && !tags.includes("coding")) return false;
            if (activeCategory === "reasoning" && !tags.includes("reasoning")) return false;
            if (activeCategory === "vision" && !tags.includes("vision")) return false;
            if (activeCategory === "flagship" && !tags.includes("flagship")) return false;
          }
        }

        if (searchQuery) {
          const hay = ((m.name || "") + " " + (m.id || "") + " " + (m.provider || "") + " " + (m.desc || "")).toLowerCase();
          if (!hay.includes(searchQuery)) return false;
        }

        return true;
      });
      renderSourceBar(filtered);

      if (filtered.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<circle cx="11" cy="11" r="8"></circle>' +
            '<line x1="21" y1="21" x2="16.65" y2="16.65"></line>' +
          '</svg>' +
          '<div>' + (activeCategory === "pinned" ? 'No pinned models yet. Click the pin icon on any model card to pin it!' : 'No matching models found. Try clearing filters or refreshing catalog.') + '</div>' +
        '</div>';
        return;
      }

      grid.innerHTML = filtered.map(m => {
        const isActive = m.id === activeModelId && (m.provider||"").toLowerCase() === activeModelProvider.toLowerCase();
        const isPinned = pinnedModels.some(p => p.id === m.id && (!p.provider || p.provider === m.provider));
        const ctxStr = m.context || formatCtx(m.context_limit);
        const pricingStr = m.is_free ? "Free Tier" : (m.pricing || "");

        return '<div class="model-card ' + (isActive ? 'active-model' : '') + '">' +
          '<div class="model-card-top">' +
            '<div class="model-header-row">' +
              '<div>' +
                '<div class="model-name">' + escapeHtml(m.name || m.id) + '</div>' +
                '<div class="model-id">' + escapeHtml(m.id) + '</div>' +
              '</div>' +
              '<div style="display:flex; align-items:center; gap:6px;">' +
                '<button class="pin-card-btn ' + (isPinned ? 'pinned' : '') + '" data-action="toggle-pin" data-id="' + escapeHtml(m.id) + '" data-provider="' + escapeHtml(m.provider) + '" data-name="' + escapeHtml(m.name || m.id) + '" title="' + (isPinned ? 'Unpin model' : 'Pin model to quick list') + '">' +
                  '<svg width="13" height="13" viewBox="0 0 24 24" fill="' + (isPinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76l-1.8-1.79A2 2 0 0 1 16.6 12V5a2 2 0 0 0-2-2h-5.2a2 2 0 0 0-2 2v7a2 2 0 0 1-.6 1.45L5 15.24z"></path></svg>' +
                '</button>' +
                '<span class="badge blue">' + escapeHtml(m.provider) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="model-desc">' + escapeHtml(m.desc || "High-performance AI model.") + '</div>' +
            '<div class="model-badges">' +
              (m.needs_key ? '<span class="badge orange" title="Set your ' + escapeHtml(providerName(m.provider)) + ' API key to use this model">Needs API key</span>' : '') +
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

    function editProvider(id) {
      const provider = allProviders.find(p => p.id === id) || {};
      const fields = { "connection-id": provider.id || "", "connection-name": provider.name || "",
        "connection-url": provider.base_url || "", "connection-model": provider.model || "",
        "connection-type": provider.type || "openai", "connection-version": provider.api_version || "", "connection-key": "" };
      Object.keys(fields).forEach(key => document.getElementById(key).value = fields[key]);
      document.getElementById("connection-id").disabled = Boolean(id);
      document.getElementById("connection-editor").style.display = "block";
      document.getElementById(id ? "connection-url" : "connection-id").focus();
      document.getElementById("provider-status").textContent = "";
    }

    function renderProviders() {
      const grid = document.getElementById("keys-grid");
      if (!grid) return;
      const providerMeta = {
        andromity: { name: "Andromity Cloud Gateway", desc: "Managed cloud intelligence for autonomous coding. Zero setup required.", portal: "https://agenticmarket.dev" },
        openrouter: { name: "OpenRouter", desc: "One key for models from Anthropic, OpenAI, Google, Meta, DeepSeek and more, with unified billing.", portal: "https://openrouter.ai/keys" },
        anthropic: { name: "Anthropic", desc: "Direct access to Claude Opus 4.6, Claude Sonnet 4.6/3.7, and Claude Haiku.", portal: "https://console.anthropic.com/settings/keys" },
        openai: { name: "OpenAI", desc: "Direct access to GPT-4o, GPT-4.1, o1, o3, and o4-mini models.", portal: "https://platform.openai.com/api-keys" },
        google: { name: "Google Gemini", desc: "Direct access to Gemini 2.5 Pro, 2.5 Flash, and Gemini 2.0 Flash.", portal: "https://aistudio.google.com/app/apikey" },
        deepseek: { name: "DeepSeek", desc: "DeepSeek V3 and DeepSeek R1 reasoning models.", portal: "https://platform.deepseek.com/api_keys" },
        groq: { name: "Groq Cloud", desc: "Ultra-low-latency inference for Llama 3.3 70B and Mixtral.", portal: "https://console.groq.com/keys" },
        nvidia: { name: "NVIDIA NIM", desc: "NVIDIA GPU cloud hardware accelerated open models.", portal: "https://build.nvidia.com/" },
        ollama: { name: "Ollama (Local Offline)", desc: "Local offline models running on your machine with zero data leaves your device.", portal: "https://ollama.com" }
      };

      const defaultProviders = [
        { id: 'andromity', name: 'Andromity Cloud Gateway', has_key: true },
        { id: 'openrouter', name: 'OpenRouter', has_key: false },
        { id: 'anthropic', name: 'Anthropic', has_key: false },
        { id: 'openai', name: 'OpenAI', has_key: false },
        { id: 'google', name: 'Google Gemini', has_key: false },
        { id: 'deepseek', name: 'DeepSeek', has_key: false },
        { id: 'groq', name: 'Groq Cloud', has_key: false },
        { id: 'nvidia', name: 'NVIDIA NIM', has_key: false },
        { id: 'ollama', name: 'Ollama (Local Offline)', has_key: true }
      ];

      const displayList = (allProviders && allProviders.length > 0) ? [...allProviders] : defaultProviders;
      const customChips = document.getElementById("custom-provider-chips");
      if (customChips) {
        customChips.innerHTML = displayList.filter(p => p.custom).map(p => '<button class="chip" data-provider="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</button>').join('');
        customChips.querySelectorAll('[data-provider]').forEach(chip => chip.addEventListener('click', () => {
          document.querySelectorAll('.chip[data-provider]').forEach(c => c.classList.remove('active'));
          chip.classList.add('active'); activeProvider = chip.dataset.provider; renderModels();
        }));
      }
      if (!displayList.some(p => p.id === 'andromity')) {
        displayList.unshift({ id: 'andromity', name: 'Andromity Cloud Gateway', has_key: true });
      }

      grid.innerHTML = displayList.map(p => {
        const meta = providerMeta[p.id] || { name: p.name || p.id, desc: "AI Provider API", portal: p.portal || "" };
        const hasKey = p.has_key || p.id === "ollama" || p.id === "andromity";
        if (p.custom) {
          const id = escapeHtml(p.id);
          return '<div class="item-card"><div class="item-card-top"><div class="item-card-title">' + escapeHtml(p.name) + '</div><span class="badge">Custom</span></div>' +
            '<div class="item-card-desc">' + escapeHtml(p.base_url || p.type) + '<br>' + escapeHtml(p.model || '') + '</div>' +
            '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
            '<button class="btn" data-action="use-provider" data-id="' + id + '">Use model</button>' +
            '<button class="btn btn-secondary" data-action="edit-provider" data-id="' + id + '">Edit</button>' +
            '<button class="btn btn-secondary" data-action="test-provider" data-id="' + id + '">Test</button>' +
            '<button class="btn btn-secondary" data-action="delete-provider" data-id="' + id + '">Remove</button></div></div>';
        }

        if (p.id === 'andromity') {
          const isAuthed = currentAccount && currentAccount.isAuthenticated;
          const uname = isAuthed ? (currentAccount.username || "User") : "";
          const planBadge = isAuthed ? (currentAccount.plan === "pro" ? "Pro Plan" : "Community") : "Anonymous Free Trial";

          return '<div class="item-card">' +
            '<div class="item-card-top">' +
              '<div class="item-card-title">' +
                '<span class="status-dot ' + (isAuthed ? 'connected' : '') + '"></span>' +
                '<span>' + escapeHtml(meta.name) + '</span>' +
              '</div>' +
              '<span class="badge ' + (isAuthed ? 'green' : '') + '">' + (isAuthed ? 'Connected' : 'Free Trial') + '</span>' +
            '</div>' +
            '<div class="item-card-desc">' + escapeHtml(meta.desc) + '</div>' +
            '<div style="margin: 10px 0; padding: 10px 12px; border-radius: 6px; background: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">' +
              '<div>' +
                '<div style="font-size: 12px; font-weight: 600; color: var(--fg);">' + (isAuthed ? '✓ ' + escapeHtml(uname) : 'AgenticMarket Account') + '</div>' +
                '<div style="font-size: 11px; color: var(--fg-muted); margin-top: 2px;">' + planBadge + '</div>' +
              '</div>' +
              (isAuthed
                ? '<button class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px;" data-action="logout-account">Sign Out</button>'
                : '<button class="btn" style="font-size: 11px; padding: 4px 12px;" data-action="login-account">Sign In with AgenticMarket</button>'
              ) +
            '</div>' +
            (waitlistJoined
              ? '<button class="btn btn-secondary waitlist-offer" data-action="join-waitlist" disabled>On the waitlist ✓</button>'
              : waitlistOffered
                ? '<button class="btn btn-secondary waitlist-offer" data-action="join-waitlist" title="Opens a short form in the chat">Need more? Join the waitlist</button>'
                : '') +
          '</div>';
        }

        return '<div class="item-card">' +
          '<div class="item-card-top">' +
            '<div class="item-card-title">' +
              '<span class="status-dot ' + (hasKey ? 'connected' : '') + '"></span>' +
              '<span>' + escapeHtml(meta.name) + '</span>' +
            '</div>' +
            (p.id === 'ollama'
              ? '<span class="badge ' + (ollamaStatus?.running ? 'green' : '') + '">' + (!ollamaChecked ? 'Checking' : ollamaStatus?.running ? 'Running' : 'Offline') + '</span>'
              : '<span class="badge ' + (hasKey ? 'green' : '') + '" data-key-badge="' + escapeHtml(p.id) + '" data-has-key="' + (hasKey ? '1' : '0') + '">' + (hasKey ? 'Active' : p.key_required ? 'No key' : 'Optional Key') + '</span>') +
          '</div>' +
          '<div class="item-card-desc">' + escapeHtml(meta.desc) + '</div>' +
          (p.id !== 'ollama'
            ? '<div class="key-input-row">' +
                '<input type="password" class="key-input" id="key-input-' + escapeHtml(p.id) + '" placeholder="' + (hasKey ? '•••••••••••••••• (Configured)' : 'Paste API Key here…') + '">' +
                '<button class="btn" data-action="save-key" data-id="' + escapeHtml(p.id) + '">Save</button>' +
              '</div>' +
              '<div class="key-actions-row">' +
                (meta.portal ? '<a class="portal-link" href="#" data-action="open-portal" data-url="' + escapeHtml(meta.portal) + '">Get API Key &rarr;</a>' : '<span></span>') +
                '<button type="button" class="btn btn-secondary btn-test-key" data-action="test-key" data-id="' + escapeHtml(p.id) + '" data-has-key="' + (hasKey ? '1' : '0') + '">Test</button>' +
              '</div>' +
              '<div class="key-test-status" data-provider="' + escapeHtml(p.id) + '" role="status" aria-live="polite"></div>'
            : '<div class="item-card-desc">' + (!ollamaChecked ? 'Checking Ollama…' : !ollamaStatus ? 'Could not check Ollama' : ollamaStatus.running ? 'Ollama running · ' + (ollamaStatus.models || []).length + ' installed models' : 'Ollama is not running') + '</div>' +
              (ollamaChecked && ollamaStatus?.installed && !ollamaStatus.running ? '<button class="btn" data-action="start-ollama">Start Ollama</button>' : '') +
              (ollamaChecked && !ollamaStatus?.running ? '<button class="btn" data-action="ollama-download">Install Ollama</button>' : '') +
              '<button class="btn" data-action="check-ollama">Check again</button><button class="btn" data-action="ollama-docs">Setup documentation</button>'
          ) +
        '</div>';
      }).join("");
      applyKeyTestState();
      noteWaitlistOffer();
    }

    function applyKeyTestState() {
      document.querySelectorAll('[data-action="test-key"]').forEach(btn => {
        const pid = btn.dataset.id || "";
        const hasKey = btn.dataset.hasKey === "1";
        btn.disabled = !hasKey || !!keyTestRunning;
        btn.textContent = keyTestRunning && keyTestRunning === pid ? "Testing…" : "Test";
        btn.title = !hasKey ? "Save an API key first"
          : keyTestRunning && keyTestRunning !== pid ? "Another key test is running"
          : "Send a tiny request to check this key";
      });
      document.querySelectorAll("[data-key-badge]").forEach(el => {
        if (el.dataset.hasKey !== "1") return;
        const state = keyTests[el.dataset.keyBadge || ""];
        const rejected = state && !state.running && state.errorType === "auth_error";
        el.className = "badge " + (rejected ? "orange" : "green");
        el.textContent = rejected ? "Check key" : "Active";
      });
      document.querySelectorAll(".key-test-status[data-provider]").forEach(el => {
        const state = keyTests[el.dataset.provider || ""];
        const done = state && !state.running;
        el.className = "key-test-status" + (done && state.tone ? " " + state.tone : "");
        el.textContent = !state ? "" : state.running ? "Testing…" : state.label;
        el.title = done ? (state.detail || (state.model ? "Tested with " + state.model : "")) : "";
      });
    }

    function startKeyTest(pid) {
      if (!pid) return;
      keyTestRunning = pid;
      keyTests[pid] = { running: true };
      clearTimeout(keyTestTimer);
      keyTestTimer = setTimeout(() => {
        if (keyTestRunning !== pid) return;
        keyTestRunning = "";
        keyTests[pid] = { running: false, tone: "error", label: "Couldn't reach provider" };
        applyKeyTestState();
      }, 25000);
      applyKeyTestState();
    }

    function finishKeyTest(msg) {
      const pid = msg.provider || "";
      if (keyTestRunning === pid) {
        keyTestRunning = "";
        clearTimeout(keyTestTimer);
      }
      keyTests[pid] = {
        running: false,
        tone: msg.tone || (msg.ok ? "ok" : "error"),
        label: msg.label || (msg.ok ? "Connected" : "Couldn't verify the key"),
        detail: msg.detail || "",
        model: msg.model || "",
        errorType: msg.errorType || "",
      };
      applyKeyTestState();
    }

    ${getUsageScript()}

    function renderUsageChart(sessions, range) {
      const container = document.getElementById("usage-bar-chart-container");
      if (!container) return;

      const period = document.getElementById('usage-bar-period');
      if (period) period.textContent = range === 'today' ? 'Today · 2-hour intervals' : range === 'week' ? 'Last 7 Days' : 'Last 14 Days';
      const slots = usageBarSlots(sessions, range);
      const numSlots = slots.length;

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
            let posX = (grpRect.left + grpRect.width / 2) - wrapRect.left;
            let posY = grpRect.top - wrapRect.top + 20;

            // Clamping so tooltip never clips off the left or right sides of the card
            posX = Math.max(95, Math.min(wrapRect.width - 95, posX));

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
      if (usageData.by_model) {
        Object.assign(modelMap, usageData.by_model);
      } else if (Array.isArray(filteredSessions) && filteredSessions.length > 0) {
        filteredSessions.forEach(s => {
          const m = s.model || 'default';
          if (!modelMap[m]) modelMap[m] = { tokens: 0, cost: 0, provider: s.provider || '' };
          modelMap[m].tokens += (s.token_total || s.tokens || 0);
          modelMap[m].cost += (s.cost_usd || 0);
        });
      }

      const entries = Object.entries(modelMap);
      if (entries.length === 0) {
        usagePagination('usage-models-pagination', 0, 0, usagePageSize);
        container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:6px 0;">No model usage recorded in this timeframe.</div>';
        return;
      }

      entries.sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0));
      const totalTokens = entries.reduce((acc, [, data]) => acc + (data.tokens || 0), 0) || 1;

      usageModelPage = Math.min(usageModelPage, Math.max(0, Math.ceil(entries.length / usagePageSize) - 1));
      usagePagination('usage-models-pagination', usageModelPage, entries.length, usagePageSize);
      container.innerHTML = entries.slice(usageModelPage * usagePageSize, (usageModelPage + 1) * usagePageSize).map(([modelId, data]) => {
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
      if (usageData.by_provider) {
        Object.assign(provMap, usageData.by_provider);
      } else if (Array.isArray(filteredSessions) && filteredSessions.length > 0) {
        filteredSessions.forEach(s => {
          const p = s.provider || (s.model && s.model.includes('/') ? s.model.split('/')[0] : 'openrouter');
          if (!provMap[p]) provMap[p] = { tokens: 0, cost: 0, sessions: 0 };
          provMap[p].tokens += (s.token_total || s.tokens || 0);
          provMap[p].cost += (s.cost_usd || 0);
          provMap[p].sessions += 1;
        });
      }

      const entries = Object.entries(provMap);
      if (entries.length === 0) {
        usagePagination('usage-providers-pagination', 0, 0, usagePageSize);
        container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:6px 0;">No provider activity recorded in this timeframe.</div>';
        return;
      }

      entries.sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0));
      const totalTokens = entries.reduce((acc, [, data]) => acc + (data.tokens || 0), 0) || 1;

      usageProviderPage = Math.min(usageProviderPage, Math.max(0, Math.ceil(entries.length / usagePageSize) - 1));
      usagePagination('usage-providers-pagination', usageProviderPage, entries.length, usagePageSize);
      container.innerHTML = entries.slice(usageProviderPage * usagePageSize, (usageProviderPage + 1) * usagePageSize).map(([provId, data]) => {
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

      const start = typeof usageData.sessions_offset === 'number' ? 0 : usageSessionPage * usagePageSize;
      tbody.innerHTML = list.slice(start, start + usagePageSize).map(s => {
        const sName = s.name || s.id || "Untitled Session";
        const modelStr = (s.model || "default") + (s.provider ? ' (' + s.provider + ')' : "");
        const tokens = s.token_total || s.tokens || 0;
        const cost = s.cost_usd || 0;
        const dStr = s.updated_at || s.created_at || "";
        const dateFormatted = dStr ? new Date(dStr).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "N/A";

        return '<tr style="border-bottom: 1px solid rgba(var(--tint), 0.03);">' +
          '<td style="padding:8px 12px; font-weight:500; font-size:12px; word-break:break-all;">' + escapeHtml(sName) + '</td>' +
          '<td style="padding:8px 12px; font-size:11px; color:var(--text-muted);">' + escapeHtml(modelStr) + '</td>' +
          '<td style="padding:8px 12px; text-align:right; font-size:12px; font-weight:600; font-family:var(--font-mono);">' + Number(tokens).toLocaleString() + '</td>' +
          '<td style="padding:8px 12px; text-align:right; font-size:11.5px; color:var(--tag-green-fg); font-family:var(--font-mono);">' + Number(cost).toFixed(4) + '</td>' +
          '<td style="padding:8px 12px; text-align:right; font-size:11px; color:var(--text-muted);">' + escapeHtml(dateFormatted) + '</td>' +
        '</tr>';
      }).join("");
    }

    function skillSourceName(r) {
      return (r.source_label || r.source_id || "").split(" — ")[0];
    }

    function skillSearchScore(s, terms) {
      const name = (s.name || "").toLowerCase();
      const tags = (s.tags || []).map(t => String(t).toLowerCase());
      const hay = [s.name, s.description, (s.tags || []).join(" "), s.category_label].join(" ").toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (hay.indexOf(t) === -1) return -1;
        if (name === t) score += 6;
        else if (name.indexOf(t) === 0) score += 4;
        else if (name.indexOf(t) !== -1) score += 3;
        else if (tags.indexOf(t) !== -1) score += 2;
        else score += 1;
      }
      return score;
    }

    function filterSkillsByQuery(list) {
      const terms = skillsQuery.split(" ").filter(Boolean);
      if (terms.length === 0) return list;
      return list
        .map((s, i) => ({ s: s, i: i, score: skillSearchScore(s, terms) }))
        .filter(x => x.score >= 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map(x => x.s);
    }

    function findInstalledSkill(name) {
      const lower = (name || "").toLowerCase();
      return allSkills.find(s => (s.name || "").toLowerCase() === lower) || null;
    }

    function skillUpdateFor(installed) {
      if (!installed || !installed.source || !installed.version) return null;
      const remote = allRemoteSkills.find(r => r.source_id === installed.source && r.name === installed.name);
      return remote && remote.version && remote.version !== installed.version ? remote : null;
    }

    function skillChip(action, value, label, active, count) {
      return '<button type="button" class="chip' + (active ? ' active' : '') + '" data-action="' + action + '" data-value="' + escapeHtml(value) + '">' +
        escapeHtml(label) + (count === undefined ? '' : '<span class="chip-count">' + count + '</span>') + '</button>';
    }

    function renderSkillFilters(base) {
      const catEl = document.getElementById("skills-category-chips");
      const srcEl = document.getElementById("skills-source-chips");
      const scopeEl = document.getElementById("skills-scope-chips");
      const registry = activeSkillsTab === "registry";
      if (scopeEl) scopeEl.style.display = registry ? "" : "none";

      const totals = {};
      const labels = {};
      allRemoteSkills.forEach(r => {
        const c = r.category || "other";
        totals[c] = (totals[c] || 0) + 1;
        labels[c] = r.category_label || c;
      });
      const order = Object.keys(totals).sort((a, b) => (a === "other") - (b === "other") || totals[b] - totals[a]);
      if (catEl) {
        if (!registry || order.length < 2) {
          catEl.style.display = "none";
        } else {
          const counts = {};
          base.forEach(r => { const c = r.category || "other"; counts[c] = (counts[c] || 0) + 1; });
          catEl.style.display = "";
          catEl.innerHTML = '<span class="chip-label">Category:</span>' +
            skillChip("skills-category", "all", "All", skillsCategory === "all", base.length) +
            order.filter(c => counts[c] || c === skillsCategory)
              .map(c => skillChip("skills-category", c, labels[c], skillsCategory === c, counts[c] || 0)).join("");
        }
      }
      if (srcEl) {
        const sources = [];
        allRemoteSkills.forEach(r => {
          if (!sources.some(x => x.id === r.source_id)) sources.push({ id: r.source_id, label: skillSourceName(r) });
        });
        if (!registry || sources.length < 2) {
          srcEl.style.display = "none";
        } else {
          srcEl.style.display = "";
          srcEl.innerHTML = '<span class="chip-label">Source:</span>' +
            skillChip("skills-source", "all", "All sources", skillsSource === "all") +
            skillChip("skills-source", "verified", "Verified", skillsSource === "verified") +
            sources.map(x => skillChip("skills-source", x.id, x.label, skillsSource === x.id)).join("");
        }
      }
    }

    function skillsEmptyState(message) {
      return '<div class="empty-state" style="grid-column: 1 / -1;">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>' +
        '<div>' + message + '</div>' +
      '</div>';
    }

    function installedSkillCard(s) {
      const update = skillUpdateFor(s);
      return '<div class="item-card" data-action="skill-open" data-skill-name="' + escapeHtml(s.name) + '" data-source-id="' + escapeHtml(s.source || '') + '" data-skill-path="' + escapeHtml(s.path || '') + '" tabindex="0" role="button" aria-label="Open skill ' + escapeHtml(s.name) + '">' +
        '<div class="item-card-top">' +
          '<div class="item-card-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>' +
            '<span>' + escapeHtml(s.name) + '</span>' +
          '</div>' +
          '<div class="skill-badges">' +
            (update ? '<span class="badge orange">Update available</span>' : '') +
            '<span class="badge purple">' + escapeHtml(s.scope || 'skill') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="item-card-desc">' + escapeHtml(s.description || 'Custom agent workflow skill.') + '</div>' +
        '<div style="font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); word-break: break-all;">' + escapeHtml(s.path || '') + '</div>' +
        '<div style="display: flex; gap: 6px;">' +
          (update ? '<button class="btn" style="padding: 4px 10px; font-size: 11px;" data-action="install-skill" data-skill-name="' + escapeHtml(s.name) + '" data-source-id="' + escapeHtml(update.source_id) + '" data-skill-ref="' + escapeHtml(update.commit || '') + '" data-skill-scope="' + (s.scope === 'project' ? 'project' : 'user') + '">Update</button>' : '') +
          (s.scope === 'builtin' ? '' : '<button class="btn btn-secondary" data-action="remove-skill" data-skill-name="' + escapeHtml(s.name) + '" data-skill-path="' + escapeHtml(s.path || '') + '">Remove Skill</button>') +
        '</div>' +
      '</div>';
    }

    function remoteSkillCard(r) {
      const installed = findInstalledSkill(r.name);
      const fromOtherSource = !!(installed && installed.source && installed.source !== r.source_id);
      const hasUpdate = !!(installed && !fromOtherSource && installed.version && r.version && installed.version !== r.version);
      const buttonLabel = !installed ? 'Install Skill' : hasUpdate ? 'Update' : fromOtherSource ? 'Replace' : 'Reinstall';
      const tags = (r.tags || []).slice(0, 4).map(t =>
        '<span class="skill-tag" data-action="skills-tag" data-value="' + escapeHtml(t) + '" tabindex="0" role="button">#' + escapeHtml(t) + '</span>').join('');
      return '<div class="item-card" data-action="skill-open" data-skill-name="' + escapeHtml(r.name) + '" data-source-id="' + escapeHtml(r.source_id || '') + '" tabindex="0" role="button" aria-label="Open skill ' + escapeHtml(r.name) + '">' +
        '<div class="item-card-top">' +
          '<div class="item-card-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>' +
            '<span>' + escapeHtml(r.name) + '</span>' +
          '</div>' +
          '<div class="skill-badges">' +
            (r.featured ? '<span class="badge orange">Featured</span>' : '') +
            (r.verified ? '<span class="badge green">Verified</span>' : '') +
            (r.category_label && r.category !== 'other' ? '<span class="badge purple">' + escapeHtml(r.category_label) + '</span>' : '') +
            '<span class="badge blue">' + escapeHtml(skillSourceName(r)) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="item-card-desc">' + escapeHtml(r.description || 'Remote instruction pack from ' + r.repo) + '</div>' +
        (tags ? '<div class="skill-tags">' + tags + '</div>' : '') +
        '<div style="display: flex; align-items: center; justify-content: space-between; margin-top: 8px;">' +
          '<span class="skill-badges">' +
            (installed ? '<span class="badge green" style="font-size:10px; font-weight:600;">' + (fromOtherSource ? 'Installed (other source)' : 'Installed') + '</span>' : '') +
            (hasUpdate ? '<span class="badge orange" style="font-size:10px; font-weight:600;">Update available</span>' : '') +
          '</span>' +
          '<button class="btn ' + (installed && !hasUpdate ? 'btn-secondary' : '') + '" style="padding: 4px 10px; font-size: 11px;" data-action="install-skill" data-skill-name="' + escapeHtml(r.name) + '" data-source-id="' + escapeHtml(r.source_id || 'anthropic') + '" data-skill-ref="' + escapeHtml(r.commit || '') + '">' + buttonLabel + '</button>' +
        '</div>' +
      '</div>';
    }

    function skillDocKey(d) {
      return [d.name, d.sourceId || "", d.path || ""].join("|");
    }

    function openSkillDetail(name, sourceId, path) {
      skillDetail = { name: name, sourceId: sourceId || "", path: path || "" };
      const key = skillDocKey(skillDetail);
      if (!skillDocs[key] || skillDocs[key].error) {
        skillDocs[key] = { loading: true };
        vscode.postMessage({ type: "skill_read", key: key, name: name, sourceId: skillDetail.sourceId, path: skillDetail.path });
      }
      renderSkillDetail();
    }

    function closeSkillDetail() {
      skillDetail = null;
      renderSkillDetail();
    }

    function resolveSkillDetail() {
      if (!skillDetail) return null;
      const installed = (skillDetail.path
        ? allSkills.find(s => s.name === skillDetail.name && s.path === skillDetail.path)
        : null) || findInstalledSkill(skillDetail.name);
      const sourceId = skillDetail.sourceId || (installed && installed.source) || "";
      const remote = allRemoteSkills.find(r => r.name === skillDetail.name && (!sourceId || r.source_id === sourceId)) || null;
      return installed || remote ? { installed: installed, remote: remote } : null;
    }

    function skillDetailRow(label, valueHtml) {
      return '<div class="skill-detail-row"><span class="skill-detail-label">' + label + '</span><span>' + valueHtml + '</span></div>';
    }

    function renderSkillDetail() {
      const overlay = document.getElementById("skill-detail-overlay");
      if (!overlay) return;
      const detail = resolveSkillDetail();
      if (!skillDetail || !detail) {
        skillDetail = null;
        overlay.style.display = "none";
        overlay.innerHTML = "";
        return;
      }
      const installed = detail.installed;
      const remote = detail.remote;
      const name = (remote || installed).name;
      const description = (remote && remote.description) || (installed && installed.description) || "No description provided.";
      const fromOtherSource = !!(installed && remote && installed.source && installed.source !== remote.source_id);
      const hasUpdate = !!(installed && remote && !fromOtherSource && installed.version && remote.version && installed.version !== remote.version);
      const doc = skillDocs[skillDocKey(skillDetail)] || {};

      const badges = (remote && remote.featured ? '<span class="badge orange">Featured</span>' : '') +
        (remote && remote.verified ? '<span class="badge green">Verified</span>' : '') +
        (remote && remote.category_label && remote.category !== "other" ? '<span class="badge purple">' + escapeHtml(remote.category_label) + '</span>' : '') +
        (remote ? '<span class="badge blue">' + escapeHtml(skillSourceName(remote)) + '</span>' : '') +
        (installed ? '<span class="badge green">Installed (' + escapeHtml(installed.scope || "skill") + ')</span>' : '') +
        (hasUpdate ? '<span class="badge orange">Update available</span>' : '');

      const tags = remote ? (remote.tags || []).map(t =>
        '<span class="skill-tag" data-action="skills-tag" data-value="' + escapeHtml(t) + '" tabindex="0" role="button">#' + escapeHtml(t) + '</span>').join("") : "";

      let rows = "";
      if (remote) {
        const ref = remote.commit || "main";
        rows += skillDetailRow("Source", escapeHtml(remote.source_label || remote.source_id));
        rows += skillDetailRow("Repository", '<a href="#" style="color:var(--accent); text-decoration:none;" data-action="open-portal" data-url="https://github.com/' +
          escapeHtml(remote.repo) + '/tree/' + escapeHtml(ref) + '/' + escapeHtml(remote.dir) + '">' + escapeHtml(remote.repo + "/" + remote.dir) + '</a>');
        if (remote.commit) rows += skillDetailRow("Pinned commit", '<code>' + escapeHtml(remote.commit.slice(0, 7)) + '</code>');
      }
      if (installed) {
        rows += skillDetailRow("Installed at", '<code style="word-break:break-all;">' + escapeHtml(installed.path || "") + '</code>');
      }

      const needsScope = remote && (!installed || fromOtherSource);
      const scopeChips = needsScope
        ? '<div class="filter-chips"><span class="chip-label">Install to:</span>' +
          '<button type="button" class="chip' + (skillsInstallScope === "user" ? " active" : "") + '" data-action="skills-scope" data-value="user">All projects</button>' +
          '<button type="button" class="chip' + (skillsInstallScope === "project" ? " active" : "") + '" data-action="skills-scope" data-value="project">This project only</button></div>'
        : "";

      const installAttrs = remote
        ? ' data-skill-name="' + escapeHtml(remote.name) + '" data-source-id="' + escapeHtml(remote.source_id) + '" data-skill-ref="' + escapeHtml(remote.commit || "") + '"'
        : "";
      let actions = "";
      if (installed && installed.scope !== "builtin") {
        actions += '<button class="btn btn-secondary" data-action="remove-skill" data-skill-name="' + escapeHtml(installed.name) + '" data-skill-path="' + escapeHtml(installed.path || "") + '">Remove</button>';
      }
      if (hasUpdate) {
        actions += '<button class="btn"' + installAttrs + ' data-skill-scope="' + (installed.scope === "project" ? "project" : "user") + '" data-action="install-skill">Update</button>';
      } else if (remote && !installed) {
        actions += '<button class="btn"' + installAttrs + ' data-action="install-skill">Install</button>';
      } else if (fromOtherSource) {
        actions += '<button class="btn"' + installAttrs + ' data-action="install-skill">Replace with this version</button>';
      }

      const docHtml = doc.loading
        ? '<div class="skill-detail-doc-note">Loading instructions...</div>'
        : doc.error
          ? '<div class="skill-detail-doc-note">' + escapeHtml(doc.error) + '</div>'
          : '<pre class="skill-detail-doc">' + escapeHtml(doc.content || "") + '</pre>';

      overlay.style.display = "flex";
      overlay.innerHTML = '<div class="skill-detail" role="dialog" aria-label="Skill details">' +
        '<div class="skill-detail-head">' +
          '<h3 class="skill-detail-title">' + escapeHtml(name) + '</h3>' +
          '<button class="btn btn-secondary" style="padding: 2px 9px;" data-action="skill-close" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="skill-badges" style="justify-content:flex-start;">' + badges + '</div>' +
        '<p class="skill-detail-desc">' + escapeHtml(description) + '</p>' +
        (tags ? '<div class="skill-tags">' + tags + '</div>' : '') +
        '<div class="skill-detail-meta">' + rows + '</div>' +
        '<div class="chip-label" style="margin-top:4px;">Instructions (SKILL.md)</div>' +
        docHtml +
        scopeChips +
        '<div class="skill-detail-actions">' + actions + '</div>' +
      '</div>';
    }

    function renderSkills() {
      renderSkillList();
      renderSkillDetail();
    }

    function renderSkillList() {
      const grid = document.getElementById("skills-grid");
      if (!grid) return;
      if (activeSkillsTab === "installed") {
        renderSkillFilters([]);
        if (allSkills.length === 0) {
          grid.innerHTML = skillsEmptyState('No skills installed yet. Switch to "Browse Online Registry" to install instruction packs.');
          return;
        }
        const list = filterSkillsByQuery(allSkills);
        grid.innerHTML = list.length === 0
          ? skillsEmptyState('No installed skills match your search.')
          : list.map(installedSkillCard).join("");
        return;
      }

      if (allRemoteSkills.length === 0) {
        renderSkillFilters([]);
        grid.innerHTML = skillsEmptyState('Loading the skills catalog...');
        return;
      }
      const bySource = allRemoteSkills.filter(r =>
        skillsSource === "all" || (skillsSource === "verified" ? r.verified : r.source_id === skillsSource));
      const base = filterSkillsByQuery(bySource);
      renderSkillFilters(base);
      const matches = base.filter(r => skillsCategory === "all" || (r.category || "other") === skillsCategory);
      if (matches.length === 0) {
        grid.innerHTML = skillsEmptyState('No skills match your filters.');
        return;
      }
      const page = matches.slice(0, skillsLimit);
      grid.innerHTML = page.map(remoteSkillCard).join("") +
        (matches.length > page.length
          ? '<div class="skills-footer"><button class="btn btn-secondary" data-action="skills-show-more">Show more (' + (matches.length - page.length) + ' remaining)</button></div>'
          : '');
    }

    function renderConnectors() {
      const list = document.getElementById("connectors-list");
      if (!list) return;
      if (allConnectors.length === 0) {
        list.innerHTML = '<div class="section-desc">App connectors need an updated Andromity server. Update Andromity, then refresh.</div>';
        return;
      }
      const query = connectorQuery.trim().toLowerCase();
      const matches = allConnectors.filter(c => !query ||
        [c.name, c.description, c.category].some(v => String(v || "").toLowerCase().includes(query)));
      if (matches.length === 0) {
        list.innerHTML = '<div class="section-desc">No apps match your search. Use Add MCP Server for any other MCP server URL.</div>';
        return;
      }
      const groups = [];
      matches.forEach(c => {
        let group = groups.find(g => g.category === c.category);
        if (!group) { group = { category: c.category, items: [] }; groups.push(group); }
        group.items.push(c);
      });
      list.innerHTML = groups.map(g =>
        '<div class="connector-category">' + escapeHtml(g.category) + '</div>' +
        '<div class="connector-grid">' + g.items.map(c =>
          '<div class="connector-tile">' +
            connectorIcon(c.id, c.name, "") +
            '<div class="connector-text">' +
              '<div class="connector-name">' + escapeHtml(c.name) + '</div>' +
              '<div class="connector-desc">' + escapeHtml(c.description) +
                (c.connected ? '' : c.needs_client ? ' Needs your own Google OAuth client.' : c.auth === 'token' ? ' Connects with an access token.' : '') + '</div>' +
              (CONNECTOR_GUIDE_SLUGS[c.id] ? '<a href="#" class="connector-guide" data-action="open_connector_guide" data-slug="' + escapeHtml(CONNECTOR_GUIDE_SLUGS[c.id]) + '">Setup guide</a>' : '') +
            '</div>' +
            (c.connected
              ? '<span class="badge green">Connected</span>'
              : '<button class="btn" data-action="connector_connect" data-id="' + escapeHtml(c.id) + '">Connect</button>') +
          '</div>').join('') +
        '</div>').join('');
    }

    function connectorIcon(id, name, size) {
      const icon = CONNECTOR_ICONS[id];
      const cls = "connector-icon" + (size ? " " + size : "");
      if (!icon || !/^[0-9a-f]{6}$/i.test(icon.hex)) {
        return '<span class="' + cls + ' connector-icon-letter" aria-hidden="true">' + escapeHtml(String(name || id || "?").charAt(0).toUpperCase()) + '</span>';
      }
      const rgb = [0, 2, 4].map(i => parseInt(icon.hex.slice(i, i + 2), 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      const fg = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.4 ? "#000000" : "#ffffff";
      return '<span class="' + cls + '" style="background:#' + icon.hex + ';" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24"><path fill="' + fg + '" d="' + escapeHtml(icon.path) + '"></path></svg></span>';
    }

    function setMcpView(view) {
      mcpView = view;
      const yours = view === "yours";
      const toggle = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? "" : "none"; };
      toggle("mcp-view-yours", yours);
      toggle("mcp-view-discover", !yours);
      toggle("connectors-search-row", !yours);
      document.getElementById("filter-mcp-yours")?.classList.toggle("active", yours);
      document.getElementById("filter-mcp-discover")?.classList.toggle("active", !yours);
    }

    function renderMcpCounts() {
      const yoursNum = document.getElementById("mcp-yours-num");
      if (yoursNum) yoursNum.textContent = String(allMcpServers.length);
      const discoverNum = document.getElementById("mcp-discover-num");
      if (discoverNum) discoverNum.textContent = String(allConnectors.length);
      if (!mcpView) setMcpView(allMcpServers.length === 0 && allConnectors.length > 0 ? "discover" : "yours");
    }

    function renderMcp() {
      const grid = document.getElementById("mcp-grid");
      if (!grid) return;
      if (allMcpServers.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M9 9h6v6H9z"></path></svg>' +
          '<div>No MCP servers yet. Connect an app from Discover, or use Add MCP Server for any remote or local server.</div>' +
          (allConnectors.length ? '<button class="btn" style="margin-top:10px;" data-action="mcp_show_discover">Discover apps</button>' : '') +
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
                        : isDisabled ? 'background:rgba(var(--tint), 0.2);'
                        : '';

        // Status badge
        const badgeColor = isRunning  ? 'green'
                         : isError    ? ''
                         : isAuth     ? 'orange'
                         : isDisabled ? ''
                         : '';
        const badgeStyle = isError   ? 'background:rgba(248,81,73,0.15); color:#f85149; border:1px solid rgba(248,81,73,0.3);'
                         : isDisabled ? 'background:rgba(var(--tint), 0.06); color:var(--text-muted);'
                         : '';
        const badgeLabel = isRunning  ? 'Connected'
                         : isError    ? 'error'
                         : isAuth     ? 'needs auth'
                         : isDisabled ? 'disabled'
                         : 'not started';

        const cmdStr = s.command ? escapeHtml(s.command) + (s.args && s.args.length ? ' ' + s.args.map(escapeHtml).join(' ') : '') : '<span style="color:var(--text-muted)">no command</span>';
        const tools = Array.isArray(s.tools) ? s.tools : [];
        const toolsHtml = tools.map(tool => '<div class="mcp-tool">' +
          '<div class="mcp-tool-name">' + escapeHtml(tool.name) + '</div>' +
          '<div class="mcp-tool-description">' + escapeHtml(tool.description || 'No description provided by this server.') + '</div>' +
        '</div>').join('');

        return '<div class="item-card mcp-card">' +
          '<div class="item-card-top">' +
            '<div class="item-card-title">' +
              '<span class="status-dot ' + dotClass + '" style="' + dotStyle + '"></span>' +
              (allConnectors.some(c => c.id === s.name && c.connected) ? connectorIcon(s.name, s.name, "small") : '') +
              '<span>' + escapeHtml(s.name) + '</span>' +
            '</div>' +
            '<span class="badge ' + badgeColor + '" style="' + badgeStyle + '">' + escapeHtml(badgeLabel) + '</span>' +
          '</div>' +
          '<div class="item-card-desc mcp-endpoint"><code>' + cmdStr + '</code></div>' +
          (isError && s.error ? '<div style="font-size:11px; color:#f85149; margin-top:6px; padding:5px 8px; background:rgba(248,81,73,0.08); border:1px solid rgba(248,81,73,0.2);">' + escapeHtml(s.error) + '</div>' : '') +
          (isError && s.error_detail ? '<div style="font-size:10.5px; color:var(--text-muted); margin-top:4px; padding:5px 8px; background:rgba(var(--tint), 0.03); border:1px solid var(--card-border); max-height:80px; overflow:auto; white-space:pre-wrap; word-break:break-word;">' + escapeHtml(s.error_detail) + '</div>' : '') +
          (isRunning ? '<details class="mcp-tools"><summary>View tools (' + escapeHtml(String(s.tools_count || 0)) + ')</summary>' +
            '<div class="mcp-tools-list">' + (toolsHtml || '<div class="mcp-tool-description">' +
              (s.tools_count > 0 ? 'Tool details unavailable. Update the daemon and refresh.' : 'This server currently exposes no tools.') + '</div>') + '</div></details>' : '') +
          (!isRunning && !isDisabled && (s.remote || isAuth) ? '<div style="margin-top:8px;"><button class="btn" style="font-size:11px; padding:4px 10px;" data-action="mcp_auth" data-name="' + escapeHtml(s.name) + '">Connect / Authenticate</button></div>' : '') +
          '<div style="display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;">' +
            '<button class="btn btn-secondary" style="padding:4px 8px; font-size:11px;" data-action="mcp_restart" data-name="' + escapeHtml(s.name) + '"' + (isDisabled ? ' disabled title="Enable first to restart"' : '') + '>↺ Restart</button>' +
            (isDisabled
              ? '<button class="btn" style="padding:4px 8px; font-size:11px;" data-action="mcp_toggle" data-name="' + escapeHtml(s.name) + '" data-disabled="false">Enable</button>'
              : '<button class="btn btn-secondary" style="padding:4px 8px; font-size:11px;" data-action="mcp_toggle" data-name="' + escapeHtml(s.name) + '" data-disabled="true">Disable</button>'
            ) +
            (isRunning && s.remote ? '<button class="btn btn-secondary" data-action="mcp_auth" data-name="' + escapeHtml(s.name) + '">Re-authenticate</button>' : '') +
            '<button class="btn btn-secondary" data-action="mcp_remove" data-name="' + escapeHtml(s.name) + '">Remove</button>' +
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

    let cronEditingId = null;
    let cronPreviewSeq = 0;
    let cronPreviewTimer = null;
    let cronScheduleValid = true;
    let cronSaving = false;

    function cronField(id) { return document.getElementById(id); }

    function setCronSelect(id, value, label) {
      const sel = cronField(id);
      if (!sel) return;
      const v = String(value);
      if (!Array.from(sel.options).some(o => o.value === v)) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = label || v;
        sel.appendChild(opt);
      }
      sel.value = v;
    }

    function currentCronSchedule() {
      const sel = cronField("cron-schedule-select");
      const custom = cronField("cron-custom-schedule");
      if (!sel) return "every 1h";
      return sel.value === "custom" ? (custom ? custom.value.trim() : "") : sel.value;
    }

    function setCronFormError(text) {
      const el = cronField("cron-form-error");
      if (!el) return;
      el.textContent = text || "";
      el.hidden = !text;
    }

    function syncCronSaveButtons() {
      ["btn-save-cron", "btn-save-run-cron"].forEach(id => {
        const b = cronField(id);
        if (b) b.disabled = cronSaving || !cronScheduleValid;
      });
    }

    function requestCronPreview() {
      clearTimeout(cronPreviewTimer);
      cronPreviewTimer = setTimeout(() => {
        const schedule = currentCronSchedule();
        const box = cronField("cron-schedule-preview");
        cronPreviewSeq += 1;
        if (!schedule) {
          if (box) { box.textContent = "Enter a schedule."; box.className = "cron-schedule-preview invalid"; }
          cronScheduleValid = false;
          syncCronSaveButtons();
          return;
        }
        vscode.postMessage({ type: "cron_preview", schedule: schedule, requestId: cronPreviewSeq });
      }, 250);
    }

    function renderCronPreview(msg) {
      if (msg.requestId !== cronPreviewSeq) return;
      const box = cronField("cron-schedule-preview");
      if (!box) return;
      if (msg.unavailable) {
        box.textContent = "";
        box.className = "cron-schedule-preview";
        cronScheduleValid = true;
      } else if (!msg.valid) {
        box.textContent = msg.error || "This schedule is not valid.";
        box.className = "cron-schedule-preview invalid";
        cronScheduleValid = false;
      } else {
        const times = (msg.next_runs || []).slice(0, 5).map(formatCronAbsolute).filter(Boolean);
        box.innerHTML = "<strong>" + escapeHtml(msg.description || "") + "</strong>" +
          "<span>" + (times.length ? "Next: " + escapeHtml(times.join(" · ")) : "No upcoming runs.") + "</span>";
        box.className = "cron-schedule-preview valid";
        cronScheduleValid = true;
      }
      syncCronSaveButtons();
    }

    function openCronForm(job) {
      if (!cronCreateForm) return;
      cronEditingId = job ? String(job.id) : null;
      const title = cronField("cron-form-title");
      if (title) title.textContent = job ? "Edit " + (job.name || "job") : "Create Scheduled Job";
      const saveBtn = cronField("btn-save-cron");
      if (saveBtn) saveBtn.textContent = job ? "Save changes" : "Create job";
      cronField("cron-name-input").value = job ? (job.name || "") : "";
      cronField("cron-prompt-input").value = job ? (job.prompt || "") : "";
      cronField("cron-commands-input").value = job && Array.isArray(job.allowed_commands) ? job.allowed_commands.join(", ") : "";
      const sel = cronField("cron-schedule-select");
      const custom = cronField("cron-custom-schedule");
      const schedule = job ? String(job.schedule || "") : "every 1h";
      const isPreset = Array.from(sel.options).some(o => o.value === schedule && o.value !== "custom");
      sel.value = isPreset ? schedule : "custom";
      custom.value = isPreset ? "" : schedule;
      custom.style.display = isPreset ? "none" : "block";
      setCronSelect("cron-mode-select", job ? String(job.mode || "trust").toLowerCase() : "safe");
      const timeout = job ? Number(job.timeout_seconds || 600) : 600;
      setCronSelect("cron-timeout-select", timeout, Math.round(timeout / 60) + " minutes");
      setCronSelect("cron-onfail-select", job ? (job.on_failure || "notify") : "retry");
      setCronSelect("cron-notify-select", job ? (job.notify || "failures") : "failures");
      setCronSelect("cron-catchup-select", job ? (job.catch_up || "once") : "once");
      const modelSel = cronField("cron-model-select");
      if (modelSel) {
        if (job && job.model && !Array.from(modelSel.options).some(o => o.value === job.model)) {
          const opt = document.createElement("option");
          opt.value = job.model;
          opt.dataset.provider = job.provider || "";
          opt.textContent = job.model + (job.provider ? " (" + job.provider + ")" : "");
          modelSel.appendChild(opt);
        }
        modelSel.value = job && job.model ? job.model : "";
      }
      const folder = cronField("cron-form-folder");
      if (folder) {
        const where = job && job.project_path ? job.project_path : currentWorkspacePath;
        folder.textContent = where ? "Runs in " + where : "Open a folder in VS Code to create scheduled jobs.";
      }
      setCronFormError("");
      cronSaving = false;
      cronScheduleValid = true;
      syncCronSaveButtons();
      cronCreateForm.style.display = "flex";
      if (btnToggleAddCron) btnToggleAddCron.textContent = "Close Form";
      requestCronPreview();
      cronField("cron-name-input").focus();
    }

    function closeCronForm() {
      if (!cronCreateForm) return;
      cronCreateForm.style.display = "none";
      cronEditingId = null;
      cronSaving = false;
      if (btnToggleAddCron) btnToggleAddCron.textContent = "+ New Cron Job";
    }

    function submitCronForm(runNow) {
      const prompt = cronField("cron-prompt-input").value.trim();
      const schedule = currentCronSchedule();
      if (!schedule) { setCronFormError("Enter a schedule."); return; }
      if (!prompt) {
        setCronFormError("Enter a prompt for the job.");
        cronField("cron-prompt-input").focus();
        return;
      }
      const modelSelect = cronField("cron-model-select");
      const pickedOption = modelSelect && modelSelect.value ? modelSelect.options[modelSelect.selectedIndex] : null;
      const payload = {
        name: cronField("cron-name-input").value.trim() || "Scheduled Job",
        schedule: schedule,
        prompt: prompt,
        model: (modelSelect ? modelSelect.value : "") || activeModelId,
        // A picked model carries its own provider; the default uses the active one.
        provider: (pickedOption && pickedOption.dataset.provider) || activeModelProvider,
        mode: cronField("cron-mode-select").value,
        allowed_commands: cronField("cron-commands-input").value.trim(),
        timeout_seconds: Number(cronField("cron-timeout-select").value),
        on_failure: cronField("cron-onfail-select").value,
        notify: cronField("cron-notify-select").value,
        catch_up: cronField("cron-catchup-select").value,
      };
      setCronFormError("");
      cronSaving = true;
      syncCronSaveButtons();
      if (cronEditingId) {
        vscode.postMessage({ type: "cron_update", id: cronEditingId, payload: payload, runNow: !!runNow });
      } else {
        vscode.postMessage({ type: "cron_create", payload: Object.assign({}, payload, { run_now: !!runNow }) });
      }
    }

    if (btnToggleAddCron && cronCreateForm) {
      btnToggleAddCron.addEventListener("click", () => {
        if (cronCreateForm.style.display === "none") openCronForm(null);
        else closeCronForm();
      });
    }

    if (btnCancelCron) btnCancelCron.addEventListener("click", closeCronForm);

    const cronScheduleSelect = document.getElementById("cron-schedule-select");
    const cronCustomScheduleInput = document.getElementById("cron-custom-schedule");
    if (cronScheduleSelect) {
      cronScheduleSelect.addEventListener("change", () => {
        if (cronCustomScheduleInput) {
          cronCustomScheduleInput.style.display = cronScheduleSelect.value === "custom" ? "block" : "none";
          if (cronScheduleSelect.value === "custom") cronCustomScheduleInput.focus();
        }
        requestCronPreview();
      });
    }
    if (cronCustomScheduleInput) cronCustomScheduleInput.addEventListener("input", requestCronPreview);

    if (btnSaveCron) btnSaveCron.addEventListener("click", () => submitCronForm(false));
    const btnSaveRunCron = document.getElementById("btn-save-run-cron");
    if (btnSaveRunCron) btnSaveRunCron.addEventListener("click", () => submitCronForm(true));

    if (btnRefreshCrons) {
      btnRefreshCrons.addEventListener("click", () => {
        btnRefreshCrons.disabled = true;
        const orig = btnRefreshCrons.innerHTML;
        btnRefreshCrons.innerHTML = '<span style="display:inline-block; width:9px; height:9px; border:1.5px solid currentColor; border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; margin-right:4px;"></span> Refreshing...';
        vscode.postMessage({ type: "refresh_crons" });
        setTimeout(() => {
          btnRefreshCrons.disabled = false;
          btnRefreshCrons.innerHTML = orig;
        }, 3000);
      });
    }


    document.querySelectorAll("[data-docs-url]").forEach(link => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        vscode.postMessage({ type: "open_url", url: link.getAttribute("data-docs-url") });
      });
    });
    const cronContainer = document.getElementById("cron-list-container");
    if (cronContainer) {
      cronContainer.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn || !cronContainer.contains(btn)) return;
        // The document-level handler also knows open-session; handle it once, here.
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === "toggle") {
          vscode.postMessage({ type: "cron_toggle", id });
        } else if (action === "run") {
          cronRunning.add(String(id));
          renderCrons();
          vscode.postMessage({ type: "cron_run_now", id });
        } else if (action === "delete") {
          vscode.postMessage({ type: "cron_delete", id });
        } else if (action === "new-cron") {
          openCronForm(null);
        } else if (action === "edit") {
          const job = allCrons.find(j => String(j.id) === String(id));
          if (job) openCronForm(job);
        } else if (action === "duplicate") {
          vscode.postMessage({ type: "cron_duplicate", id });
        } else if (action === "fix") {
          const fix = btn.dataset.fix;
          if (fix === "api_keys") {
            switchTab("keys", true);
          } else if (fix === "trust_workspace") {
            if (currentWorkspacePath) vscode.postMessage({ type: "trust_folder", path: currentWorkspacePath });
          } else {
            const job = allCrons.find(j => String(j.id) === String(id));
            if (job) openCronForm(job);
          }
        } else if (action === "history" || action === "refresh-history") {
          const runsDiv = document.getElementById("cron-runs-" + id);
          if (!runsDiv) return;
          if (action === "history" && cronOpenHistory.has(id)) {
            cronOpenHistory.delete(id);
            runsDiv.hidden = true;
            btn.setAttribute("aria-expanded", "false");
            return;
          }
          cronOpenHistory.add(id);
          runsDiv.hidden = false;
          const toggleBtn = cronContainer.querySelector('.cron-history-toggle[data-id="' + CSS.escape(id) + '"]');
          if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
          if (!cronRunsCache[id] || action === "refresh-history") {
            runsDiv.innerHTML = '<div class="cron-runs-loading">Loading runs…</div>';
          }
          vscode.postMessage({ type: "fetch_cron_runs", id: id });
        } else if (action === "expand-run") {
          const detail = btn.nextElementSibling;
          if (detail) {
            detail.hidden = !detail.hidden;
            btn.setAttribute("aria-expanded", String(!detail.hidden));
          }
        } else if (action === "open-session" || action === "open-session-tab") {
          const sId = btn.dataset.sessionId;
          if (sId) {
            vscode.postMessage({ type: "open_cron_session", sessionId: sId, sessionName: btn.dataset.sessionName || "Cron run", target: action === "open-session-tab" ? "tab" : "sidebar" });
          }
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

    // Cron jobs: each card shows schedule, next and last run, model and mode; history rows expand for output.
    const cronRunsCache = {};
    const cronOpenHistory = new Set();
    const cronRunning = new Set();
    const CRON_OUTCOME = { success: "Succeeded", needs_attention: "Needs attention", failed: "Failed", timeout: "Timed out", interrupted: "Interrupted", skipped: "Skipped", missed: "Missed", running: "Running", never: "Never run" };
    const CRON_TRIGGER = { manual: "Manual", catch_up: "Catch-up", retry: "Retry" };
    const CRON_FIX = { api_keys: "Open API keys", trust_workspace: "Trust this workspace", edit_job: "Edit job" };
    const CRON_ON_FAILURE = { retry: "Retry temporary errors", notify: "Record and wait", disable: "Pause the job" };
    const CRON_NOTIFY = { failures: "When it needs attention", always: "After every run", never: "Never" };
    const cronSvg = (body) => '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
    const CRON_ICON = {
      success: cronSvg('<polyline points="20 6 9 17 4 12"></polyline>'),
      failed: cronSvg('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'),
      timeout: cronSvg('<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>'),
      interrupted: cronSvg('<line x1="12" y1="6" x2="12" y2="13"></line><line x1="12" y1="18" x2="12.01" y2="18"></line>'),
      running: cronSvg('<circle cx="12" cy="12" r="4" fill="currentColor"></circle>'),
      needs_attention: cronSvg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'),
      skipped: cronSvg('<polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline>'),
      missed: cronSvg('<polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline>'),
    };
    const CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

    function formatCronWhen(iso) {
      if (!iso) return "";
      const date = new Date(iso);
      if (isNaN(date.getTime())) return "";
      const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return date.toDateString() === new Date().toDateString() ? "Today " + time : date.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + time;
    }

    function formatCronAbsolute(iso) {
      if (!iso) return "";
      const date = new Date(iso);
      if (isNaN(date.getTime())) return "";
      const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const today = new Date();
      const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      if (date.toDateString() === today.toDateString()) return "Today " + time;
      if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow " + time;
      return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " " + time;
    }

    function cronFolderName(path) {
      if (!path) return "";
      const parts = String(path).split(String.fromCharCode(92)).join("/").split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : String(path);
    }

    function cronFixButton(job) {
      const fix = job.fix_action;
      if (!fix || !CRON_FIX[fix]) return "";
      return '<button class="btn btn-secondary" data-action="fix" data-fix="' + escapeHtml(fix) + '" data-id="' + escapeHtml(String(job.id)) + '">' + CRON_FIX[fix] + '</button>';
    }

    function formatCronDuration(ms) {
      if (!ms) return "";
      if (ms < 1000) return Math.round(ms) + "ms";
      if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
      return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
    }

    // next_run_in comes from the daemon as "now", "45m", "1h 5m", "2d 3h" or "completed".
    function cronMinutesUntil(nextIn) {
      if (!nextIn || nextIn === "completed") return Infinity;
      if (nextIn === "now") return 0;
      let minutes = 0;
      String(nextIn).split(" ").forEach(part => {
        const value = parseFloat(part);
        if (isNaN(value)) return;
        if (part.endsWith("d")) minutes += value * 1440;
        else if (part.endsWith("h")) minutes += value * 60;
        else if (part.endsWith("m")) minutes += value;
        else if (part.endsWith("s")) minutes += value / 60;
      });
      return minutes;
    }

    function updateCronSummary() {
      const summary = document.getElementById("cron-summary");
      if (!summary) return;
      if (!allCrons.length) {
        summary.innerHTML = "";
        return;
      }
      const active = allCrons.filter(j => j.enabled !== false);
      const next = active.slice().sort((a, b) => cronMinutesUntil(a.next_run_in) - cronMinutesUntil(b.next_run_in))[0];
      const attention = allCrons.filter(j => (j.enabled === false && j.paused_reason) || j.last_status === "needs_attention" || j.last_status === "failed" || j.last_status === "timeout").length;
      const parts = ["<span><strong>" + allCrons.length + "</strong> job" + (allCrons.length === 1 ? "" : "s") + "</span>",
        "<span><strong>" + active.length + "</strong> active</span>"];
      if (cronRunning.size) parts.push("<span><strong>" + cronRunning.size + "</strong> running now</span>");
      if (attention) parts.push("<span><strong>" + attention + "</strong> need" + (attention === 1 ? "s" : "") + " attention</span>");
      if (next && cronMinutesUntil(next.next_run_in) !== Infinity) {
        parts.push("<span>Next: <strong>" + escapeHtml(next.name || next.id) + "</strong> " + (next.next_run_in === "now" ? "due now" : "in " + escapeHtml(next.next_run_in)) + "</span>");
      }
      summary.innerHTML = parts.join("");
    }

    function cronFact(label, valueHtml) {
      return '<div class="cron-fact"><dt>' + label + '</dt><dd>' + valueHtml + '</dd></div>';
    }

    function cronCardHtml(job) {
      const id = String(job.id);
      const enabled = job.enabled !== false;
      const running = cronRunning.has(id) || job.running === true;
      const needsFix = !enabled && !!job.paused_reason;
      const state = running ? "running" : needsFix ? "error" : enabled ? "active" : "paused";
      const stateLabel = running ? "Running" : needsFix ? "Paused · needs fixing" : enabled ? "Active" : "Paused";
      const nextIn = job.next_run_in;
      let next;
      if (running) next = "Running now";
      else if (!enabled) next = "Paused";
      else if (job.schedule_valid === false) next = "Invalid schedule";
      else if (!job.next_run_at || nextIn === "completed") next = "No more runs";
      else next = formatCronAbsolute(job.next_run_at) + (nextIn === "now" ? " · due now" : nextIn ? " · in " + nextIn : "");
      const lastStatus = job.last_status || "never";
      const lastWhen = formatCronWhen(job.last_run);
      const last = lastWhen
        ? escapeHtml(lastWhen) + ' · <span class="cron-outcome ' + escapeHtml(lastStatus) + '">' + escapeHtml(CRON_OUTCOME[lastStatus] || lastStatus) + '</span>'
        : (lastStatus === "skipped" || lastStatus === "missed" ? '<span class="cron-outcome ' + escapeHtml(lastStatus) + '">' + escapeHtml(CRON_OUTCOME[lastStatus]) + '</span>' : "Never run");
      const model = job.model ? escapeHtml(job.model) + (job.provider ? ' <span style="color:var(--text-muted)">· ' + escapeHtml(job.provider) + '</span>' : '') : "Default model";
      const cmds = Array.isArray(job.allowed_commands) ? job.allowed_commands.join(", ") : String(job.allowed_commands || "");
      const folder = job.project_path ? '<span title="' + escapeHtml(job.project_path) + '">' + escapeHtml(cronFolderName(job.project_path)) + '</span>' : "—";
      const timeoutMin = job.timeout_seconds ? Math.round(job.timeout_seconds / 60) + " min" : "10 min";
      const historyOpen = cronOpenHistory.has(id);
      let notice = "";
      if (job.folder_problem) {
        notice = '<div class="cron-notice"><span>' + escapeHtml(job.folder_problem) + '</span></div>';
      } else if (needsFix) {
        notice = '<div class="cron-notice"><span>' + escapeHtml(job.paused_reason) + '</span><span style="display:flex; gap:6px;">' + cronFixButton(job) + '<button class="btn btn-secondary" data-action="toggle" data-id="' + escapeHtml(id) + '">Resume</button></span></div>';
      } else if (job.last_error && ["failed", "timeout", "needs_attention", "skipped", "missed", "interrupted"].indexOf(lastStatus) >= 0) {
        const fixBtn = cronFixButton(job);
        notice = '<div class="cron-last-error' + (fixBtn ? ' with-fix' : '') + '"><span>' + escapeHtml(job.last_error) + '</span>' + fixBtn + '</div>';
      }
      return '<article class="cron-card ' + state + '" data-job-id="' + escapeHtml(id) + '">' +
        '<div class="cron-card-head">' +
          '<div class="cron-card-heading">' +
            '<span class="cron-card-name">' + escapeHtml(job.name || id) + '</span>' +
            '<span class="cron-interval-pill" title="' + escapeHtml(job.schedule || "") + '">' + escapeHtml(job.schedule_description || job.schedule || "") + '</span>' +
            '<span class="cron-status-pill ' + state + '">' + stateLabel + '</span>' +
          '</div>' +
          '<div class="cron-card-actions">' +
            '<button class="btn" data-action="run" data-id="' + escapeHtml(id) + '"' + (running ? ' disabled' : '') + '>' + (running ? 'Running…' : 'Run now') + '</button>' +
            '<button class="btn btn-secondary" data-action="edit" data-id="' + escapeHtml(id) + '">Edit</button>' +
            '<button class="btn btn-secondary" data-action="duplicate" data-id="' + escapeHtml(id) + '" title="Make a paused copy of this job">Duplicate</button>' +
            '<button class="btn btn-secondary" data-action="toggle" data-id="' + escapeHtml(id) + '">' + (enabled ? 'Pause' : 'Resume') + '</button>' +
            '<button class="btn-icon-danger" data-action="delete" data-id="' + escapeHtml(id) + '" title="Delete job" aria-label="Delete ' + escapeHtml(job.name || "job") + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>' +
          '</div>' +
        '</div>' +
        '<div class="cron-card-prompt" title="' + escapeHtml(job.prompt || "") + '">' + escapeHtml(job.prompt || "") + '</div>' +
        '<dl class="cron-facts">' +
          cronFact("Next run", escapeHtml(next)) +
          cronFact("Last run", last) +
          cronFact("Model", model) +
          cronFact("Permission mode", escapeHtml(String(job.mode || "trust").toUpperCase())) +
          cronFact("Folder", folder) +
          cronFact("Time limit", escapeHtml(timeoutMin)) +
          cronFact("On failure", escapeHtml(CRON_ON_FAILURE[job.on_failure] || job.on_failure || "")) +
          cronFact("Notify", escapeHtml(CRON_NOTIFY[job.notify] || CRON_NOTIFY.failures)) +
          (cmds ? cronFact("Allowed commands", '<code>' + escapeHtml(cmds) + '</code>') : cronFact("Allowed commands", "None")) +
        '</dl>' +
        notice +
        '<button class="cron-history-toggle" data-action="history" data-id="' + escapeHtml(id) + '" aria-expanded="' + historyOpen + '" aria-controls="cron-runs-' + escapeHtml(id) + '">' + CHEVRON + '<span>Run history</span></button>' +
        '<div id="cron-runs-' + escapeHtml(id) + '" class="cron-runs-container"' + (historyOpen ? '' : ' hidden') + '></div>' +
      '</article>';
    }

    function renderCrons() {
      const container = document.getElementById("cron-list-container");
      const badge = document.getElementById("crons-count-badge");
      if (badge) badge.textContent = allCrons.length;
      updateCronSummary();
      if (!container) return;

      if (!allCrons || allCrons.length === 0) {
        container.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
          '<div>No scheduled jobs yet. A job runs a prompt on a schedule, for example running the tests every morning or reviewing new changes every hour.</div>' +
          '<button class="btn" data-action="new-cron">+ New Cron Job</button></div>';
        return;
      }

      container.innerHTML = allCrons.map(cronCardHtml).join("");
      cronOpenHistory.forEach(id => renderCronRuns(id));
    }

    function cronRunHtml(run) {
      const status = run.status || "unknown";
      const when = formatCronWhen(run.started_at) || "Unknown time";
      const tools = (run.tools_used || []).length;
      const meta = [run.model, tools ? tools + " tool" + (tools === 1 ? "" : "s") : "", run.cost_usd ? "$" + Number(run.cost_usd).toFixed(4) : ""].filter(Boolean).join(" · ");
      const output = run.output || run.output_preview || "";
      const sId = run.session_id || "";
      const sessionName = "Cron run: " + (run.job_name || "job") + " (" + when + ")";
      let detail = "";
      if (run.error) detail += '<div class="cron-last-error">' + escapeHtml(run.error) + '</div>';
      if (run.blocked_tools && run.blocked_tools.length) detail += '<div><span class="cron-run-label">Blocked</span> ' + escapeHtml(run.blocked_tools.join("; ")) + '</div>';
      if (run.scheduled_for && run.trigger === "catch_up") detail += '<div><span class="cron-run-label">Planned for</span> ' + escapeHtml(formatCronAbsolute(run.scheduled_for)) + '</div>';
      if (tools) detail += '<div><span class="cron-run-label">Tools</span> ' + escapeHtml(run.tools_used.join(", ")) + '</div>';
      if (status !== "skipped" && status !== "missed") {
        detail += output ? '<div class="cron-run-label">Output</div><pre class="cron-run-output">' + escapeHtml(output) + '</pre>' : '<div class="cron-runs-empty">No output recorded.</div>';
      }
      detail += '<div class="cron-run-actions">' + (sId
        ? '<button class="btn btn-secondary" data-action="open-session" data-session-id="' + escapeHtml(sId) + '" data-session-name="' + escapeHtml(sessionName) + '">Open session</button>' +
          '<button class="btn btn-secondary" data-action="open-session-tab" data-session-id="' + escapeHtml(sId) + '" data-session-name="' + escapeHtml(sessionName) + '">Open in tab</button>' +
          '<span class="cron-run-session">' + escapeHtml(sId.slice(0, 22)) + '</span>'
        : '<span class="cron-run-session">No session was recorded for this run.</span>') + '</div>';
      return '<div class="cron-run ' + escapeHtml(status) + '">' +
        '<button class="cron-run-summary" data-action="expand-run" aria-expanded="false">' +
          '<span class="cron-run-icon">' + (CRON_ICON[status] || "") + '</span>' +
          '<span>' + escapeHtml(when) + '</span>' +
          '<span class="cron-run-status">' + escapeHtml(CRON_OUTCOME[status] || status) + (run.duration_ms ? ' · ' + formatCronDuration(run.duration_ms) : '') +
            (CRON_TRIGGER[run.trigger] ? '<span class="cron-trigger-badge">' + CRON_TRIGGER[run.trigger] + '</span>' : '') + '</span>' +
          '<span class="cron-run-meta">' + escapeHtml(meta) + '</span>' +
          CHEVRON +
        '</button>' +
        '<div class="cron-run-detail" hidden>' + detail + '</div>' +
      '</div>';
    }

    function renderCronRuns(jobId) {
      const div = document.getElementById("cron-runs-" + jobId);
      const runs = cronRunsCache[jobId];
      if (!div || !runs) return;
      if (!runs.length) {
        div.innerHTML = '<div class="cron-runs-empty">No runs yet. Use Run now to try this job.</div>';
        return;
      }
      const ok = runs.filter(r => r.status === "success").length;
      const durations = runs.map(r => r.duration_ms).filter(Boolean);
      const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
      div.innerHTML = '<div class="cron-runs-head"><span>' + runs.length + ' run' + (runs.length === 1 ? '' : 's') + ' · ' + ok + ' succeeded' + (avg ? ' · average ' + formatCronDuration(avg) : '') + '</span>' +
        '<button class="btn btn-secondary" data-action="refresh-history" data-id="' + escapeHtml(jobId) + '">Refresh</button></div>' +
        '<div class="cron-runs">' + runs.map(cronRunHtml).join("") + '</div>';
    }

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
