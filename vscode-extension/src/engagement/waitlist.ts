import { osFamily } from "./feedbackSubmit.js";

/** The waitlist form: what someone would want and where they heard about Andromity. Only the answers,
 *  the client, OS family and extension version are sent: no email, telemetry ID, session or workspace data. */

export const WAITLIST_ENDPOINT = "https://telemetry.agenticmarket.dev/waitlist";
export const MAX_WANTS_NOTE = 300;
export const MAX_HEARD_NOTE = 200;
const TIMEOUT_MS = 10_000;

/** Ids must match WANTS and HEARD_FROM in telemetry-worker/waitlist.js, which refuses anything else. */
export const WAITLIST_WANTS = [
  { id: "higher_limit", label: "Higher daily limit" },
  { id: "stronger_models", label: "Stronger models" },
  { id: "faster", label: "Faster responses" },
  { id: "team_features", label: "Team features" },
  { id: "other", label: "Something else" },
] as const;

export const WAITLIST_HEARD_FROM = [
  { id: "marketplace", label: "VS Code Marketplace" },
  { id: "search", label: "Search engine" },
  { id: "friend", label: "Friend or colleague" },
  { id: "reddit", label: "Reddit" },
  { id: "x", label: "X / Twitter" },
  { id: "youtube", label: "YouTube" },
  { id: "blog", label: "Blog or article" },
  { id: "other", label: "Other" },
] as const;

export interface WaitlistAnswer {
  wants: string[];
  wantsNote: string;
  heardFrom: string;
  heardNote: string;
}

export interface WaitlistPayload {
  wants: string[];
  wants_note?: string;
  heard_from: string;
  heard_note?: string;
  client: "vscode";
  os: ReturnType<typeof osFamily>;
  version: string;
}

export type WaitlistSubmitResult = "joined" | "unavailable" | "failed";

function noteOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

/** Validates what the chat page sends. The page renders model output, so nothing in it is trusted. */
export function cleanWaitlistAnswer(input: unknown): { answer: WaitlistAnswer } | { error: string } {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const picked: unknown[] = Array.isArray(value.wants) ? value.wants : [];
  const wants = WAITLIST_WANTS.map((choice) => choice.id as string).filter((id) => picked.includes(id));
  if (!wants.length) return { error: "Pick at least one thing you'd want." };
  const heard = WAITLIST_HEARD_FROM.find((choice) => choice.id === value.heard_from);
  if (!heard) return { error: "Pick where you heard about Andromity." };
  const wantsNote = noteOf(value.wants_note);
  if (wantsNote.length > MAX_WANTS_NOTE) {
    return { error: `Please keep what you'd want under ${MAX_WANTS_NOTE} characters (now ${wantsNote.length}).` };
  }
  const heardNote = noteOf(value.heard_note);
  if (heardNote.length > MAX_HEARD_NOTE) {
    return { error: `Please keep where you heard about Andromity under ${MAX_HEARD_NOTE} characters (now ${heardNote.length}).` };
  }
  return { answer: { wants, wantsNote, heardFrom: heard.id, heardNote } };
}

export function waitlistPayload(answer: WaitlistAnswer, version: string, platform: string): WaitlistPayload {
  return {
    wants: answer.wants,
    ...(answer.wantsNote ? { wants_note: answer.wantsNote } : {}),
    heard_from: answer.heardFrom,
    ...(answer.heardNote ? { heard_note: answer.heardNote } : {}),
    client: "vscode",
    os: osFamily(platform),
    version,
  };
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export async function submitWaitlist(payload: WaitlistPayload, fetchImpl: FetchLike = fetch): Promise<WaitlistSubmitResult> {
  try {
    const response = await fetchImpl(WAITLIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return "joined";
    return response.status === 503 ? "unavailable" : "failed";
  } catch {
    return "failed";
  }
}
