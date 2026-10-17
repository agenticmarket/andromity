/** When to ask a regular user for a rating or to share Andromity. Pure state
 *  transitions so the rules are testable without VS Code; extension.ts keeps the
 *  state in globalState and shows the notifications. Usage is measured in
 *  distinct days with a finished turn, so someone who comes back after a break
 *  is not asked the moment they return. */

import { SITE_BASE } from "../docsLinks.js";

export type EngagementPrompt = "feedback" | "share";
export type PromptResponse = "accepted" | "later" | "never";

interface PromptState {
  status: "pending" | "done" | "never";
  asks: number;
  /** Not asked again before the user has this many active days. */
  nextAtActiveDay: number;
}

export interface EngagementState {
  activeDays: number;
  lastActiveDay: string;
  completedTurns: number;
  lastPromptDay: string;
  feedback: PromptState;
  share: PromptState;
}

export const PROMPT_RULES: Record<EngagementPrompt, { minActiveDays: number; minTurns: number; maxAsks: number }> = {
  feedback: { minActiveDays: 3, minTurns: 15, maxAsks: 3 },
  share: { minActiveDays: 7, minTurns: 40, maxAsks: 2 },
};
/** Active days between a dismissed ask and the next one. */
export const SNOOZE_ACTIVE_DAYS = 4;

const EXTENSION_ID = "agenticmarket.andromity-agent";
export const MARKETPLACE_REVIEW_URL = `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}&ssr=false#review-details`;
export const OPEN_VSX_REVIEW_URL = "https://open-vsx.org/extension/agenticmarket/andromity-agent/reviews";
export const FEEDBACK_ISSUE_URL = "https://github.com/agenticmarket/andromity/issues/new";
export const SHARE_URL = SITE_BASE;
export const SHARE_TEXT = "Andromity: an open-source AI coding agent for VS Code that shows exactly what it did";

export function initialEngagementState(): EngagementState {
  const pending = (): PromptState => ({ status: "pending", asks: 0, nextAtActiveDay: 0 });
  return { activeDays: 0, lastActiveDay: "", completedTurns: 0, lastPromptDay: "", feedback: pending(), share: pending() };
}

/** Fills gaps in stored state so a partial or older shape never throws. */
export function normalizeEngagementState(raw: unknown): EngagementState {
  const base = initialEngagementState();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<EngagementState>;
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  const str = (s: unknown) => (typeof s === "string" ? s : "");
  const prompt = (p: unknown): PromptState => {
    const v = (p && typeof p === "object" ? p : {}) as Partial<PromptState>;
    const status = v.status === "done" || v.status === "never" ? v.status : "pending";
    return { status, asks: num(v.asks), nextAtActiveDay: num(v.nextAtActiveDay) };
  };
  return {
    activeDays: num(value.activeDays),
    lastActiveDay: str(value.lastActiveDay),
    completedTurns: num(value.completedTurns),
    lastPromptDay: str(value.lastPromptDay),
    feedback: prompt(value.feedback),
    share: prompt(value.share),
  };
}

/** Local calendar day, YYYY-MM-DD. */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function recordCompletedTurn(state: EngagementState, today: string): EngagementState {
  const newDay = state.lastActiveDay !== today;
  return {
    ...state,
    completedTurns: state.completedTurns + 1,
    activeDays: newDay ? state.activeDays + 1 : state.activeDays,
    lastActiveDay: today,
  };
}

function eligible(state: EngagementState, prompt: EngagementPrompt): boolean {
  const rules = PROMPT_RULES[prompt];
  const p = state[prompt];
  return p.status === "pending"
    && p.asks < rules.maxAsks
    && state.activeDays >= Math.max(rules.minActiveDays, p.nextAtActiveDay)
    && state.completedTurns >= rules.minTurns;
}

/** At most one ask per day; the rating ask comes before the share ask. */
export function duePrompt(state: EngagementState, today: string): EngagementPrompt | null {
  if (state.lastPromptDay === today) return null;
  if (eligible(state, "feedback")) return "feedback";
  if (eligible(state, "share")) return "share";
  return null;
}

/** Recorded before the notification is shown, so closing it without a choice counts as "later". */
export function markPromptShown(state: EngagementState, prompt: EngagementPrompt, today: string): EngagementState {
  const p = state[prompt];
  return {
    ...state,
    lastPromptDay: today,
    [prompt]: { ...p, asks: p.asks + 1, nextAtActiveDay: state.activeDays + SNOOZE_ACTIVE_DAYS },
  };
}

export function applyPromptResponse(state: EngagementState, prompt: EngagementPrompt, response: PromptResponse): EngagementState {
  if (response === "later") return state;
  return { ...state, [prompt]: { ...state[prompt], status: response === "accepted" ? "done" : "never" } };
}

/** VS Code's own builds read reviews from the Visual Studio Marketplace; forks
 *  (Cursor, Windsurf, VSCodium, ...) install from Open VSX. */
export function reviewUrlFor(uriScheme: string): string {
  return /^vscode(-insiders|-exploration)?$/.test(uriScheme) ? MARKETPLACE_REVIEW_URL : OPEN_VSX_REVIEW_URL;
}

export function shareTargets(): { x: string; linkedin: string } {
  const url = encodeURIComponent(SHARE_URL);
  return {
    x: `https://x.com/intent/post?text=${encodeURIComponent(SHARE_TEXT)}&url=${url}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
  };
}
