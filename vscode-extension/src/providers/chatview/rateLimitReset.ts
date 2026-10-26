// Injected into webviews with toString(), and production builds rename identifiers, so this
// may only use its parameters and built-ins.

/** When a provider's rate limit lifts, read from the error text, as epoch milliseconds. */
export function rateLimitResetAt(text: string, nowMs: number): number | null {
  if (typeof text !== "string" || !text) return null;
  const maxAheadMs = 8 * 24 * 60 * 60 * 1000;
  const plausible = (ms: number) => (ms > nowMs - 60_000 && ms - nowMs <= maxAheadMs ? Math.max(ms, nowMs) : null);

  const epoch = /x-?ratelimit-reset(?:-requests|-tokens)?["']?\s*[:=]\s*["']?(\d{10,13})(?!\d)/i.exec(text);
  if (epoch) {
    const value = Number(epoch[1]);
    const found = plausible(epoch[1].length >= 13 ? value : value * 1000);
    if (found !== null) return found;
  }

  const retryAfter = /retry[-_ ]after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(text);
  if (retryAfter) return plausible(nowMs + Number(retryAfter[1]) * 1000);

  const phrase = /(?:try again|retry|resets?|available again)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:ms|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?![a-z])\s*)+)/i.exec(text);
  if (phrase) {
    let total = 0;
    const unit = /(\d+(?:\.\d+)?)\s*(ms|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)/gi;
    let m: RegExpExecArray | null;
    while ((m = unit.exec(phrase[1])) !== null) {
      const n = Number(m[1]);
      const u = m[2].toLowerCase();
      total += u === "ms" ? n : u.startsWith("h") ? n * 3_600_000 : u.startsWith("m") ? n * 60_000 : n * 1000;
    }
    if (total > 0) return plausible(nowMs + total);
  }
  return null;
}

export function getRateLimitResetScript(): string {
  return `const rateLimitResetAt = ${rateLimitResetAt.toString()};\n`;
}
