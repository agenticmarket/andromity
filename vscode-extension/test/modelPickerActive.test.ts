import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { element, loadChat } from "./helpers/chatHarness.js";

function picker(currentModel: string, currentProvider: string, models: any[]) {
  const list = element();
  const h = loadChat({ state: { currentModel, currentProvider }, elements: { "flyout-list": list } });
  h.sandbox.__models = models;
  h.eval("allModels = __models; pinnedModels = [];");
  const render = (query = "") => {
    h.eval(`renderFlyoutList(${JSON.stringify(query)})`);
    const html: string = list.innerHTML;
    const rows = [...html.matchAll(/class="flyout-item ?(active)?"[^>]*data-model-id="([^"]+)" data-provider="([^"]+)"/g)]
      .map(m => ({ active: m[1] === "active", key: `${m[3]}/${m[2]}` }));
    const sections = [...html.matchAll(/flyout-section-title"><span>([A-Z ]+)<\/span>/g)].map(m => m[1]);
    return { html, rows, sections, active: rows.filter(r => r.active).map(r => r.key) };
  };
  return { render };
}

const haikus = [
  { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5", provider: "openrouter" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "commoncode" },
];

describe("Model picker shows the active model", () => {
  it("marks only the model on the session's provider, not every model with the same ID", () => {
    const view = picker("claude-haiku-5-5", "commoncode", haikus).render();
    assert.deepEqual(view.active, ["commoncode/claude-haiku-5-5"]);
    assert.equal((view.html.match(/flyout-active-label">Active</g) || []).length, 1);
  });

  it("lists the active model first, under Current, and not again below", () => {
    const view = picker("claude-haiku-5-5", "anthropic", haikus).render();
    assert.deepEqual(view.sections, ["CURRENT", "ALL MODELS"]);
    assert.deepEqual(view.rows[0], { active: true, key: "anthropic/claude-haiku-5-5" });
    assert.equal(view.rows.filter(r => r.key === "anthropic/claude-haiku-5-5").length, 1);
  });

  it("puts the active model at the top of search results", () => {
    const view = picker("claude-haiku-5-5", "anthropic", haikus).render("haiku");
    assert.deepEqual(view.rows[0], { active: true, key: "anthropic/claude-haiku-5-5" });
    assert.equal(view.rows.length, 4);
  });

  it("still shows the active model when it is past the list cap or missing from the catalog", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `vendor/model-${i}`, name: `Model ${i}`, provider: "openrouter" }));
    assert.deepEqual(picker("vendor/model-59", "openrouter", many).render().rows[0], { active: true, key: "openrouter/vendor/model-59" });

    const missing = picker("claude-haiku-5-5", "andromity", many).render();
    assert.deepEqual(missing.rows[0], { active: true, key: "andromity/claude-haiku-5-5" });
    assert.equal(missing.active.length, 1);
  });
});
