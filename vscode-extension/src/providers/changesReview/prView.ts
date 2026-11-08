/** What the Create pull request form shows. Built in the extension host, rendered by the review webview.
 *  Text the user types (branch name, commit message, title, description, reviewers) is owned by the
 *  webview; the host only fills it through `pr_field` messages. */

export type PrPhase = "closed" | "loading" | "blocked" | "form" | "running" | "done" | "failed";
export type Tone = "muted" | "warn" | "danger" | "ok";

export interface PrTag {
  text: string;
  tone: Tone;
}

export interface PrFileRow {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  checked: boolean;
  tags: PrTag[];
  notOpened: boolean;
}

export interface PrCheckItem {
  label: "High" | "Secret";
  text: string;
  subject?: string;
  path?: string;
  line?: number;
}

export interface PrAction {
  id: string;
  label: string;
  primary?: boolean;
}

export interface PrStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed";
}

export interface PrFormView {
  title: string;
  repo: { display: string; visibility: "public" | "private" | null } | null;
  account: { kind: "signed_in"; login: string } | { kind: "sign_in"; label: string } | null;
  accountNote: string | null;
  update: { number: number; title: string } | null;
  base: string;
  baseOptions: string[];
  branch: {
    current: string | null;
    mustCreate: boolean;
    create: boolean;
    note: string;
    nameProblem: string | null;
  };
  latest: { show: boolean; enabled: boolean; on: boolean; label: string; note: string | null } | null;
  notes: PrTag[];
  scope: "turn" | "all";
  hasTurn: boolean;
  turnCount: number;
  allCount: number;
  files: PrFileRow[];
  sizeLine: PrTag;
  leftOverLine: string | null;
  stagedOutside: { paths: string[]; choice: "unstage" | "include" | null } | null;
  drafting: boolean;
  draftNote: string | null;
  commitAi: boolean;
  coAuthor: boolean;
  showPullFields: boolean;
  descriptionLabel: string;
  descriptionHint: string | null;
  chips: string[];
  reviewers: { show: boolean; suggestions: string[]; problems: string[] };
  receipt: {
    show: boolean;
    available: boolean;
    reason: string | null;
    attach: boolean;
    label: string;
    summary: string | null;
    preview: string | null;
  };
  publicNote: string | null;
  draft: { show: boolean; on: boolean };
  checks: { items: PrCheckItem[]; notes: string[]; key: string; acked: boolean } | null;
  primary: { label: string; enabled: boolean };
  secondary: PrAction[];
  disabledReason: string | null;
  plan: string;
}

export interface PrRunView {
  title: string;
  steps: PrStep[];
  cancellable: boolean;
  note: string | null;
}

export interface PrDoneView {
  title: string;
  heading: string;
  url: string | null;
  lines: string[];
  actions: PrAction[];
  steps: PrStep[];
  footnote: string | null;
}

export interface PrFailedView {
  title: string;
  heading: string;
  message: string;
  actions: PrAction[];
  steps: PrStep[];
}

export interface PrView {
  phase: PrPhase;
  blocked?: { title: string; message: string; actions: PrAction[] };
  form?: PrFormView;
  run?: PrRunView;
  done?: PrDoneView;
  failed?: PrFailedView;
}

export interface PrButtonState {
  visible: boolean;
  enabled: boolean;
  label: string;
  reason: string | null;
}
