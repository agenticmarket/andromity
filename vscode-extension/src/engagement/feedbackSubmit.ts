/** Sends a note the user typed into the feedback box. Only the note, the client,
 *  OS family and extension version are sent: no telemetry ID, session or workspace data. */

export const FEEDBACK_ENDPOINT = "https://telemetry.agenticmarket.dev/feedback";
export const MAX_FEEDBACK_LENGTH = 2000;
const TIMEOUT_MS = 10_000;

export interface FeedbackPayload {
  message: string;
  client: "vscode";
  os: "windows" | "darwin" | "linux" | "unknown";
  version: string;
  /** Set by the in-chat check-in; a plain note leaves these out. */
  sentiment?: "love" | "ok" | "bad";
  annoyances?: string[];
}

export function osFamily(platform: string): FeedbackPayload["os"] {
  if (platform === "win32") return "windows";
  if (platform === "darwin" || platform === "linux") return platform;
  return "unknown";
}

/** Returns an error for the input box, or null when the note can be sent. */
export function validateFeedback(message: string): string | null {
  const length = message.trim().length;
  if (length > MAX_FEEDBACK_LENGTH) return `Please keep it under ${MAX_FEEDBACK_LENGTH} characters (now ${length}).`;
  return null;
}

export function feedbackPayload(message: string, version: string, platform: string): FeedbackPayload {
  return { message: message.trim(), client: "vscode", os: osFamily(platform), version };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean }>;

export async function submitFeedback(payload: FeedbackPayload, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
