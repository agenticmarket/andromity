import * as vscode from "vscode";
import { cleanPromptForDisplay } from "./providers/promptDisplay.js";

/** A saved session as `session.get` returns it (only the fields used here). */
export interface SessionTranscript {
  name?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    if (part?.type === "image_url" || part?.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n\n");
}

/** Prompts and replies as Markdown, for pasting into a PR, issue or chat. Tool calls and
 *  their output, system messages and the IDE context attached to prompts are left out. */
export function formatChatMarkdown(session: SessionTranscript): { markdown: string; count: number } {
  const blocks: string[] = [];
  let lastSpeaker = "";
  for (const message of session.messages || []) {
    let speaker = "";
    let text = "";
    if (message.role === "user") {
      speaker = "You";
      text = cleanPromptForDisplay(textOf(message.content)).trim();
    } else if (message.role === "assistant") {
      speaker = "Andromity";
      text = textOf(message.content).trim();
    }
    if (!text) continue;
    // A reply spans several assistant messages around its tool calls; they share one heading.
    if (speaker === lastSpeaker) blocks[blocks.length - 1] += `\n\n${text}`;
    else blocks.push(`### ${speaker}\n\n${text}`);
    lastSpeaker = speaker;
  }
  const title = session.name ? `# ${cleanPromptForDisplay(session.name).trim()}\n\n` : "";
  return { markdown: blocks.length ? title + blocks.join("\n\n") + "\n" : "", count: blocks.length };
}

/** Copies a session's prompts and replies to the clipboard as Markdown. */
export async function copySessionAsMarkdown(rpc: { call<T>(method: string, params: any): Promise<T> } | null | undefined, sessionId: string): Promise<void> {
  if (!rpc || !sessionId) {
    void vscode.window.showWarningMessage("Open a chat with messages first, then copy it.");
    return;
  }
  const session = await rpc.call<SessionTranscript>("session.get", { session_id: sessionId }).catch(() => null);
  if (!session) {
    void vscode.window.showErrorMessage("Could not read this chat. Check that the Andromity engine is running, then try again.");
    return;
  }
  const { markdown, count } = formatChatMarkdown(session);
  if (!count) {
    void vscode.window.showInformationMessage("Nothing to copy yet. Send a message first.");
    return;
  }
  await vscode.env.clipboard.writeText(markdown);
  void vscode.window.showInformationMessage(`Copied ${count} message${count === 1 ? "" : "s"} as Markdown.`);
}
