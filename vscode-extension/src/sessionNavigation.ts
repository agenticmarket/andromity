/** Reply to the chat's back/forward buttons: whether the session can be opened. */
export interface SessionNavResult {
  type: "session_nav_result";
  sessionId: string;
  status: "ok" | "missing" | "error";
}

interface SessionLister {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * Checks a session from the chat's history before switching to it. Loading an unknown id
 * would create a new empty session with that id, so a deleted session must be caught here.
 */
export async function checkSessionForNavigation(
  rpc: SessionLister | null | undefined,
  sessionId: unknown,
  projectPath: string | undefined,
): Promise<SessionNavResult> {
  const id = typeof sessionId === "string" ? sessionId : "";
  if (!id || !rpc) return { type: "session_nav_result", sessionId: id, status: "error" };
  try {
    const sessions = await rpc.call<Array<{ id?: string }>>("session.list", { project_path: projectPath, include_subagents: true });
    const found = Array.isArray(sessions) && sessions.some((session) => session?.id === id);
    return { type: "session_nav_result", sessionId: id, status: found ? "ok" : "missing" };
  } catch {
    return { type: "session_nav_result", sessionId: id, status: "error" };
  }
}
