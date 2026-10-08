import * as vscode from "vscode";

export const DEFAULT_GATEWAY_URL = "https://gateway.agenticmarket.dev";
export const DEFAULT_WEB_APP_URL = "https://agenticmarket.dev";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Account endpoints receive the user's sign-in token, so a value is accepted only
 * over https on agenticmarket.dev, or on loopback for local gateway development.
 */
export function normalizeAccountUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  const host = url.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const isAgenticMarket = host === "agenticmarket.dev" || host.endsWith(".agenticmarket.dev");
  const allowed = url.protocol === "https:" ? isAgenticMarket || isLoopback : url.protocol === "http:" && isLoopback;
  if (!allowed) return undefined;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Workspace and folder values are ignored: a cloned repository must not redirect the token. */
export function accountUrl(key: "gatewayUrl" | "webAppUrl"): string {
  const inspected = vscode.workspace.getConfiguration("andromity").inspect<string>(key);
  const fallback = key === "gatewayUrl" ? DEFAULT_GATEWAY_URL : DEFAULT_WEB_APP_URL;
  return normalizeAccountUrl(inspected?.globalValue) ?? fallback;
}
