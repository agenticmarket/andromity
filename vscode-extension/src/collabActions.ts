interface RpcCaller {
  call(method: string, params?: any): Promise<any>;
}

/** Ask a session to answer another session's pending question now. Returns a message for the user when that is not possible. */
export async function wakeSessionForQuestion(rpc: RpcCaller | null, sessionId: string, questionId: string): Promise<string | null> {
  if (!rpc) return "Andromity is still starting. Try again in a moment.";
  try {
    const result = await rpc.call("session.wakeForQuestion", { session_id: sessionId, question_id: questionId });
    if (result && result.success === false) return "This question was already answered or has expired.";
    return null;
  } catch (err) {
    console.error("[Collab] Could not wake session for question:", err);
    return "Andromity couldn't start an answer for this question. Try again, or reply in the chat yourself.";
  }
}
