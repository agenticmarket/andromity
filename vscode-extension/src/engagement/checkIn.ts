import { MAX_FEEDBACK_LENGTH } from "./feedbackSubmit.js";

/** The in-chat check-in: how Andromity feels to use, then what gets in the way. */

export const SENTIMENTS = ["love", "ok", "bad"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/** Ids must match ANNOYANCES in telemetry-worker/feedback.js, which refuses anything else. */
export const ANNOYANCES = [
  { id: "slow", label: "Slow responses" },
  { id: "wrong_edits", label: "Wrong or broken edits" },
  { id: "too_many_prompts", label: "Too many approval prompts" },
  { id: "errors_limits", label: "Errors or limits" },
  { id: "hard_to_use", label: "Hard to understand" },
  { id: "missing_feature", label: "Missing a feature" },
] as const;

export interface CheckInAnswer {
  sentiment: Sentiment;
  annoyances: string[];
  message: string;
}

/** Validates what the chat page sends. The page renders model output, so nothing in it is trusted. */
export function cleanCheckIn(input: unknown): { answer: CheckInAnswer } | { error: string } {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const sentiment = value.sentiment;
  if (typeof sentiment !== "string" || !(SENTIMENTS as readonly string[]).includes(sentiment)) {
    return { error: "Choose how Andromity is working for you first." };
  }
  const picked = Array.isArray(value.annoyances) ? value.annoyances : [];
  const known = ANNOYANCES.map((a) => a.id as string);
  const annoyances = known.filter((id) => picked.includes(id));
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (message.length > MAX_FEEDBACK_LENGTH) {
    return { error: `Please keep it under ${MAX_FEEDBACK_LENGTH} characters (now ${message.length}).` };
  }
  return { answer: { sentiment: sentiment as Sentiment, annoyances, message } };
}
