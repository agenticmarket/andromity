import { recordFeatureUse } from "./telemetry/featureUsage.js";

const NEXT_STEP_EVENTS = new Set(["shown", "run", "new_session", "tab", "dismissed"]);

/** Counts which suggested-next-step action was used; never the suggestion's text. */
export function recordNextStepEvent(event: unknown, sessionId?: string): void {
  if (typeof event === "string" && NEXT_STEP_EVENTS.has(event)) {
    recordFeatureUse("next_step_" + event, { sessionId });
  }
}
