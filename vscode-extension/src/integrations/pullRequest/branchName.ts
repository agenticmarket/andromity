export const DEFAULT_BRANCH_PREFIX = "andromity/";
export const MAX_BRANCH_LENGTH = 100;
const SLUG_LENGTH = 48;

/** Git's branch-name rules plus a stricter character set, so a name is never read as an option,
 *  a revision expression or a path outside refs/heads. */
export function isValidBranchName(name: unknown): name is string {
  if (typeof name !== "string" || !name || name.length > MAX_BRANCH_LENGTH) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name === "HEAD" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("//")) return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.toLowerCase().endsWith(".lock"));
}

/** The configured prefix if it makes valid branch names, else the default. An empty prefix is allowed. */
export function branchPrefix(setting: unknown): string {
  if (setting === "") return "";
  if (typeof setting !== "string") return DEFAULT_BRANCH_PREFIX;
  const prefix = setting.trim();
  if (!prefix) return "";
  return prefix.length <= 40 && isValidBranchName(prefix + "x") ? prefix : DEFAULT_BRANCH_PREFIX;
}

function cut(slug: string): string {
  if (slug.length <= SLUG_LENGTH) return slug;
  const head = slug.slice(0, SLUG_LENGTH + 1);
  const at = head.lastIndexOf("-");
  return (at >= 12 ? head.slice(0, at) : slug.slice(0, SLUG_LENGTH)).replace(/-+$/, "");
}

/** `fix(orders): Round totals!` gives `round-totals`. The conventional-commit type is dropped. */
export function slugFromSubject(subject: unknown): string {
  if (typeof subject !== "string") return "";
  const firstLine = subject.split(/\r?\n/, 1)[0] || "";
  const text = firstLine.replace(/^\s*[A-Za-z]+(?:\([^)]*\))?!?:\s*/, "");
  const slug = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cut(slug);
}

function slugFromFiles(files: readonly string[]): string {
  const first = files.find((file) => typeof file === "string" && file.trim());
  if (!first) return "changes";
  const base = first.split(/[\\/]/).pop() || "";
  const stem = base.replace(/\.[^.]+$/, "") || base;
  const slug = slugFromSubject(`update ${stem}`);
  return slug || "changes";
}

export function suggestBranchName(prefix: string, subject: string | undefined, files: readonly string[]): string {
  const slug = slugFromSubject(subject) || slugFromFiles(files);
  const name = `${prefix}${slug}`;
  return isValidBranchName(name) ? name : `${DEFAULT_BRANCH_PREFIX}changes`;
}

/** `name`, or `name-2`, `name-3` … the first one `taken` says is free. Gives up after 50 tries. */
export async function firstFreeName(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string | null> {
  for (let n = 1; n <= 50; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = name.length + suffix.length > MAX_BRANCH_LENGTH ? name.slice(0, MAX_BRANCH_LENGTH - suffix.length).replace(/[-./]+$/, "") + suffix : name + suffix;
    if (!isValidBranchName(candidate)) return null;
    if (!(await taken(candidate))) return candidate;
  }
  return null;
}
