export interface FoundSecret {
  label: string;
  start: number;
  end: number;
  preview: string;
}

// Injected into webviews with toString(), and production builds rename identifiers, so these
// may only use their parameters and built-ins.

/** Credentials with a recognisable shape. Only high-confidence formats, so ordinary text never trips it. */
export function findSecrets(text: string): FoundSecret[] {
  if (typeof text !== "string" || text.length < 16) return [];
  const rules: [string, RegExp][] = [
    ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g],
    ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
    ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
    ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{30,}/g],
    ["OpenRouter API key", /\bsk-or-[A-Za-z0-9_-]{30,}/g],
    ["Stripe live key", /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g],
    ["API key", /\bsk-(?!ant-|or-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
    ["Slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g],
    ["Hugging Face token", /\bhf_[A-Za-z0-9]{34,}\b/g],
    ["Groq API key", /\bgsk_[A-Za-z0-9]{40,}\b/g],
    ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
    ["database URL with a password", /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s/]+/g],
    ["Azure storage key", /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/g],
    ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ];
  const found: FoundSecret[] = [];
  for (const [label, pattern] of rules) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!found.some(f => start < f.end && end > f.start)) {
        const value = m[0];
        const preview = value.length <= 12 ? value.slice(0, 4) + "…" : value.slice(0, 8) + "…" + value.slice(-2);
        found.push({ label, start, end, preview });
      }
      if (m[0].length === 0) pattern.lastIndex++;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The text with each found secret replaced by `marker`, or by a marker naming what it was. */
export function redactSecrets(text: string, secrets: FoundSecret[], marker?: string): string {
  if (typeof text !== "string") return "";
  let out = "";
  let at = 0;
  for (const s of [...secrets].sort((a, b) => a.start - b.start)) {
    if (s.start < at) continue;
    out += text.slice(at, s.start) + (marker ?? "[REDACTED " + s.label + "]");
    at = s.end;
  }
  return out + text.slice(at);
}

export function getSecretScanScript(): string {
  return `const findSecrets = ${findSecrets.toString()};\n`
    + `const redactSecrets = ${redactSecrets.toString()};\n`;
}
