import * as vscode from "vscode";

/** Edit-and-resend removes turns and rolls back their file changes, so it asks first. */
export async function confirmRewindAndResend(turnsToUndo: unknown): Promise<boolean> {
  const count = Math.max(1, Math.floor(Number(turnsToUndo)) || 1);
  const choice = await vscode.window.showWarningMessage(
    count > 1
      ? `Edit and resend? This undoes the last ${count} turns and their file changes, then sends your edited message.`
      : "Edit and resend? This undoes this turn and its file changes, then sends your edited message.",
    { modal: true },
    "Undo and Resend"
  );
  return choice === "Undo and Resend";
}

export function resendPromptOf(message: any): string | undefined {
  const text = message?.resendPrompt;
  return typeof text === "string" && text.trim() ? text : undefined;
}
