import * as path from "path";
import * as vscode from "vscode";

/** Host-side checks for security-relevant requests that arrive from webviews.
 *  A webview renders model output, so anything it sends is treated as
 *  untrusted input: elevation always goes through a native VS Code prompt. */

export const PERMISSION_MODES = ["safe", "trust", "full", "yolo"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const MODE_RANK: Record<PermissionMode, number> = { safe: 0, trust: 1, full: 2, yolo: 3 };
/** Modes that run shell commands and edit files without per-action review. */
const UNREVIEWED_MODES = new Set<PermissionMode>(["full", "yolo"]);

export function normalizePermissionMode(value: unknown): PermissionMode | null {
  if (typeof value !== "string") return null;
  const mode = value.trim().toLowerCase();
  return (PERMISSION_MODES as readonly string[]).includes(mode) ? (mode as PermissionMode) : null;
}

/** Returns the mode to apply, or null when the request is invalid or the user declined. */
export async function confirmPermissionMode(requested: unknown, current: string): Promise<PermissionMode | null> {
  const mode = normalizePermissionMode(requested);
  if (!mode) return null;
  if (!UNREVIEWED_MODES.has(mode) || mode === normalizePermissionMode(current)) return mode;
  const label = mode.toUpperCase();
  const detail = mode === "yolo"
    ? "The agent will run shell commands and edit files silently, without asking."
    : "The agent will run shell commands and edit files without asking, logging each action.";
  const choice = await vscode.window.showWarningMessage(
    `Switch Andromity to ${label} mode?`,
    { modal: true, detail },
    `Enable ${label}`
  );
  return choice === `Enable ${label}` ? mode : null;
}

/** A per-prompt mode override may lower privileges but never raise them above
 *  the mode the user already approved. */
export function clampPromptMode(requested: unknown, current: string): string {
  const approved = normalizePermissionMode(current) ?? "safe";
  const mode = normalizePermissionMode(requested);
  if (!mode) return approved;
  return MODE_RANK[mode] <= MODE_RANK[approved] ? mode : approved;
}

type Validator = (value: unknown) => boolean;
const isShortString = (max: number): Validator => (v) => typeof v === "string" && v.length <= max;
const matches = (pattern: RegExp): Validator => (v) => typeof v === "string" && pattern.test(v);
const isBoolean: Validator = (v) => typeof v === "boolean";
const isIntInRange = (min: number, max: number): Validator => (v) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Daemon config keys the webviews may write through config.set. Permission
 *  mode is deliberately absent: it must go through confirmPermissionMode. */
const WEBVIEW_CONFIG_KEYS: Record<string, { section: string; key: string; valid: Validator }> = {
  model: { section: "default", key: "model", valid: isShortString(300) },
  provider: { section: "default", key: "provider", valid: matches(/^[A-Za-z0-9_.:-]{1,64}$/) },
  profile: { section: "default", key: "profile", valid: matches(/^[A-Za-z0-9_-]{1,64}$/) },
  reasoningEffort: { section: "default", key: "reasoning_effort", valid: matches(/^(?:[a-z]{1,16}|budget:\d{1,7})$/) },
  userName: { section: "user", key: "name", valid: isShortString(128) },
  userEmail: { section: "user", key: "email", valid: isShortString(254) },
  maxSubagents: { section: "subagents", key: "max_parallel", valid: isIntInRange(1, 64) },
  autoCompact: { section: "advanced", key: "auto_compact", valid: isBoolean },
  maxFileSize: { section: "advanced", key: "max_file_size_kb", valid: isIntInRange(1, 1_048_576) },
  startupSession: { section: "default", key: "startupSession", valid: matches(/^(?:last|fresh)$/) },
  waterfallAutoOpen: { section: "default", key: "waterfallAutoOpen", valid: isBoolean },
};

export function resolveWebviewConfigWrite(
  key: unknown,
  value: unknown
): { section: string; key: string; value: unknown } | null {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(WEBVIEW_CONFIG_KEYS, key)) return null;
  const target = WEBVIEW_CONFIG_KEYS[key];
  return target.valid(value) ? { section: target.section, key: target.key, value } : null;
}

export function currentWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Andromity's own trust grants shell and file-write access, so it can only be
 *  given to an open workspace folder that VS Code already trusts, and only
 *  after a native confirmation. Returns the folder to trust, or null. */
export async function confirmAndromityTrust(requestedPath?: unknown): Promise<string | null> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const target = typeof requestedPath === "string" && requestedPath ? requestedPath : folders[0];
  if (!target || !folders.some((folder) => samePath(folder, target))) {
    void vscode.window.showWarningMessage("Andromity can only trust a folder that is open in this window.");
    return null;
  }
  if (vscode.workspace.isTrusted === false) {
    const choice = await vscode.window.showWarningMessage(
      "VS Code is in Restricted Mode for this folder. Trust it in VS Code first, then enable Andromity's file and shell access.",
      "Manage Workspace Trust"
    );
    if (choice === "Manage Workspace Trust") {
      void vscode.commands.executeCommand("workbench.trust.manage");
    }
    return null;
  }
  const choice = await vscode.window.showWarningMessage(
    `Allow Andromity to edit files and run commands in ${path.basename(target)}?`,
    { modal: true, detail: target },
    "Trust Folder"
  );
  return choice === "Trust Folder" ? target : null;
}

/** MCP servers configured in a project can launch local processes. */
export function requireWorkspaceTrust(action: string): boolean {
  if (vscode.workspace.isTrusted !== false) return true;
  void vscode.window.showWarningMessage(`Trust this workspace in VS Code before you ${action}.`);
  return false;
}

const DOUBLE_BACKSLASH = String.fromCharCode(92).repeat(2);

export function isUncPath(p: string): boolean {
  return p.startsWith(DOUBLE_BACKSLASH) || p.startsWith("//");
}

export function isInsideWorkspace(p: string): boolean {
  const resolved = path.resolve(p);
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
    const relative = path.relative(folder.uri.fsPath, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

/** Paths in webview messages can come from model output. Network paths are
 *  refused outright (touching one sends Windows credentials to that host), and
 *  local files outside the workspace need an explicit confirmation. */
export async function allowOpenPath(p: string): Promise<boolean> {
  if (isUncPath(p)) {
    void vscode.window.showWarningMessage("Andromity does not open files on network shares from chat links.");
    return false;
  }
  // Callers join relative paths onto the workspace, so check where they land
  // ("../../.ssh/id_rsa" is relative but outside).
  const root = currentWorkspaceFolder();
  const resolved = path.isAbsolute(p) || !root ? p : path.resolve(root, p);
  if (isUncPath(resolved)) return false;
  if (!path.isAbsolute(resolved) || isInsideWorkspace(resolved)) return true;
  const choice = await vscode.window.showWarningMessage(
    "Open a file outside this workspace?",
    { modal: true, detail: resolved },
    "Open"
  );
  return choice === "Open";
}
