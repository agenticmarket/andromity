import * as path from "node:path";
import { cleanPromptForDisplay } from "../promptDisplay.js";

/** Builds the Fingerprint report for a session: what the agent read, changed,
 *  ran and delegated, per turn, with node positions for the canvas. Pure, so it
 *  can be tested without VS Code. */

export type ToolKind = "read" | "write" | "explore" | "web" | "shell" | "shell-io" | "subagent" | "plan" | "coord" | "other";
export type CallStatus = "ok" | "error" | "blocked" | "running" | "none";

const TOOL_KINDS: Record<string, ToolKind> = {
  read_file: "read",
  write_file: "write",
  edit_file: "write",
  edit_file_multi: "write",
  list_dir: "explore",
  find_files: "explore",
  grep_search: "explore",
  web_search: "web",
  fetch_url: "web",
  shell_exec: "shell",
  shell_bg: "shell",
  shell_read: "shell-io",
  shell_list: "shell-io",
  shell_kill: "shell-io",
  spawn_subagent: "subagent",
  write_plan: "plan",
  update_plan_step: "plan",
  ask_questions: "plan",
  list_tools: "plan",
  read_handoff: "coord",
  write_handoff: "coord",
};

export function toolKind(name: string): ToolKind {
  if (Object.prototype.hasOwnProperty.call(TOOL_KINDS, name)) return TOOL_KINDS[name];
  if (name.startsWith("session_") || name.startsWith("shared_state_")) return "coord";
  return "other";
}

const CATEGORY: Record<ToolKind, string> = {
  read: "read",
  explore: "read",
  write: "write",
  shell: "shell",
  "shell-io": "shell",
  subagent: "subagent",
  web: "other",
  plan: "other",
  coord: "other",
  other: "other",
};

// Mirrors andromity.core.security.is_sensitive_path so the panel flags exactly the paths the agent guards.
const SENSITIVE_NAMES = new Set([".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "authorized_keys", "known_hosts", "config.toml"]);
const SENSITIVE_DIRS = new Set([".ssh", ".git", ".aws", ".gnupg"]);
const SENSITIVE_KEYWORD = /(^|[._\-/])(secret|password|credential|token)s?([._\-/]|$)/i;
const SENSITIVE_SYSTEM_PATHS = ["/etc/shadow", "/etc/passwd", "/proc/self/environ"];
const SOURCE_CODE_EXTS = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".java", ".cs", ".rb", ".php"]);
const SECRET_SOURCE_STEMS = new Set(["secret", "secrets", "password", "passwords", "credential", "credentials"]);

export function isSensitivePath(rawPath: string): boolean {
  if (!rawPath) return false;
  const normalized = rawPath.trim().replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  if (SENSITIVE_SYSTEM_PATHS.some((systemPath) => lower.includes(systemPath))) return true;
  const parts = normalized.split("/").filter(Boolean);
  const name = (parts[parts.length - 1] || "").toLowerCase();
  if (SENSITIVE_NAMES.has(name) || name.startsWith(".env.")) return true;
  if (parts.some((part) => SENSITIVE_DIRS.has(part.toLowerCase()))) return true;
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
  if (SOURCE_CODE_EXTS.has(suffix)) return SECRET_SOURCE_STEMS.has(name.slice(0, dot));
  return SENSITIVE_KEYWORD.test(name);
}

// Same token rule the core applies before allowlisting a command (security.is_command_allowlisted).
function sensitiveCommandTarget(command: string): string {
  for (const token of command.trim().split(/\s+/)) {
    const value = (token.includes("=") ? token.slice(token.indexOf("=") + 1) : token).replace(/^['"]+|['"]+$/g, "");
    if (value && isSensitivePath(value)) return value;
  }
  return "";
}

// Phrases the core uses when it refuses a tool (agent.py, tools.py).
const BLOCKED_RESULT = /TOOL BLOCKED|TOOL REJECTED BY USER|Access denied:|blocked by air-gap policy/;
const ERROR_RESULT = /^\s*(error\b|\[error)/i;
const OUTPUT_LIMIT = 4000;

const COMPACTION_SUMMARY = /^\s*\[(Conversation summary of earlier turns|Previous context summary)/;
const COMPACTION_ACK = /^\s*Understood\. I have the context/;

interface Call {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: string;
  success?: boolean;
}

interface TurnGroup {
  id: string;
  index: number;
  prompt: string;
  ts: string;
  durationMs: number;
  error: boolean;
  followUps: string[];
  calls: Call[];
}

interface SubagentData {
  id: string;
  toolCallId?: string;
  role: string;
  task: string;
  model: string;
  provider: string;
  status: "running" | "done" | "failed";
  summary: string;
  error: string | null;
  durationMs: number;
  tools: Call[];
}

export interface FingerprintTraceOptions {
  sessionId: string;
  workspaceRoot?: string;
  storeEvents?: any[];
  activeEvents?: any[];
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part && part.type === "text" ? part.text || "" : "")).join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function parseArgs(raw: any): Record<string, any> {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { raw };
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function firstLine(text: string): string {
  return (text || "").split(/\r?\n/).find((line) => line.trim()) || "";
}

function pathTools(workspaceRoot?: string) {
  const p = workspaceRoot && /^[a-zA-Z]:[\\/]/.test(workspaceRoot) ? path.win32 : path.posix;
  const absolute = (raw: string) => (workspaceRoot && !p.isAbsolute(raw) ? p.resolve(workspaceRoot, raw) : raw);
  return {
    key(raw: string): string {
      const normalized = absolute(raw).replace(/\\/g, "/");
      return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
    },
    display(raw: string): string {
      if (!raw) return "";
      if (!workspaceRoot) return raw.replace(/\\/g, "/");
      const rel = p.relative(workspaceRoot, absolute(raw));
      if (!rel) return ".";
      return !rel.startsWith("..") && !p.isAbsolute(rel) ? rel.replace(/\\/g, "/") : raw.replace(/\\/g, "/");
    },
  };
}

function callTarget(call: Call): string {
  const a = call.args || {};
  return a.path || a.file_path || a.target_file || a.file || "";
}

function callStatus(call: Call, running: boolean): CallStatus {
  if (call.result === undefined) return running ? "running" : "none";
  const head = call.result.slice(0, 300);
  if (BLOCKED_RESULT.test(head)) return "blocked";
  if (call.success === false || ERROR_RESULT.test(head)) return "error";
  return "ok";
}

function conversationMessages(sessionData: any): any[] {
  const all = [...(Array.isArray(sessionData?.compacted_history) ? sessionData.compacted_history : []), ...(Array.isArray(sessionData?.messages) ? sessionData.messages : [])];
  return all.filter((m) => {
    if (!m || m.role === "system") return false;
    if (m.role === "user" && COMPACTION_SUMMARY.test(textOf(m.content))) return false;
    if (m.role === "assistant" && COMPACTION_ACK.test(textOf(m.content))) return false;
    return true;
  });
}

function promptText(message: any): string {
  const text = cleanPromptForDisplay(textOf(message.content)).trim();
  if (text) return text;
  return Array.isArray(message.images) && message.images.length ? "(image prompt)" : "(empty prompt)";
}

function newTurn(index: number, prompt: string, ts: string): TurnGroup {
  return { id: `turn-${index}`, index, prompt, ts, durationMs: 0, error: false, followUps: [], calls: [] };
}

function groupTurns(messages: any[]): TurnGroup[] {
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, textOf(m.content));
  }
  const turns: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      // Messages typed while the agent works steer the running turn rather than start a new one.
      if (m.steering && current) current.followUps.push(promptText(m));
      else turns.push((current = newTurn(turns.length + 1, promptText(m), m.ts || "")));
    } else if (m.role === "assistant") {
      if (!current) turns.push((current = newTurn(turns.length + 1, "Earlier activity", m.ts || "")));
      const turn = current;
      // duration is the time since the turn began, so the last value is the turn's length.
      if (typeof m.duration === "number" && m.duration > 0) turn.durationMs = Math.max(turn.durationMs, Math.round(m.duration * 1000));
      if (textOf(m.content).includes("andromity-error-card")) turn.error = true;
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = tc.function || tc;
        const id = tc.id || `tc-${turn.index}-${turn.calls.length + 1}`;
        turn.calls.push({ id, name: fn.name || tc.name || "tool", args: parseArgs(fn.arguments), result: results.get(id) });
      }
    }
  }
  return turns;
}

// Tool calls still in flight are not in the session yet; their names and argument chunks come from the live event buffer.
function mergeActiveCalls(turns: TurnGroup[], activeEvents: any[]): void {
  const chunks = new Map<string, string>();
  for (const ev of activeEvents) {
    if (ev?.type === "tool_delta" && ev.tool_id) chunks.set(ev.tool_id, (chunks.get(ev.tool_id) || "") + (ev.chunk || ""));
  }
  const findCall = (id: string) => {
    for (const turn of turns) {
      const call = turn.calls.find((c) => c.id === id);
      if (call) return call;
    }
    return undefined;
  };
  for (const ev of activeEvents) {
    if (!ev || !ev.tool_id) continue;
    if (ev.type === "tool_start" && !findCall(ev.tool_id)) {
      if (!turns.length) turns.push(newTurn(1, "Current task", ""));
      turns[turns.length - 1].calls.push({ id: ev.tool_id, name: ev.tool_name || "tool", args: parseArgs(chunks.get(ev.tool_id)) });
    } else if (ev.type === "tool_result") {
      const call = findCall(ev.tool_id);
      if (call && call.result === undefined) {
        call.result = textOf(ev.result);
        if (ev.success === false) call.success = false;
      }
    }
  }
}

function collectSubagents(turns: TurnGroup[], storeEvents: any[]): Map<string, SubagentData> {
  const subagentsMap = new Map<string, SubagentData>();
  const getOrCreate = (id: string, initial: Partial<SubagentData> = {}): SubagentData => {
    let sub = subagentsMap.get(id);
    if (!sub) {
      sub = {
        id,
        role: initial.role || "subagent",
        task: initial.task || "",
        model: initial.model || "",
        provider: initial.provider || "",
        status: initial.status || "running",
        summary: initial.summary || "",
        error: initial.error || null,
        durationMs: initial.durationMs || 0,
        tools: [],
        ...(initial.toolCallId ? { toolCallId: initial.toolCallId } : {}),
      };
      subagentsMap.set(id, sub);
      return sub;
    }
    if (initial.role && sub.role === "subagent") sub.role = initial.role;
    if (initial.task && !sub.task) sub.task = initial.task;
    if (initial.model && !sub.model) sub.model = initial.model;
    if (initial.provider && !sub.provider) sub.provider = initial.provider;
    if (initial.status) sub.status = initial.status;
    if (initial.summary && !sub.summary) sub.summary = initial.summary;
    if (initial.error && !sub.error) sub.error = initial.error;
    if (initial.durationMs && !sub.durationMs) sub.durationMs = initial.durationMs;
    if (initial.toolCallId && !sub.toolCallId) sub.toolCallId = initial.toolCallId;
    return sub;
  };

  for (const ev of storeEvents) {
    if (!ev) continue;
    const aid = ev.agent_id || ev.id || "";
    if (ev.type === "subagent_spawned") {
      const id = aid || (ev.tool_id ? `sub_${ev.tool_id}` : "");
      if (id) getOrCreate(id, { role: ev.role, task: ev.task, model: ev.model, provider: ev.provider, status: "running", toolCallId: ev.tool_id });
    } else if (ev.type === "subagent_progress" && aid) {
      const sub = getOrCreate(aid, { role: ev.role, task: ev.task, model: ev.model, provider: ev.provider });
      if (ev.duration_ms) sub.durationMs = Math.max(sub.durationMs, ev.duration_ms);
      if (ev.event_type === "completed" || ev.event_type === "done") {
        sub.status = "done";
        if (ev.detail) sub.summary = ev.detail;
      } else if (["failed", "error", "killed", "timeout"].includes(ev.event_type)) {
        sub.status = "failed";
        sub.error = ev.detail || ev.error || "Subagent failed";
      }
      if (ev.tool_name || ev.event_type === "tool_result") {
        const name = ev.tool_name || "tool";
        const id = ev.tool_id || `${aid}-step-${sub.tools.length + 1}`;
        const result = typeof ev.tool_result === "string" ? ev.tool_result : ev.tool_result != null ? JSON.stringify(ev.tool_result) : ev.detail;
        const existing = sub.tools.find((t) => t.id === id || (t.name === name && t.result === undefined));
        if (existing) {
          if (result !== undefined) existing.result = result;
          if (ev.status === "error") existing.success = false;
        } else {
          sub.tools.push({
            id,
            name,
            args: parseArgs(ev.tool_args),
            result: ev.event_type === "tool_result" || result ? result || "" : undefined,
            ...(ev.status === "error" ? { success: false } : {}),
          });
        }
      }
    } else if (ev.type === "subagent_done" && aid) {
      const sub = getOrCreate(aid);
      sub.status = "done";
      if (ev.result) sub.summary = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result);
      if (ev.duration_ms) sub.durationMs = ev.duration_ms;
    } else if (ev.type === "subagent_failed" && aid) {
      const sub = getOrCreate(aid);
      sub.status = "failed";
      sub.error = ev.error || "Subagent failed";
      if (ev.duration_ms) sub.durationMs = ev.duration_ms;
    }
  }

  for (const turn of turns) {
    for (const call of turn.calls) {
      if (toolKind(call.name) !== "subagent") continue;
      let parsed: any = null;
      if (call.result) {
        try {
          parsed = JSON.parse(call.result);
        } catch {
          parsed = null;
        }
      }
      const agentId = parsed?.agent_id || call.args.agent_id || [...subagentsMap.values()].find((s) => s.toolCallId === call.id)?.id || call.id;
      const sub = getOrCreate(agentId, {
        toolCallId: call.id,
        role: parsed?.role || call.args.role,
        task: call.args.task || call.args.instruction || parsed?.task,
        model: call.args.model_override || call.args.model || parsed?.model,
        provider: call.args.provider_override || call.args.provider || parsed?.provider,
        status: parsed?.status === "completed" ? "done" : parsed?.status === "failed" ? "failed" : call.result ? "done" : undefined,
        summary: parsed?.summary || (parsed ? "" : call.result || ""),
        durationMs: parsed?.duration_ms || 0,
        error: parsed?.error || null,
      });
      sub.toolCallId = call.id;
      if (parsed && Array.isArray(parsed.tools_called)) {
        parsed.tools_called.forEach((step: any, i: number) => {
          const args = parseArgs(step.args);
          const id = step.id || `${agentId}-tool-${i}`;
          if (sub.tools.some((t) => t.id === id || (t.name === step.name && JSON.stringify(t.args) === JSON.stringify(args)))) return;
          sub.tools.push({
            id,
            name: step.name || "tool",
            args,
            result: typeof step.result === "string" ? step.result : JSON.stringify(step.result ?? ""),
            ...(step.status === "error" ? { success: false } : {}),
          });
        });
      }
    }
  }
  return subagentsMap;
}

interface Item {
  id: string;
  kind: ToolKind;
  calls: Call[];
}

// Repeat reads or edits of one file, and a turn's directory listings and searches, collapse into one node each.
function groupCalls(calls: Call[], keyOf: (raw: string) => string): Item[] {
  const items: Item[] = [];
  const byFile = new Map<string, Item>();
  let explore: Item | null = null;
  for (const call of calls) {
    const kind = toolKind(call.name);
    if (kind === "explore") {
      if (explore) explore.calls.push(call);
      else items.push((explore = { id: call.id, kind, calls: [call] }));
      continue;
    }
    const target = callTarget(call);
    if ((kind === "read" || kind === "write") && target) {
      const key = kind + ":" + keyOf(target);
      const existing = byFile.get(key);
      if (existing) {
        existing.calls.push(call);
        continue;
      }
      const item = { id: call.id, kind, calls: [call] };
      byFile.set(key, item);
      items.push(item);
      continue;
    }
    items.push({ id: call.id, kind, calls: [call] });
  }
  return items;
}

const VERBS: Record<string, string> = { write_file: "Wrote", edit_file: "Edited", edit_file_multi: "Edited" };

function describeCall(call: Call, display: (raw: string) => string): { title: string; sub: string } {
  const a = call.args || {};
  const target = display(callTarget(call));
  const base = target ? target.split("/").pop() || target : "";
  switch (call.name) {
    case "read_file":
      return { title: `Read ${base || "file"}`, sub: a.start_line ? `${target} · lines ${a.start_line}${a.end_line ? "–" + a.end_line : "+"}` : target };
    case "write_file":
    case "edit_file":
    case "edit_file_multi":
      return { title: `${VERBS[call.name]} ${base || "file"}`, sub: target };
    case "list_dir":
      return { title: !target || target === "." ? "Listed workspace root" : `Listed ${target}`, sub: "" };
    case "find_files":
      return { title: `Found files ${a.pattern || ""}`.trim(), sub: target };
    case "grep_search":
      return { title: `Searched “${clip(String(a.query || a.pattern || ""), 40)}”`, sub: target };
    case "web_search":
      return { title: `Searched the web for “${clip(String(a.query || ""), 40)}”`, sub: "" };
    case "fetch_url": {
      let host = String(a.url || "");
      try {
        host = new URL(host).host;
      } catch {}
      return { title: `Fetched ${host || "a page"}`, sub: String(a.url || "") };
    }
    case "shell_exec":
    case "shell_bg":
      return { title: clip(String(a.command || "command"), 80), sub: call.name === "shell_bg" ? "Background process" : clip(firstLine(call.result || ""), 80) };
    case "shell_read":
      return { title: `Read output of ${a.process_id || "process"}`, sub: "" };
    case "shell_list":
      return { title: "Listed background processes", sub: "" };
    case "shell_kill":
      return { title: `Stopped ${a.process_id || "process"}`, sub: "" };
    case "write_plan":
      return { title: `Wrote plan${a.title ? " “" + clip(String(a.title), 40) + "”" : ""}`, sub: Array.isArray(a.steps) ? `${a.steps.length} steps` : "" };
    case "update_plan_step":
      return { title: `Plan step${a.step_index !== undefined ? " " + a.step_index : ""} → ${a.status || "updated"}`, sub: "" };
    case "ask_questions": {
      const asked = Array.isArray(a.questions) ? a.questions.length : 0;
      return { title: asked ? `Asked ${asked} question${asked === 1 ? "" : "s"}` : "Asked questions", sub: "" };
    }
    default:
      return { title: call.name.replace(/_/g, " "), sub: "" };
  }
}

const STATUS_BADGE: Record<CallStatus, [string, string]> = {
  ok: ["OK", "muted"],
  error: ["Error", "red"],
  blocked: ["Blocked", "amber"],
  running: ["Running", "amber"],
  none: ["No result", "muted"],
};

function worstStatus(statuses: CallStatus[]): CallStatus {
  for (const s of ["running", "blocked", "error", "none"] as CallStatus[]) if (statuses.includes(s)) return s;
  return "ok";
}

const CARD_W = 250;
const HUB_X = 40;
const NODE_X0 = HUB_X + CARD_W + 50;
const COL_W = 280;
const ROW_H = 118;
const COLS = 4;
const LANE_GAP = 56;

interface Lane {
  hub: any;
  items: any[];
}

// Each turn is a lane: its hub on the left, actions in reading order to the right, wrapping every four.
// Lanes stack top to bottom, so edges only ever join neighbours and never cross a card.
function layoutLanes(lanes: Lane[]): { nodes: any[]; connections: any[] } {
  const nodes: any[] = [];
  const connections: any[] = [];
  let top = 40;
  lanes.forEach((lane, laneIndex) => {
    lane.hub.x = HUB_X;
    lane.hub.y = top;
    nodes.push(lane.hub);
    if (laneIndex > 0) connections.push({ from: lanes[laneIndex - 1].hub.id, to: lane.hub.id, kind: "turn", grad: "grad-dag-1" });
    lane.items.forEach((node, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      node.x = NODE_X0 + col * COL_W;
      node.y = top + row * ROW_H;
      nodes.push(node);
      const grad = node.category === "write" ? "grad-dag-3" : node.category === "shell" ? "grad-dag-4" : "grad-dag-2";
      if (col === 0) connections.push({ from: lane.hub.id, to: node.id, grad, dashed: !!node.sensitive });
      else connections.push({ from: lane.items[i - 1].id, to: node.id, grad, dashed: !!node.sensitive });
    });
    const rows = Math.max(1, Math.ceil(lane.items.length / COLS));
    top += rows * ROW_H + LANE_GAP;
  });
  return { nodes, connections };
}

interface Tally {
  modified: Set<string>;
  read: Set<string>;
  commands: number;
  searches: number;
  sensitiveBlocked: Set<string>;
  sensitiveAccessed: Set<string>;
}

const newTally = (): Tally => ({ modified: new Set(), read: new Set(), commands: 0, searches: 0, sensitiveBlocked: new Set(), sensitiveAccessed: new Set() });

function tallyCall(tally: Tally, call: Call, status: CallStatus, keyOf: (raw: string) => string): void {
  const kind = toolKind(call.name);
  const target = callTarget(call);
  const done = status === "ok" || status === "running";
  if (kind === "write" && target && done) tally.modified.add(keyOf(target));
  if (kind === "read" && target && done) tally.read.add(keyOf(target));
  if (kind === "shell" && status !== "blocked") tally.commands++;
  if (kind === "explore" || kind === "web") tally.searches++;
  const sensitive = sensitiveTarget(call);
  if (sensitive) (status === "blocked" ? tally.sensitiveBlocked : tally.sensitiveAccessed).add(kind === "shell" ? sensitive : keyOf(sensitive));
}

function sensitiveTarget(call: Call): string {
  const kind = toolKind(call.name);
  if (kind === "shell") return sensitiveCommandTarget(String(call.args?.command || ""));
  const target = callTarget(call);
  return (kind === "read" || kind === "write" || kind === "explore") && isSensitivePath(target) ? target : "";
}

function tallyMetrics(tally: Tally, durationMs: number) {
  return {
    durationMs,
    filesModified: tally.modified.size,
    filesRead: tally.read.size,
    commandsRun: tally.commands,
    searches: tally.searches,
    sensitiveBlocked: tally.sensitiveBlocked.size,
    sensitiveAccessed: tally.sensitiveAccessed.size,
  };
}

function callDetails(call: Call, status: CallStatus, display: (raw: string) => string) {
  const output = call.result || "";
  const args = { ...call.args };
  for (const key of ["content", "new_str", "old_str"]) {
    if (typeof args[key] === "string" && args[key].length > 400) args[key] = clip(args[key], 400);
  }
  return {
    name: call.name,
    ...describeCall(call, display),
    target: display(callTarget(call)),
    command: call.args?.command || "",
    status,
    args: clip(JSON.stringify(args, null, 2), 1500),
    output: clip(output, OUTPUT_LIMIT),
    outputLength: output.length,
  };
}

function itemNode(item: Item, laneId: string, running: boolean, ctx: { display: (raw: string) => string; key: (raw: string) => string; tally: Tally }, subagents?: Map<string, SubagentData>) {
  const statuses = item.calls.map((call) => callStatus(call, running));
  item.calls.forEach((call, i) => tallyCall(ctx.tally, call, statuses[i], ctx.key));
  const status = worstStatus(statuses);
  const [badge, badgeType] = STATUS_BADGE[status];
  const first = item.calls[0];
  const count = item.calls.length;
  const sensitive = item.calls.map(sensitiveTarget).find(Boolean) || "";
  const node: any = {
    id: item.id,
    type: item.kind === "shell-io" ? "shell" : item.kind,
    category: CATEGORY[item.kind],
    turn: laneId,
    badge,
    badgeType: status === "ok" && item.kind === "write" ? "green" : badgeType,
    status,
    count,
    sensitive: !!sensitive,
    details: { calls: item.calls.map((call, i) => callDetails(call, statuses[i], ctx.display)) },
  };
  if (item.kind === "explore" && count > 1) {
    const targets = item.calls.map((call) => describeCall(call, ctx.display).title);
    node.title = `Explored ${count} locations`;
    node.sub = clip(targets.slice(0, 2).join(", ") + (count > 2 ? ` +${count - 2}` : ""), 90);
  } else {
    const { title, sub } = describeCall(first, ctx.display);
    node.title = count > 1 ? `${title} ×${count}` : title;
    node.sub = sub;
  }
  const target = callTarget(first);
  if ((item.kind === "read" || item.kind === "write") && target) {
    node.filePath = target;
    node.line = Number(first.args?.start_line) || 1;
  }
  if (item.kind === "subagent" && subagents) {
    const sub = [...subagents.values()].find((s) => s.toolCallId === first.id);
    if (sub) {
      const subStatus = sub.status;
      node.title = `Subagent: ${sub.role}`;
      node.sub = clip(sub.task || "", 90);
      node.badge = subStatus === "running" ? "Running" : subStatus === "failed" ? "Failed" : "Done";
      node.badgeType = subStatus === "running" ? "amber" : subStatus === "failed" ? "red" : "muted";
      node.subagentId = sub.id;
      node.hasSubagentDrilldown = true;
      node.subagentActionCount = sub.tools.length;
    }
  }
  return node;
}

function hubStatus(running: boolean, error: boolean): [string, string, string] {
  if (running) return ["running", "Running", "amber"];
  if (error) return ["error", "Error", "red"];
  return ["done", "Done", "muted"];
}

export function buildFingerprintTrace(sessionData: any, options: FingerprintTraceOptions) {
  const paths = pathTools(options.workspaceRoot);
  const turns = groupTurns(conversationMessages(sessionData));
  mergeActiveCalls(turns, options.activeEvents || []);
  const sessionRunning = sessionData?.status === "running" || sessionData?.runtime?.is_running === true;
  const subagentsMap = collectSubagents(turns, options.storeEvents || []);
  const tally = newTally();
  const ctx = { display: paths.display, key: paths.key, tally };

  const lanes: Lane[] = turns.map((turn, i) => {
    const running = sessionRunning && i === turns.length - 1;
    const [status, badge, badgeType] = hubStatus(running, turn.error);
    const items = groupCalls(turn.calls, paths.key).map((item) => itemNode(item, turn.id, running, ctx, subagentsMap));
    return {
      hub: {
        id: turn.id,
        type: "llm",
        category: "llm",
        title: `Turn ${turn.index}`,
        sub: clip(turn.prompt, 140),
        badge,
        badgeType,
        status,
        turn: turn.id,
        isTurnHub: true,
        details: { prompt: turn.prompt, ts: turn.ts, durationMs: turn.durationMs, actions: turn.calls.length, followUps: turn.followUps },
      },
      items,
    };
  });

  const subagents: Record<string, any> = {};
  subagentsMap.forEach((sub, aid) => {
    const subTally = newTally();
    const laneId = `${aid}-lineage`;
    const running = sub.status === "running";
    const items = groupCalls(sub.tools, paths.key).map((item) => itemNode(item, laneId, running, { ...ctx, tally: subTally }));
    const statusLabel = sub.status === "running" ? "Running" : sub.status === "failed" ? "Failed" : "Done";
    const { nodes, connections } = layoutLanes([{
      hub: {
        id: `${aid}-hub`,
        type: "subagent",
        category: "subagent",
        title: `Subagent: ${sub.role}`,
        sub: clip(sub.task || "", 140),
        badge: statusLabel,
        badgeType: sub.status === "running" ? "amber" : sub.status === "failed" ? "red" : "muted",
        status: sub.status,
        turn: laneId,
        isTurnHub: true,
        details: { prompt: sub.task, role: sub.role, model: sub.model, provider: sub.provider, durationMs: sub.durationMs, actions: sub.tools.length, finalSummary: clip(sub.summary || "", OUTPUT_LIMIT), error: sub.error },
      },
      items,
    }]);
    // Subagent work is part of what the session touched.
    subTally.modified.forEach((k) => tally.modified.add(k));
    subTally.read.forEach((k) => tally.read.add(k));
    subTally.sensitiveBlocked.forEach((k) => tally.sensitiveBlocked.add(k));
    subTally.sensitiveAccessed.forEach((k) => tally.sensitiveAccessed.add(k));
    tally.commands += subTally.commands;
    tally.searches += subTally.searches;
    subagents[aid] = {
      id: aid,
      toolCallId: sub.toolCallId,
      role: sub.role,
      task: sub.task,
      model: sub.model,
      provider: sub.provider,
      status: sub.status,
      summary: clip(sub.summary || "", OUTPUT_LIMIT),
      error: sub.error,
      durationMs: sub.durationMs,
      metrics: tallyMetrics(subTally, sub.durationMs),
      turns: [{ id: laneId, index: 1, prompt: sub.task || `Subagent ${sub.role}`, ts: "", durationMs: sub.durationMs, actions: sub.tools.length, status: sub.status === "failed" ? "error" : sub.status === "running" ? "running" : "done" }],
      nodes,
      connections,
      tools: sub.tools.map((t) => ({ id: t.id, name: t.name, target: paths.display(callTarget(t)) || t.args?.command || "", status: callStatus(t, running) })),
    };
  });

  const { nodes, connections } = layoutLanes(lanes);
  const durationMs = turns.reduce((sum, turn) => sum + turn.durationMs, 0);
  return {
    session_id: options.sessionId,
    status: sessionRunning ? "running" : "idle",
    nodes,
    connections,
    metrics: tallyMetrics(tally, durationMs),
    turns: lanes.map((lane, i) => ({
      id: turns[i].id,
      index: turns[i].index,
      prompt: turns[i].prompt,
      ts: turns[i].ts,
      durationMs: turns[i].durationMs,
      actions: turns[i].calls.length,
      status: lane.hub.status,
      followUps: turns[i].followUps.length,
    })),
    subagents,
  };
}
