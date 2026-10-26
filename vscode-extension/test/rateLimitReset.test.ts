import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { getRateLimitResetScript, rateLimitResetAt } from "../src/providers/chatview/rateLimitReset.js";
import { element, loadChat } from "./helpers/chatHarness.js";

const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);

describe("rateLimitResetAt", () => {
  it("reads reset headers in milliseconds or seconds", () => {
    const inMs = NOW + 3 * 3600_000;
    assert.equal(rateLimitResetAt(`"X-RateLimit-Reset":"${inMs}"`, NOW), inMs);
    assert.equal(rateLimitResetAt(`x-ratelimit-reset: ${Math.floor(inMs / 1000)}`, NOW), Math.floor(inMs / 1000) * 1000);
    assert.equal(rateLimitResetAt(`x-ratelimit-reset-requests=${inMs}`, NOW), inMs);
  });

  it("reads retry-after and 'try again in' phrasing", () => {
    assert.equal(rateLimitResetAt('"retry_after": 30', NOW), NOW + 30_000);
    assert.equal(rateLimitResetAt("Retry-After: 12.5", NOW), NOW + 12_500);
    assert.equal(rateLimitResetAt("Please try again in 20s.", NOW), NOW + 20_000);
    assert.equal(rateLimitResetAt("Please try again in 1m30s", NOW), NOW + 90_000);
    assert.equal(rateLimitResetAt("try again in 6.5 seconds", NOW), NOW + 6_500);
    assert.equal(rateLimitResetAt("Quota resets in 2 hours", NOW), NOW + 7_200_000);
    assert.equal(rateLimitResetAt("retry in 450ms", NOW), NOW + 450);
  });

  it("ignores values that cannot be a reset time", () => {
    assert.equal(rateLimitResetAt("Rate limit exceeded", NOW), null);
    assert.equal(rateLimitResetAt(`X-RateLimit-Reset: ${NOW - 86_400_000}`, NOW), null, "long past");
    assert.equal(rateLimitResetAt(`X-RateLimit-Reset: ${NOW + 60 * 86_400_000}`, NOW), null, "absurdly far");
    assert.equal(rateLimitResetAt("X-RateLimit-Limit: 50", NOW), null);
    assert.equal(rateLimitResetAt("error 1793030400000123", NOW), null);
    assert.equal(rateLimitResetAt(undefined as any, NOW), null);
    const start = Date.now();
    rateLimitResetAt("try again in " + "1".repeat(50_000) + "x", NOW);
    assert.ok(Date.now() - start < 1000);
  });

  it("runs from its injected source alone", () => {
    const sandbox: any = {};
    vm.createContext(sandbox);
    vm.runInContext(getRateLimitResetScript() + "this.out = rateLimitResetAt('try again in 5s', 1000);", sandbox);
    assert.equal(sandbox.out, 6000);
  });
});

describe("rate limit error card", () => {
  function render(error: string) {
    let html = "";
    const chat = loadChat({
      elements: {
        "chat-messages": element({ appendChild: (node: any) => { html = node.innerHTML || ""; return node; } }),
      },
    });
    chat.eval("document.createElement = () => { const el = { innerHTML: '', firstElementChild: null, appendChild() {}, set className(v) {}, setAttribute() {} }; return el; };");
    chat.post({ type: "agent_error", error });
    return html;
  }

  it("tells the user when a long limit lifts and leads with switching model", () => {
    const reset = Date.now() + 5 * 3600_000;
    const html = render(`litellm.RateLimitError: {"error":{"message":"Rate limit exceeded: free-models-per-day","code":429,"metadata":{"headers":{"X-RateLimit-Reset":"${reset}"}}}}`);
    assert.match(html, /free-models-per-day\. The limit resets at /);
    assert.match(html, /Switch to another model to keep working now\./);
    assert.ok(html.indexOf('data-action="switch-model-flyout"') < html.indexOf('data-action="retry-turn"'), "switch model comes first");
    assert.match(html, /class="btn-error-retry" data-action="switch-model-flyout"/);
  });

  it("classifies by whole status codes, not digits inside timestamps or IDs", () => {
    const reset = Date.now() + 3 * 3600_000;
    const rateLimited = render(`RateLimitError 429: {"request_id":"req_4045001","X-RateLimit-Reset":"${reset}"}`);
    assert.match(rateLimited, /data-error-type="rate_limit"/);
    assert.match(render("Error code: 404 - model gpt-x not found"), /data-error-type="model_not_found"/);
    assert.match(render("upstream returned 503 Service Unavailable"), /data-error-type="provider_unavailable"/);
    assert.match(render("HTTP 401: invalid credentials"), /data-error-type="auth_error"/);
    assert.doesNotMatch(render("Tool output had 14045 lines and took 5002ms"), /data-error-type="(model_not_found|provider_unavailable|auth_error|rate_limit)"/);
  });

  it("keeps Retry first for a short wait and for unknown resets", () => {
    const short = render("429 Too Many Requests. Please try again in 20s");
    assert.match(short, /resets in under a minute\. Retry after that\./);
    assert.ok(short.indexOf('data-action="retry-turn"') < short.indexOf('data-action="switch-model-flyout"'));
    const unknown = render("429 rate limit exceeded");
    assert.match(unknown, /Please wait a moment and click Retry\./);
  });
});
