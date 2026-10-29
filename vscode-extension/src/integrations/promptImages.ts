import * as vscode from "vscode";
import { RpcClient } from "../server/RpcClient.js";
import { PromptImageMessage, SessionUndoResult, SessionWebviewEvent, UndonePrompt } from "../server/types.js";

const MAX_PROMPT_IMAGES = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_URI_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + "data:image/jpeg;base64,".length;
const IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|gif|webp);base64,/;
const STORED_IMAGE_NAME = /^[0-9a-f]{16}\.jpg$/;

export function isImageDataUri(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IMAGE_URI_CHARS && IMAGE_DATA_URI.test(value);
}

/** The prompt an undo removed, from the engine's reply, ready to go back in the input box. */
export function undonePromptOf(result: SessionUndoResult | null | undefined): UndonePrompt | undefined {
  const prompt = result?.undone_prompt;
  if (!prompt || typeof prompt !== "object") return undefined;
  const text = typeof prompt.text === "string" ? prompt.text : "";
  const images = Array.isArray(prompt.images) ? prompt.images.filter(isImageDataUri).slice(0, MAX_PROMPT_IMAGES) : [];
  return text.trim() || images.length ? { text, images } : undefined;
}

/** The image viewer asks for the full-size copy of an image sent with an earlier prompt of the session shown. */
export async function handlePromptImageMessage(
  rpc: RpcClient, message: PromptImageMessage, sessionId: string,
  post: (event: SessionWebviewEvent) => void,
): Promise<boolean> {
  if (message.type !== "load_prompt_image") return false;
  if (typeof message.name !== "string" || !STORED_IMAGE_NAME.test(message.name)) return true;
  const name = message.name;
  let uri: string | null = null;
  if (sessionId) {
    try {
      const result = await rpc.call<{ success?: boolean; uri?: unknown }>("session.image", {
        session_id: sessionId, name, project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      });
      uri = result?.success && isImageDataUri(result.uri) ? result.uri : null;
    } catch {
      uri = null;
    }
  }
  post({ type: "prompt_image", session_id: sessionId, name, uri });
  return true;
}
