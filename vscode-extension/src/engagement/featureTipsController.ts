import * as vscode from "vscode";
import {
  type FeatureTipId, type FeatureTipsState, type TurnFacts,
  markTipShown, normalizeFeatureTipsState, pickTip, recordTurn, retireTip, tipsUsedBy, wantsMcpCount,
} from "./featureTips.js";
import { onFeatureUse, recordFeatureUse } from "../telemetry/featureUsage.js";

const STATE_KEY = "andromity.featureTips.state";
const SETTING = "featureTips";

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Keeps feature tip state in globalState and retires a tip as soon as its
 *  feature is used anywhere in the extension. */
export class FeatureTipsController implements vscode.Disposable {
  private _writes: Promise<void> = Promise.resolve();
  private readonly _unsubscribe: () => void;

  constructor(private readonly _memento: vscode.Memento) {
    this._unsubscribe = onFeatureUse((feature) => {
      for (const id of tipsUsedBy(feature)) void this._update((state) => retireTip(state, id));
    });
  }

  enabled(): boolean {
    return vscode.workspace.getConfiguration("andromity").get<boolean>(SETTING, true) !== false;
  }

  /** Whether the MCP tip could show today, so counting servers is worth an RPC call. */
  wantsMcpCount(): boolean {
    return this.enabled() && wantsMcpCount(normalizeFeatureTipsState(this._memento.get(STATE_KEY)), localDay(new Date()));
  }

  /** Records the finished turn and returns the tip to show under it, if any. */
  async onTurnFinished(facts: TurnFacts): Promise<FeatureTipId | null> {
    const today = localDay(new Date());
    const result: { tip: FeatureTipId | null } = { tip: null };
    const saved = await this._update((state) => {
      const next = recordTurn(state, facts.sessionId, today);
      result.tip = this.enabled() ? pickTip(next, facts, today) : null;
      return result.tip ? markTipShown(next, result.tip, today) : next;
    });
    // A tip whose showing couldn't be saved would repeat after every turn.
    if (!saved) return null;
    if (result.tip) recordFeatureUse(`tip_shown_${result.tip}`, { sessionId: facts.sessionId });
    return result.tip;
  }

  async acted(id: FeatureTipId): Promise<void> {
    recordFeatureUse(`tip_clicked_${id}`);
    await this._update((state) => retireTip(state, id));
  }

  async hide(id: FeatureTipId): Promise<void> {
    recordFeatureUse(`tip_hidden_${id}`);
    await this._update((state) => retireTip(state, id));
  }

  async turnOff(): Promise<void> {
    recordFeatureUse("tips_turned_off");
    await vscode.workspace.getConfiguration("andromity").update(SETTING, false, vscode.ConfigurationTarget.Global);
  }

  dispose(): void {
    this._unsubscribe();
  }

  private _update(change: (state: FeatureTipsState) => FeatureTipsState): Promise<boolean> {
    const write = this._writes.then(async () => {
      const next = change(normalizeFeatureTipsState(this._memento.get(STATE_KEY)));
      await this._memento.update(STATE_KEY, next);
      return true;
    }).catch(() => false);
    this._writes = write.then(() => undefined);
    return write;
  }
}
