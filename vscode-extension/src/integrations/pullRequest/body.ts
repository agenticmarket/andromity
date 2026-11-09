/** GitHub refuses a pull request or comment body longer than this. */
export const GITHUB_BODY_LIMIT = 65_536;
export const MAX_TITLE = 256;
export const MAX_DESCRIPTION = 60_000;
export const MAX_COMMIT_MESSAGE = 20_000;

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
