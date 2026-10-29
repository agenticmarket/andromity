import type { RpcClient } from "./RpcClient.js";
import type {
  KeyCheckResult,
  KeyCheckTone,
  ModelInfo,
  ProviderModelsRefresh,
  ProviderModelsReply,
  ProviderProbeReply,
} from "./types.js";

/** How long a key test may run before the provider is reported as unreachable. */
export const KEY_CHECK_TIMEOUT_MS = 20_000;
export const MODEL_REFRESH_TIMEOUT_MS = 12_000;

/** Connection IDs accepted by the engine: presets and validated custom connections. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

type RpcCaller = Pick<RpcClient, "call">;

const FIXED_LABELS: Record<string, { label: string; tone: KeyCheckTone }> = {
  auth_error: { label: "Key rejected", tone: "error" },
  model_forbidden: { label: "This account can't use that model", tone: "warn" },
  rate_limit: { label: "Rate limited (the key works)", tone: "warn" },
  quota_exceeded: { label: "Rate limited (the key works)", tone: "warn" },
  model_not_found: { label: "Model not found", tone: "warn" },
  endpoint_not_found: { label: "Model not found", tone: "warn" },
  timeout: { label: "Couldn't reach provider", tone: "error" },
  provider_unavailable: { label: "Couldn't reach provider", tone: "error" },
  ollama_offline: { label: "Couldn't reach provider", tone: "error" },
  incomplete_stream: { label: "The provider closed the connection early", tone: "error" },
  empty_response: { label: "The model sent no reply", tone: "warn" },
  airgap: { label: "Blocked by air-gap mode", tone: "warn" },
  no_key: { label: "No API key saved", tone: "warn" },
  no_model: { label: "No model to test with", tone: "warn" },
};

const UNREACHABLE: KeyCheckResult = { ok: false, tone: "error", label: "Couldn't reach provider", errorType: "timeout" };
const UNVERIFIED: KeyCheckResult = { ok: false, tone: "error", label: "Couldn't verify the key", errorType: "generic" };

/** Single-line plain text of bounded length; the webviews escape it again before rendering. */
export function plainText(value: unknown, limit = 120): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
}

export function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.max(1, Math.round(ms))} ms`;
}

export function describeKeyCheck(reply: ProviderProbeReply | null | undefined): KeyCheckResult {
  const model = plainText(reply?.model, 200) || undefined;
  const detail = plainText(reply?.detail) || undefined;
  if (reply?.success === true) {
    const latency = reply.latency_ms;
    const timed = typeof latency === "number" && Number.isFinite(latency) && latency > 0;
    return { ok: true, tone: "ok", label: timed ? `Connected · ${formatLatency(latency)}` : "Connected", model };
  }
  const errorType = typeof reply?.error_type === "string" && reply.error_type ? reply.error_type : "generic";
  const fixed = FIXED_LABELS[errorType];
  if (fixed) return { ok: false, tone: fixed.tone, label: fixed.label, errorType, detail, model };
  return { ok: false, tone: "error", label: detail || UNVERIFIED.label, errorType, model };
}

export async function checkProviderKey(rpc: RpcCaller, provider: string, timeoutMs = KEY_CHECK_TIMEOUT_MS): Promise<KeyCheckResult> {
  try {
    return describeKeyCheck(await rpc.call<ProviderProbeReply>("config.test_provider", { provider }, timeoutMs));
  } catch (error) {
    return error instanceof Error && error.message.startsWith("RPC timeout") ? { ...UNREACHABLE } : { ...UNVERIFIED };
  }
}

const keyTestSupport = new WeakMap<object, boolean>();

/** Older engines test a key with another provider's default model, so their results are not trusted.
 *  A provider list the caller already has answers this without a request: only newer engines send key_required. */
export async function supportsKeyTests(rpc: RpcCaller, providers?: unknown): Promise<boolean> {
  const known = keyTestSupport.get(rpc);
  if (known !== undefined) return known;
  if (Array.isArray(providers) && providers.some((p) => p && typeof p === "object")) {
    const supported = providers.some((p) => p && typeof p === "object" && typeof (p as { key_required?: unknown }).key_required === "boolean");
    keyTestSupport.set(rpc, supported);
    return supported;
  }
  try {
    const reply = await rpc.call<{ key_tests?: unknown }>("config.capabilities", {}, 5000);
    const supported = !(reply && typeof reply === "object" && reply.key_tests === false);
    keyTestSupport.set(rpc, supported);
    return supported;
  } catch (error) {
    const missing = error instanceof Error && error.message.includes("-32601");
    if (missing) keyTestSupport.set(rpc, false);
    return !missing;
  }
}

export const KEY_TESTS_UNSUPPORTED: KeyCheckResult = {
  ok: false, tone: "warn", label: "Update the Andromity engine to test keys", errorType: "unsupported",
};

let queueTail: Promise<unknown> = Promise.resolve();

/** Key tests run one at a time, so a test started by saving a key never overlaps an earlier one. */
export function runKeyCheck(rpc: RpcCaller, provider: string, onStart?: () => void): Promise<KeyCheckResult> {
  const run = queueTail.then(() => {
    onStart?.();
    return checkProviderKey(rpc, provider);
  });
  queueTail = run.catch(() => undefined);
  return run;
}

/** The onboarding wording for a saved key that did not pass its test, or "" when it passed. */
export function unverifiedNotice(result: KeyCheckResult | null): string {
  return result && !result.ok ? `Saved, but couldn't verify: ${result.label}` : "";
}

export async function refreshProviderModels(rpc: RpcCaller, provider: string): Promise<ProviderModelsRefresh> {
  try {
    const reply = await rpc.call<ProviderModelsReply>("config.refresh_provider_models", { provider }, MODEL_REFRESH_TIMEOUT_MS);
    const ok = reply?.ok === true;
    return {
      provider, ok,
      message: ok ? "" : plainText(reply?.message) || "Couldn't refresh models.",
      models: Array.isArray(reply?.models) ? reply.models : null,
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    if (text.includes("-32601")) {
      const models = await rpc.call<ModelInfo[]>("config.refresh_models", { provider }, MODEL_REFRESH_TIMEOUT_MS).catch(() => null);
      return Array.isArray(models)
        ? { provider, ok: true, message: "", models }
        : { provider, ok: false, message: "Couldn't refresh models.", models: null };
    }
    return { provider, ok: false, message: text.startsWith("RPC timeout") ? "Couldn't reach provider." : "Couldn't refresh models.", models: null };
  }
}
