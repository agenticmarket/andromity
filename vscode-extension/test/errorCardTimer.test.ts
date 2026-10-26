import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadChat } from "./helpers/chatHarness.js";

type FakeNode = Record<string, any>;

function el(tagName: string, textContent = "", opts: { classes?: string[]; attrs?: Record<string, string>; childNodes?: FakeNode[] } = {}): FakeNode {
  return {
    nodeType: 1, tagName, textContent,
    classList: { contains: (c: string) => (opts.classes || []).includes(c) },
    getAttribute: (name: string) => (opts.attrs || {})[name] ?? null,
    childNodes: opts.childNodes || [],
  };
}

/** A parsed backend card, as DOMParser would return it, built from plain objects. */
function parserFor(errorType: string, bodyNodes: FakeNode[], buttons: FakeNode[]) {
  const parts: Record<string, FakeNode> = {
    ".error-card-body": el("DIV", "", { childNodes: bodyNodes }),
    ".error-badge": el("SPAN", "HIGH DEMAND"),
    ".error-title": el("SPAN", "Andromity is busy right now"),
  };
  const card = {
    getAttribute: (name: string) => (name === "data-error-type" ? errorType : null),
    querySelector: (selector: string) => parts[selector] ?? null,
    querySelectorAll: (selector: string) => (selector.includes("[data-action]") ? buttons : []),
  };
  return class {
    parseFromString() {
      return { querySelector: (selector: string) => (selector === ".andromity-error-card" ? card : null) };
    }
  };
}

function rebuild(parser: unknown): string {
  const chat = loadChat();
  chat.sandbox.DOMParser = parser;
  return chat.eval("errorCardFromMarkup('<div class=\"andromity-error-card\"></div>')");
}

describe("backend error card timer", () => {
  it("keeps a classed timer as its own badge instead of running it into the message", () => {
    const html = rebuild(parserFor("service_busy", [
      el("DIV", "Shared models are in very high demand right now."),
      el("DIV", "Expected back around 20:02 your time", { classes: ["error-card-timer"] }),
    ], [
      el("BUTTON", "Switch Model", { attrs: { "data-action": "switch-model-flyout", title: "Choose another model" } }),
      el("BUTTON", "Retry Turn", { attrs: { "data-action": "retry-turn" } }),
      el("BUTTON", "Use Your Own Key", { attrs: { "data-action": "open-settings" } }),
      el("BUTTON", "Run evil", { attrs: { "data-action": "send-starter" } }),
    ]));
    assert.match(html, /very high demand right now\.<br><div style="[^"]*">.*Expected back around 20:02 your time<\/div>/);
    assert.ok(!html.includes("right now.Expected"), html);
    assert.match(html, /data-error-type="service_busy"/);
    assert.ok(html.indexOf('data-action="switch-model-flyout"') < html.indexOf('data-action="retry-turn"'));
    assert.match(html, /class="btn-error-retry" data-action="switch-model-flyout"/);
    assert.ok(html.includes('data-action="open-settings"'));
    assert.ok(!html.includes("send-starter"), "only known card actions survive");
  });

  it("still recognises the older quota timer by its text", () => {
    const html = rebuild(parserFor("quota_exceeded", [
      el("DIV", "You have reached your daily limit."),
      el("DIV", "Quota resets in 3h 10m (00:00 UTC)"),
    ], []));
    assert.match(html, /<br><div style="[^"]*">.*Quota resets in 3h 10m \(00:00 UTC\)<\/div>/);
  });

  it("escapes timer text from the backend", () => {
    const html = rebuild(parserFor("service_busy", [
      el("DIV", "<img src=x onerror=alert(1)>", { classes: ["error-card-timer"] }),
    ], []));
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("&lt;img"), html);
  });
});
