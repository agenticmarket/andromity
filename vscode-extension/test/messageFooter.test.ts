/**
 * messageFooter.test.ts
 * Unit tests for the post-response meta strip ("344.3s · 04:43 PM · Copy").
 *
 * The footer helpers live inside the generated webview client script, so they
 * are extracted and evaluated in a Node VM — the same approach already used by
 * webviewScripts.test.ts. This validates the rendered markup (not just syntax)
 * and the theme-parity of the accompanying styles.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";
import type { ChatViewState } from "../src/providers/chatview/chatHtml.js";

const TEST_STATE: ChatViewState = {
  currentSessionId: "sess-footer",
  currentModel: "anthropic/claude-3.7-sonnet",
  currentProvider: "anthropic",
  currentMode: "safe",
  currentProfile: "builder",
  currentReasoning: "medium",
  models: [],
};

/**
 * Extracts the footer runtime (formatDuration + buildMessageFooter +
 * pinLatestMessageFooter) out of the generated script and runs it in a VM with
 * a minimal DOM stub.
 */
function loadFooterRuntime(): any {
  const script = getChatClientScript("vscode-resource://icon.svg", TEST_STATE);
  const start = script.indexOf("// Humanized turn duration");
  const end = script.indexOf("function normalizePromptText");
  assert.ok(start > -1, "footer helpers must exist in the generated client script");
  assert.ok(end > start, "footer helpers must be emitted before normalizePromptText");

  const sandbox: any = {
    document: {
      createElement: () => ({ className: "", innerHTML: "", appendChild: () => {} }),
      querySelectorAll: () => [],
    },
  };
  sandbox.formatTime = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  vm.createContext(sandbox);
  new vm.Script(script.substring(start, end), { filename: "footerRuntime.js" }).runInContext(sandbox);
  return sandbox;
}

/** Counts how many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Post-response meta strip (footer) unit tests", () => {
  it("formatDuration should humanize seconds instead of printing raw floats", () => {
    const rt = loadFooterRuntime();
    assert.equal(rt.formatDuration(344.3), "5m 44s", "344.3s must read as 5m 44s");
    assert.equal(rt.formatDuration(0.42), "0.4s");
    assert.equal(rt.formatDuration(42.7), "43s");
    assert.equal(rt.formatDuration(59.6), "1m");
    assert.equal(rt.formatDuration(60), "1m");
    assert.equal(rt.formatDuration(300), "5m");
    assert.equal(rt.formatDuration(3725), "1h 02m");
    assert.equal(rt.formatDuration(3661), "1h 01m");
    assert.equal(rt.formatDuration(-1), "", "negative durations render nothing");
    assert.equal(rt.formatDuration(undefined), "", "missing durations render nothing");
  });

  it("buildMessageFooter should render a duration badge, timestamp and copy action", () => {
    const rt = loadFooterRuntime();
    const ts = new Date(2026, 8, 24, 16, 43, 0).getTime();
    const footer = rt.buildMessageFooter({
      durationSeconds: 344.3,
      timestamp: ts,
      copyAction: "copy-message",
      copyTitle: "Copy response",
    });
    const html: string = footer.innerHTML;

    assert.equal(footer.className, "message-footer");
    assert.ok(html.includes('class="message-meta"'), "meta group must wrap duration + time");
    assert.ok(html.includes("5m 44s"), "humanized duration must be shown");
    assert.ok(html.includes("<span>5m 44s</span>"), "visible duration label must be humanized");
    assert.ok(html.includes("Took 344.3s"), "exact seconds must survive in the tooltip");
    assert.ok(html.includes('class="message-time"'), "timestamp must be rendered");
    assert.ok(/message-time">\d{1,2}:\d{2}/.test(html), "timestamp must be a localized clock time");
    assert.ok(html.includes('class="turn-duration-badge"'), "duration badge must be themed");
    assert.ok(html.includes('class="message-actions"'), "actions must be grouped");
    assert.ok(html.includes('data-action="copy-message"'), "copy action must keep the delegation hook");
    assert.ok(html.includes('aria-label="Copy response"'), "copy action must be accessible");
    assert.equal(count(html, "<span"), count(html, "</span>"), "meta strip markup must be balanced");
  });

  it("buildMessageFooter should omit the duration badge for prompts but keep time + copy", () => {
    const rt = loadFooterRuntime();
    const footer = rt.buildMessageFooter({
      timestamp: Date.now(),
      copyAction: "copy-prompt",
      copyTitle: "Copy prompt",
    });
    const html: string = footer.innerHTML;

    assert.ok(!html.includes("turn-duration-badge"), "prompts have no turn duration");
    assert.ok(html.includes('class="message-time"'), "prompt timestamp must still render");
    assert.ok(html.includes('data-action="copy-prompt"'), "prompt copy hook must be preserved");
    assert.equal(count(html, "<span"), count(html, "</span>"));
  });

  it("buildMessageFooter should tolerate missing options", () => {
    const rt = loadFooterRuntime();
    const footer = rt.buildMessageFooter();
    assert.equal(footer.className, "message-footer");
    assert.ok(!footer.innerHTML.includes("button"), "no copy button without copyAction");
  });

  it("chat styles should expose the meta strip tokens and stay balanced", () => {
    const css = getChatStyles();
    for (const token of [
      ".message-footer.visible",
      ".message-meta",
      ".message-meta-sep",
      ".message-time",
      ".message-actions",
      ".msg-copy-btn.copied",
      ".assistant-text li::marker",
      ".assistant-text li > p",
      "--font-mono",
    ]) {
      assert.ok(css.includes(token), `styles must define ${token}`);
    }
    assert.ok(css.includes("font-variant-numeric: tabular-nums"), "duration digits must not jitter");
    assert.ok(!css.includes("margin: 4px 0 6px 18px"), "legacy duplicate list rule must be removed");
    assert.equal(count(css, "{"), count(css, "}"), "generated CSS braces must balance");
  });
});

