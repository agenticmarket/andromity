import { EventEmitter } from "events";
import {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

export class RpcClient extends EventEmitter {
  private _nextId = 1;
  private _pendingRequests = new Map<
    string | number,
    { resolve: (res: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }
  >();
  private _sendRaw: (msg: string) => void;
  private _buffer = "";

  constructor(sendRaw: (msg: string) => void) {
    super();
    this._sendRaw = sendRaw;
  }

  public handleIncomingMessage(raw: string): void {
    this._buffer += raw;
    let newlineIndex: number;
    while ((newlineIndex = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, newlineIndex).trim();
      this._buffer = this._buffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        if (this._isResponse(msg)) {
          this._handleResponse(msg);
        } else if (this._isNotification(msg)) {
          this._handleNotification(msg);
        }
      } catch (e) {
        console.error("[Andromity RPC] Failed to parse message:", line, e);
      }
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
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`RPC timeout (${timeoutMs}ms) for method: ${method}`));
      }, timeoutMs);

      this._pendingRequests.set(id, { resolve, reject, timer });
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
    clearTimeout(pending.timer);

    if (resp.error) {
      pending.reject(
        new Error(`[RPC ${resp.error.code}] ${resp.error.message}`)
      );
    } else {
      pending.resolve(resp.result);
    }
  }

  private _handleNotification(notif: JsonRpcNotification): void {
    this.emit(notif.method, notif.params);
    this.emit("*", notif.method, notif.params);
  }

  public close(reason = "RPC connection closed"): void {
    for (const [id, pending] of this._pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pendingRequests.clear();
  }
}
