import * as vscode from "vscode";
import { airGapOffMessage } from "../airgap.js";
import { currentAirGap } from "../airgapState.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import { FEEDBACK_ISSUE_URL } from "./feedbackPrompt.js";
import { feedbackPayload, submitFeedback, validateFeedback } from "./feedbackSubmit.js";

export interface FeedbackResult {
  type: "feedback_result";
  ok: boolean;
  error?: string;
  /** The note could not be delivered, so the form offers a GitHub issue instead. */
  canOpenIssue?: boolean;
}

/** Handles the chat's feedback form messages. Returns the reply for the form, or null for other messages. */
export async function handleFeedbackMessage(
  message: { type?: string; message?: unknown },
  context: vscode.ExtensionContext | undefined,
  submit: typeof submitFeedback = submitFeedback,
): Promise<FeedbackResult | null> {
  if (message.type === "feedback_issue") {
    if (typeof message.message === "string" && message.message.trim()) {
      await vscode.env.clipboard.writeText(message.message.trim());
    }
    recordFeatureUse("feedback_issue_clicked");
    await vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_ISSUE_URL));
    return null;
  }
  if (message.type !== "submit_feedback") return null;

  const text = typeof message.message === "string" ? message.message : "";
  if (currentAirGap().enabled) return { type: "feedback_result", ok: false, error: airGapOffMessage("sending feedback") };
  if (!text.trim()) return { type: "feedback_result", ok: false, error: "Write a note first." };
  const invalid = validateFeedback(text);
  if (invalid) return { type: "feedback_result", ok: false, error: invalid };

  const version = String(context?.extension.packageJSON.version || "");
  if (await submit(feedbackPayload(text, version, process.platform))) {
    recordFeatureUse("feedback_sent");
    return { type: "feedback_result", ok: true };
  }
  return {
    type: "feedback_result",
    ok: false,
    error: "Your feedback couldn't be sent right now. You can post it as a GitHub issue instead.",
    canOpenIssue: true,
  };
}
