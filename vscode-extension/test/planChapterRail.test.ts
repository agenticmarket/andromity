import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getPlanChapterRailScript, getPlanChapterRailStyles } from "../src/panels/planChapterRail.js";

const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (name: string) {
  if (name === "vscode") return { Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ path: parts.join("/") }) } };
  return originalRequire.apply(this, arguments);
};
const { PlanEditorPanel } = require("../src/panels/PlanEditorPanel.js");
Module.prototype.require = originalRequire;

function planHtml(): string {
  const panel = Object.create(PlanEditorPanel.prototype);
  panel._extensionUri = { fsPath: "ext" };
  panel._currentPlan = { title: "Plan", status: "pending", body: "## One\n\ntext\n\n## Two" };
  return panel._getHtmlForWebview({ cspSource: "vscode-webview:", asWebviewUri: (u: unknown) => String(u) });
}

it("injects the chapter rail into the plan tab", () => {
  const html = planHtml();
  assert.ok(html.includes(getPlanChapterRailScript().trim().slice(0, 200)));
  assert.ok(html.includes(getPlanChapterRailStyles().trim().slice(0, 200)));
  const script = html.slice(html.lastIndexOf("<script"), html.lastIndexOf("</script>"));
  assert.ok(script.indexOf("const chapterRail =") < script.indexOf("renderPlan(embeddedPlan)"), "the rail must exist before the first plan renders");
  new vm.Script(script.slice(script.indexOf(">") + 1));
});

it("treats markdown headings, the checklist and open questions as chapters", () => {
  const rail = getPlanChapterRailScript();
  for (const selector of [".plan-markdown > h1", ".plan-markdown > h2", ".plan-markdown > h3", "#plan-content > .steps-card", "#plan-content > .questions-box"]) {
    assert.ok(rail.includes(selector), selector);
  }
});

it("rebuilds when the plan re-renders and keeps the rail off for a single section", () => {
  const rail = getPlanChapterRailScript();
  assert.ok(rail.includes("new MutationObserver(scheduleChapterRail).observe(contentEl, { childList: true })"));
  assert.ok(rail.includes("chapters.length > 1"));
});

it("keeps headings clear of the sticky action bar when jumping", () => {
  assert.match(getPlanChapterRailStyles(), /scroll-margin-top: \d+px/);
});
