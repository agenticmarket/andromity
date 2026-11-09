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
  /** No turn was handed over, so the turn was found by its changes ("exact": its line counts are still in
   *  these files) or only by file names ("names": the files also have other changes). */
  matched?: "exact" | "names";
  commitSha?: string;
  /** Files the turn changed that this pull request leaves out. */
  leftOut: readonly string[];
  /** Files this pull request commits that the turn did not change. */
  extra: readonly string[];
}

/** The line written by fixed code that ties a receipt to the commit it ships in. */
export function receiptLinkLine(link: ReceiptLink): string {
  const sha = link.commitSha && /^[0-9a-f]{7,64}$/.test(link.commitSha) ? `, committed as ${mdCode(link.commitSha.slice(0, 7))}` : "";
  const how = link.matched === "exact" ? ", found by matching the changed files"
    : link.matched === "names" ? ", found by file name; these files also have changes this receipt does not cover" : "";
  const parts = [`Receipt for Andromity turn ${Math.trunc(link.turnIndex) + 1}${how}${sha}.`];
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
  let fence: { char: string; length: number } | null = null;
  const outside: string[] = [];
  for (const line of text.split("\n")) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    outside.push(line);
  }
  let out = text;
  if (fence) out += "\n" + fence.char.repeat(fence.length);
  const prose = outside.join("\n");
  if (prose.lastIndexOf("<!--") > prose.lastIndexOf("-->")) out += "\n-->";
  const pre = count(prose, /<pre\b[^>]*>/gi) - count(prose, /<\/pre>/gi);
  if (pre > 0) out += "\n" + "</pre>".repeat(Math.min(pre, 50));
  const details = count(prose, /<details\b[^>]*>/gi) - count(prose, /<\/details>/gi);
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

export interface ProvenanceRow {
  path: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  coverage: "covered" | "partial" | "edited" | "none";
  /** "turn 2 · chat 1" labels, newest first. */
  turns: string[];
}

export interface ProvenanceReceipt {
  label: string;
  files: number;
  needsEyes: boolean;
  markdown: string;
}

export interface Provenance {
  rows: ProvenanceRow[];
  totals: { files: number; covered: number; partial: number; edited: number };
  receipts: ProvenanceReceipt[];
  /** Receipts that were found but couldn't be loaded or didn't fit. */
  missing: string[];
  head: string;
  truncated: boolean;
}

const MAX_TABLE_ROWS = 100;
export const PROVENANCE_START = "<!-- andromity-receipts -->";
export const PROVENANCE_END = "<!-- /andromity-receipts -->";

function source(row: ProvenanceRow): string {
  const shown = row.turns.slice(0, 4).reverse();
  const turns = (row.turns.length > 4 ? `${row.turns.length - 4} earlier turns, then ` : "") + shown.join(", then ");
  if (row.coverage === "covered") return row.turns.length > 1 ? `${turns}, with nothing in between` : `${turns}, as the turn left it`;
  if (row.coverage === "partial") return `${turns}; earlier changes have no receipt`;
  if (row.coverage === "edited") return `${turns}, then changed outside Andromity`;
  return "No Andromity receipt found on this computer";
}

function counts(row: ProvenanceRow): string {
  if (row.binary) return "binary";
  return `+${row.additions ?? 0} −${row.deletions ?? 0}`;
}

/** The pull request's receipts section, written by fixed code: which turn produced each file, then each turn's receipt. */
export function composeProvenance(provenance: Provenance, budget: number): { text: string; shortened: boolean } {
  const { rows, totals } = provenance;
  const head = /^[0-9a-f]{7,64}$/.test(provenance.head) ? mdCode(provenance.head.slice(0, 7)) : "the pushed commit";
  const lines = [
    PROVENANCE_START,
    "---",
    "",
    `**Andromity receipts** · ${plural(totals.files, "file", "files")} in this pull request · covered by a receipt: **${totals.covered} of ${totals.files}**`
      + (totals.partial ? ` · partly: ${totals.partial}` : "") + (totals.edited ? ` · changed after their turn: ${totals.edited}` : ""),
    "",
    "| File | Lines | Made by |",
    "|---|---|---|",
  ];
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    const name = row.oldPath ? `${mdCode(row.oldPath)} → ${mdCode(row.path)}` : mdCode(row.path);
    const cell = (value: string) => value.replace(/\|/g, "\\|");
    lines.push(`| ${cell(name)} | ${counts(row)} | ${cell(source(row))} |`);
  }
  const rest = rows.slice(MAX_TABLE_ROWS);
  if (rest.length || provenance.truncated) {
    const covered = rest.filter((row) => row.coverage === "covered").length;
    lines.push("", `<sub>And ${plural(rest.length, "more file", "more files")}${provenance.truncated ? " (the list stops at 3,000)" : ""}: ${covered} covered by a receipt.</sub>`);
  }
  lines.push("", `<sub>Matched by file contents against the turns recorded on the computer that opened this pull request, as of ${head}. A file counts as covered only when every change since the base branch was made in turns that have a receipt.</sub>`);
  let text = lines.join("\n");
  const close = `\n\n${PROVENANCE_END}`;
  let shortened = false;
  const left: string[] = [...provenance.missing];
  for (const receipt of provenance.receipts) {
    const summary = `Receipt · ${receipt.label} · ${plural(receipt.files, "file", "files")}${receipt.needsEyes ? " · needs your eyes" : ""}`;
    const opener = `\n\n<details><summary>${summary}</summary>\n\n`;
    const room = budget - text.length - close.length - opener.length - "\n\n</details>".length - 200;
    if (room < 400) {
      left.push(receipt.label);
      continue;
    }
    const fitted = fitReceipt(closeOpenBlocks(receipt.markdown.trim()), room);
    if (fitted.shortened) shortened = true;
    text += `${opener}${fitted.text}\n\n</details>`;
  }
  if (left.length) {
    text += `\n\n<sub>Not attached here: ${left.slice(0, 10).join(", ")}${left.length > 10 ? ` and ${left.length - 10} more` : ""}. They are in Andromity's receipt tab.</sub>`;
    shortened = true;
  }
  return { text: text + close, shortened };
}
