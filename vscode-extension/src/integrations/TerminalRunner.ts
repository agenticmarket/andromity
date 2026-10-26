import * as vscode from "vscode";
import { normalizeShellCommand, resolveShellPath, shellFamilyForLanguage } from "./shellLanguages.js";
import { currentAirGap } from "../airgapState.js";
import { terminalAirGapEnv } from "../airgap.js";
import { describeCommandRisks, hasHiddenContent, revealHiddenContent } from "../commandRisk.js";
import { requireWorkspaceTrust } from "../server/securityPolicy.js";

export type RunState = "running" | "succeeded" | "failed" | "untracked";

export interface RunStatus {
  state: RunState;
  command: string;
  exitCode?: number;
  /** Last lines of output, kept in the editor until the user asks for a fix. */
  outputTail?: string;
}

const SHELL_INTEGRATION_WAIT_MS = 3000;
const OUTPUT_TAIL_LINES = 100;
const OUTPUT_TAIL_CHARS = 8000;
const ANSI_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export function outputTail(raw: string): string {
  const lines = raw.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-OUTPUT_TAIL_LINES).join("\n");
  return tail.length > OUTPUT_TAIL_CHARS ? tail.slice(-OUTPUT_TAIL_CHARS) : tail;
}

function terminalCwd(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
  return (folder || vscode.workspace.workspaceFolders?.[0])?.uri;
}

/** Shell integration (VS Code 1.93+) reports exit codes; older builds and
 *  shells without it resolve undefined and the command runs untracked. */
function waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
  if (typeof vscode.window.onDidChangeTerminalShellIntegration !== "function") return Promise.resolve(undefined);
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { listener.dispose(); resolve(undefined); }, SHELL_INTEGRATION_WAIT_MS);
    const listener = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal !== terminal) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(e.shellIntegration);
    });
  });
}

function trackExecution(execution: vscode.TerminalShellExecution, command: string, report: (status: RunStatus) => void) {
  let raw = "";
  const reading = (async () => {
    try {
      for await (const chunk of execution.read()) {
        raw += chunk;
        if (raw.length > OUTPUT_TAIL_CHARS * 4) raw = raw.slice(-OUTPUT_TAIL_CHARS * 2);
      }
    } catch {
      // Output is best effort; the exit code still reports.
    }
  })();
  const listener = vscode.window.onDidEndTerminalShellExecution(async (e) => {
    if (e.execution !== execution) return;
    listener.dispose();
    await Promise.race([reading, new Promise((r) => setTimeout(r, 500))]);
    const exitCode = e.exitCode;
    if (exitCode === undefined) report({ state: "untracked", command });
    else report({ state: exitCode === 0 ? "succeeded" : "failed", command, exitCode, outputTail: outputTail(raw) });
  });
}

/**
 * Chat code blocks come from the model. A block that hides part of itself or would do
 * lasting damage is shown in full, with the reasons, before it reaches a terminal.
 */
export async function confirmUnusualCommand(command: string): Promise<boolean> {
  const reasons = describeCommandRisks(command).filter((r) => r.level === "danger").map((r) => r.label);
  if (hasHiddenContent(command)) reasons.push("Contains hidden characters or text pushed off screen");
  if (!reasons.length) return true;
  const choice = await vscode.window.showWarningMessage(
    "Run this command in a new terminal?",
    { modal: true, detail: reasons.map((r) => "• " + r).join("\n") + "\n\n" + revealHiddenContent(command) },
    "Run",
  );
  return choice === "Run";
}

/** Opens a new integrated terminal and runs a chat code block in it. */
export async function runCodeBlockInTerminal(code: unknown, lang: unknown, report?: (status: RunStatus) => void): Promise<void> {
  const family = shellFamilyForLanguage(typeof lang === "string" ? lang : "");
  if (!family) return;
  const command = normalizeShellCommand(typeof code === "string" ? code : "", family);
  if (!command.trim()) return;

  if (!requireWorkspaceTrust("run commands from chat")) return;
  if (!(await confirmUnusualCommand(command))) return;

  const shellPath = resolveShellPath(family, process.platform, vscode.env.shell || "");
  if (shellPath === null) {
    void vscode.window.showWarningMessage("CMD blocks can only run on Windows. Copy the command and adapt it for your shell.");
    report?.({ state: "untracked", command });
    return;
  }

  const options: vscode.TerminalOptions = { name: "Andromity: Run", cwd: terminalCwd() };
  if (shellPath) options.shellPath = shellPath;
  const airGapEnv = terminalAirGapEnv(currentAirGap());
  if (Object.keys(airGapEnv).length) {
    options.env = airGapEnv;
    options.name = "Andromity: Run (air-gap)";
  }
  const terminal = vscode.window.createTerminal(options);
  terminal.show();

  const integration = report ? await waitForShellIntegration(terminal) : undefined;
  if (!integration || !report) {
    terminal.sendText(command, true);
    report?.({ state: "untracked", command });
    return;
  }
  report({ state: "running", command });
  trackExecution(integration.executeCommand(command), command, report);
}
