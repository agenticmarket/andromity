import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";

const script = getChatClientScript("icon.svg", {
  currentSessionId: "current", currentModel: "model", currentProvider: "provider",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
});
const start = script.indexOf("    function renderRunningLabel(");
const end = script.indexOf("    function filterAndRenderSessions(");
assert.ok(start > 0 && end > start, "session list renderer not found in the webview script");
const renderer = script.slice(start, end);

function renderItem(session: Record<string, unknown>, sessionsState: Record<string, unknown> = {}): string {
  const context = vm.createContext({
    session, sessionsState, currentSessionId: "current",
    escapeHtml: (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    cleanPromptForDisplay: (value: unknown) => String(value ?? ""),
    formatDateBadge: () => "1d ago",
    formatFullTimeTooltip: () => "",
  });
  return vm.runInContext(renderer + "\nrenderSessionItemHtml(session, {});", context);
}

const base = { id: "s1", name: "Explaining project architecture", message_count: 9, cost_usd: 0.004, updated_at: "2026-10-16T05:58:21Z" };

describe("Interrupted sessions in the session list", () => {
  it("shows an Interrupted badge with an explanation and no running label", () => {
    const html = renderItem({ ...base, status: "interrupted" });
    assert.ok(html.includes("session-status-interrupted"), html);
    assert.ok(html.includes(">Interrupted<"));
    assert.match(html, /title="Andromity stopped before this reply finished[^"]*Open the chat and send a message to continue\."/);
    assert.ok(!html.includes("session-status-running"), "an interrupted session must not show Running");
  });

  it("shows a shimmering Running label, not a dot, for a session that is really running", () => {
    const running = renderItem({ ...base, status: "running" });
    assert.match(running, /class="session-badge-status session-status-running status-shimmer">Running</);
    assert.ok(renderItem({ ...base, status: "idle" }, { s1: { isRunning: true } }).includes("session-status-running"));
    assert.ok(!running.includes("-dot"), running);
  });

  it("marks the open session without a dot", () => {
    const html = renderItem({ ...base, id: "current" });
    assert.ok(html.includes('aria-current="true"') && !html.includes("-dot"), html);
  });

  it("keeps the other end states as they were", () => {
    assert.ok(renderItem({ ...base, status: "cancelled" }).includes(">Cancelled<"));
    assert.ok(renderItem({ ...base, status: "error" }).includes("session-status-error"));
    const idle = renderItem({ ...base, status: "idle" });
    assert.ok(!idle.includes("session-badge-status"));
  });

  it("styles the Interrupted badge like other states that need attention", () => {
    const css = getChatStyles();
    assert.match(css, /\.session-badge-status\.session-status-paused_limit_reached,\s*\.session-badge-status\.session-status-interrupted\s*\{/);
  });
});
