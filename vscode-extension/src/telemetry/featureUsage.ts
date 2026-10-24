/** "Was this feature used" events. Each event is only a feature name
 *  (plus the session id it happened in); it goes through the daemon's
 *  telemetry.recordFeature to the Andromity telemetry worker, where the admin
 *  dashboard counts users and uses per name. Never prompts, code, paths, model
 *  output or settings values. The daemon applies the same opt-outs again. */

interface TelemetryRpc {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

let activeClient: TelemetryRpc | null = null;
// extension.ts supplies VS Code's telemetry switch and andromity.telemetry; kept out of this
// module so the shared bridges stay importable without VS Code.
let telemetryGate: () => boolean = () => true;
const seenPerSession = new Map<string, Set<string>>();
const MAX_TRACKED_SESSIONS = 200;
const NO_SESSION = "";

export function setFeatureUsageClient(client: TelemetryRpc | null): void {
  activeClient = client;
}

/** Lowercase letters, digits and underscores, at most 31 characters: longer
 *  word-only names would be rewritten by the daemon's API-key scrubber. */
export function featureName(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 31)
    .replace(/_$/, "");
}

export function setFeatureUsageGate(gate: () => boolean): void {
  telemetryGate = gate;
}

function telemetryAllowed(): boolean {
  try {
    return telemetryGate();
  } catch {
    return false;
  }
}

export interface FeatureUseOptions {
  sessionId?: string;
  /** Count a session once for actions people repeat often (copying, jumping, expanding). */
  oncePerSession?: boolean;
  client?: TelemetryRpc | null;
}

export function recordFeatureUse(feature: string, options: FeatureUseOptions = {}): void {
  const name = featureName(feature);
  const client = options.client ?? activeClient;
  if (!name || !client || !telemetryAllowed()) return;
  if (options.oncePerSession) {
    const key = options.sessionId || NO_SESSION;
    let seen = seenPerSession.get(key);
    if (!seen) {
      seen = new Set();
      seenPerSession.set(key, seen);
      if (seenPerSession.size > MAX_TRACKED_SESSIONS) {
        const oldest = seenPerSession.keys().next().value;
        if (oldest !== undefined) seenPerSession.delete(oldest);
      }
    }
    if (seen.has(name)) return;
    seen.add(name);
  }
  const params = options.sessionId ? { feature: name, session_id: options.sessionId } : { feature: name };
  void client.call("telemetry.recordFeature", params).catch(() => {});
}
