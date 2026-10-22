import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";

const script = getChatClientScript("icon.svg", {
  currentSessionId: "current", currentModel: "model", currentProvider: "provider",
  currentMode: "safe", currentProfile: "builder", currentReasoning: "medium",
});
const start = script.indexOf("    function renderRunningArc(");
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
  it("shows an Interrupted badge with an explanation and no running spinner", () => {
    const html = renderItem({ ...base, status: "interrupted" });
    assert.ok(html.includes("session-status-interrupted"), html);
    assert.ok(html.includes(">Interrupted<"));
    assert.match(html, /title="Andromity stopped before this reply finished[^"]*Open the chat and send a message to continue\."/);
    assert.ok(!html.includes("session-running-arc"), "an interrupted session must not spin");
  });

  it("still spins for a session that is really running", () => {
    assert.ok(renderItem({ ...base, status: "running" }).includes("session-running-arc"));
    assert.ok(renderItem({ ...base, status: "idle" }, { s1: { isRunning: true } }).includes("session-running-arc"));
  });

  it("keeps the other end states as they were", () => {
    assert.ok(renderItem({ ...base, status: "cancelled" }).includes(">Cancelled<"));
    assert.ok(renderItem({ ...base, status: "error" }).includes("session-status-error"));
    const idle = renderItem({ ...base, status: "idle" });
    assert.ok(!idle.includes("session-badge-status") && !idle.includes("session-running-arc"));
  });

  it("styles the Interrupted badge like other states that need attention", () => {
    const css = getChatStyles();
    assert.match(css, /\.session-badge-status\.session-status-paused_limit_reached,\s*\.session-badge-status\.session-status-interrupted\s*\{/);
  });
});
