/** Which feature tip, if any, to show under a finished reply. Pure state
 *  transitions so the rules are testable without VS Code; the controller keeps
 *  the state in globalState. A tip only introduces a feature this user has not
 *  used yet, only when the turn that just ended makes it relevant, and at most
 *  once a day. */

export type FeatureTipId =
  | "fingerprint" | "commit_message" | "inline_edit" | "cron_jobs"
  | "generate_tests" | "fix_terminal_error" | "air_gap" | "mcp_servers";

export interface TurnFacts {
  sessionId: string;
  filesEdited: number;
  /** Edited files that are code but not tests, and edited test files. */
  sourceFilesEdited: number;
  testFilesEdited: number;
  toolCalls: number;
  shellCommands: number;
  inGitRepo: boolean;
  scheduled: boolean;
  localModel: boolean;
  airGapOn: boolean;
  /** Configured MCP servers, or -1 when not known. */
  mcpServers: number;
}

interface TipRecord {
  shown: number;
  retired: boolean;
}

export interface FeatureTipsState {
  /** Distinct sessions with a finished turn, capped at FIRST_SESSIONS_QUIET + 1. */
  sessionsSeen: string[];
  activeDays: number;
  lastActiveDay: string;
  lastTipDay: string;
  tips: Record<FeatureTipId, TipRecord>;
}

export interface FeatureTip {
  id: FeatureTipId;
  /** Feature names (as recorded by featureUsage) that mean the user already knows it. */
  usedBy: string[];
  applies(facts: TurnFacts, state: FeatureTipsState): boolean;
}

/** No tips while a user is still in their first sessions. */
export const FIRST_SESSIONS_QUIET = 2;
export const MAX_SHOWS_PER_TIP = 2;

export const FEATURE_TIPS: FeatureTip[] = [
  {
    id: "fingerprint",
    usedBy: ["fingerprint", "cmd_openfingerprint"],
    applies: (f) => f.filesEdited >= 1,
  },
  {
    id: "commit_message",
    usedBy: ["cmd_generatecommitmessage"],
    applies: (f) => f.filesEdited >= 1 && f.inGitRepo,
  },
  {
    id: "inline_edit",
    usedBy: ["inline_edit", "cmd_inlineedit"],
    applies: (f) => f.filesEdited >= 1 && f.filesEdited <= 2 && f.toolCalls <= 4,
  },
  {
    id: "cron_jobs",
    usedBy: ["cron_created"],
    applies: (f, s) => f.filesEdited === 0 && f.toolCalls >= 1 && s.activeDays >= 3,
  },
  {
    id: "generate_tests",
    usedBy: ["cmd_generatetests", "chat_participant_tests"],
    applies: (f) => f.sourceFilesEdited >= 1 && f.testFilesEdited === 0,
  },
  {
    id: "fix_terminal_error",
    usedBy: ["cmd_fixterminalerror"],
    applies: (f) => f.shellCommands >= 1,
  },
  {
    id: "air_gap",
    usedBy: ["cmd_toggleairgap", "cmd_airgapselftest", "airgap_toggled"],
    applies: (f) => f.localModel && !f.airGapOn,
  },
  {
    id: "mcp_servers",
    usedBy: ["mcp_added", "connector_connected"],
    applies: (f, s) => f.mcpServers === 0 && s.activeDays >= MCP_TIP_ACTIVE_DAYS,
  },
];

export const MCP_TIP_ACTIVE_DAYS = 5;

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "kts", "cs", "c", "cc", "cpp", "h", "hpp",
  "rb", "php", "swift", "scala", "dart", "vue", "svelte",
]);

export function isTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").pop() || "";
  return /(^|\/)(tests?|__tests__|specs?)\//.test(normalized)
    || /[._-](test|spec)s?\.[a-z0-9]+$/.test(name)
    || /^test_.+\.py$/.test(name);
}

export function isSourcePath(filePath: string): boolean {
  const name = filePath.replace(/\\/g, "/").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && CODE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) && !isTestPath(filePath);
}

const TIP_IDS = FEATURE_TIPS.map((tip) => tip.id);

export function initialFeatureTipsState(): FeatureTipsState {
  const tips = {} as Record<FeatureTipId, TipRecord>;
  for (const id of TIP_IDS) tips[id] = { shown: 0, retired: false };
  return { sessionsSeen: [], activeDays: 0, lastActiveDay: "", lastTipDay: "", tips };
}

/** Fills gaps in stored state so a partial or older shape never throws. */
export function normalizeFeatureTipsState(raw: unknown): FeatureTipsState {
  const base = initialFeatureTipsState();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<FeatureTipsState>;
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  const str = (s: unknown) => (typeof s === "string" ? s : "");
  const storedTips = (value.tips && typeof value.tips === "object" ? value.tips : {}) as Partial<Record<FeatureTipId, Partial<TipRecord>>>;
  for (const id of TIP_IDS) {
    const tip = storedTips[id] || {};
    base.tips[id] = { shown: num(tip.shown), retired: tip.retired === true };
  }
  base.sessionsSeen = Array.isArray(value.sessionsSeen)
    ? value.sessionsSeen.filter((s): s is string => typeof s === "string" && !!s).slice(0, FIRST_SESSIONS_QUIET + 1)
    : [];
  base.activeDays = num(value.activeDays);
  base.lastActiveDay = str(value.lastActiveDay);
  base.lastTipDay = str(value.lastTipDay);
  return base;
}

export function recordTurn(state: FeatureTipsState, sessionId: string, today: string): FeatureTipsState {
  const next = { ...state, sessionsSeen: [...state.sessionsSeen] };
  if (sessionId && !next.sessionsSeen.includes(sessionId) && next.sessionsSeen.length <= FIRST_SESSIONS_QUIET) {
    next.sessionsSeen.push(sessionId);
  }
  if (state.lastActiveDay !== today) {
    next.activeDays = state.activeDays + 1;
    next.lastActiveDay = today;
  }
  return next;
}

/** The tip to show after this turn, preferring the one shown least so far. */
export function pickTip(state: FeatureTipsState, facts: TurnFacts, today: string): FeatureTipId | null {
  if (facts.scheduled || state.lastTipDay === today) return null;
  if (state.sessionsSeen.length <= FIRST_SESSIONS_QUIET) return null;
  let best: FeatureTip | null = null;
  for (const tip of FEATURE_TIPS) {
    const record = state.tips[tip.id];
    if (record.retired || record.shown >= MAX_SHOWS_PER_TIP || !tip.applies(facts, state)) continue;
    if (!best || record.shown < state.tips[best.id].shown) best = tip;
  }
  return best ? best.id : null;
}

export function markTipShown(state: FeatureTipsState, id: FeatureTipId, today: string): FeatureTipsState {
  const tips = { ...state.tips, [id]: { ...state.tips[id], shown: state.tips[id].shown + 1 } };
  return { ...state, tips, lastTipDay: today };
}

/** Clicked, hidden, or the feature was used another way: the tip never shows again. */
export function retireTip(state: FeatureTipsState, id: FeatureTipId): FeatureTipsState {
  if (state.tips[id].retired) return state;
  return { ...state, tips: { ...state.tips, [id]: { ...state.tips[id], retired: true } } };
}

/** True when the MCP tip could still show today, so the server count is worth asking for. */
export function wantsMcpCount(state: FeatureTipsState, today: string): boolean {
  const record = state.tips.mcp_servers;
  return !record.retired && record.shown < MAX_SHOWS_PER_TIP && state.lastTipDay !== today && state.activeDays >= MCP_TIP_ACTIVE_DAYS;
}

export function tipsUsedBy(feature: string): FeatureTipId[] {
  return FEATURE_TIPS.filter((tip) => tip.usedBy.includes(feature)).map((tip) => tip.id);
}

export function isFeatureTipId(value: unknown): value is FeatureTipId {
  return typeof value === "string" && (TIP_IDS as string[]).includes(value);
}
