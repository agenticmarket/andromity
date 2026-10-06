import { SessionWebviewEvent } from "./types.js";

/** Buffer notifications until history and runtime have been installed together. */
export class SessionHydration {
  private version = 0;
  private sessionId: string | null = null;
  private events: SessionWebviewEvent[] = [];

  begin(sessionId: string): number {
    this.sessionId = sessionId;
    this.events = [];
    return ++this.version;
  }

  isCurrent(version: number): boolean { return version === this.version; }

  capture(event: SessionWebviewEvent): boolean {
    if (!this.sessionId || event.session_id !== this.sessionId || event.event_seq === undefined) return false;
    this.events.push(event);
    return true;
  }

  finish(version: number, sequence: number, post: (event: SessionWebviewEvent) => void): void {
    if (!this.isCurrent(version)) return;
    const events = this.events;
    this.sessionId = null;
    this.events = [];
    for (const event of events) {
      if (event.event_seq === undefined || event.event_seq > sequence) post(event);
    }
  }
}
