export type ShellFamily = "posix" | "powershell" | "cmd";

export const SHELL_LANGUAGES: Readonly<Record<string, ShellFamily>> = {
  bash: "posix",
  sh: "posix",
  shell: "posix",
  shellscript: "posix",
  zsh: "posix",
  fish: "posix",
  console: "posix",
  terminal: "posix",
  powershell: "powershell",
  pwsh: "powershell",
  ps1: "powershell",
  ps: "powershell",
  cmd: "cmd",
  bat: "cmd",
  batch: "cmd",
};

export function shellFamilyForLanguage(lang: string | undefined): ShellFamily | undefined {
  const key = String(lang || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SHELL_LANGUAGES, key) ? SHELL_LANGUAGES[key] : undefined;
}

const PROMPT_PATTERNS: Record<ShellFamily, RegExp> = {
  posix: /^\$ /,
  powershell: /^PS(?: [^>]*)?> /,
  cmd: /^[A-Za-z]:\\[^>]*> /,
};

/**
 * Strips copy-paste prompts ("$ ", "PS C:\> ", "C:\> ") only when every
 * non-empty line carries one; otherwise the block may mix commands with
 * output and is sent as written.
 */
export function normalizeShellCommand(code: string, family: ShellFamily): string {
  const lines = String(code || "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const prompt = PROMPT_PATTERNS[family];
  const nonEmpty = lines.filter((line) => line.trim());
  if (nonEmpty.length && nonEmpty.every((line) => prompt.test(line))) {
    return lines.map((line) => line.replace(prompt, "")).join("\n");
  }
  return lines.join("\n");
}

function shellBaseName(shellPath: string): string {
  const base = shellPath.split(/[\\/]/).pop() || "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Picks the shell for a block. `undefined` means the user's default terminal
 * profile; `null` means the block cannot run on this platform.
 */
export function resolveShellPath(
  family: ShellFamily,
  platform: NodeJS.Platform,
  defaultShell: string
): string | undefined | null {
  const current = shellBaseName(defaultShell);
  if (family === "posix") return undefined;
  if (family === "powershell") {
    if (current === "pwsh" || current === "powershell") return undefined;
    return platform === "win32" ? "powershell.exe" : "pwsh";
  }
  if (platform !== "win32") return null;
  return current === "cmd" ? undefined : "cmd.exe";
}
