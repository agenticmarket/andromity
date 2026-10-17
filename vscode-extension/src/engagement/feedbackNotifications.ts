import * as vscode from "vscode";
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

const STATE_KEY = "andromity.engagement";

export class FeedbackNotifications {
  private _showing = false;

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

  async onTurnCompleted(): Promise<void> {
    const today = localDay(new Date());
    let state = recordCompletedTurn(this._read(), today);
    const prompt = this._showing ? null : duePrompt(state, today);
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

  /** From the command palette: the user acted, so the matching ask is retired. */
  async rate(): Promise<void> {
    await this._openReviewPage();
    await this._settle("feedback");
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
      recordFeatureUse("feedback_issue_clicked");
      await vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_ISSUE_URL));
      return "accepted";
    }
    return choice === never ? "never" : "later";
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
