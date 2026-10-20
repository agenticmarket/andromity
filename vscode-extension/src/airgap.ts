/** Air-gap mode as the extension sees it. Pure functions; callers pass VS Code's view of the settings. */

export type AirGapSource = "organization" | "user" | "workspace" | "off";

export interface AirGapState {
  enabled: boolean;
  /** Where "on" came from. A workspace may only turn the mode on, never off. */
  source: AirGapSource;
  /** Set through the environment (an administrator or launcher), so the UI cannot turn it off. */
  locked: boolean;
  allowedHosts: string[];
}

export interface SettingInspection<T> {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

function hostList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items.map((item) => String(item).trim()).filter(Boolean);
}

export function resolveAirGap(
  enabled: SettingInspection<boolean> | undefined,
  allowedHosts: SettingInspection<string[]> | undefined,
  env: Record<string, string | undefined>,
): AirGapState {
  const fromEnv = env.ANDROMITY_AIRGAP === "1";
  // Allowed hosts widen what can be reached, so a repository's settings cannot add any.
  const hosts = [...new Set([...hostList(env.ANDROMITY_AIRGAP_ALLOW), ...hostList(allowedHosts?.globalValue)])];
  if (fromEnv) return { enabled: true, source: "organization", locked: true, allowedHosts: hosts };
  if (enabled?.globalValue === true) return { enabled: true, source: "user", locked: false, allowedHosts: hosts };
  if (enabled?.workspaceValue === true || enabled?.workspaceFolderValue === true) {
    return { enabled: true, source: "workspace", locked: false, allowedHosts: hosts };
  }
  return { enabled: false, source: "off", locked: false, allowedHosts: hosts };
}

/** Environment for the engine daemon. */
export function daemonAirGapEnv(state: AirGapState): Record<string, string> {
  if (!state.enabled) return {};
  return { ANDROMITY_AIRGAP: "1", ANDROMITY_AIRGAP_ALLOW: state.allowedHosts.join(",") };
}

const DEAD_PROXY = "http://127.0.0.1:9";

/** Environment for terminals the extension opens (the Run button). Mirrors the engine's command
 *  environment: tools that honour proxy settings fail fast; others need a firewall. */
export function terminalAirGapEnv(state: AirGapState): Record<string, string> {
  if (!state.enabled) return {};
  const noProxy = ["localhost", "127.0.0.1", "::1", ...state.allowedHosts].join(",");
  const env: Record<string, string> = {
    ANDROMITY_AIRGAP: "1",
    ANDROMITY_AIRGAP_ALLOW: state.allowedHosts.join(","),
    NODE_USE_ENV_PROXY: "1",
    GIT_SSH_COMMAND: "false",
    GIT_TERMINAL_PROMPT: "0",
    DO_NOT_TRACK: "1",
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY"]) {
    env[name] = DEAD_PROXY;
    env[name.toLowerCase()] = DEAD_PROXY;
  }
  return env;
}

export function airGapOffMessage(feature: string, remedy = ""): string {
  return `Air-gap mode is on, so ${feature} is turned off because it needs the internet.${remedy ? " " + remedy : ""}`;
}

/** First tooltip line for the status bar while air-gap mode is on. */
export function airGapStatusLine(state: AirGapState, blockedCount: number): string {
  const reach = state.allowedHosts.length ? `this machine and ${state.allowedHosts.join(", ")}` : "this machine";
  const origin = state.source === "organization" ? " (set by your organization)"
    : state.source === "workspace" ? " (turned on by this project)" : "";
  const blocked = blockedCount
    ? ` Blocked ${blockedCount} connection attempt${blockedCount === 1 ? "" : "s"} since the engine started; see the Andromity output.`
    : "";
  return `Air-gap mode is on${origin}: Andromity can reach only ${reach}.${blocked}`;
}
