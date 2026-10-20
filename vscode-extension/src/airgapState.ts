import * as vscode from "vscode";
import { AirGapState, airGapStatusLine, resolveAirGap } from "./airgap.js";

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
