/** Counts what happened while the chat view was hidden, for the badge on its icon. */

export type AwayEvent = "reply" | "approval" | "question";

export interface ViewBadge {
  value: number;
  tooltip: string;
}

export class AwayBadge {
  private _replies = 0;
  private _attention: "approval" | "question" | null = null;

  note(event: AwayEvent): void {
    if (event === "reply") this._replies++;
    else if (this._attention !== "approval") this._attention = event;
  }

  clear(): void {
    this._replies = 0;
    this._attention = null;
  }

  badge(): ViewBadge | undefined {
    const value = this._replies + (this._attention ? 1 : 0);
    if (!value) return undefined;
    const parts: string[] = [];
    if (this._attention === "approval") parts.push("Andromity needs your approval");
    else if (this._attention === "question") parts.push("Andromity has a question for you");
    if (this._replies) parts.push(`${this._replies} ${this._replies === 1 ? "reply" : "replies"} finished`);
    return { value, tooltip: parts.join(" · ") };
  }
}
