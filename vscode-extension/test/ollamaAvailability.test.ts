import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vm from "node:vm";

const source = readFileSync("src/panels/SettingsPanel.ts", "utf8");
const emptyState = source.slice(source.indexOf("      if (activeProvider === 'ollama'", source.indexOf("    function renderModels()")), source.indexOf("      const filtered = allModels.filter"));
const selection = source.slice(source.indexOf("    window.selectModel ="), source.indexOf("    window.togglePin ="));

it("shows setup actions rather than catalog models when Ollama is stopped or missing", () => {
  for (const installed of [true, false]) {
    const grid = { innerHTML: "" };
    const context = vm.createContext({ grid, activeProvider: "ollama", ollamaChecked: true,
      ollamaStatus: { running: false, installed, models: [] } });
    vm.runInContext("function render(){" + emptyState + "}\nrender();", context);
    assert.ok(grid.innerHTML.includes("Ollama is not running"));
    assert.ok(grid.innerHTML.includes("Install Ollama"));
    assert.equal(grid.innerHTML.includes('data-action="start-ollama"'), installed);
    assert.ok(grid.innerHTML.includes("Setup documentation"));
  }
});

it("distinguishes a running empty installation from stopped Ollama", () => {
  const grid = { innerHTML: "" };
  vm.runInNewContext("function render(){" + emptyState + "}\nrender();", {
    grid, activeProvider: "ollama", ollamaChecked: true, ollamaStatus: { running: true, models: [] },
  });
  assert.ok(grid.innerHTML.includes("No models installed"));
  assert.ok(grid.innerHTML.includes("Download qwen2.5-coder:7b"));
  assert.ok(!grid.innerHTML.includes("Start Ollama"));
});

it("rejects stale Ollama selections and allows only installed models", () => {
  const posts: any[] = [];
  const context = vm.createContext({ window: {}, ollamaStatus: { running: true, models: ["installed:3b"] },
    renderModels: () => {}, updateActiveBanner: () => {}, vscode: { postMessage: (message: any) => posts.push(message) } });
  vm.runInContext(selection + "window.selectModel('catalog:7b', 'ollama');", context);
  assert.equal(posts[0].type, "check_ollama_status");
  assert.ok(!posts.some(message => message.type === "select_model"));
  vm.runInContext("window.selectModel('installed:3b', 'ollama');", context);
  assert.equal(posts[1].type, "select_model");
  assert.equal(posts[1].modelId, "installed:3b");
});
