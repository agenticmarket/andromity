import type { Receipt } from "../../providers/receipt/types.js";
import { mdCode, plainText } from "./body.js";

/** One turn's receipt, keyed by chat and turn. */
export interface RecordTurn {
  key: string;
  receipt: Receipt;
}

export interface RecordFile {
  path: string;
  coverage: "covered" | "partial" | "edited" | "none";
  /** Keys of the turns that changed this file. */
  turns: string[];
}

export interface RecordItem {
  severity: "high" | "medium";
  detail: string;
  subject?: string;
  decidedBy?: string;
}

export interface ChangeRecord {
  head: string;
  /** "pull_request": every file of the pushed pull request was matched; "turn": only the form's own turn. */
  scope: "pull_request" | "turn";
  files: { total: number; withAi: number; modifiedOutside: string[]; notRecorded: string[] };
  models: string[];
  modes: string[];
  approvals: { approved: number; declined: number; blocked: number };
  checks: { command: string; passed: boolean; exitCode: number | null }[];
  noCheckAfter: string[];
  commands: { total: number; failed: number };
  webHosts: string[];
  webSearches: number;
  mcpServers: string[];
  subagents: number;
  items: RecordItem[];
  /** The pull request lists more files than were matched. */
  truncated: boolean;
  /** Fixed sentences about how the files were matched, shown under the table. */
  notes: string[];
}

const SKIPPED_FINDINGS = new Set(["large_change", "long_command"]);
const MAX_ITEMS = 15;
const MAX_LISTED = 10;
const MAX_COMMAND = 200;

/** When the turn ended, or NaN when its receipt doesn't say. */
function ended(receipt: Receipt): number {
  const value = receipt.ended_at ?? receipt.started_at;
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function byTime(a: RecordTurn, b: RecordTurn): number {
  const x = ended(a.receipt);
  const y = ended(b.receipt);
  return (Number.isFinite(x) ? x : 0) - (Number.isFinite(y) ? y : 0);
}

function addUnique(list: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const clean = plainText(value, 500).trim();
  if (clean && !list.includes(clean)) list.push(clean);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function commandKey(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? plainText(value, limit) : "";
}

/** The record of the pull request, from its files and the receipts of the turns that made them. `later` are receipts
 *  of turns that changed none of its files; only their checks count. `unread` is how many receipts couldn't be read;
 *  `skipped` how many turns weren't asked for because of the limit. */
export function buildChangeRecord(input: {
  head: string;
  scope: ChangeRecord["scope"];
  files: RecordFile[];
  turns: RecordTurn[];
  later?: RecordTurn[];
  unread?: number;
  skipped?: number;
  truncated?: boolean;
  notes?: string[];
}): ChangeRecord {
  const byKey = new Map(input.turns.map((turn) => [turn.key, turn.receipt]));
  const turns = [...input.turns].sort(byTime);
  const withChecks = [...input.turns, ...(input.later ?? [])].sort(byTime);

  const unique = new Map<string, RecordFile>();
  for (const file of input.files) {
    const path = text(file?.path, 1000).trim();
    if (!path) continue;
    const known = unique.get(path);
    const turnsOf = Array.isArray(file.turns) ? file.turns.filter((key) => typeof key === "string") : [];
    if (!known) unique.set(path, { path, coverage: file.coverage, turns: turnsOf });
    else known.turns = [...new Set([...known.turns, ...turnsOf])];
  }
  const allFiles = [...unique.values()];
  const withAi = allFiles.filter((file) => file.coverage === "covered" || file.coverage === "partial" || file.coverage === "edited");
  const files = {
    total: allFiles.length,
    withAi: withAi.length,
    modifiedOutside: allFiles.filter((file) => file.coverage === "partial" || file.coverage === "edited").map((file) => file.path),
    notRecorded: allFiles.filter((file) => !withAi.includes(file)).map((file) => file.path),
  };

  const models: string[] = [];
  const modes: string[] = [];
  const webHosts: string[] = [];
  const mcpServers: string[] = [];
  const approvals = { approved: 0, declined: 0, blocked: 0 };
  const commands = { total: 0, failed: 0 };
  let webSearches = 0;
  let subagents = 0;
  let resealed = 0;
  for (const { receipt } of turns) {
    for (const model of Array.isArray(receipt.models) ? receipt.models : []) addUnique(models, model);
    addUnique(modes, receipt.mode);
    for (const host of Array.isArray(receipt.web_hosts) ? receipt.web_hosts : []) addUnique(webHosts, host);
    for (const server of Array.isArray(receipt.mcp_servers) ? receipt.mcp_servers : []) addUnique(mcpServers, server);
    const summary = (receipt.summary && typeof receipt.summary === "object" ? receipt.summary : {}) as Partial<Receipt["summary"]>;
    approvals.approved += count(summary.approved_by_person);
    approvals.declined += Math.max(count(summary.denied), count(summary.denied_by_person));
    approvals.blocked += count(summary.blocked);
    commands.total += count(summary.commands);
    commands.failed += count(summary.commands_failed);
    webSearches += count(summary.web_searches);
    subagents += count(summary.subagents);
    if (receipt.sealed && receipt.sealed.matches === false) resealed++;
  }

  const checksByCommand = new Map<string, ChangeRecord["checks"][number]>();
  const checkTimes: number[] = [];
  for (const { receipt } of withChecks) {
    let added = false;
    for (const check of Array.isArray(receipt.checks) ? receipt.checks : []) {
      if (!check || typeof check.command !== "string" || !check.command.trim()) continue;
      const command = plainText(check.command, 2000);
      const key = commandKey(command);
      checksByCommand.delete(key);
      checksByCommand.set(key, { command, passed: check.result === "passed", exitCode: Number.isSafeInteger(check.exit_code) ? check.exit_code : null });
      added = true;
    }
    const time = ended(receipt);
    if (added && Number.isFinite(time)) checkTimes.push(time);
  }
  const checks = [...checksByCommand.values()];
  const noCheckAfter = checks.length
    ? withAi.filter((file) => {
      const receipts = file.turns.map((key) => byKey.get(key));
      if (!receipts.length || receipts.some((receipt) => !receipt)) return true;
      const times = (receipts as Receipt[]).map(ended);
      if (times.some((time) => !Number.isFinite(time))) return true;
      const last = Math.max(...times);
      return !checkTimes.some((time) => time >= last);
    }).map((file) => file.path)
    : [];

  const items: RecordItem[] = [];
  const seen = new Set<string>();
  for (const { receipt } of turns) {
    const names = new Map<string, string>();
    for (const person of Array.isArray(receipt.approvers) ? receipt.approvers : []) {
      if (person && typeof person.id === "string" && typeof person.name === "string") names.set(person.id, person.name);
    }
    for (const finding of Array.isArray(receipt.needs_attention) ? receipt.needs_attention : []) {
      if (!finding || typeof finding !== "object" || typeof finding.kind !== "string" || SKIPPED_FINDINGS.has(finding.kind)) continue;
      if (finding.severity !== "high" && finding.severity !== "medium") continue;
      const detail = text(finding.detail, 300).trim();
      if (!detail) continue;
      const subject = text(finding.subject, 2000);
      if (finding.kind === "check_failed" && subject && checksByCommand.get(commandKey(subject))?.passed) continue;
      const key = `${finding.kind}\u0000${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const decidedBy = typeof finding.approver === "string" ? names.get(finding.approver) : undefined;
      items.push({
        severity: finding.severity,
        detail,
        ...(subject ? { subject } : {}),
        ...(decidedBy ? { decidedBy: plainText(decidedBy, 100) } : {}),
      });
    }
  }
  if (resealed) items.push({ severity: "high", detail: resealed === 1 ? "The record of 1 turn differs from the copy sealed when the turn ended" : `The records of ${resealed} turns differ from the copies sealed when the turns ended` });
  if (input.unread) items.push({ severity: "high", detail: `The records of ${input.unread} ${input.unread === 1 ? "turn" : "turns"} could not be read, so they are not included` });
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));

  const notes = [...(input.notes ?? [])];
  if (input.skipped) notes.push(`${input.skipped} ${input.skipped === 1 ? "turn is" : "turns are"} not included because a record covers at most 60 turns.`);

  return {
    head: input.head,
    scope: input.scope,
    files,
    models,
    modes,
    approvals,
    checks,
    noCheckAfter,
    commands,
    webHosts,
    webSearches,
    mcpServers,
    subagents,
    items,
    truncated: input.truncated === true,
    notes,
  };
}

export const RECORD_START = "<!-- andromity-receipts -->";
export const RECORD_END = "<!-- /andromity-receipts -->";

function cell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}

/** Text outside code: no Markdown, HTML, links, images, @mentions or issue references can come out of it. Pipes
 *  are left for `cell`. */
function mdText(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]~()])/g, "\\$1")
    .replace(/@|:\/\/|www\.|#(?=\d)|GH-(?=\d)/gi, (match) => match[0] + "\u200b" + match.slice(1));
}

function cut(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) + "…" : value;
}

function codeList(values: readonly string[], limit: number, length = 300): string {
  const shown = values.slice(0, Math.max(1, limit)).map((value) => mdCode(cut(value, length)));
  const more = values.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

const MODE_NAMES: Record<string, string> = { safe: "Safe", full: "Full", yolo: "YOLO", plan: "Plan", auto: "Auto" };

function modeName(mode: string): string {
  return MODE_NAMES[mode.toLowerCase()] ?? mdCode(cut(mode, 60));
}

function itemLine(item: RecordItem): string {
  const subject = item.subject ? `: ${mdCode(cut(item.subject, MAX_COMMAND))}` : "";
  const decided = item.decidedBy ? ` · decided by ${mdCode(item.decidedBy)} (git user.name, not verified)` : "";
  return `${item.severity === "high" ? "High" : "Medium"} · ${mdText(item.detail)}${subject}${decided}`;
}

function checkLine(check: ChangeRecord["checks"][number]): string {
  return `${mdCode(cut(check.command, MAX_COMMAND))} ${check.passed ? "passed" : "failed"}${check.exitCode === null ? "" : ` (exit ${check.exitCode})`}`;
}

function rows(record: ChangeRecord, limits: { items: number; listed: number }): [string, string][] {
  const out: [string, string][] = [];
  const items = record.items.slice(0, limits.items).map(itemLine);
  if (record.items.length > limits.items) items.push(`and ${record.items.length - limits.items} more in Andromity`);
  if (items.length) out.push(["Items for review", items.join("<br>")]);

  out.push(["Files changed with AI", `${record.files.withAi} of ${record.files.total}`]);
  if (record.files.modifiedOutside.length) out.push(["Modified outside Andromity", codeList(record.files.modifiedOutside, limits.listed)]);
  out.push(["Not recorded by Andromity", record.files.notRecorded.length ? codeList(record.files.notRecorded, limits.listed) : "None"]);

  if (record.models.length) {
    const shown = record.models.slice(0, limits.listed).map((model) => model === "andromity/auto"
      ? `${mdCode(model)} (model selected per request by the Andromity gateway)` : mdCode(cut(model, 120)));
    const more = record.models.length - shown.length;
    out.push(["Models", shown.join(" · ") + (more > 0 ? ` · and ${more} more` : "")]);
  } else {
    out.push(["Models", "Not recorded"]);
  }

  const approvals = record.approvals.approved || record.approvals.declined || record.approvals.blocked
    ? [`Approved by a person: ${record.approvals.approved}`, `Declined: ${record.approvals.declined}`, `Blocked by Andromity: ${record.approvals.blocked}`].join(" · ")
    : "No approvals recorded";
  const modes = record.modes.length
    ? record.modes.slice(0, limits.listed).map(modeName).join(", ") + (record.modes.length > limits.listed ? ` and ${record.modes.length - limits.listed} more` : "")
    : "Not recorded";
  out.push(["Permission mode", `${modes} · ${approvals}`]);

  if (record.checks.length) {
    const ordered = [...record.checks.filter((check) => !check.passed), ...record.checks.filter((check) => check.passed)];
    const shown = ordered.slice(0, limits.listed).map(checkLine);
    const rest = ordered.slice(limits.listed);
    const failedRest = rest.filter((check) => !check.passed).length;
    if (rest.length) shown.push(`and ${rest.length} more${failedRest ? ` (${failedRest} failed)` : ""}`);
    out.push(["Checks", shown.join("<br>")]);
  } else {
    out.push(["Checks", "None recorded"]);
  }
  if (record.noCheckAfter.length) out.push(["No check after last change", codeList(record.noCheckAfter, limits.listed)]);

  out.push(["Commands run", record.commands.total ? `${record.commands.total}${record.commands.failed ? ` · ${record.commands.failed} failed` : ""}` : "None recorded"]);
  const network = [
    ...(record.webHosts.length ? [codeList(record.webHosts, limits.listed, 200)] : []),
    ...(record.webSearches ? [`Web searches: ${record.webSearches}`] : []),
  ];
  out.push(["Network access", network.length ? network.join(" · ") : "None recorded"]);
  const tools = [
    ...(record.mcpServers.length ? [`MCP servers: ${codeList(record.mcpServers, limits.listed, 200)}`] : []),
    ...(record.subagents ? [`Sub-agents: ${record.subagents}`] : []),
  ];
  out.push(["Tools and servers", tools.length ? tools.join(" · ") : "None recorded"]);
  if (!items.length) out.push(["Items for review", "None"]);
  return out;
}

/** The pull request's AI change record, written by fixed code. Never longer than `budget` characters; empty when
 *  even the shortest form doesn't fit. */
export function composeChangeRecord(record: ChangeRecord, budget: number): string {
  const head = /^[0-9a-f]{7,64}$/.test(record.head) ? ` · Commit ${mdCode(record.head.slice(0, 7))}` : "";
  const scope = record.scope === "turn"
    ? "Only the turn this pull request was created from was matched; the pull request's other files were not compared with Andromity's records."
    : "Matched by file contents against Andromity's records on the computer that opened this pull request.";
  const footer = [
    scope,
    ...(record.truncated ? ["The pull request lists more files than were matched."] : []),
    ...record.notes.map(mdText),
    "Approver names come from git settings and are not verified. Per-turn records are in Andromity.",
  ].join(" ");
  for (const limits of [{ items: MAX_ITEMS, listed: MAX_LISTED }, { items: 5, listed: 3 }, { items: 2, listed: 1 }]) {
    const table = rows(record, limits).map(([label, value]) => `| **${label}** | ${cell(value)} |`);
    const out = [RECORD_START, "---", "", `**AI change record** · Generated from Andromity session records${head}`, "", "| | |", "|---|---|", ...table, "", `<sub>${footer}</sub>`, RECORD_END].join("\n");
    if (out.length <= budget) return out;
  }
  const short = [RECORD_START, "---", "", `**AI change record**${head}`, "", "<sub>The record is too long for this pull request. It is in Andromity.</sub>", RECORD_END].join("\n");
  return short.length <= budget ? short : "";
}
