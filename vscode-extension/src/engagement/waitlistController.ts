import * as vscode from "vscode";
import { airGapOffMessage } from "../airgap.js";
import { currentAirGap } from "../airgapState.js";
import { recordFeatureUse } from "../telemetry/featureUsage.js";
import { WAITLIST_HEARD_FROM, WAITLIST_WANTS, cleanWaitlistAnswer, submitWaitlist, waitlistPayload } from "./waitlist.js";

const JOINED_KEY = "andromity.waitlistJoined";
/** Set once a gateway error has carried the join_waitlist action. Until then no card offers the waitlist. */
const OFFERED_KEY = "andromity.waitlistOffered";

/** Chat page messages the waitlist handles. None of them needs the engine. */
export const WAITLIST_MESSAGES: ReadonlySet<unknown> = new Set(["waitlist_offer_shown", "waitlist_open", "waitlist_join"]);

export interface WaitlistChoice {
  id: string;
  label: string;
}

export interface WaitlistStateMessage {
  type: "waitlist_state";
  joined: boolean;
  offered: boolean;
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

/** The waitlist offer, its form and the local flags. Usage telemetry records only that the offer was shown. */
export class WaitlistController {
  private readonly _listeners = new Set<() => void>();
  private _joining: Promise<WaitlistReply> | null = null;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  joined(): boolean {
    return this._context.globalState.get<boolean>(JOINED_KEY) === true;
  }

  /** The backend has offered the waitlist at least once. */
  offered(): boolean {
    return this.joined() || this._context.globalState.get<boolean>(OFFERED_KEY) === true;
  }

  stateMessage(): WaitlistStateMessage {
    return { type: "waitlist_state", joined: this.joined(), offered: this.offered() };
  }

  /** Called after the offered or joined flag changes, so every open page can show it. */
  onDidChange(listener: () => void): vscode.Disposable {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  /** Only the engine's own turn result may call this; rendered chat text can imitate an error card. */
  async markOffered(): Promise<void> {
    if (this.offered()) return;
    try {
      await this._context.globalState.update(OFFERED_KEY, true);
    } catch {
      return;
    }
    this._notify();
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
    this._notify();
    return { type: "waitlist_result", ok: true };
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        // One page failing to update must not fail the change.
      }
    }
  }
}
