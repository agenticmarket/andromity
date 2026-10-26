export type CommandRiskLevel = "danger" | "warn" | "info";

export interface CommandRisk {
  level: CommandRiskLevel;
  label: string;
}

// Injected into webviews with toString(), and production builds rename identifiers, so these
// may only use their parameters and built-ins.

/** Plain-language reasons a shell command deserves a closer look before it is approved. */
export function describeCommandRisks(command: string): CommandRisk[] {
  if (typeof command !== "string" || !command.trim()) return [];
  const cmd = command.replace(/\r\n?/g, "\n");
  const rules: [string, string, RegExp][] = [
    ["danger", "Deletes files recursively", /(?:^|[\s;&|(/\\])rm\s+(?:[^\n;&|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|\bRemove-Item\b[^\n;&|]*\s-Recurse\b|(?:^|[\s;&|(])(?:rmdir|rd|del|erase)\s+(?:[^\n;&|]*\s)?\/[sS]\b|\bshutil\.rmtree\b/i],
    ["danger", "Downloads and runs a script", /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|dash|python3?|node|perl|ruby|iex|Invoke-Expression|pwsh|powershell)\b|\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n]*?(?:&&|;|\n)[^\n]*?(?:(?:^|[\s;&|(])(?:sh|bash|zsh|python3?|node|pwsh|powershell)\s+[^\s;&|]+\.(?:sh|py|js|ps1)\b|chmod\s+\+x|(?:^|[\s;&|(])\.[/\\][^\s;&|]+)/i],
    ["danger", "Runs with elevated privileges", /(?:^|[\s;&|(])(?:sudo|doas|runas|su)\s|-Verb\s+RunAs\b/i],
    ["danger", "Force-pushes over remote history", /\bgit\s+push\b[^\n;&|]*\s(?:--force(?:-with-lease)?|-f)\b|\bgit\s+push\b[^\n;&|]*\s\+[\w./-]+/],
    ["danger", "Discards uncommitted changes", /\bgit\s+reset\s+(?:[^\n;&|]*\s)?--hard\b|\bgit\s+clean\s+-[a-zA-Z]*[fdx]|\bgit\s+checkout\s+(?:[^\n;&|]*\s)?--\s+\.(?:\s|$)|\bgit\s+restore\s+(?:[^\n;&|]*\s)?\.(?:\s|$)/],
    ["danger", "Overwrites a disk or file system", /\bdd\s+[^\n;&|]*\bof=\/dev\/|\bmkfs(?:\.\w+)?\b|(?:^|[\s;&|(])format\s+[a-zA-Z]:|\bdiskpart\b|\bFormat-Volume\b/i],
    ["warn", "Pushes or publishes outside this machine", /\bgit\s+push\b|\b(?:npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bvsce\s+publish\b|\bgh\s+release\s+create\b/],
    ["warn", "Sends data over the network", /\bcurl\b[^\n;&|]*\s(?:-d|--data(?:-[a-z]+)?|-F|--form|-T|--upload-file|-X\s*(?:POST|PUT|PATCH))\b|\bwget\b[^\n;&|]*--post-(?:data|file)\b|\bInvoke-(?:WebRequest|RestMethod)\b[^\n;&|]*-Method\s+(?:Post|Put|Patch)\b|(?:^|[\s;&|(])(?:nc|ncat|netcat|scp)\s/i],
    ["warn", "Reads secrets or credentials", /(?:^|[\s"'=/\\])\.env(?![.\w-]*example)(?:\.[\w-]+)?(?=$|[\s"';&|])|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|[/\\]\.ssh[/\\]|\.aws[/\\]credentials|\.(?:npmrc|pypirc|netrc|git-credentials)\b|\.docker[/\\]config\.json|\.kube[/\\]config|\bprintenv\b/i],
    ["warn", "Evaluates code built at run time", /(?:^|[\s;&|(])(?:eval|iex|Invoke-Expression)\b/i],
    ["warn", "Stops running processes", /(?:^|[\s;&|(])(?:kill|pkill|killall|taskkill)\s|\bStop-Process\b/i],
    ["warn", "Changes system-wide settings", /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b[^\n;&|]*\s(?:-g|--global)\b|\bgit\s+config\s+--(?:global|system)\b|\bsetx\b|\breg(?:\.exe)?\s+(?:add|delete|import)\b|\bSet-ExecutionPolicy\b|\bcrontab\b|\bsystemctl\s+(?:enable|disable|start|stop|restart)\b|\bchmod\s+(?:-R\s+)?[0-7]?777\b/i],
    ["info", "Installs packages, which can run their install scripts", /\b(?:npm|pnpm|bun)\s+(?:i|install|add|ci)\b|\byarn\s+(?:add|install)\b|\bpip3?\s+install\b|\buv\s+(?:add|pip\s+install)\b|\bcargo\s+(?:add|install)\b|\bgo\s+(?:get|install)\b|\bgem\s+install\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b|\b(?:choco|winget)\s+install\b/i],
    ["info", "Substitutes the output of another command", /\$\(|`[^`]+`/],
  ];
  const found: CommandRisk[] = [];
  for (const [level, label, pattern] of rules) {
    if (pattern.test(cmd)) found.push({ level: level as CommandRiskLevel, label });
  }
  const has = (label: string) => found.some(r => r.label === label);
  if (has("Reads secrets or credentials") && has("Sends data over the network")) {
    found.unshift({ level: "danger", label: "May send secrets off this machine" });
  }
  let segments = 1;
  let quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"') i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "\\") { i++; continue; }
    if (ch === ";" || ch === "\n") { segments++; continue; }
    if (ch === "&" || ch === "|") {
      if (cmd[i + 1] === ch) i++;
      else if (ch === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) continue;
      segments++;
    }
  }
  const trailing = cmd.trim().replace(/[;&\s]+$/, "") !== cmd.trim();
  if (trailing) segments--;
  if (segments > 1) found.push({ level: "info", label: "Runs " + segments + " commands in a row" });
  const rank: Record<string, number> = { danger: 0, warn: 1, info: 2 };
  return found.sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * Whether an approval for this command can be remembered. The server never allowlists a
 * command that contains shell control characters, so offering to remember one would only
 * store a rule that never matches.
 */
export function canRememberCommand(command: string): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  return !/[;&|`$(){}<>\n\r%^\x00]/.test(command.trim());
}

const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const HIDDEN_CHARACTERS_ALL = new RegExp(HIDDEN_CHARACTERS.source, "g");
const OFFSCREEN_GAP = /[ \t]{16,}(?=\S)/;

/** Text a reader cannot see: invisible or direction-changing characters, or a long gap that pushes the rest off screen. */
export function hasHiddenContent(command: string): boolean {
  return typeof command === "string" && (HIDDEN_CHARACTERS.test(command) || OFFSCREEN_GAP.test(command));
}

/** The command with every hidden character and long gap spelled out. */
export function revealHiddenContent(command: string): string {
  if (typeof command !== "string") return "";
  return command
    .replace(HIDDEN_CHARACTERS_ALL, (ch) => "<U+" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") + ">")
    .replace(/[ \t]{16,}(?=\S)/g, (run) => " <" + run.length + " blank characters> ");
}

export function getCommandRiskScript(): string {
  return `const describeCommandRisks = ${describeCommandRisks.toString()};\n`
    + `const canRememberCommand = ${canRememberCommand.toString()};\n`;
}
