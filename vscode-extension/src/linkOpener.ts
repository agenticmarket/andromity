import * as vscode from "vscode";

/**
 * Opens an http(s) link after the user confirms it. Links in chat and task output come from the
 * model, tools or web pages, and their text can differ from where they point, so the dialog shows
 * the full address. Returns true when the link was opened.
 */
export async function confirmAndOpenLink(url: unknown, question = "Open this link?"): Promise<boolean> {
  if (typeof url !== "string" || !url.trim()) return false;
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(url.trim(), true);
  } catch {
    return false;
  }
  if (uri.scheme !== "http" && uri.scheme !== "https") return false;
  const choice = await vscode.window.showInformationMessage(question, { modal: true, detail: url.trim() }, "Open");
  if (choice !== "Open") return false;
  await vscode.env.openExternal(uri);
  return true;
}
