import type { CommandRisk } from "./commandRisk.js";
import { findSecrets } from "./secretScan.js";

// Injected into webviews with toString(), and production builds rename identifiers, so this
// may only use its parameters and built-ins.
function urlRisks(url: string, scan: (text: string) => { label: string }[]): CommandRisk[] {
  if (typeof url !== "string" || !url.trim()) return [];
  const risks: CommandRisk[] = [];
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { decoded = url; }
  const secrets = scan(decoded);
  if (secrets.length) risks.push({ level: "danger", label: "The address contains a credential (" + secrets[0].label + ")" });
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (parsed) {
    const parts = [...Array.from(parsed.searchParams.values()), ...parsed.pathname.split("/"), parsed.hash.slice(1)];
    if (parts.some(part => part.length >= 64)) risks.push({ level: "warn", label: "The address carries a long block of data" });
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.startsWith("[")) {
      risks.push({ level: "warn", label: "Goes to a raw IP address instead of a domain name" });
    }
    if (parsed.protocol === "http:") risks.push({ level: "info", label: "Uses unencrypted http" });
  }
  return risks;
}

/** Reasons a URL fetch deserves a second look: data that could be leaving in the address itself. */
export function describeUrlRisks(url: string): CommandRisk[] {
  return urlRisks(url, findSecrets);
}

/** Needs the secret scan script injected before it. */
export function getUrlRiskScript(): string {
  return `const describeUrlRisks = (url) => (${urlRisks.toString()})(url, findSecrets);\n`;
}
