import { it } from "node:test";
import assert from "node:assert/strict";
import {
  EngagementState,
  MARKETPLACE_REVIEW_URL,
  OPEN_VSX_REVIEW_URL,
  PROMPT_RULES,
  SNOOZE_ACTIVE_DAYS,
  applyPromptResponse,
  duePrompt,
  initialEngagementState,
  localDay,
  markPromptShown,
  normalizeEngagementState,
  recordCompletedTurn,
  reviewUrlFor,
  shareTargets,
} from "../src/engagement/feedbackPrompt.js";

function day(n: number): string {
  return localDay(new Date(2026, 0, 1 + n));
}

/** `turnsPerDay` finished turns on each of `days` consecutive days starting at `start`. */
function use(state: EngagementState, start: number, days: number, turnsPerDay: number): EngagementState {
  for (let d = start; d < start + days; d++) {
    for (let t = 0; t < turnsPerDay; t++) state = recordCompletedTurn(state, day(d));
  }
  return state;
}

it("counts distinct active days, not turns, toward regular use", () => {
  const state = use(initialEngagementState(), 0, 1, 50);
  assert.equal(state.activeDays, 1);
  assert.equal(state.completedTurns, 50);
  assert.equal(duePrompt(state, day(0)), null, "a single heavy day is not regular use");
});

it("asks a regular user for feedback once their usage clears both thresholds", () => {
  const { minActiveDays } = PROMPT_RULES.feedback;
  let state = use(initialEngagementState(), 0, minActiveDays - 1, 10);
  assert.equal(duePrompt(state, day(minActiveDays - 2)), null);
  state = use(state, minActiveDays - 1, 1, 1);
  assert.equal(duePrompt(state, day(minActiveDays - 1)), "feedback");

  const light = use(initialEngagementState(), 0, minActiveDays, 1);
  assert.equal(duePrompt(light, day(minActiveDays - 1)), null, "a few turns spread over days is not enough");
});

it("asks at most once a day and snoozes by active days after 'later'", () => {
  let state = use(initialEngagementState(), 0, 3, 10);
  const today = day(2);
  state = markPromptShown(state, "feedback", today);
  state = applyPromptResponse(state, "feedback", "later");
  assert.equal(duePrompt(state, today), null);

  state = use(state, 3, SNOOZE_ACTIVE_DAYS - 1, 5);
  assert.equal(duePrompt(state, day(3 + SNOOZE_ACTIVE_DAYS - 2)), null, "still snoozed");
  state = use(state, 3 + SNOOZE_ACTIVE_DAYS - 1, 1, 1);
  assert.equal(duePrompt(state, day(3 + SNOOZE_ACTIVE_DAYS - 1)), "feedback");
});

it("stops after the maximum number of asks", () => {
  let state = use(initialEngagementState(), 0, 3, 10);
  let d = 3;
  for (let ask = 0; ask < PROMPT_RULES.feedback.maxAsks; ask++) {
    assert.equal(duePrompt(state, day(d - 1)), "feedback", `ask ${ask + 1}`);
    state = markPromptShown(state, "feedback", day(d - 1));
    state = use(state, d, SNOOZE_ACTIVE_DAYS, 2);
    d += SNOOZE_ACTIVE_DAYS;
  }
  assert.equal(state.feedback.asks, PROMPT_RULES.feedback.maxAsks);
  assert.notEqual(duePrompt(state, day(d)), "feedback");
});

it("never asks again after 'don't ask again' and moves on to sharing once the user has rated", () => {
  let state = use(initialEngagementState(), 0, 3, 10);
  state = markPromptShown(state, "feedback", day(2));
  const declined = applyPromptResponse(state, "feedback", "never");
  const rated = applyPromptResponse(state, "feedback", "accepted");

  const later = (s: EngagementState) => use(s, 3, 10, 5);
  assert.notEqual(duePrompt(later(declined), day(30)), "feedback");
  assert.equal(duePrompt(later(rated), day(30)), "share");

  const shared = applyPromptResponse(markPromptShown(later(rated), "share", day(30)), "share", "accepted");
  assert.equal(duePrompt(use(shared, 31, 20, 5), day(60)), null);
});

it("does not ask to share before the user is well established", () => {
  let state = use(initialEngagementState(), 0, PROMPT_RULES.share.minActiveDays - 1, 10);
  state = applyPromptResponse(state, "feedback", "never");
  assert.equal(duePrompt(state, day(30)), null);
});

it("recovers from missing or malformed stored state", () => {
  assert.deepEqual(normalizeEngagementState(undefined), initialEngagementState());
  assert.deepEqual(normalizeEngagementState("garbage"), initialEngagementState());
  const partial = normalizeEngagementState({ activeDays: 4, completedTurns: -3, feedback: { status: "never", asks: "x" } });
  assert.equal(partial.activeDays, 4);
  assert.equal(partial.completedTurns, 0);
  assert.deepEqual(partial.feedback, { status: "never", asks: 0, nextAtActiveDay: 0 });
  assert.equal(partial.share.status, "pending");
});

it("sends VS Code users to the Marketplace and editor forks to Open VSX", () => {
  assert.equal(reviewUrlFor("vscode"), MARKETPLACE_REVIEW_URL);
  assert.equal(reviewUrlFor("vscode-insiders"), MARKETPLACE_REVIEW_URL);
  assert.equal(reviewUrlFor("cursor"), OPEN_VSX_REVIEW_URL);
  assert.equal(reviewUrlFor("windsurf"), OPEN_VSX_REVIEW_URL);
  assert.equal(reviewUrlFor("vscodium"), OPEN_VSX_REVIEW_URL);
});

it("share links carry only the public site and product blurb", () => {
  const { x, linkedin } = shareTargets();
  assert.equal(new URL(x).searchParams.get("url"), "https://andromity.agenticmarket.dev");
  assert.ok(new URL(x).searchParams.get("text")?.startsWith("Andromity"));
  assert.deepEqual([...new URL(linkedin).searchParams.keys()], ["url"]);
});
