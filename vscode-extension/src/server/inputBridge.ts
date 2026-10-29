import * as vscode from "vscode";
import { RpcClient } from "./RpcClient.js";
import { InputBridgeMessage, InputQueueState, SessionInfo } from "./types.js";
import { EditorBridge } from "../integrations/EditorBridge.js";
import { clampPromptMode } from "./securityPolicy.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import { SCHEDULED_RUN_BUSY, SCHEDULED_RUN_BUSY_TEXT } from "../cronNotifications.js";

// A typed slash command at the start of a prompt, e.g. "/review"; paths like "/usr/bin" do not match.
const SLASH_COMMAND = /^\/([a-z][a-z0-9-]{1,20})(?=\s|$)/i;

/** Common queue transport for the sidebar and standalone session tabs.
 *  approvedMode is the permission mode the user confirmed on the host; a
 *  message may lower it for one turn but never raise it. */
export async function handleInputMessage(
  rpc: RpcClient, message: InputBridgeMessage, currentSession: string,
  post: (message: unknown) => void, approvedMode = "safe",
): Promise<boolean> {
  const methods: Record<string, string> = {
    queue_snapshot: "agent.queue", queue_promote: "agent.promote",
    queue_remove: "agent.remove", queue_resume: "agent.resume",
  };
  if (message.type !== "submit_input" && message.type !== "retry_turn" && !methods[message.type]) return false;
  let sid = message.sessionId || currentSession;
  try {
    const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!sid) {
      const session = await rpc.call<SessionInfo>("session.create", { project_path: projectPath, name: "Main Session" });
      sid = session.id;
      post({ type: "input_session", session_id: sid });
    }
    if (message.type === "retry_turn") {
      await rpc.call("agent.retry", {
        session_id: sid, strip_images: message.stripImages === true,
        model: message.model, provider: message.provider, reasoning_effort: message.reasoningEffort,
      });
      post({ type: "retry_result", session_id: sid, success: true });
      recordFeatureUse(message.stripImages === true ? "turn_retried_no_image" : "turn_retried", { client: rpc, sessionId: sid });
    } else if (message.type === "submit_input") {
      const prompt = EditorBridge.formatPromptWithEditorState(
        message.prompt || "", EditorBridge.getActiveContext(), message.attachContext !== false);
      const result = await rpc.call<{ queue: InputQueueState; input_id: string }>("agent.submit", {
        session_id: sid, request_id: message.requestId, delivery: message.delivery || "queue",
        prompt, image_uris: message.images || [], image_only: message.imageOnly === true, project_path: projectPath,
        profile: message.profile, model: message.model, provider: message.provider,
        mode: clampPromptMode(message.mode, approvedMode), reasoning_effort: message.reasoningEffort,
      });
      post({ type: "input_accepted", request_id: message.requestId, session_id: sid, input_id: result.input_id });
      const usage = { client: rpc, sessionId: sid, oncePerSession: true };
      if ((message.images || []).length) recordFeatureUse("image_attached", usage);
      if (message.delivery === "steer") recordFeatureUse("prompt_steered", usage);
      const slash = SLASH_COMMAND.exec((message.prompt || "").trim());
      if (slash) recordFeatureUse("slash_" + slash[1], usage);
      post({ type: "queue_state", ...result.queue, supported: true });
    } else {
      const result = await rpc.call<InputQueueState>(methods[message.type], {
        session_id: sid, input_id: message.inputId,
      });
      if (message.type !== "queue_snapshot") recordFeatureUse(message.type, { client: rpc, sessionId: sid, oncePerSession: true });
      post({ type: "queue_state", ...result, supported: true });
    }
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    if (message.type === "retry_turn") {
      const known = ["Wait for the current turn", "This request is no longer available", "This message only contains an image"];
      post({ type: "retry_result", session_id: sid, success: false,
        error: known.some(prefix => text.includes(prefix)) ? text.slice(text.indexOf(known.find(prefix => text.includes(prefix))!))
          : "Retry could not start. Reconnect and try again." });
    } else if (message.type === "queue_snapshot") {
      post({ type: "queue_unavailable", session_id: sid, unsupported: text.includes("not found") || text.includes("-32601") });
    } else {
      post({ type: "input_rejected", session_id: sid, request_id: message.requestId,
        error: text.includes("Queue is full") ? "Queue is full (max 10). Remove a message or wait for delivery."
          : text.includes(SCHEDULED_RUN_BUSY) ? SCHEDULED_RUN_BUSY_TEXT
          : "Message was not confirmed. Your draft is preserved; reconnect and retry." });
    }
  }
  return true;
}
