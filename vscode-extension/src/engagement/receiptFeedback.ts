/** When to ask whether a receipt was useful. Pure state transitions so the rules are testable
 *  without VS Code; ReceiptPanel keeps the state in globalState and shows the strip. */

import { MAX_FEEDBACK_LENGTH } from "./feedbackSubmit.js";

export type ReceiptRating = "up" | "down";

export interface ReceiptFeedbackState {
  status: "active" | "never";
  /** Receipts opened, counted whether or not anything was asked. */
  opens: number;
  /** Times the question was shown since the last answer. */
  asks: number;
  answers: number;
  lastAnswerAtOpen: number;
}

export const RECEIPT_FEEDBACK_KEY = "andromity.receiptFeedback";
export const RECEIPT_FEEDBACK_RULES = {
  /** Stop asking someone who has seen the question this many times without answering, until their next answer cycle. */
  maxAsksPerAnswer: 5,
  maxAnswers: 3,
  /** Receipts opened between an answer and the next time the question is shown. */
  reaskAfterOpens: 10,
};
const COUNT_LIMIT = 1_000_000;

const RATING_MESSAGE: Record<ReceiptRating, string> = { up: "[receipt up]", down: "[receipt down]" };
const NOTE_PREFIX: Record<ReceiptRating, string> = { up: "[receipt note up] ", down: "[receipt note down] " };
/** The longest prefix a note carries, so a page can limit the box to what will be accepted. */
export const RECEIPT_NOTE_PREFIX_MAX = NOTE_PREFIX.down.length;

export function initialReceiptFeedbackState(): ReceiptFeedbackState {
  return { status: "active", opens: 0, asks: 0, answers: 0, lastAnswerAtOpen: 0 };
}

/** Fills gaps in stored state so a partial, older or tampered shape never throws. */
export function normalizeReceiptFeedbackState(raw: unknown): ReceiptFeedbackState {
  const base = initialReceiptFeedbackState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const value = raw as Partial<Record<keyof ReceiptFeedbackState, unknown>>;
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), COUNT_LIMIT) : 0);
  const opens = count(value.opens);
  return {
    status: value.status === "never" ? "never" : "active",
    opens,
    asks: count(value.asks),
    answers: count(value.answers),
    lastAnswerAtOpen: Math.min(count(value.lastAnswerAtOpen), opens),
  };
}

export function afterReceiptOpened(state: ReceiptFeedbackState): ReceiptFeedbackState {
  return { ...state, opens: Math.min(state.opens + 1, COUNT_LIMIT) };
}

export function shouldAskReceiptFeedback(state: ReceiptFeedbackState): boolean {
  if (state.status !== "active" || state.answers >= RECEIPT_FEEDBACK_RULES.maxAnswers) return false;
  if (state.asks >= RECEIPT_FEEDBACK_RULES.maxAsksPerAnswer) return false;
  return state.answers === 0 || state.opens - state.lastAnswerAtOpen >= RECEIPT_FEEDBACK_RULES.reaskAfterOpens;
}

export function afterReceiptAsked(state: ReceiptFeedbackState): ReceiptFeedbackState {
  return { ...state, asks: Math.min(state.asks + 1, COUNT_LIMIT) };
}

export function afterReceiptAnswered(state: ReceiptFeedbackState): ReceiptFeedbackState {
  return { ...state, answers: Math.min(state.answers + 1, COUNT_LIMIT), asks: 0, lastAnswerAtOpen: state.opens };
}

export function afterReceiptNever(state: ReceiptFeedbackState): ReceiptFeedbackState {
  return { ...state, status: "never" };
}

export function isReceiptRating(value: unknown): value is ReceiptRating {
  return value === "up" || value === "down";
}

/** The anonymous answer itself. Like the in-chat check-in it is stored apart from the telemetry ID. */
export function receiptRatingMessage(rating: ReceiptRating): string {
  return RATING_MESSAGE[rating];
}

export function receiptNoteMessage(rating: ReceiptRating, text: string): string {
  return NOTE_PREFIX[rating] + text.trim();
}

/** Returns an error for the note box, or null when the note can be sent. */
export function validateReceiptNote(rating: ReceiptRating, text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return "Write a note first.";
  const length = receiptNoteMessage(rating, text).length;
  if (length > MAX_FEEDBACK_LENGTH) return `Please keep it shorter (now ${length} of ${MAX_FEEDBACK_LENGTH} characters).`;
  return null;
}
