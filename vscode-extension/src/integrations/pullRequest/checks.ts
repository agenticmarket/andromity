import { findSecrets } from "../../secretScan.js";

export const DEFAULT_SIZE_WARNING_LINES = 300;
export const MAX_REVIEWERS = 10;
/** Files larger than this are not read for the secret scan; the scan says which were skipped. */
export const MAX_SCAN_BYTES = 5 * 1024 * 1024;

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "cargo.lock",
  "poetry.lock", "uv.lock", "pipfile.lock", "gemfile.lock", "composer.lock", "go.sum", "packages.lock.json", "pdm.lock",
]);

export function isLockfile(path: string): boolean {
  const base = path.split(/[\\/]/).pop() || "";
  return LOCKFILES.has(base.toLowerCase());
}

export interface SizedFile {
  path: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface SizeSummary {
  lines: number;
  files: number;
  lockfiles: string[];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function sizeOf(files: readonly SizedFile[]): SizeSummary {
  let lines = 0;
  const lockfiles: string[] = [];
  for (const file of files) {
    if (isLockfile(file.path)) {
      lockfiles.push(file.path);
      continue;
    }
    lines += count(file.additions) + count(file.deletions);
  }
  return { lines, files: files.length, lockfiles };
}

/** The configured limit: a positive whole number, 0 to turn the warning off, else the default. */
export function sizeWarningLimit(setting: unknown): number {
  if (typeof setting !== "number" || !Number.isFinite(setting) || setting < 0) return DEFAULT_SIZE_WARNING_LINES;
  return Math.min(Math.floor(setting), 1_000_000);
}

export type SecretPlace = "file" | "commit_message" | "title" | "description";

/** A found secret, described without any part of its value. */
export interface SecretHit {
  place: SecretPlace;
  kind: string;
  path?: string;
  line?: number;
}

/** Lines a unified diff adds, with their line numbers in the new file. */
export function addedLines(diff: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let next = 0;
  let inHunk = false;
  for (const raw of diff.split(/\r?\n/)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      next = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ line: next, text: raw.slice(1) });
      next++;
    } else if (raw.startsWith(" ")) {
      next++;
    } else if (raw.startsWith("\\")) {
      continue;
    } else if (!raw.startsWith("-") && raw !== "") {
      inHunk = false;
    }
  }
  return out;
}

function hitsIn(text: string, lineOf: (offset: number) => number | undefined, place: SecretPlace, path?: string): SecretHit[] {
  const seen = new Set<string>();
  const hits: SecretHit[] = [];
  for (const found of findSecrets(text)) {
    const line = lineOf(found.start);
    const key = `${found.label}:${line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ place, kind: found.label, path, line });
  }
  return hits;
}

function lineIndex(starts: number[], numbers: number[], offset: number): number | undefined {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 ? numbers[hi] : undefined;
}

/** Secrets on lines a diff adds. Lines already in the base are not new and are not reported. */
export function secretsInDiff(path: string, diff: string): SecretHit[] {
  const lines = addedLines(diff);
  if (!lines.length) return [];
  const starts: number[] = [];
  const numbers: number[] = [];
  let text = "";
  for (const entry of lines) {
    starts.push(text.length);
    numbers.push(entry.line);
    text += entry.text + "\n";
  }
  return hitsIn(text, (offset) => lineIndex(starts, numbers, offset), "file", path);
}

function wholeTextHits(text: string, place: SecretPlace, path?: string): SecretHit[] {
  if (!text) return [];
  const starts: number[] = [0];
  const numbers: number[] = [1];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
      numbers.push(numbers.length + 1);
    }
  }
  return hitsIn(text, (offset) => lineIndex(starts, numbers, offset), place, path);
}

/** Secrets anywhere in a whole file (used when its diff is too large to show). */
export function secretsInFile(path: string, content: string): SecretHit[] {
  return wholeTextHits(content, "file", path);
}

export function secretsInText(place: Exclude<SecretPlace, "file">, text: string): SecretHit[] {
  return wholeTextHits(text, place);
}

/** True when the bytes look like a binary file (a NUL in the first 8 KB). */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export interface ReviewerChoice {
  reviewers: string[];
  teams: string[];
  problems: string[];
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const TEAM_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** People as GitHub user names (with or without @) and teams as org/team, checked before anything is sent. */
export function chooseReviewers(entries: readonly unknown[], owner: string, self: string | undefined): ReviewerChoice {
  const reviewers: string[] = [];
  const teams: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().replace(/^@/, "");
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (value.includes("/")) {
      const [org, slug, ...rest] = value.split("/");
      if (rest.length || !LOGIN.test(org) || !TEAM_SLUG.test(slug)) {
        problems.push(`"${value.slice(0, 60)}" isn't a team name like org/team.`);
      } else if (org.toLowerCase() !== owner.toLowerCase()) {
        problems.push(`${value} isn't a team in ${owner}.`);
      } else {
        teams.push(slug);
      }
      continue;
    }
    if (!LOGIN.test(value)) {
      problems.push(`"${value.slice(0, 60)}" isn't a GitHub user name.`);
    } else if (self && key === self.toLowerCase()) {
      problems.push("You can't ask yourself for a review.");
    } else {
      reviewers.push(value);
    }
  }
  if (reviewers.length + teams.length > MAX_REVIEWERS) {
    problems.push(`Ask at most ${MAX_REVIEWERS} people or teams.`);
  }
  return { reviewers, teams, problems };
}

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** People and teams the text will notify (@name), outside code. */
export function mentionsIn(text: string): string[] {
  const out = new Set<string>();
  const re = /(^|[^A-Za-z0-9_`@/.])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?)/g;
  let match: RegExpExecArray | null;
  const plain = withoutCode(text);
  while ((match = re.exec(plain)) !== null) {
    out.add("@" + match[2]);
    if (out.size >= 20) break;
  }
  return [...out];
}

/** Issues GitHub will close when this merges ("Fixes #12", "closes org/repo#3"), outside code. */
export function closedIssuesIn(text: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[0-9]+)\b/gi;
  let match: RegExpExecArray | null;
  const plain = withoutCode(text);
  while ((match = re.exec(plain)) !== null) {
    out.add(match[1]);
    if (out.size >= 20) break;
  }
  return [...out];
}
