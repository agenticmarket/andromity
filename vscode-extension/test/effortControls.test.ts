import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

function harness() {
  const script = getChatClientScript("icon", {
    currentSessionId: "test", currentProvider: "openrouter", currentModel: "custom",
    currentMode: "safe", currentProfile: "builder", currentReasoning: "off",
  });
  const discovery = script.slice(script.indexOf("    let REASONING_LEVELS ="), script.indexOf("    let attachedImages ="));
  const controls = script.slice(script.indexOf("    function getReasoningLevelIndex"), script.indexOf("    function updateReasoningBadge"));
  const elements = new Map<string, any>();
  const create = () => {
    const element: any = {
      children: [], style: {}, classList: { toggle() {}, remove() {} },
      removeAttribute() {}, setAttribute(key: string, value: string) { this[key] = value; },
      addEventListener() {}, appendChild(child: any) { this.children.push(child); },
    };
    Object.defineProperty(element, "innerHTML", { set() { element.children = []; } });
    return element;
  };
  const posts: any[] = [];
  const context: any = {
    currentModel: "custom", currentProvider: "openrouter", currentReasoning: "off", allModels: [],
    document: {
      getElementById(id: string) { if (!elements.has(id)) elements.set(id, create()); return elements.get(id); },
      createElement: create,
    },
    vscode: { postMessage(message: any) { posts.push(message); } },
  };
  vm.createContext(context);
  vm.runInContext(discovery + controls, context);
  return { context, elements, posts, run: (code: string) => vm.runInContext(code, context) };
}

describe("Model-specific effort controls", () => {
  it("orders reversed provider levels from low to max without adding unsupported levels", () => {
    const h = harness();
    h.context.allModels = [{ id: "custom", provider: "openrouter", reasoning: {
      supported_efforts: ["max", "high", "low"], default_effort: "auto",
    } }];
    h.run("updateReasoningUI()");
    assert.deepEqual(h.elements.get("reasoning-slider-labels").children.map((b: any) => b.textContent), ["Auto", "Low", "High", "Max"]);
  });

  it("renders the exact enum including future levels and adjusts slider bounds", () => {
    const h = harness();
    h.context.allModels = [{ id: "custom", provider: "openrouter", reasoning: {
      mode: "configurable", supported_efforts: ["low", "xhigh", "ultra"], default_effort: "low",
    } }];
    h.run("updateReasoningUI()");
    assert.deepEqual(h.elements.get("reasoning-slider-labels").children.map((b: any) => b.textContent), ["Auto", "Low", "Xhigh", "Ultra"]);
    assert.equal(h.elements.get("reasoning-slider-range").max, "3");
    assert.equal(h.context.currentReasoning, "low");
    h.run("setReasoningLevel('off', true)");
    assert.equal(h.posts.length, 0);
    h.run("setReasoningLevel('ultra', true)");
    assert.equal(h.posts[0].value, "ultra");
  });

  it("preserves explicit supported off on initialization", () => {
    const h = harness();
    h.context.allModels = [{ id: "custom", provider: "openrouter", reasoning: {
      mode: "toggleable", supported_efforts: ["none", "high"], default_effort: "high",
    } }];
    h.run("updateReasoningUI()");
    assert.equal(h.context.currentReasoning, "off");
    assert.equal(h.elements.get("prompt-reasoning-label").textContent, "Off");
  });

  it("does not reuse another provider's capability for the same model id", () => {
    const h = harness();
    h.run("currentModelReasoningCapability = { _modelId: 'custom', _providerId: 'anthropic', supported_efforts: ['high'] }");
    h.run("updateReasoningUI()");
    assert.equal(h.elements.get("reasoning-slider-labels").children.length, 1);
    assert.equal(h.context.currentReasoning, "auto");
    assert.equal(h.elements.get("reasoning-slider-range").disabled, true);
    assert.equal(h.elements.get("btn-prompt-reasoning").disabled, true);
    assert.equal(h.elements.get("prompt-reasoning-label").textContent, "N/A");
    h.run("setReasoningLevel('auto', true)");
    assert.equal(h.posts.length, 0);
  });

  it("enables the control for toggle-only models", () => {
    const h = harness();
    h.context.allModels = [{ id: "custom", provider: "openrouter", reasoning: {
      mode: "toggleable", supported_efforts: ["on", "off"], default_effort: "auto",
    } }];
    h.run("updateReasoningUI()");
    assert.equal(h.elements.get("btn-prompt-reasoning").disabled, false);
    assert.deepEqual(h.elements.get("reasoning-slider-labels").children.map((b: any) => b.textContent), ["Auto", "Off", "On"]);
  });

  it("validates token budgets and clears unsupported values when switching models", () => {
    const h = harness();
    h.context.allModels = [{ id: "custom", provider: "openrouter", reasoning: {
      supported_efforts: ["on"], supports_max_tokens: true, request_format: "anthropic_budget", budget_min: 1024, budget_max: 8191,
    } }];
    h.run("updateReasoningUI(); setReasoningLevel('budget:2048', true)");
    assert.equal(h.posts[0].value, "budget:2048");
    assert.equal(h.elements.get("reasoning-budget-row").hidden, false);
    h.run("setReasoningLevel('budget:0', true); setReasoningLevel('budget:8192', true)");
    assert.equal(h.posts.length, 1);
    h.context.currentModel = "another";
    h.run("updateReasoningUI()");
    assert.equal(h.context.currentReasoning, "auto");
    assert.equal(h.elements.get("reasoning-budget-row").hidden, true);
  });
});
