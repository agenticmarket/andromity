/** Tracks sessions the user is not looking at, for the status bar and for the
 *  "needs you" notification. Pure state: the host supplies what is on screen. */

export interface SessionViewState {
  /** Session open in the sidebar chat. */
  currentSessionId(): string;
  /** Whether the sidebar chat view is visible. */
  isChatVisible(): boolean;
  /** Whether the session is shown in a visible pop-out tab. */
  isShownInTab(sessionId: string): boolean;
  isWindowFocused(): boolean;
  sessionName(sessionId: string): string | undefined;
}

export type AttentionKind = "approval" | "question";

interface RunningSession {
  startedAt: number;
  activity: string;
}

export interface StatusView {
  text: string;
  tooltip: string;
  /** Session the status bar click should open, if one is unambiguous. */
  openSessionId?: string;
}

const TOOL_ACTIVITY: Array<[RegExp, string]> = [
  [/^(write_file|edit_file|edit_file_multi|apply_patch|create_file)$/, "Editing a file"],
  [/^(read_file|view_file|list_dir|list_directory)$/, "Reading files"],
  [/^(grep_search|search|find_files|glob)$/, "Searching the code"],
  [/^(shell_exec|shell_bg|run_command)$/, "Running a command"],
  [/^(web_search|web_fetch|fetch_url)$/, "Searching the web"],
  [/^(spawn_subagent|subagent|delegate)/, "Working with a subagent"],
];

export function describeToolActivity(toolName: string | undefined): string {
  const name = String(toolName || "");
  for (const [pattern, label] of TOOL_ACTIVITY) if (pattern.test(name)) return label;
  return name ? `Using ${name.replace(/_/g, " ")}` : "Working";
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export class BackgroundSessions {
  private readonly _running = new Map<string, RunningSession>();
  private readonly _attention = new Map<string, AttentionKind>();

  constructor(private readonly _view: SessionViewState, private readonly _now: () => number = Date.now) {}

  /** The user can see this session right now. */
  isOnScreen(sessionId: string): boolean {
    if (this._view.isShownInTab(sessionId)) return true;
    return sessionId === this._view.currentSessionId() && this._view.isChatVisible();
  }

  /** A request from this session would go unseen without a notification. */
  needsNotification(sessionId: string): boolean {
    return !this._view.isWindowFocused() || !this.isOnScreen(sessionId);
  }

  isBackground(sessionId: string): boolean {
    return sessionId !== this._view.currentSessionId() && !this._view.isShownInTab(sessionId);
  }

  /** Returns whether anything visible changed, so per-token events can skip a redraw. */
  markActivity(sessionId: string, activity: string): boolean {
    const existing = this._running.get(sessionId);
    const hadAttention = this._attention.delete(sessionId);
    if (!existing) {
      this._running.set(sessionId, { startedAt: this._now(), activity });
      return true;
    }
    if (existing.activity === activity) return hadAttention;
    existing.activity = activity;
    return true;
  }

  markAttention(sessionId: string, kind: AttentionKind): void {
    if (!this._running.has(sessionId)) this._running.set(sessionId, { startedAt: this._now(), activity: "Waiting for you" });
    this._attention.set(sessionId, kind);
  }

  /** Returns true when this session was already waiting, so a repeat request is not re-notified. */
  hasAttention(sessionId: string): boolean {
    return this._attention.has(sessionId);
  }

  clearAttention(sessionId: string): void {
    this._attention.delete(sessionId);
  }

  markFinished(sessionId?: string): void {
    if (!sessionId) {
      this._running.clear();
      this._attention.clear();
      return;
    }
    this._running.delete(sessionId);
    this._attention.delete(sessionId);
  }

  label(sessionId: string): string {
    return this._view.sessionName(sessionId) || "Background session";
  }

  /** Status bar: unchanged for the session in view; a quiet count and a tooltip for the rest. */
  render(): StatusView {
    const waiting = [...this._attention.entries()].filter(([sid]) => this.needsNotification(sid));
    const background = [...this._running.entries()].filter(([sid]) => this.isBackground(sid));
    const lines = background.map(([sid, s]) => {
      const kind = this._attention.get(sid);
      const state = kind === "approval" ? "Needs your approval" : kind === "question" ? "Has a question for you" : s.activity;
      return `${this.label(sid)} — ${state} · since ${formatClock(s.startedAt)}`;
    });
    for (const [sid, kind] of waiting) {
      if (this.isBackground(sid)) continue;
      lines.unshift(`${this.label(sid)} — ${kind === "approval" ? "Needs your approval" : "Has a question for you"}`);
    }

    if (waiting.length) {
      return {
        text: waiting.some(([, kind]) => kind === "approval") ? "$(alert) Andromity" : "$(question) Andromity",
        tooltip: lines.join("\n") + "\n\nClick to open.",
        openSessionId: waiting[0][0],
      };
    }
    if (background.length) {
      return {
        text: `$(andromity-logo) Andromity · ${background.length}`,
        tooltip: `Running in the background:\n${lines.join("\n")}\n\nClick to open${background.length === 1 ? " it" : " the chat"}.`,
        openSessionId: background.length === 1 ? background[0][0] : undefined,
      };
    }
    return { text: "$(andromity-logo) Andromity", tooltip: "Andromity Coding Agent" };
  }
}
