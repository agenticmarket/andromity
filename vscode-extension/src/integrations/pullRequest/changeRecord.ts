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

function ended(receipt: Receipt): number {
  const time = Date.parse(receipt.ended_at ?? receipt.started_at ?? "");
  return Number.isFinite(time) ? time : 0;
}

function addUnique(list: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const clean = plainText(value, 500).trim();
  if (clean && !list.includes(clean)) list.push(clean);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function sameCommand(a: string, b: string): boolean {
  return a.split(/\s+/).join(" ") === b.split(/\s+/).join(" ");
}

/** The record of the pull request, from its files and the receipts of the turns that made them. `later` are receipts
 *  of turns that changed none of its files; only their checks count. `unread` is how many receipts couldn't be read. */
export function buildChangeRecord(input: {
  head: string;
  scope: ChangeRecord["scope"];
  files: RecordFile[];
  turns: RecordTurn[];
  later?: RecordTurn[];
  unread?: number;
  truncated?: boolean;
  notes?: string[];
}): ChangeRecord {
  const byKey = new Map(input.turns.map((turn) => [turn.key, turn.receipt]));
  const turns = [...input.turns].sort((a, b) => ended(a.receipt) - ended(b.receipt));
  const withChecks = [...input.turns, ...(input.later ?? [])].sort((a, b) => ended(a.receipt) - ended(b.receipt));

  const withAi = input.files.filter((file) => file.coverage !== "none");
  const files = {
    total: input.files.length,
    withAi: withAi.length,
    modifiedOutside: input.files.filter((file) => file.coverage === "partial" || file.coverage === "edited").map((file) => file.path),
    notRecorded: input.files.filter((file) => file.coverage === "none").map((file) => file.path),
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
    const summary = receipt.summary ?? ({} as Receipt["summary"]);
    approvals.approved += count(summary.approved_by_person);
    approvals.declined += count(summary.denied_by_person);
    approvals.blocked += count(summary.blocked);
    commands.total += count(summary.commands);
    commands.failed += count(summary.commands_failed);
    webSearches += count(summary.web_searches);
    subagents += count(summary.subagents);
    if (receipt.sealed && receipt.sealed.matches === false) resealed++;
  }

  const checks: ChangeRecord["checks"] = [];
  const checkTimes: number[] = [];
  for (const { receipt } of withChecks) {
    for (const check of Array.isArray(receipt.checks) ? receipt.checks : []) {
      if (!check || typeof check.command !== "string" || !check.command.trim()) continue;
      const entry = { command: plainText(check.command, 2000), passed: check.result === "passed", exitCode: Number.isSafeInteger(check.exit_code) ? check.exit_code : null };
      const at = checks.findIndex((existing) => sameCommand(existing.command, entry.command));
      if (at >= 0) checks.splice(at, 1);
      checks.push(entry);
    }
    if ((Array.isArray(receipt.checks) ? receipt.checks : []).length) checkTimes.push(ended(receipt));
  }
  const noCheckAfter = checks.length
    ? withAi.filter((file) => {
      const last = Math.max(...file.turns.map((key) => byKey.get(key)).filter((r): r is Receipt => !!r).map(ended), 0);
      return !checkTimes.some((time) => time >= last);
    }).map((file) => file.path)
    : [];

  const items: RecordItem[] = [];
  const seen = new Set<string>();
  for (const { receipt } of turns) {
    const names = new Map((Array.isArray(receipt.approvers) ? receipt.approvers : []).map((person) => [person.id, person.name]));
    for (const finding of Array.isArray(receipt.needs_attention) ? receipt.needs_attention : []) {
      if (!finding || SKIPPED_FINDINGS.has(finding.kind) || (finding.severity !== "high" && finding.severity !== "medium")) continue;
      if (finding.kind === "check_failed" && finding.subject && checks.some((check) => check.passed && sameCommand(check.command, finding.subject as string))) continue;
      const key = `${finding.kind}\u0000${finding.subject ?? ""}\u0000${finding.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const decidedBy = finding.approver ? names.get(finding.approver) : undefined;
      items.push({
        detail: plainText(finding.detail, 300),
        ...(finding.subject ? { subject: plainText(finding.subject, 2000) } : {}),
        ...(decidedBy ? { decidedBy: plainText(decidedBy, 100) } : {}),
      });
    }
  }
  if (resealed) items.push({ detail: resealed === 1 ? "The record of 1 turn differs from the copy sealed when the turn ended" : `The records of ${resealed} turns differ from the copies sealed when the turns ended` });
  if (input.unread) items.push({ detail: `The records of ${input.unread} ${input.unread === 1 ? "turn" : "turns"} could not be read, so they are not included` });

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
    notes: [...(input.notes ?? [])],
  };
}

export const RECORD_START = "<!-- andromity-receipts -->";
export const RECORD_END = "<!-- /andromity-receipts -->";

function cell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}

function codeList(values: readonly string[], limit: number, cut = 300): string {
  const shown = values.slice(0, limit).map((value) => mdCode(value.length > cut ? value.slice(0, cut) + "…" : value)).join(", ");
  return values.length > limit ? `${shown} and ${values.length - limit} more` : shown;
}

const MODE_NAMES: Record<string, string> = { safe: "Safe", full: "Full", yolo: "YOLO", plan: "Plan", auto: "Auto" };

function modeName(mode: string): string {
  return MODE_NAMES[mode.toLowerCase()] ?? mode;
}

function itemLine(item: RecordItem): string {
  const subject = item.subject ? `: ${mdCode(item.subject.length > MAX_COMMAND ? item.subject.slice(0, MAX_COMMAND) + "…" : item.subject)}` : "";
  const decided = item.decidedBy ? ` · decided by ${item.decidedBy} (git user.name, not verified)` : "";
  return `${item.detail}${subject}${decided}`;
}

function rows(record: ChangeRecord, limits: { items: number; listed: number }): [string, string][] {
  const out: [string, string][] = [];
  const items = record.items.slice(0, limits.items).map(itemLine);
  if (record.items.length > limits.items) items.push(`and ${record.items.length - limits.items} more in Andromity`);
  if (items.length) out.push(["Items for review", items.join("<br>")]);

  out.push(["Files changed with AI", `${record.files.withAi} of ${record.files.total}`]);
  if (record.files.modifiedOutside.length) out.push(["Modified outside Andromity", codeList(record.files.modifiedOutside, limits.listed)]);
  out.push(["Not recorded by Andromity", record.files.notRecorded.length ? codeList(record.files.notRecorded, limits.listed) : "None"]);

  out.push(["Models", record.models.length
    ? record.models.slice(0, limits.listed).map((model) => model === "andromity/auto" ? `${mdCode(model)} (model selected per request by the Andromity gateway)` : mdCode(model)).join(" · ")
    : "Not recorded"]);

  const approvals = record.approvals.approved || record.approvals.declined || record.approvals.blocked
    ? [`Approved by a person: ${record.approvals.approved}`, `Declined: ${record.approvals.declined}`, `Blocked by Andromity: ${record.approvals.blocked}`].join(" · ")
    : "No approvals requested";
  out.push(["Permission mode", `${record.modes.length ? record.modes.map(modeName).join(", ") : "Not recorded"} · ${approvals}`]);

  out.push(["Checks", record.checks.length
    ? record.checks.slice(0, limits.listed).map((check) => `${mdCode(check.command.length > MAX_COMMAND ? check.command.slice(0, MAX_COMMAND) + "…" : check.command)} ${check.passed ? "passed" : "failed"}${check.exitCode === null ? "" : ` (exit ${check.exitCode})`}`).join("<br>")
      + (record.checks.length > limits.listed ? `<br>and ${record.checks.length - limits.listed} more` : "")
    : "None recorded"]);
  if (record.noCheckAfter.length) out.push(["No check after last change", codeList(record.noCheckAfter, limits.listed)]);

  out.push(["Commands run", record.commands.total ? `${record.commands.total}${record.commands.failed ? ` · ${record.commands.failed} failed` : ""}` : "None"]);
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

/** The pull request's AI change record, written by fixed code. Fits within `budget` characters. */
export function composeChangeRecord(record: ChangeRecord, budget: number): string {
  const head = /^[0-9a-f]{7,64}$/.test(record.head) ? ` · Commit ${mdCode(record.head.slice(0, 7))}` : "";
  const scope = record.scope === "turn"
    ? "Only the turn this pull request was created from was matched; the pull request's other files were not compared with Andromity's records."
    : "Matched by file contents against Andromity's records on the computer that opened this pull request.";
  const footer = [
    scope,
    ...(record.truncated ? ["The pull request lists more files than were matched."] : []),
    ...record.notes,
    "Approver names come from git settings and are not verified. Per-turn records are in Andromity.",
  ].join(" ");
  for (const limits of [{ items: MAX_ITEMS, listed: MAX_LISTED }, { items: 5, listed: 3 }, { items: 0, listed: 0 }]) {
    const table = rows(record, limits).map(([label, value]) => `| **${label}** | ${cell(value)} |`);
    const text = [RECORD_START, "---", "", `**AI change record** · Generated from Andromity session records${head}`, "", "| | |", "|---|---|", ...table, "", `<sub>${footer}</sub>`, RECORD_END].join("\n");
    if (text.length <= budget) return text;
  }
  return [RECORD_START, "---", "", `**AI change record**${head}`, "", "<sub>The record is too long for this pull request. It is in Andromity.</sub>", RECORD_END].join("\n");
}
