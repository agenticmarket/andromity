import * as vscode from "vscode";
import { AirGapState, airGapStatusLine, airGapTurnOnWarning, resolveAirGap } from "./airgap.js";

/** Air-gap mode from VS Code settings and the extension host environment. */
export function currentAirGap(): AirGapState {
  try {
    const config = vscode.workspace.getConfiguration("andromity");
    return resolveAirGap(
      config.inspect<boolean>("airGap.enabled"),
      config.inspect<string[]>("airGap.allowedHosts"),
      process.env,
    );
  } catch {
    return resolveAirGap(undefined, undefined, process.env);
  }
}

/** The chat webview message that shows or hides the Air-gap pill. */
export function airGapPillMessage(): { type: string; key: string; value: boolean; title: string } {
  const airGap = currentAirGap();
  return { type: "config_updated", key: "airgap", value: airGap.enabled, title: airGapStatusLine(airGap, 0) };
}

/** Asks before turning air-gap mode on, listing what will stop for this setup. */
export async function confirmTurnOnAirGap(current: { provider?: string; model?: string; running?: boolean }): Promise<boolean> {
  const warning = airGapTurnOnWarning(current);
  const choice = await vscode.window.showWarningMessage(warning.message, { modal: true, detail: warning.detail }, "Turn On Air-gap Mode");
  return choice === "Turn On Air-gap Mode";
}
