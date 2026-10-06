import { it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { getUsageScript } from "../src/panels/usage/usageScript.js";
import { decodeUsagePng } from "../src/panels/usage/usageImage.js";

const Module = require("module");
const originalRequire = Module.prototype.require;
let saveTarget: unknown = { path: "/usage.png" };
let saved: Buffer | undefined;
let caption = "";
const notifications: string[] = [];
const mockVscode = {
  Uri: { file: (path: string) => ({ path }), joinPath: () => ({ fsPath: "icon.svg" }) },
  workspace: { workspaceFolders: [{ uri: { fsPath: "/project" } }], fs: { writeFile: async (_uri: unknown, bytes: Buffer) => { saved = bytes; } } },
  window: { showSaveDialog: async () => saveTarget, showErrorMessage: () => {}, showInformationMessage: (message: string) => notifications.push(message) },
  env: { clipboard: { writeText: async (value: string) => { caption = value; } } },
};
Module.prototype.require = function (name: string) {
  return name === "vscode" ? mockVscode : originalRequire.apply(this, arguments);
};
const { SettingsPanel } = require("../src/panels/SettingsPanel.js");
Module.prototype.require = originalRequire;

function harness(data: Record<string, unknown> = {}) {
  const elements: Record<string, any> = {};
  const texts: string[] = [];
  const posts: any[] = [];
  const context = {
    fillText: (value: string) => texts.push(value), fillRect: () => {}, drawImage: () => texts.push("LOGO DRAWN"),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  const element = (id: string) => elements[id] ||= {
    value: id === "usage-share-format" ? "square" : "recap", checked: false,
    addEventListener: () => {}, innerHTML: "", textContent: "", disabled: false, complete: true, naturalWidth: 128,
    querySelector: () => null, querySelectorAll: () => [],
  };
  const sandbox = vm.createContext({
    usageData: data, currentUsageRange: "all", currentUsageScope: "global",
    formatTokens: (n: number) => String(n),
    escapeHtml: (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
    vscode: { postMessage: (message: unknown) => posts.push(message) },
    document: { getElementById: element, createElement: () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => "data:image/png;base64,test" }) },
  });
  vm.runInContext(getUsageScript(), sandbox);
  return { sandbox, elements, texts, posts, element };
}

function settingsHtml(): string {
  const panel = Object.create(SettingsPanel.prototype);
  panel._panel = { webview: { cspSource: "vscode-webview:", asWebviewUri: () => "icon.svg" } };
  panel._extensionUri = { fsPath: "/extension" };
  panel._getNonce = () => "test";
  return panel._getHtmlForWebview();
}

it("builds 365 consecutive UTC dates across leap days and a timezone boundary", () => {
  const { sandbox } = harness();
  const days = vm.runInContext("usageDays('all', new Date('2024-03-01T00:30:00+05:30'))", sandbox);
  assert.equal(days.length, 365);
  assert.equal(days.at(-1).key, "2024-02-29");
  assert.equal(days[0].key, "2023-03-02");
  for (let i = 1; i < days.length; i++) assert.equal(days[i].date - days[i - 1].date, 86400000);
  assert.equal(vm.runInContext("usageDays('month').length", sandbox), 30);
});

it("counts gaps, current streak, best streak and empty days correctly", () => {
  const { sandbox } = harness();
  assert.equal(vm.runInContext("usageActivityStats([2,2,0,2,0].map(tokens => ({tokens}))).current", sandbox), 1);
  assert.equal(vm.runInContext("usageActivityStats([2,2,0,2,0].map(tokens => ({tokens}))).best", sandbox), 2);
  assert.equal(vm.runInContext("usageActivityStats([0,0].map(tokens => ({tokens}))).active", sandbox), 0);
  const svg = vm.runInContext("usageGridSvg(usageDays('all'))", sandbox);
  assert.equal((svg.match(/class="usage-day"/g) || []).length, 365);
  assert.ok(svg.includes('tabindex="0"'));
  assert.ok(svg.includes("0 tokens"));
});

it("keeps the original bar chart and uses all hourly aggregates despite session pagination", () => {
  const html = settingsHtml();
  assert.ok(html.includes('id="usage-bar-chart-container"'));
  assert.ok(html.includes('id="usage-chart-container"'));
  assert.ok(html.includes('data-usage-share-kind="daily"'));
  assert.ok(html.includes('data-usage-share-kind="activity"'));
  const { sandbox } = harness({ hourly_activity: { "2026-10-06T01": { tokens: 23000, count: 153, cost: 1 } }, sessions: [] });
  const slots = vm.runInContext("usageBarSlots([], 'today', new Date('2026-10-06T18:00:00Z'))", sandbox);
  assert.equal(slots[0].tokens, 23000);
  assert.equal(slots[0].count, 153);
  assert.equal(slots.length, 12);
});

it("ignores stale filter responses and closes the share dialog only on export success", () => {
  const { sandbox, element } = harness({ total_tokens: 99 });
  let closed = 0;
  element('usage-share-dialog').close = () => closed++;
  const html = settingsHtml();
  const start = html.indexOf('        case "usage_loaded": {');
  const end = html.indexOf('        case "models_refreshed": {', start);
  vm.runInContext('function consumeUsage(msg) { switch(msg.type) {' + html.slice(start, end) + '} }', sandbox);
  vm.runInContext("requestUsage(); currentUsageRange = 'week'; requestUsage(); consumeUsage({type:'usage_loaded',requestId:1,timeRange:'all',scope:'global',usage:{total_tokens:777}});", sandbox);
  assert.equal(vm.runInContext('usageData.total_tokens', sandbox), 99);
  vm.runInContext("consumeUsage({type:'usage_export_result',success:false,cancelled:true});", sandbox);
  assert.equal(closed, 0);
  vm.runInContext("consumeUsage({type:'usage_export_result',success:true});", sandbox);
  assert.equal(closed, 1);
});

it("renders full aggregate totals and paginates models without changing their share denominator", () => {
  const models = Object.fromEntries(Array.from({ length: 23 }, (_, i) => ["model-" + i, { tokens: 100, cost: 0 }]));
  const { sandbox, elements } = harness({ total_tokens: 2300, total_sessions: 153, sessions_total: 153, sessions_offset: 110, by_model: models, by_provider: {}, sessions: [] });
  const panel = Object.create(SettingsPanel.prototype);
  panel._panel = { webview: { cspSource: "vscode-webview:", asWebviewUri: () => "icon.svg" } };
  panel._extensionUri = { fsPath: "/extension" };
  panel._getNonce = () => "test";
  const html = panel._getHtmlForWebview();
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  const start = html.indexOf("    function renderUsageChart(");
  const end = html.indexOf("    function renderSkills()", start);
  vm.runInContext(html.slice(start, end) + "\nrenderUsage();", sandbox);
  assert.equal(elements["stat-usage-tokens"].textContent, "2300");
  assert.equal(elements["stat-usage-sessions"].textContent, "153");
  assert.equal((elements["usage-models-breakdown"].innerHTML.match(/class="usage-item-row"/g) || []).length, 10);
  assert.ok(elements["usage-models-breakdown"].innerHTML.includes("(4%)"));
  vm.runInContext("usageModelPage = 2; renderModelBreakdown([]);", sandbox);
  assert.equal((elements["usage-models-breakdown"].innerHTML.match(/class="usage-item-row"/g) || []).length, 3);
  assert.ok(elements["usage-models-pagination"].innerHTML.includes("21–23 of 23"));
});

it("requests older sessions with range, scope and a monotonically increasing request ID", () => {
  const { sandbox, posts, elements } = harness();
  vm.runInContext("currentUsageRange = 'week'; currentUsageScope = 'project'; usageSessionPage = 11; requestUsage(false); requestUsage();", sandbox);
  assert.equal(posts[0].offset, 110);
  assert.equal(posts[0].timeRange, "week");
  assert.equal(posts[0].scope, "project");
  assert.equal(posts[1].offset, 0);
  assert.equal(posts[1].requestId, posts[0].requestId + 1);
  assert.equal(elements["usage-share-open"].disabled, true);
});

it("creates all nine card variants with exact dimensions, real logo, optional cost and aggregate-only text", () => {
  const { sandbox, element, texts } = harness({ total_tokens: 12345, total_sessions: 153, total_cost_usd: 9.5, sessions: [{ name: "PRIVATE SESSION", project_path: "PRIVATE PATH" }], by_model: { "PRIVATE MODEL": { tokens: 12345 } } });
  for (const format of ["square", "landscape", "story"]) {
    for (const kind of ["recap", "activity", "daily"]) {
      element("usage-share-format").value = format;
      element("usage-share-kind").value = kind;
      const result = vm.runInContext("usageShareCanvas()", sandbox);
      assert.deepEqual([result.canvas.width, result.canvas.height], format === "story" ? [1080, 1920] : format === "landscape" ? [1200, 675] : [1080, 1080]);
    }
  }
  assert.ok(texts.includes("github.com/agenticmarket/andromity"));
  assert.equal(texts.filter(text => text === "LOGO DRAWN").length, 9);
  assert.ok(texts.includes("ACTIVE DAYS · LAST YEAR"));
  assert.ok(!texts.join(" ").includes("PRIVATE"));
  assert.ok(!texts.join(" ").includes("Estimated API cost"));
  element("usage-share-cost").checked = true;
  vm.runInContext("usageShareCanvas()", sandbox);
  assert.ok(texts.join(" ").includes("$9.5000"));
});

function png(): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(1080, 16); bytes.writeUInt32BE(1080, 20);
  return "data:image/png;base64," + bytes.toString("base64");
}

it("bounds PNG payloads and rejects other image types and invalid headers", () => {
  assert.equal(decodeUsagePng(png()).length, 24);
  for (const value of [null, "data:image/svg+xml;base64,AAAA", "data:image/png;base64,AAAA", "x".repeat(12_000_001)]) assert.throws(() => decodeUsagePng(value));
});

it("saves PNG and copies caption without a daemon; cancellation never writes a file", async () => {
  const panel = Object.create(SettingsPanel.prototype);
  const posts: any[] = [];
  panel._rpcClient = null;
  panel._panel = { webview: { postMessage: (message: unknown) => posts.push(message) } };
  saved = undefined;
  await panel._handleMessage({ type: "export_usage_image", image: png(), format: "square" });
  assert.ok(saved);
  assert.equal(posts.at(-1).success, true);
  assert.equal(notifications.at(-1), "Exported usage image.");
  const notificationCount = notifications.length;
  saved = undefined; saveTarget = undefined;
  await panel._handleMessage({ type: "export_usage_image", image: png() });
  assert.equal(saved, undefined);
  assert.equal(posts.at(-1).cancelled, true);
  assert.equal(notifications.length, notificationCount);
  await panel._handleMessage({ type: "copy_usage_caption", caption: "Building with Andromity" });
  assert.equal(caption, "Building with Andromity");
});
