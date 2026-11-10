import { EventEmitter } from "events";
import {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

/** Matches the daemon's own 64 MB frame limit (server/main.py MAX_LINE_LENGTH). */
export const MAX_BUFFERED_LINE_CHARS = 64 * 1024 * 1024;

/** Request timers held for a daemon that has not spoken yet start anyway after this long. */
export const DAEMON_READY_WAIT_LIMIT_MS = 120000;

/** Calls slower than this are written to the output channel, so a slow start can be read from the log. */
export const SLOW_CALL_LOG_MS = 5000;

interface PendingRequest {
  resolve: (res: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout | null;
  timeoutMs: number;
  method: string;
  sentAt: number;
}

export class RpcClient extends EventEmitter {
  private _nextId = 1;
  private _pendingRequests = new Map<string | number, PendingRequest>();
  private _sendRaw: (msg: string) => void;
  private _buffer = "";
  private _log: (msg: string) => void;
  private _daemonReady: boolean;
  private _readyLimit: NodeJS.Timeout | null = null;

  /** With waitForDaemon, request timeouts only start counting once markDaemonReady() is called. */
  constructor(sendRaw: (msg: string) => void, options?: { log?: (msg: string) => void; waitForDaemon?: boolean }) {
    super();
    this._sendRaw = sendRaw;
    // Route parse problems to the extension's output channel (visible to users)
    // instead of only the hidden DevTools console.
    this._log = options?.log ?? ((msg: string) => console.error(msg));
    this._daemonReady = !options?.waitForDaemon;
    if (!this._daemonReady) {
      this._readyLimit = setTimeout(() => {
        this._log(`[Andromity RPC] The engine has not answered after ${DAEMON_READY_WAIT_LIMIT_MS / 1000}s; starting request timeouts anyway.`);
        this.markDaemonReady();
      }, DAEMON_READY_WAIT_LIMIT_MS);
    }
  }

  /** The daemon has produced output, so it is running: start the timeouts of calls sent before that. */
  public markDaemonReady(): void {
    if (this._daemonReady) return;
    this._daemonReady = true;
    if (this._readyLimit) clearTimeout(this._readyLimit);
    this._readyLimit = null;
    for (const [id, pending] of this._pendingRequests.entries()) {
      if (!pending.timer) pending.timer = this._startTimer(id, pending);
    }
  }

  private _startTimer(id: string | number, pending: PendingRequest): NodeJS.Timeout {
    return setTimeout(() => {
      this._pendingRequests.delete(id);
      pending.reject(new Error(`RPC timeout (${pending.timeoutMs}ms) for method: ${pending.method}`));
    }, pending.timeoutMs);
  }

  public handleIncomingMessage(raw: string): void {
    // Only scan the new chunk for newlines: rescanning the whole buffer made a
    // multi-MB session payload arriving in 64 KB chunks quadratic.
    const scanFrom = this._buffer.length;
    this._buffer += raw;
    let lineStart = 0;
    let newlineIndex = this._buffer.indexOf("\n", scanFrom);
    const lines: string[] = [];
    while (newlineIndex !== -1) {
      lines.push(this._buffer.slice(lineStart, newlineIndex));
      lineStart = newlineIndex + 1;
      newlineIndex = this._buffer.indexOf("\n", lineStart);
    }
    if (lineStart > 0) this._buffer = this._buffer.slice(lineStart);
    if (this._buffer.length > MAX_BUFFERED_LINE_CHARS) {
      this._log(`[Andromity RPC] Dropped an unterminated message larger than ${MAX_BUFFERED_LINE_CHARS} characters.`);
      this._buffer = "";
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        this._dispatchMessage(msg);
      } catch (e) {
        // Frozen binaries / chatty libraries sometimes print to stdout WITHOUT
        // a trailing newline, which concatenates garbage onto the next JSON-RPC
        // line. Salvage the embedded JSON object so notifications (especially
        // agent/done) are not silently dropped — otherwise the UI shows
        // "working..." forever even though the turn finished daemon-side.
        const salvaged = this._salvageJson(line);
        if (salvaged) {
          this._log(
            `[Andromity RPC] Salvaged JSON from corrupted line (non-JSON prefix/suffix from the daemon): ${line.slice(0, 200)}`
          );
          this._dispatchMessage(salvaged);
        } else {
          this._log(
            `[Andromity RPC] Failed to parse message (dropped, ${line.length} chars): ${line.slice(0, 500)}`
          );
        }
      }
    }
  }

  /** Find the first '{' that starts a plausible JSON-RPC object and try to parse from there. */
  private _salvageJson(line: string): any | null {
    const start = line.indexOf("{");
    if (start <= 0) return null;
    try {
      const parsed = JSON.parse(line.slice(start));
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // fall through
    }
    return null;
  }

  private _dispatchMessage(msg: any): void {
    if (this._isResponse(msg)) {
      this._handleResponse(msg);
    } else if (this._isNotification(msg)) {
      this._handleNotification(msg);
    }
  }

  public async call<T = any>(
    method: string,
    params: Record<string, any> = {},
    timeoutMs: number = 30000
  ): Promise<T> {
    const id = this._nextId++;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, timer: null, timeoutMs, method, sentAt: Date.now() };
      if (this._daemonReady) pending.timer = this._startTimer(id, pending);
      this._pendingRequests.set(id, pending);
      this._sendRaw(JSON.stringify(req) + "\n");
    });
  }

  public notify(method: string, params: Record<string, any> = {}): void {
    const notif: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this._sendRaw(JSON.stringify(notif) + "\n");
  }

  private _isResponse(msg: any): msg is JsonRpcResponse {
    return (
      typeof msg === "object" &&
      msg !== null &&
      "id" in msg &&
      ("result" in msg || "error" in msg)
    );
  }

  private _isNotification(msg: any): msg is JsonRpcNotification {
    return (
      typeof msg === "object" &&
      msg !== null &&
      !("id" in msg) &&
      "method" in msg
    );
  }

  private _handleResponse(resp: JsonRpcResponse): void {
    if (resp.id === null || resp.id === undefined) return;
    const pending = this._pendingRequests.get(resp.id);
    if (!pending) return;

    this._pendingRequests.delete(resp.id);
    if (pending.timer) clearTimeout(pending.timer);
    const took = Date.now() - pending.sentAt;
    if (took >= SLOW_CALL_LOG_MS) {
      this._log(`[Andromity RPC] ${pending.method.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 80)} took ${(took / 1000).toFixed(1)}s.`);
    }

    if (resp.error) {
      pending.reject(
        new Error(`[RPC ${resp.error.code}] ${resp.error.message}`)
      );
    } else {
      pending.resolve(resp.result);
    }
  }

  /** EventEmitter-reserved method names must never be re-emitted directly:
   *  emitting "error" with no listener throws an unhandled exception (crashing
   *  the extension host), and emitting "newListener"/"removeListener" corrupts
   *  the emitter's own listener bookkeeping. They are still forwarded to "*"
   *  listeners so nothing observably disappears. */
  private _isReservedEventName(method: string): boolean {
    return (
      method === "error" ||
      method === "newListener" ||
      method === "removeListener"
    );
  }

  private _handleNotification(notif: JsonRpcNotification): void {
    if (this._isReservedEventName(notif.method)) {
      console.warn(
        `[Andromity RPC] Ignoring reserved notification method: ${notif.method}`
      );
    } else {
      this.emit(notif.method, notif.params);
    }
    this.emit("*", notif.method, notif.params);
  }

  public close(reason = "RPC connection closed"): void {
    if (this._readyLimit) clearTimeout(this._readyLimit);
    this._readyLimit = null;
    this._daemonReady = true;
    for (const pending of this._pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pendingRequests.clear();
  }
}
