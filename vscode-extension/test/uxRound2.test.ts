import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { element, loadChat } from "./helpers/chatHarness.js";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";
import { getChatActivityStyles } from "../src/providers/chatview/chatActivityStyles.js";
import { getChatPolishStyles } from "../src/providers/chatview/chatPolishStyles.js";
import { getWaterfallStyles } from "../src/providers/waterfall/waterfallStyles.js";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import { BackgroundSessions, SessionViewState, describeToolActivity } from "../src/backgroundSessions.js";

const SRC = join(__dirname, "..", "..", "src");
const source = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const WHITE = /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/g;
const LIGHT_TINT = /:root:has\(> body\.vscode-light\), :root:has\(> body\.vscode-high-contrast-light\) \{\s*--tint: 0, 0, 0;/;

describe("light themes", () => {
  it("chat and Waterfall tint surfaces with the theme instead of fixed white", () => {
    const chat = getChatStyles() + getChatActivityStyles() + getChatPolishStyles();
    assert.equal((chat.match(WHITE) || []).length, 0);
    assert.match(chat, /--tint: 255, 255, 255;/);
    assert.match(chat, LIGHT_TINT);
    assert.ok(chat.includes(".activity-row:hover .activity-filename {\n      color: var(--vscode-textLink-activeForeground, var(--fg));"), "hover text follows the theme");

    const waterfall = getWaterfallStyles();
    assert.equal((waterfall.match(WHITE) || []).length, 1, "only the decorative progress shimmer stays white");
    assert.match(waterfall, LIGHT_TINT);
    assert.doesNotMatch(waterfall, /:\s*;/, "every Waterfall declaration has a value");
    assert.match(waterfall, /\.wf-tab \{[^}]*background: transparent;/, "inactive Waterfall tabs keep the panel background");
  });

  it("Settings, Plan, Changes Review and background task panels follow the theme too", () => {
    for (const file of ["panels/SettingsPanel.ts", "panels/PlanEditorPanel.ts", "providers/changesReview/reviewStyles.ts", "panels/BackgroundTaskPanel.ts"]) {
      const text = source(file);
      assert.equal((text.match(WHITE) || []).length, 0, file);
    }
    for (const file of ["panels/SettingsPanel.ts", "panels/PlanEditorPanel.ts", "providers/changesReview/reviewStyles.ts", "panels/BackgroundTaskPanel.ts"]) {
      assert.match(source(file), /--tint: 255, 255, 255;/, file);
    }
  });

  it("uses the class names VS Code actually sets for high contrast", () => {
    const chat = getChatStyles() + getChatPolishStyles();
    assert.ok(!/vscode-highContrast/.test(chat));
    assert.match(chat, /body\.vscode-high-contrast-light \.prompt-box/);
  });
});

describe("keyboard access in the chat", () => {
  function toggleCard(open: boolean) {
    const card: any = element();
    if (open) card.classList.add("expanded");
    const header: any = element();
    header.matches = (sel: string) => sel.split(",").includes(".tool-header");
    header.closest = (sel: string) => sel === ".tool-card" ? card : (sel.includes('[role="button"]') && header.attrs.role === "button" ? header : null);
    return { card, header };
  }

  it("tool headers become focusable buttons that report whether they are expanded", () => {
    const h = loadChat();
    const { header } = toggleCard(true);
    h.sandbox.header = header;
    h.eval("syncToggleHeader(header)");
    assert.equal(header.attrs.tabindex, "0");
    assert.equal(header.attrs.role, "button");
    assert.equal(header.attrs["aria-expanded"], "true");

    h.keydown({ key: "Enter", target: header });
    assert.equal(header.clicks, 1, "Enter expands it like a click");
  });

  it("session rows are focusable and hover-only buttons show on focus", () => {
    const script = getChatClientScript("icon.svg", { currentSessionId: "s", currentModel: "m", currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" });
    assert.ok(script.includes(`data-action="switch-session" data-session-id="' + escapeHtml(s.id) + '" tabindex="0" role="button" aria-label="Open session '`));
    const css = getChatStyles();
    assert.ok(css.includes(".session-item:focus-within .session-item-actions"));
    assert.ok(css.includes(".code-block-container:focus-within .code-block-actions"));
  });
});

describe("keyboard access in Settings and Waterfall", () => {
  it("Settings filter chips are real buttons and skill cards and tags are focusable", () => {
    const settings = source("panels/SettingsPanel.ts");
    assert.ok(!/<div class="chip[ "]/.test(settings), "no div chips left");
    assert.ok((settings.match(/<button type="button" class="chip/g) || []).length >= 30);
    assert.ok(settings.includes(`data-skill-path="' + escapeHtml(s.path || '') + '" tabindex="0" role="button" aria-label="Open skill '`));
    assert.ok(settings.includes(`'<span class="skill-tag" data-action="skills-tag" data-value="' + escapeHtml(t) + '" tabindex="0" role="button">`));
    assert.ok(settings.includes(`'<a class="portal-link" href="#" data-action="open-portal"`));
    assert.ok(settings.includes(`target.getAttribute?.("role") !== "button"`), "Enter/Space activates role=button controls");
  });

  it("Waterfall turn headers and span rows open with Enter or Space", () => {
    const script = source("providers/waterfall/waterfallScript.ts");
    assert.ok(script.includes(`class="wf-turn-header" data-turn-id="\\\${turn.id}" tabindex="0" role="button" aria-expanded="true"`));
    assert.ok(script.includes(`<div class="wf-span-main" tabindex="0" role="button" aria-expanded="false">`));
    assert.equal((script.match(/activateOnEnterOrSpace\((turnHeader|spanMain)\)/g) || []).length, 2);
  });
});

describe("screen readers and the / and @ menus", () => {
  it("the prompt box points at the open menu and its highlighted option", () => {
    const h = loadChat();
    const input = h.byId["prompt-input"];
    h.eval("showSlashPalette([{ cmd: '/a', desc: 'A' }, { cmd: '/b', desc: 'B' }]); navigateSlashPalette(1);");
    assert.equal(input.attrs["aria-expanded"], "true");
    assert.equal(input.attrs["aria-controls"], "slash-palette");
    assert.equal(input.attrs["aria-activedescendant"], "slash-opt-1");

    h.eval("hideMentionPalette();");
    assert.equal(input.attrs["aria-controls"], "slash-palette", "closing the other menu leaves this one alone");

    h.eval("hideSlashPalette();");
    assert.equal(input.attrs["aria-expanded"], "false");
    assert.equal(input.attrs["aria-controls"], undefined);
    assert.equal(input.attrs["aria-activedescendant"], undefined);
  });
});

describe("background sessions", () => {
  function view(over: Partial<Record<keyof SessionViewState, any>> = {}): SessionViewState {
    return {
      currentSessionId: () => "fg",
      isChatVisible: () => true,
      isShownInTab: () => false,
      isWindowFocused: () => true,
      sessionName: (sid: string) => ({ fg: "Current", bg: "Fix login" } as Record<string, string>)[sid],
      ...over,
    };
  }
  const at = () => new Date(2026, 9, 20, 10, 32).getTime();

  it("the session in view never changes the status bar", () => {
    const s = new BackgroundSessions(view(), at);
    s.markActivity("fg", "Editing a file");
    assert.deepEqual(s.render(), { text: "$(andromity-logo) Andromity", tooltip: "Andromity Coding Agent" });
  });

  it("a background session shows a quiet count, with details only in the tooltip", () => {
    const s = new BackgroundSessions(view(), at);
    s.markActivity("bg", describeToolActivity("edit_file"));
    const r = s.render();
    assert.equal(r.text, "$(andromity-logo) Andromity · 1");
    assert.match(r.tooltip, /Fix login — Editing a file · since 10:32/);
    assert.equal(r.openSessionId, "bg");
    assert.ok(!r.text.includes("~spin"), "no animation");
  });

  it("per-token activity does not redraw unless something changed", () => {
    const s = new BackgroundSessions(view(), at);
    assert.equal(s.markActivity("bg", "Writing a reply"), true);
    assert.equal(s.markActivity("bg", "Writing a reply"), false);
    assert.equal(s.markActivity("bg", "Running a command"), true);
  });

  it("notifies for a background session, or the current one when the chat is hidden or VS Code is unfocused", () => {
    assert.equal(new BackgroundSessions(view()).needsNotification("bg"), true);
    assert.equal(new BackgroundSessions(view()).needsNotification("fg"), false);
    assert.equal(new BackgroundSessions(view({ isChatVisible: () => false })).needsNotification("fg"), true);
    assert.equal(new BackgroundSessions(view({ isWindowFocused: () => false })).needsNotification("fg"), true);
    assert.equal(new BackgroundSessions(view({ isShownInTab: (sid: string) => sid === "bg" })).needsNotification("bg"), false);
  });

  it("a waiting session shows in the status bar until it resumes", () => {
    const s = new BackgroundSessions(view(), at);
    s.markAttention("bg", "approval");
    assert.equal(s.hasAttention("bg"), true);
    let r = s.render();
    assert.equal(r.text, "$(alert) Andromity");
    assert.match(r.tooltip, /Fix login — Needs your approval/);
    assert.equal(r.openSessionId, "bg");

    s.markActivity("bg", "Running a command");
    r = s.render();
    assert.equal(r.text, "$(andromity-logo) Andromity · 1");
    s.markFinished("bg");
    assert.equal(s.render().text, "$(andromity-logo) Andromity");
  });
});

describe("Fix with Andromity on a failed Run", () => {
  function runButton(h: ReturnType<typeof loadChat>) {
    const btn: any = element({ tagName: "BUTTON" });
    btn.attrs["data-code"] = encodeURIComponent("npm test");
    btn.attrs["data-lang"] = "bash";
    h.sandbox.btn = btn;
    h.eval("window.runCodeInTerminal(btn)");
    const sent = h.posted.at(-1);
    assert.equal(sent.type, "run_in_terminal");
    assert.match(sent.runId, /^run-/);
    return { btn, runId: sent.runId as string };
  }

  it("shows the result on the Run button and offers Fix only on failure", () => {
    const h = loadChat();
    const { btn, runId } = runButton(h);
    h.post({ type: "run_status", runId, state: "running", command: "npm test" });
    assert.match(btn.innerHTML, /Running…/);
    h.eval("window.runCodeInTerminal(btn)");
    assert.equal(h.posted.filter((m: any) => m.type === "run_in_terminal").length, 1, "no second run while running");

    h.post({ type: "run_status", runId, state: "failed", command: "npm test", exitCode: 1, outputTail: "Error: boom" });
    assert.match(btn.innerHTML, /Exit 1/);
    assert.equal(btn.attrs["data-run-state"], "failed");
    assert.match(btn.inserted.at(-1), /data-action="fix-run" data-run-id="run-/);
  });

  it("Fix sends the command, exit code and output to the chat", () => {
    const h = loadChat();
    const { runId } = runButton(h);
    h.post({ type: "run_status", runId, state: "failed", command: "npm test", exitCode: 2, outputTail: "Error: boom" });
    const fix: any = element({ tagName: "BUTTON" });
    fix.attrs["data-run-id"] = runId;
    h.sandbox.fix = fix;
    h.eval("window.fixFailedRun(fix)");
    const sent = h.posted.find((m: any) => m.type === "send_prompt");
    assert.ok(sent, "a prompt was sent");
    assert.match(sent.prompt, /failed with exit code 2/);
    assert.match(sent.prompt, /npm test/);
    assert.match(sent.prompt, /Error: boom/);
  });

  it("Fix adds to an existing draft instead of sending it", () => {
    const h = loadChat();
    const { runId } = runButton(h);
    h.post({ type: "run_status", runId, state: "failed", command: "npm test", exitCode: 1, outputTail: "" });
    h.byId["prompt-input"].value = "my draft";
    const fix: any = element({ tagName: "BUTTON" });
    fix.attrs["data-run-id"] = runId;
    h.sandbox.fix = fix;
    h.eval("window.fixFailedRun(fix)");
    assert.equal(h.posted.find((m: any) => m.type === "send_prompt"), undefined);
    assert.match(h.byId["prompt-input"].value, /^my draft\n\nThis command failed with exit code 1/);
  });

  it("a successful run says Done and an untracked run goes back to Run", () => {
    const h = loadChat();
    const first = runButton(h);
    h.post({ type: "run_status", runId: first.runId, state: "succeeded", command: "npm test", exitCode: 0 });
    assert.match(first.btn.innerHTML, /Done/);
    assert.equal(first.btn.inserted.length, 0);

    const second = runButton(h);
    second.btn.attrs["data-idle-html"] = "▶ Run";
    h.post({ type: "run_status", runId: second.runId, state: "untracked", command: "npm test" });
    assert.equal(second.btn.innerHTML, "▶ Run");
    assert.equal(second.btn.attrs["data-run-state"], undefined);
  });
});

describe("rewind and resend in the webview", () => {
  it("sends the edited message once the host has undone the turns", () => {
    const h = loadChat();
    h.post({ type: "turn_undone", turnsUndone: 2, targetTurnIndex: 1, resendPrompt: "Use the v2 API instead" });
    const sent = h.posted.find((m: any) => m.type === "send_prompt");
    assert.ok(sent);
    assert.equal(sent.prompt.startsWith("Use the v2 API instead"), true);
  });

  it("a plain undo sends nothing", () => {
    const h = loadChat();
    h.post({ type: "turn_undone", turnsUndone: 1, targetTurnIndex: 0 });
    assert.equal(h.posted.find((m: any) => m.type === "send_prompt"), undefined);
  });

  it("puts an Edit button next to Undo on every message", () => {
    const script = getChatClientScript("icon.svg", { currentSessionId: "s", currentModel: "m", currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "auto" });
    assert.ok(script.includes(`data-action="edit-prompt" title="Edit and resend from here"`));
    assert.ok(script.includes(`resendPrompt: text,`));
  });
});

describe("sending while a turn runs", () => {
  it("Send stays enabled during a turn and clicking it queues the message", () => {
    const h = loadChat();
    h.post({ type: "queue_state", session_id: "s", items: [], supported: true });
    h.eval("startAssistantTurn()");
    const send = h.byId["btn-send"];
    assert.equal(send.attrs.disabled, undefined, "a disabled button swallows the click");
    h.byId["prompt-input"].value = "follow up";
    h.posted.length = 0;
    for (const fn of send.listeners.click || []) fn({});
    const sent = h.posted.find((m: any) => m.type === "submit_input");
    assert.ok(sent, "the click reached the send path");
    assert.equal(sent.delivery, "queue");
    assert.ok(sent.prompt.startsWith("follow up"));
  });

  it("Send and Stop explain themselves on hover", () => {
    const html = readFileSync(join(SRC, "providers/chatview/chatHtml.ts"), "utf8");
    assert.ok(html.includes(`id="btn-cancel" data-tip="Stop this turn"`));
    assert.ok(html.includes(`id="btn-send" data-tip="Send (Enter)"`));
    assert.ok(!/id="btn-(send|cancel)"[^>]*\stitle=/.test(html), "no second, native tooltip");
  });
});

describe("air-gap pill in the chat", () => {
  it("shows while air-gap mode is on and hides when it is off", () => {
    const h = loadChat();
    const pill: any = element();
    pill.hidden = true;
    h.byId["airgap-pill"] = pill;
    h.post({ type: "config_updated", key: "airgap", value: true, title: "Air-gap mode is on: Andromity can reach only this machine." });
    assert.equal(pill.hidden, false);
    assert.equal(pill.title, "Air-gap mode is on: Andromity can reach only this machine.");
    h.post({ type: "config_updated", key: "airgap", value: false, title: "" });
    assert.equal(pill.hidden, true);
  });
});
