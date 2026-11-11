export type ReceiptSeverity = "high" | "medium";

export interface ReceiptFinding {
  kind: string;
  severity: ReceiptSeverity | string;
  /** Andromity's own words; never a name, path or command. */
  detail: string;
  /** The path or command the finding is about. Agent-controlled. */
  subject?: string;
  /** Id of the person who decided; their name is in Receipt.approvers. */
  approver?: string;
}

export interface ReceiptCommand {
  command: string;
  outcome: string;
  exit_code: number | null;
  background: boolean;
  check: boolean;
  by: string;
  decided_by_person: boolean | null;
  decided_by: string | null;
}

export interface ReceiptCheck {
  command: string;
  result: "passed" | "failed" | string;
  exit_code: number | null;
  failed_first: boolean;
  runs: number;
}

export interface ReceiptFileChange {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
  via: "edit" | "subagent" | "other" | string;
}

export interface ReceiptApprover {
  id: string;
  name: string;
}

export interface ReceiptSummary {
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  files_read: number;
  searches: number;
  commands: number;
  commands_failed: number;
  blocked: number;
  denied: number;
  approved_by_person: number;
  denied_by_person: number;
  subagents: number;
  web_searches: number;
}

export interface Receipt {
  version: number;
  session_id: string;
  turn_index: number;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  models: string[];
  mode: string | null;
  snapshot: { before?: string | null; after?: string | null };
  summary: ReceiptSummary;
  files_changed: ReceiptFileChange[];
  edited_not_in_snapshot: string[];
  files_read: string[];
  commands: ReceiptCommand[];
  checks: ReceiptCheck[];
  web_hosts: string[];
  mcp_servers: string[];
  other_tools: Record<string, number>;
  needs_attention: ReceiptFinding[];
  approvers: ReceiptApprover[];
  cost_usd: number | null;
  tokens: number | null;
  notes: string[];
  sealed?: { hash: string; matches: boolean };
  /** How many characters of each command this receipt keeps; absent on turns sealed before commands were kept in full. */
  command_chars?: number;
  record_hash: string;
}

export interface ReceiptResponse {
  success: boolean;
  error?: string;
  receipt?: Receipt;
  text?: string;
  markdown?: string;
  viewer_id?: string | null;
  turns?: number[];
}

export interface ReceiptReadyEvent {
  session_id: string;
  turn_index: number;
  turn_key?: string | null;
  attention: number | null;
  high: number | null;
  files_changed?: number | null;
  commands?: number | null;
  commands_failed?: number | null;
}

/** Where the "was this receipt useful" strip is: not decided yet, asking, taking a note after a rating, or gone. */
export type ReceiptFeedbackStep = "unknown" | "ask" | "note-up" | "note-down" | "none";

export interface ReceiptViewState {
  sessionName: string;
  response: ReceiptResponse | null;
  loading: boolean;
  /** Turns with receipts, kept from the last good answer so an error never removes the way back. */
  turns: number[];
  /** True while a specific turn is chosen rather than the latest. */
  pinned: boolean;
  feedback?: ReceiptFeedbackStep;
}
