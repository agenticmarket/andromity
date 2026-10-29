import * as vscode from "vscode";
import { airGapOffMessage } from "../airgap.js";
import { currentAirGap } from "../airgapState.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import { WAITLIST_HEARD_FROM, WAITLIST_WANTS, cleanWaitlistAnswer, submitWaitlist, waitlistPayload } from "./waitlist.js";

const JOINED_KEY = "andromity.waitlistJoined";

export interface WaitlistChoice {
  id: string;
  label: string;
}

export interface WaitlistStateMessage {
  type: "waitlist_state";
  joined: boolean;
}

export interface WaitlistFormMessage {
  type: "waitlist_form";
  joined: boolean;
  wants: WaitlistChoice[];
  heardFrom: WaitlistChoice[];
}

export interface WaitlistReply {
  type: "waitlist_result";
  ok: boolean;
  error?: string;
}

export type WaitlistPageMessage = WaitlistFormMessage | WaitlistReply;

/** The waitlist offer, its form and the local joined flag. Usage telemetry records the steps, never the answers. */
export class WaitlistController {
  private readonly _joinListeners = new Set<() => void>();
  private _joining: Promise<WaitlistReply> | null = null;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  joined(): boolean {
    return this._context.globalState.get<boolean>(JOINED_KEY) === true;
  }

  stateMessage(): WaitlistStateMessage {
    return { type: "waitlist_state", joined: this.joined() };
  }

  /** Called after a join is stored, so every open page can show it. */
  onDidJoin(listener: () => void): vscode.Disposable {
    this._joinListeners.add(listener);
    return { dispose: () => this._joinListeners.delete(listener) };
  }

  offerShown(): void {
    if (!this.joined()) recordFeatureUse("waitlist_offer_shown", { oncePerSession: true });
  }

  /** Handles the waitlist messages of a chat page. Returns false for any other message. */
  async handleMessage(message: { type?: unknown }, post: (reply: WaitlistPageMessage) => void): Promise<boolean> {
    if (message.type === "waitlist_offer_shown") {
      this.offerShown();
    } else if (message.type === "waitlist_open") {
      this._openForm(post);
    } else if (message.type === "waitlist_join") {
      post(await this.join(message));
    } else {
      return false;
    }
    return true;
  }

  join(input: unknown, submit: typeof submitWaitlist = submitWaitlist): Promise<WaitlistReply> {
    if (!this._joining) {
      this._joining = this._join(input, submit).finally(() => {
        this._joining = null;
      });
    }
    return this._joining;
  }

  private _openForm(post: (reply: WaitlistPageMessage) => void): void {
    const joined = this.joined();
    if (!joined && currentAirGap().enabled) {
      void vscode.window.showInformationMessage(airGapOffMessage("joining the waitlist"));
      return;
    }
    if (!joined) recordFeatureUse("waitlist_form_opened");
    post({
      type: "waitlist_form",
      joined,
      wants: WAITLIST_WANTS.map(({ id, label }) => ({ id, label })),
      heardFrom: WAITLIST_HEARD_FROM.map(({ id, label }) => ({ id, label })),
    });
  }

  private async _join(input: unknown, submit: typeof submitWaitlist): Promise<WaitlistReply> {
    if (this.joined()) return { type: "waitlist_result", ok: true };
    const cleaned = cleanWaitlistAnswer(input);
    if ("error" in cleaned) return { type: "waitlist_result", ok: false, error: cleaned.error };
    if (currentAirGap().enabled) {
      return { type: "waitlist_result", ok: false, error: airGapOffMessage("joining the waitlist") };
    }
    const version = String(this._context.extension.packageJSON.version || "");
    const result = await submit(waitlistPayload(cleaned.answer, version, process.platform));
    if (result === "unavailable") {
      return { type: "waitlist_result", ok: false, error: "The waitlist isn't available right now. Please try again later." };
    }
    if (result !== "joined") {
      return { type: "waitlist_result", ok: false, error: "You couldn't be added to the waitlist right now. Check your connection and try again." };
    }
    try {
      await this._context.globalState.update(JOINED_KEY, true);
    } catch {
      // The entry is stored; a lost local flag only means the offer can appear again.
    }
    recordFeatureUse("waitlist_joined");
    for (const listener of this._joinListeners) {
      try {
        listener();
      } catch {
        // One page failing to update must not fail the join.
      }
    }
    return { type: "waitlist_result", ok: true };
  }
}
