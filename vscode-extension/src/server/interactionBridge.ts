import { RpcClient } from "./RpcClient.js";
import { InteractionMessage, SessionWebviewEvent } from "./types.js";

export function reportDisconnectedAction(
  message: { type: string; requestId?: string }, sessionId: string,
  post: (event: SessionWebviewEvent) => void,
): void {
  const error = "The daemon is disconnected. Reconnect and try again.";
  if (["approve_tool", "reject_tool", "answer_question", "ask_question_response"].includes(message.type)) {
    post({ type: "interaction_failed", session_id: sessionId, error });
  } else if (message.type === "submit_input") {
    post({ type: "input_rejected", session_id: sessionId, request_id: message.requestId, error });
  } else if (message.type === "retry_turn") {
    post({ type: "retry_result", session_id: sessionId, success: false, error });
  } else {
    post({ type: "action_failed", session_id: sessionId, error });
  }
}

export async function handleInteractionMessage(
  rpc: RpcClient, message: InteractionMessage, sessionId: string,
  post: (event: SessionWebviewEvent) => void,
): Promise<boolean> {
  const question = message.type === "answer_question" || message.type === "ask_question_response";
  if (!question && message.type !== "approve_tool" && message.type !== "reject_tool") return false;
  const identity = question ? message.questionId : message.approvalId;
  try {
    const result = await rpc.call<{ success: boolean; error?: string }>(question ? "agent.answer_question" : "agent.approve_tool", {
      session_id: sessionId, ...(question ? { question_id: identity, answers: message.answers }
        : { approval_id: identity, approved: message.type === "approve_tool", scope: message.scope || "once" }),
    });
    if (!result.success && result.error === "Workspace is untrusted") {
      post({ type: "interaction_failed", session_id: sessionId,
        error: "This workspace is untrusted. Enable workspace trust before approving tools." });
      return true;
    }
    post({ type: "interaction_resolved", session_id: sessionId, interaction_id: identity });
    if (!result.success) post({ type: "interaction_failed", session_id: sessionId,
      error: "This request is no longer pending. Refresh the session if needed." });
  } catch {
    post({ type: "interaction_failed", session_id: sessionId,
      error: "Could not confirm your response. Reconnect and try again." });
  }
  return true;
}
