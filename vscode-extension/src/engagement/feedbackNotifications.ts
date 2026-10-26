import * as vscode from "vscode";
import { airGapOffMessage } from "../airgap.js";
import { currentAirGap } from "../airgapState.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import {
  EngagementPrompt,
  EngagementState,
  FEEDBACK_ISSUE_URL,
  PromptResponse,
  SHARE_TEXT,
  SHARE_URL,
  applyPromptResponse,
  duePrompt,
  localDay,
  markPromptShown,
  normalizeEngagementState,
  recordCompletedTurn,
  reviewUrlFor,
  shareTargets,
} from "./feedbackPrompt.js";
import { MAX_FEEDBACK_LENGTH, feedbackPayload, submitFeedback, validateFeedback } from "./feedbackSubmit.js";
import { cleanCheckIn } from "./checkIn.js";

const STATE_KEY = "andromity.engagement";

export interface TurnOutcome {
  outcome?: unknown;
  scheduled?: unknown;
}

export interface CheckInReply {
  type: "checkin_result";
  ok: boolean;
  error?: string;
}

export class FeedbackNotifications {
  private _showing = false;
  /** Shows the check-in card in the chat; false when the chat isn't on screen. */
  private _presentCheckIn: (() => boolean) | null = null;

  constructor(private readonly _context: vscode.ExtensionContext) {
    // A "Don't ask again" on one machine holds on every machine with Settings Sync.
    _context.globalState.setKeysForSync([STATE_KEY]);
  }

  private _read(): EngagementState {
    return normalizeEngagementState(this._context.globalState.get(STATE_KEY));
  }

  private async _write(state: EngagementState): Promise<void> {
    await this._context.globalState.update(STATE_KEY, state);
  }

  setCheckInPresenter(present: () => boolean): void {
    this._presentCheckIn = present;
  }

  /** Counts every finished turn, but asks only after one that went well and that someone watched. */
  async onTurnCompleted(done: TurnOutcome = {}): Promise<void> {
    const today = localDay(new Date());
    let state = recordCompletedTurn(this._read(), today);
    const wentWell = (done.outcome === undefined || done.outcome === "success") && done.scheduled !== true;
    let prompt = this._showing || !wentWell ? null : duePrompt(state, today);
    if (prompt === "feedback" && this._presentCheckIn) {
      // In the chat or not at all: a toast is easy to miss and arrives out of context.
      const shown = !currentAirGap().enabled && this._presentCheckIn();
      if (shown) {
        state = markPromptShown(state, prompt, today);
        recordFeatureUse("feedback_checkin_shown");
      }
      await this._write(state);
      return;
    }
    if (prompt) state = markPromptShown(state, prompt, today);
    await this._write(state);
    if (!prompt) return;
    this._showing = true;
    try {
      recordFeatureUse(`${prompt}_prompt_shown`);
      const response = prompt === "feedback" ? await this._askForFeedback() : await this._askToShare();
      if (response !== "accepted") recordFeatureUse(`${prompt}_prompt_${response}`);
      await this._write(applyPromptResponse(this._read(), prompt, response));
    } finally {
      this._showing = false;
    }
  }

  /** Sends a check-in answer. The sentiment is not added to usage telemetry, so it stays unlinked. */
  async sendCheckIn(input: unknown, submit: typeof submitFeedback = submitFeedback): Promise<CheckInReply> {
    const cleaned = cleanCheckIn(input);
    if ("error" in cleaned) return { type: "checkin_result", ok: false, error: cleaned.error };
    if (currentAirGap().enabled) return { type: "checkin_result", ok: false, error: airGapOffMessage("sending feedback") };
    const { sentiment, annoyances, message } = cleaned.answer;
    const payload = {
      ...feedbackPayload(message, String(this._context.extension.packageJSON.version || ""), process.platform),
      sentiment,
      annoyances,
    };
    if (!(await submit(payload))) {
      return { type: "checkin_result", ok: false, error: "Your answer couldn't be sent right now. Try again in a moment." };
    }
    recordFeatureUse("feedback_checkin_sent");
    await this._write(applyPromptResponse(this._read(), "feedback", "accepted"));
    return { type: "checkin_result", ok: true };
  }

  async dismissCheckIn(never: boolean): Promise<void> {
    recordFeatureUse(never ? "feedback_checkin_never" : "feedback_checkin_later");
    await this._write(applyPromptResponse(this._read(), "feedback", never ? "never" : "later"));
  }

  async reviewFromCheckIn(): Promise<void> {
    recordFeatureUse("feedback_rate_clicked");
    await this._openReviewPage();
  }

  /** From the command palette: the user acted, so the matching ask is retired. */
  async rate(): Promise<void> {
    await this._openReviewPage();
    await this._settle("feedback");
  }

  async sendFeedback(): Promise<void> {
    if (await this._collectFeedback()) await this._settle("feedback");
  }

  async share(): Promise<void> {
    const response = await this._askToShare(false);
    if (response === "accepted") await this._settle("share");
  }

  private async _settle(prompt: EngagementPrompt): Promise<void> {
    await this._write(applyPromptResponse(this._read(), prompt, "accepted"));
  }

  private async _openReviewPage(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(reviewUrlFor(vscode.env.uriScheme)));
  }

  private async _askForFeedback(): Promise<PromptResponse> {
    const rate = "Rate Andromity";
    const feedback = "Send Feedback";
    const later = "Later";
    const never = "Don't Ask Again";
    const choice = await vscode.window.showInformationMessage(
      "Thanks for using Andromity regularly! A quick rating or a note on what to improve helps a small open-source team a lot.",
      rate, feedback, later, never
    );
    if (choice === rate) {
      recordFeatureUse("feedback_rate_clicked");
      await this._openReviewPage();
      return "accepted";
    }
    if (choice === feedback) {
      recordFeatureUse("feedback_form_opened");
      return (await this._collectFeedback()) ? "accepted" : "later";
    }
    return choice === never ? "never" : "later";
  }

  /** Asks for a note and sends it. Returns true once the note was delivered. */
  private async _collectFeedback(): Promise<boolean> {
    if (currentAirGap().enabled) {
      void vscode.window.showInformationMessage(airGapOffMessage("sending feedback"));
      return false;
    }
    const message = await vscode.window.showInputBox({
      title: "Send feedback to the Andromity team",
      prompt: `What works, what doesn't, what should we build next? Add your email if you'd like a reply. Up to ${MAX_FEEDBACK_LENGTH} characters.`,
      placeHolder: "Your feedback",
      ignoreFocusOut: true,
      validateInput: validateFeedback,
    });
    if (!message?.trim()) return false;
    const payload = feedbackPayload(message, String(this._context.extension.packageJSON.version || ""), process.platform);
    const sent = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Sending feedback…" },
      () => submitFeedback(payload),
    );
    if (sent) {
      recordFeatureUse("feedback_sent");
      void vscode.window.showInformationMessage("Thanks! Your feedback reached the Andromity team.");
      return true;
    }
    const issue = "Copy and Open GitHub Issue";
    const choice = await vscode.window.showWarningMessage(
      "Your feedback couldn't be sent right now. You can post it as a GitHub issue instead.", issue
    );
    if (choice === issue) {
      recordFeatureUse("feedback_issue_clicked");
      await vscode.env.clipboard.writeText(payload.message);
      await vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_ISSUE_URL));
      return true;
    }
    return false;
  }

  private async _askToShare(nudge = true): Promise<PromptResponse> {
    const copy = "Copy Link";
    const x = "Share on X";
    const linkedin = "Share on LinkedIn";
    const never = "Don't Ask Again";
    const message = nudge
      ? "Finding Andromity useful? Share it with developers on your team or in your network."
      : "Share Andromity with other developers.";
    const choices = nudge ? [copy, x, linkedin, never] : [copy, x, linkedin];
    const choice = await vscode.window.showInformationMessage(message, ...choices);
    const targets = shareTargets();
    if (choice === copy) {
      recordFeatureUse("share_link_copied");
      await vscode.env.clipboard.writeText(`${SHARE_TEXT}: ${SHARE_URL}`);
      void vscode.window.showInformationMessage("Andromity link copied. Thanks for sharing!");
      return "accepted";
    }
    if (choice === x || choice === linkedin) {
      recordFeatureUse(choice === x ? "share_x_clicked" : "share_linkedin_clicked");
      await vscode.env.openExternal(vscode.Uri.parse(choice === x ? targets.x : targets.linkedin));
      return "accepted";
    }
    return choice === never ? "never" : "later";
  }
}
