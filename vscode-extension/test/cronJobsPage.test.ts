import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

const Module = require("module");
const originalRequire = Module.prototype.require;
const infos: string[] = [];
const errors: string[] = [];
const mockVscode = {
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: "D:/work/repo" } }] },
  window: {
    showWarningMessage: async () => "Delete",
    showErrorMessage: (text: string) => { errors.push(text); },
    showInformationMessage: async (text: string) => { infos.push(text); return undefined; },
  },
  Uri: { joinPath: () => ({ fsPath: "icon.svg" }), parse: (value: string) => ({ toString: () => value }) },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments);
};
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
const { cronRunToast } = require("../src/cronNotifications.js");
Module.prototype.require = originalRequire;

type RpcHandler = (method: string, params: Record<string, any>) => any;

function panelHarness(rpc: RpcHandler = () => ({})) {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const posts: any[] = [];
  const panel = Object.create(SettingsPanel.prototype);
  panel._rpcClient = { call: async (method: string, params: Record<string, any>) => {
    calls.push({ method, params });
    if (method === "cron.list") return [];
    return rpc(method, params);
  } };
  panel._panel = { webview: { cspSource: "vscode-webview:", asWebviewUri: () => "icon.svg", postMessage: (post: unknown) => posts.push(post) } };
  panel._extensionUri = { fsPath: "D:/extension" };
  panel.loadData = async () => {};
  return { panel, calls, posts };
}

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function selectOptions(html: string, id: string): string[] {
  const start = html.indexOf('<select id="' + id + '"');
  const end = html.indexOf("</select>", start);
  return Array.from(html.slice(start, end).matchAll(/<option value="([^"]*)"/g), m => m[1]);
}

/** Loads the Cron Jobs page script (form + cards) into a VM with stub elements. */
function loadCronScript() {
  const html: string = panelHarness().panel._getHtmlForWebview();
  const elements: Record<string, any> = {};
  const makeElement = (id: string) => {
    const options = selectOptions(html, id).map(value => ({ value, dataset: {} as Record<string, string>, textContent: value }));
    const el: any = {
      id, value: options.length ? options[0].value : "", innerHTML: "", textContent: "", className: "",
      hidden: false, disabled: false, style: { display: "" }, dataset: {}, options,
      listeners: {} as Record<string, Function[]>,
      addEventListener(type: string, fn: Function) { (el.listeners[type] ||= []).push(fn); },
      focus() {}, scrollIntoView() {},
      appendChild(opt: any) { options.push(opt); },
      get selectedIndex() { return options.findIndex(o => o.value === el.value); },
    };
    return el;
  };
  const getElementById = (id: string) => elements[id] ??= makeElement(id);
  const posted: any[] = [];
  const context: Record<string, any> = {
    escapeHtml, posted, allCrons: [], activeModelId: "claude-sonnet", activeModelProvider: "anthropic",
    currentWorkspacePath: "D:/work/repo", CSS: { escape: (v: string) => v },
    document: { getElementById, createElement: () => ({ dataset: {} }), querySelectorAll: () => [] },
    vscode: { postMessage: (m: any) => posted.push(m) },
    setTimeout: (fn: Function) => { fn(); return 0; }, clearTimeout: () => {},
    switchTab: (tab: string) => posted.push({ switchedTo: tab }),
  };
  const rendererStart = html.indexOf("    const cronRunsCache = {};");
  const rendererEnd = html.indexOf('    vscode.postMessage({ type: "ready" });', rendererStart);
  const formStart = html.indexOf("    let cronEditingId = null;");
  const formEnd = html.indexOf("    if (btnRefreshCrons) {", formStart);
  assert.ok(rendererStart > 0 && rendererEnd > rendererStart && formStart > 0 && formEnd > formStart);
  const prelude = [
    'const btnToggleAddCron = document.getElementById("btn-toggle-add-cron");',
    'const cronCreateForm = document.getElementById("cron-create-form");',
    'const btnCancelCron = document.getElementById("btn-cancel-cron");',
    'const btnSaveCron = document.getElementById("btn-save-cron");',
  ].join("\n");
  vm.runInNewContext(prelude + "\n" + html.slice(rendererStart, rendererEnd) + "\n" + html.slice(formStart, formEnd) +
    "\nthis.api = { cronCardHtml, cronRunHtml, openCronForm, submitCronForm, renderCronPreview, closeCronForm," +
    " getSeq: () => cronPreviewSeq, cronRunning };", context);
  return { html, api: context.api, el: getElementById, posted, context };
}

const inTwoHours = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString();

const baseJob = {
  id: "a7422407", name: "Daily Code Health", prompt: "Scan TODOs", schedule: "0 9 * * 1-5",
  schedule_description: "Weekdays at 09:00", schedule_valid: true, enabled: true, mode: "safe",
  allowed_commands: ["git status", "git diff"], model: "m1", provider: "openrouter",
  project_path: "D:\\work\\repo", next_run_in: "2h 0m", next_run_at: inTwoHours(),
  last_status: "never", timeout_seconds: 900, on_failure: "retry", notify: "failures", catch_up: "once",
};

describe("Cron Jobs page", () => {
  beforeEach(() => { infos.length = 0; errors.length = 0; });

  it("renders a complete create/edit form", () => {
    const html: string = panelHarness().panel._getHtmlForWebview();
    for (const id of ["cron-mode-select", "cron-timeout-select", "cron-onfail-select", "cron-notify-select",
      "cron-catchup-select", "cron-schedule-preview", "btn-save-run-cron", "cron-form-error", "cron-form-folder"]) {
      assert.ok(html.includes('id="' + id + '"'), id + " must exist");
    }
    assert.deepEqual(selectOptions(html, "cron-notify-select"), ["failures", "always", "never"]);
    assert.ok(selectOptions(html, "cron-schedule-select").includes("weekdays at 09:00"));
    assert.ok(html.includes('<label for="cron-prompt-input">'), "fields are labelled");
  });

  it("cards show readable schedule, absolute next run, folder and all actions", () => {
    const { api } = loadCronScript();
    const card: string = api.cronCardHtml(baseJob);
    assert.ok(card.includes(">Weekdays at 09:00<"), "schedule description pill");
    assert.ok(card.includes('title="0 9 * * 1-5"'), "raw schedule on hover");
    assert.ok(/· in 2h 0m/.test(card), "relative time after the absolute time");
    assert.ok(card.includes(">repo<"), "folder name from a Windows path");
    for (const action of ["run", "edit", "duplicate", "toggle", "delete"]) {
      assert.ok(card.includes('data-action="' + action + '"'), action + " button");
    }
    assert.ok(card.includes("15 min") && card.includes("Retry temporary errors") && card.includes("When it needs attention"));
  });

  it("a paused job explains why and offers the fix", () => {
    const { api } = loadCronScript();
    const card: string = api.cronCardHtml({ ...baseJob, enabled: false, paused_reason: "Paused because this workspace is not trusted.",
      last_status: "skipped", last_error_type: "untrusted", fix_action: "trust_workspace" });
    assert.ok(card.includes("Paused · needs fixing"));
    assert.ok(card.includes("not trusted"));
    assert.ok(card.includes('data-fix="trust_workspace"') && card.includes("Trust this workspace"));
    assert.ok(card.includes("Resume"));
  });

  it("needs-attention and failed runs show the reason, not a success", () => {
    const { api } = loadCronScript();
    const card: string = api.cronCardHtml({ ...baseJob, last_status: "needs_attention", last_run: new Date().toISOString(),
      last_error: "Blocked: shell_exec: git rev-parse", fix_action: "edit_job" });
    assert.ok(card.includes("Needs attention"));
    assert.ok(!card.includes(">Succeeded<"));
    assert.ok(card.includes("git rev-parse") && card.includes('data-fix="edit_job"'));
    const failed: string = api.cronCardHtml({ ...baseJob, last_status: "failed", last_run: new Date().toISOString(),
      last_error: "The provider rejected the API key for this job's model.", fix_action: "api_keys" });
    assert.ok(failed.includes("Open API keys"));
  });

  it("a folder problem and a job running elsewhere are visible", () => {
    const { api } = loadCronScript();
    const card: string = api.cronCardHtml({ ...baseJob, folder_problem: "This job's folder no longer exists: D:/gone", running: true });
    assert.ok(card.includes("no longer exists"));
    assert.ok(card.includes("Running now") && card.includes(" disabled>Running…"));
  });

  it("run history labels catch-up runs and blocked tools, and hides output for missed runs", () => {
    const { api } = loadCronScript();
    const run: string = api.cronRunHtml({ id: "r1", status: "needs_attention", trigger: "catch_up", started_at: new Date().toISOString(),
      scheduled_for: new Date().toISOString(), blocked_tools: ["shell_exec: git rev-parse"], output: "report", session_id: "cron-a-1" });
    assert.ok(run.includes("Needs attention") && run.includes("Catch-up") && run.includes("Blocked") && run.includes("Planned for"));
    const missed: string = api.cronRunHtml({ id: "r2", status: "missed", started_at: new Date().toISOString(), error: "Missed the run" });
    assert.ok(missed.includes("Missed") && !missed.includes("No output recorded"));
  });

  it("edit form loads the job, previews the schedule and posts an update", () => {
    const { api, el, posted } = loadCronScript();
    api.openCronForm(baseJob);
    assert.equal(el("cron-form-title").textContent, "Edit Daily Code Health");
    assert.equal(el("cron-schedule-select").value, "custom");
    assert.equal(el("cron-custom-schedule").value, "0 9 * * 1-5");
    assert.equal(el("cron-mode-select").value, "safe");
    assert.equal(el("cron-timeout-select").value, "900");
    assert.equal(el("cron-commands-input").value, "git status, git diff");
    assert.equal(el("cron-model-select").value, "m1");
    const preview = posted.find(p => p.type === "cron_preview");
    assert.equal(preview.schedule, "0 9 * * 1-5");

    api.renderCronPreview({ requestId: api.getSeq(), valid: false, error: "The hour field '25' is out of range (0-23)." });
    assert.ok(el("cron-schedule-preview").textContent.includes("out of range"));
    assert.equal(el("btn-save-cron").disabled, true);
    api.renderCronPreview({ requestId: api.getSeq(), valid: true, description: "Weekdays at 09:00", next_runs: [inTwoHours()] });
    assert.ok(el("cron-schedule-preview").innerHTML.includes("Weekdays at 09:00"));
    assert.equal(el("btn-save-cron").disabled, false);

    el("cron-notify-select").value = "always";
    api.submitCronForm(true);
    const update = posted.find(p => p.type === "cron_update");
    assert.equal(update.id, "a7422407");
    assert.equal(update.runNow, true);
    assert.equal(update.payload.notify, "always");
    assert.equal(update.payload.timeout_seconds, 900);
    assert.equal(update.payload.provider, "openrouter");
    assert.equal(el("btn-save-cron").disabled, true, "saving disables the buttons");
  });

  it("stale preview responses are ignored", () => {
    const { api, el } = loadCronScript();
    api.openCronForm(null);
    api.renderCronPreview({ requestId: api.getSeq() - 1, valid: false, error: "old" });
    assert.ok(!el("cron-schedule-preview").textContent.includes("old"));
  });

  it("create form defaults to SAFE and requires a prompt", () => {
    const { api, el, posted } = loadCronScript();
    api.openCronForm(null);
    assert.equal(el("cron-mode-select").value, "safe");
    assert.ok(el("cron-form-folder").textContent.includes("D:/work/repo"));
    api.submitCronForm(false);
    assert.ok(el("cron-form-error").textContent.includes("prompt"));
    assert.equal(posted.filter(p => p.type === "cron_create").length, 0);
    el("cron-prompt-input").value = "Run tests";
    api.submitCronForm(false);
    const create = posted.find(p => p.type === "cron_create");
    assert.equal(create.payload.prompt, "Run tests");
    assert.equal(create.payload.run_now, false);
    assert.equal(create.payload.model, "claude-sonnet");
    assert.equal(create.payload.catch_up, "once");
  });
});

describe("Cron Jobs extension-host messages", () => {
  it("update then run now, and reports success to the form", async () => {
    const h = panelHarness();
    await h.panel._handleMessage({ type: "cron_update", id: "j1", payload: { name: "x" }, runNow: true });
    assert.deepEqual(h.calls.map(c => c.method), ["cron.update", "cron.run_now", "cron.list"]);
    assert.equal(h.calls[0].params.project_path, "D:/work/repo");
    assert.equal(h.calls[0].params.id, "j1");
    assert.ok(h.posts.some(p => p.type === "cron_saved"));
  });

  it("shows save errors inline instead of losing the form", async () => {
    const h = panelHarness(() => { throw new Error("Timeout must be between 1 minute and 24 hours."); });
    await h.panel._handleMessage({ type: "cron_create", payload: { prompt: "x" } });
    const failed = h.posts.find(p => p.type === "cron_save_failed");
    assert.equal(failed.error, "Timeout must be between 1 minute and 24 hours.");
    assert.ok(!h.posts.some(p => p.type === "cron_saved"));
  });

  it("forwards schedule previews and degrades on older engines", async () => {
    const ok = panelHarness(() => ({ valid: true, description: "Every hour", next_runs: [] }));
    await ok.panel._handleMessage({ type: "cron_preview", schedule: "every 1h", requestId: 4 });
    assert.deepEqual(ok.posts[0], { type: "cron_preview_result", requestId: 4, valid: true, description: "Every hour", next_runs: [] });
    const old = panelHarness(() => { throw new Error("Method not found"); });
    await old.panel._handleMessage({ type: "cron_preview", schedule: "every 1h", requestId: 5 });
    assert.deepEqual(old.posts[0], { type: "cron_preview_result", requestId: 5, unavailable: true });
  });

  it("duplicates a job", async () => {
    const h = panelHarness();
    await h.panel._handleMessage({ type: "cron_duplicate", id: "j1" });
    assert.equal(h.calls[0].method, "cron.duplicate");
    assert.ok(infos.some(t => t.includes("paused")));
  });
});

describe("Cron run notifications", () => {
  const run = (status: string, extra: Record<string, any> = {}) => ({ status, duration_ms: 1500, session_id: "cron-1", ...extra });

  it("stays quiet on success unless the job asks for every run", () => {
    assert.equal(cronRunToast({ job: { name: "J" }, run: run("success") }), null);
    assert.equal(cronRunToast({ job: { name: "J", notify: "always" }, run: run("success") })?.level, "info");
  });

  it("warns on needs-attention, timeout and skipped runs and errors on failures", () => {
    assert.equal(cronRunToast({ job: { name: "J" }, run: run("needs_attention", { error: "Blocked" }) })?.level, "warning");
    assert.equal(cronRunToast({ job: { name: "J" }, run: run("timeout") })?.level, "warning");
    assert.equal(cronRunToast({ job: { name: "J" }, run: run("skipped", { session_id: null }) })?.actions.join(), "Open Cron Jobs");
    const failed = cronRunToast({ job: { name: "J" }, run: run("failed", { error: "The provider rejected the API key." }) });
    assert.equal(failed?.level, "error");
    assert.ok(failed?.text.includes("API key"));
    assert.deepEqual(failed?.actions, ["Open Session", "Open Cron Jobs"]);
  });

  it("never notifies when the job is set to never", () => {
    assert.equal(cronRunToast({ job: { name: "J", notify: "never" }, run: run("failed") }), null);
  });
});
