/** GitHub refuses a pull request or comment body longer than this. */
export const GITHUB_BODY_LIMIT = 65_536;
const BODY_BUDGET = GITHUB_BODY_LIMIT - 512;
export const MAX_TITLE = 256;
export const MAX_DESCRIPTION = 60_000;
export const MAX_COMMIT_MESSAGE = 20_000;
const MAX_LISTED_PATHS = 10;

/** Removes control characters except tab and newline, and turns CRLF into LF. */
export function plainText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .slice(0, limit);
}

export function cleanTitle(value: unknown): string {
  return plainText(value, MAX_TITLE * 4).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

/** A model's draft, made safe to start from: no control characters and no trailers it had no basis for. */
export function cleanDraft(value: unknown, limit = MAX_DESCRIPTION): string {
  return plainText(value, limit)
    .split("\n")
    .filter((line) => !/^\s*(co-authored-by|signed-off-by|assisted-by|generated-by)\s*:/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Inline code that no backtick in the value can close. */
export function mdCode(value: string): string {
  const text = value.replace(/[\r\n]+/g, " ");
  let longest = 0;
  for (const run of text.match(/`+/g) || []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || text.startsWith(" ") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map(mdCode).join(", ");
  const more = paths.length - MAX_LISTED_PATHS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface ReceiptLink {
  turnIndex: number;
  commitSha?: string;
  /** Files the turn changed that this pull request leaves out. */
  leftOut: readonly string[];
  /** Files this pull request commits that the turn did not change. */
  extra: readonly string[];
}

/** The line written by fixed code that ties a receipt to the commit it ships in. */
export function receiptLinkLine(link: ReceiptLink): string {
  const sha = link.commitSha && /^[0-9a-f]{7,64}$/.test(link.commitSha) ? `, committed as ${mdCode(link.commitSha.slice(0, 7))}` : "";
  const parts = [`Receipt for Andromity turn ${Math.trunc(link.turnIndex) + 1}${sha}.`];
  if (link.leftOut.length) {
    parts.push(`This pull request leaves out ${plural(link.leftOut.length, "file", "files")} the turn changed: ${pathList(link.leftOut)}.`);
  }
  if (link.extra.length) {
    parts.push(`It also commits ${plural(link.extra.length, "file", "files")} the turn did not change: ${pathList(link.extra)}.`);
  }
  return `<sub>${parts.join(" ")}</sub>`;
}

const SHORTENED = "<sub>Receipt shortened to fit GitHub's limit. The full receipt is in Andromity's receipt tab.</sub>";

/** Drops the receipt's folded sections from the end, then its last lines, until it fits. The heading and
 *  "Needs your eyes" come first in the receipt, so they are the last to go. */
export function fitReceipt(receipt: string, budget: number): { text: string; shortened: boolean } {
  if (receipt.length <= budget) return { text: receipt, shortened: false };
  const lines = receipt.split("\n");
  const blocks: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("<details>")) {
      const end = lines.findIndex((line, j) => j > i && line.startsWith("</details>"));
      if (end > i) {
        blocks.push({ start: i, end });
        i = end;
      }
    }
  }
  let kept = lines.slice();
  for (const block of blocks.reverse()) {
    kept = kept.slice(0, block.start).concat(kept.slice(block.end + 1));
    const text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
    if (text.length + SHORTENED.length + 2 <= budget) return { text: `${text}\n\n${SHORTENED}`, shortened: true };
  }
  const room = Math.max(0, budget - SHORTENED.length - 2);
  let text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  if (text.length > room) {
    const cut = text.lastIndexOf("\n", room);
    text = text.slice(0, cut > 0 ? cut : room);
  }
  return { text: `${text}\n\n${SHORTENED}`, shortened: true };
}

export interface ComposedBody {
  body: string;
  receiptShortened: boolean;
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

/** Closes anything the description leaves open (an HTML comment, a code fence, <details>, <pre>), so text
 *  appended after it is shown as written rather than hidden or turned into code. */
export function closeOpenBlocks(text: string): string {
  let out = text;
  if (out.lastIndexOf("<!--") > out.lastIndexOf("-->")) out += " -->";
  if (count(out, /^ {0,3}```/gm) % 2 === 1) out += "\n```";
  if (count(out, /^ {0,3}~~~/gm) % 2 === 1) out += "\n~~~";
  const pre = count(out, /<pre\b[^>]*>/gi) - count(out, /<\/pre>/gi);
  if (pre > 0) out += "\n" + "</pre>".repeat(Math.min(pre, 50));
  const details = count(out, /<details\b[^>]*>/gi) - count(out, /<\/details>/gi);
  if (details > 0) out += "\n" + "</details>".repeat(Math.min(details, 50));
  return out;
}

/** The user's description, then a rule, the fixed link line and the engine's receipt Markdown. */
export function composeBody(description: string, receipt?: { markdown: string; link: ReceiptLink }): ComposedBody {
  const raw = plainText(description, MAX_DESCRIPTION).trim();
  if (!receipt || !receipt.markdown.trim()) return { body: raw, receiptShortened: false };
  const text = closeOpenBlocks(raw);
  const head = `${text ? text + "\n\n" : ""}---\n\n${receiptLinkLine(receipt.link)}\n\n`;
  const fitted = fitReceipt(receipt.markdown.trim(), Math.max(0, BODY_BUDGET - head.length));
  return { body: head + fitted.text, receiptShortened: fitted.shortened };
}

/** A comment carrying a turn's receipt onto an existing pull request. */
export function composeReceiptComment(receipt: { markdown: string; link: ReceiptLink }): ComposedBody {
  const head = `${receiptLinkLine(receipt.link)}\n\n`;
  const fitted = fitReceipt(receipt.markdown.trim(), BODY_BUDGET - head.length);
  return { body: head + fitted.text, receiptShortened: fitted.shortened };
}
