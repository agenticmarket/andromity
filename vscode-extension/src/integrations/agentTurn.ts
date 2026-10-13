import { RpcClient } from "../server/RpcClient.js";
import { ClarifyingQuestionsEvent, SessionInfo, ToolApprovalEvent } from "../server/types.js";

export interface AgentTurnOptions {
  prompt: string;
  projectPath?: string;
  /** Existing session to continue; a new one is created when absent. */
  sessionId?: string;
  sessionName: string;
  model?: string;
  provider?: string;
  mode: string;
  profile?: string;
  reasoningEffort?: string;
}

export interface AgentTurnCallbacks {
  onSession?(sessionId: string): void;
  onText?(text: string): void;
  onToolStart?(toolName: string, toolId: string): void;
  onToolResult?(toolId: string, success: boolean): void;
  onApproval?(event: ToolApprovalEvent): void;
  onQuestions?(event: ClarifyingQuestionsEvent): void;
}

export interface AgentTurnResult {
  sessionId: string;
  outcome: "done" | "error" | "cancelled";
  text: string;
  error?: string;
  /** Files the turn changed, as reported by agent/done. */
  turnFiles?: string[];
}

const CANCEL_GRACE_MS = 5000;

/** Minimal cancellation shape shared by vscode.CancellationToken. */
export interface TurnCancellation {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** Run one agent turn over the daemon's event stream, outside any webview.
 *  agent.prompt only starts the turn; it ends with agent/done, agent/error or
 *  agent/cancelled for the session. */
export async function runAgentTurn(
  rpc: RpcClient,
  options: AgentTurnOptions,
  callbacks: AgentTurnCallbacks,
  cancellation?: TurnCancellation
): Promise<AgentTurnResult> {
  let sessionId = options.sessionId;
  if (!sessionId) {
    const session = await rpc.call<SessionInfo>("session.create", {
      name: options.sessionName,
      project_path: options.projectPath,
    });
    sessionId = session.id;
  }
  const sid = sessionId;
  callbacks.onSession?.(sid);

  let text = "";
  const listeners: Array<[string, (params: any) => void]> = [];
  const listen = (event: string, handler: (params: any) => void) => {
    const filtered = (params: any) => {
      if (params?.session_id === sid) handler(params);
    };
    rpc.on(event, filtered);
    listeners.push([event, filtered]);
  };

  let settle: (result: AgentTurnResult) => void = () => {};
  const finished = new Promise<AgentTurnResult>((resolve) => {
    settle = resolve;
    listen("agent/textDelta", (p) => {
      const chunk = typeof p.text === "string" ? p.text : "";
      text += chunk;
      if (chunk) callbacks.onText?.(chunk);
    });
    listen("agent/toolStart", (p) => callbacks.onToolStart?.(String(p.tool_name || "tool"), String(p.tool_id || "")));
    listen("agent/toolResult", (p) => callbacks.onToolResult?.(String(p.tool_id || ""), p.success !== false));
    listen("agent/toolApprovalRequired", (p) => callbacks.onApproval?.(p));
    listen("agent/askQuestions", (p) => callbacks.onQuestions?.(p));
    listen("agent/done", (p) => resolve({
      sessionId: sid,
      outcome: "done",
      text,
      turnFiles: Array.isArray(p.turn_files) ? p.turn_files.filter((f: unknown) => typeof f === "string") : [],
    }));
    listen("agent/cancelled", () => resolve({ sessionId: sid, outcome: "cancelled", text }));
    listen("agent/error", (p) => resolve({ sessionId: sid, outcome: "error", text, error: String(p.error || "The run failed.") }));
  });

  // If the daemon never confirms (e.g. it disconnected), end the turn anyway.
  let cancelTimer: NodeJS.Timeout | undefined;
  const requestCancel = () => {
    void rpc.call("agent.cancel", { session_id: sid }).catch(() => undefined);
    cancelTimer ??= setTimeout(() => settle({ sessionId: sid, outcome: "cancelled", text }), CANCEL_GRACE_MS);
  };
  const cancelSubscription = cancellation?.onCancellationRequested(requestCancel);

  try {
    await rpc.call("agent.prompt", {
      session_id: sid,
      prompt: options.prompt,
      project_path: options.projectPath,
      model: options.model,
      provider: options.provider,
      mode: options.mode,
      profile: options.profile,
      reasoning_effort: options.reasoningEffort,
    });
    if (cancellation?.isCancellationRequested) requestCancel();
    return await finished;
  } finally {
    cancelSubscription?.dispose();
    if (cancelTimer) clearTimeout(cancelTimer);
    for (const [event, handler] of listeners) rpc.off(event, handler);
  }
}
