import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { element, loadChat } from "./helpers/chatHarness.js";
import { loadSidePanelData, mcpTooltip } from "../src/sidePanelData.js";
import { normalizeSidePanelPreferences } from "../src/sidePanelPreferences.js";

function rpc(responses: Record<string, any>) {
  const calls: string[] = [];
  return {
    calls,
    call: async (method: string) => {
      calls.push(method);
      const value = responses[method];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe("side panel data", () => {
  it("summarises MCP servers, marking disabled ones off", async () => {
    const client = rpc({ "mcp.list": [
      { name: "supabase", status: "running", tools_count: 29, remote: true },
      { name: "notion", status: "needs_auth", tools_count: 0, remote: true },
      { name: "local", status: "running", tools_count: 3, disabled: true },
      { status: "running" },
    ] });
    const data = await loadSidePanelData(client, "/repo", ["mcp"]);
    assert.deepEqual(data.mcp, [
      { name: "supabase", status: "running", tools: 29, remote: true },
      { name: "notion", status: "needs_auth", tools: 0, remote: true },
      { name: "local", status: "disabled", tools: 3, remote: false },
    ]);
    assert.deepEqual(client.calls, ["mcp.list"], "only the requested part is loaded");
    assert.equal(mcpTooltip(data.mcp), "MCP servers: 1 of 3 running, 1 needs attention. Open MCP settings");
    assert.equal(mcpTooltip([]), "MCP servers: none set up. Open MCP settings");
  });

  it("lists uncommitted files with line counts, biggest first", async () => {
    const data = await loadSidePanelData(rpc({
      "git.status": { is_git: true, branch: "dev", files: [
        { path: "src/a.ts", status: "M" }, { path: "src/big.ts", status: "M" }, { path: "new.txt", status: "??" }, { path: "logo.png", status: "M" }] },
      "git.diff_numstat": { files: { "src/a.ts": { additions: 2, deletions: 1 }, "src/big.ts": { additions: 40, deletions: 10 }, "logo.png": { additions: 0, deletions: 0, binary: true } } },
    }), "/repo", ["changes"]);
    assert.equal(data.changes!.branch, "dev");
    assert.equal(data.changes!.additions, 42);
    assert.equal(data.changes!.deletions, 11);
    assert.deepEqual(data.changes!.files.map((f) => f.path), ["src/big.ts", "src/a.ts", "new.txt", "logo.png"]);
    assert.equal(data.changes!.files[2].additions, null, "untracked files have no line counts");
    assert.equal(data.changes!.files[3].additions, null, "binary files have no line counts");
  });

  it("reports a folder that is not a git repository, and survives engine errors", async () => {
    assert.equal((await loadSidePanelData(rpc({ "git.status": { is_git: false } }), "/repo", ["changes"])).changes, null);
    const broken = await loadSidePanelData(rpc({ "mcp.list": new Error("down"), "git.status": new Error("down") }), "/repo", ["mcp", "changes"]);
    assert.deepEqual(broken.mcp, []);
    assert.equal(broken.changes, null);
  });
});

describe("side panel in the chat", () => {
  function setup(options: Parameters<typeof loadChat>[0] = {}) {
    const h = loadChat(options);
    for (const id of ["sp-context", "sp-changes", "sp-mcp", "sp-env", "btn-mcp-status", "airgap-pill"]) h.byId[id] = element();
    h.byId["airgap-pill"].hidden = true;
    return h;
  }

  it("renders changes, MCP servers and the environment from the extension's data", () => {
    const h = setup();
    h.post({
      type: "side_panel_data", folder: "agent", mcpTooltip: "MCP servers: 1 of 2 running. Open MCP settings",
      mcp: [{ name: "supabase", status: "running", tools: 29, remote: true }, { name: "notion", status: "needs_auth", tools: 0, remote: true }],
      changes: { branch: "dev", additions: 42, deletions: 11, files: [
        { path: "src/big.ts", status: "M", additions: 40, deletions: 10 }, { path: "new.txt", status: "??", additions: null, deletions: null }] },
    });
    const changes = h.byId["sp-changes"].innerHTML;
    assert.match(changes, /data-action="sp-open-diff" data-path="src\/big\.ts"/);
    assert.match(changes, /<span class="sp-file-name">big\.ts<\/span><span class="sp-file-dir">src<\/span>/);
    assert.match(changes, /<span class="sp-file-name">new\.txt<\/span>.*class="sp-status new"[^>]*>U<\/span><span class="sp-meta">new file/s);
    assert.match(changes, /class="sp-diffbar"/, "line counts come with a small diff bar");
    assert.match(changes, /class="sp-head-summary"><span class="sp-add">\+42<\/span>&nbsp;<span class="sp-del">&minus;11/, "the header sums the change");
    assert.match(changes, /2 files changed on <strong>dev<\/strong>/);
    assert.match(changes, /data-action="sp-review-all">Review changes/);
    const mcp = h.byId["sp-mcp"].innerHTML;
    assert.match(mcp, /supabase.*29 tools/s);
    assert.match(mcp, /notion.*Sign in/s);
    assert.match(mcp, /data-action="open-mcp-settings"/);
    const env = h.byId["sp-env"].innerHTML;
    assert.match(env, /Folder.*agent/s);
    assert.match(env, /Branch.*dev/s);
    assert.equal(h.byId["btn-mcp-status"].title, "MCP servers: 1 of 2 running. Open MCP settings");
  });

  it("says when there is nothing to show", () => {
    const h = setup();
    h.post({ type: "side_panel_data", mcp: [], changes: { branch: "dev", additions: 0, deletions: 0, files: [] } });
    assert.match(h.byId["sp-changes"].innerHTML, /No uncommitted changes/);
    assert.match(h.byId["sp-mcp"].innerHTML, /No MCP servers yet/);
    assert.match(h.byId["sp-mcp"].innerHTML, /Add a server/);
    h.post({ type: "side_panel_data", changes: null });
    assert.match(h.byId["sp-changes"].innerHTML, /not a git repository/);
  });

  it("the Context card shows the same breakdown as the Context window pop-up", () => {
    const h = setup();
    h.eval("currentSessionId = 's1';");
    h.post({ type: "context_breakdown", session_id: "s1", data: {
      limit: 1000000, used_tokens: 12620, auto_compact: true, compact_threshold: 0.8, message_count: 6, used_source: "provider",
      categories: [{ key: "system_prompt", label: "System prompt", tokens: 2200 }, { key: "tool_definitions", label: "Tool definitions", tokens: 4400 }],
    } });
    const html = h.byId["sp-context"].innerHTML;
    assert.match(html, /Context window/);
    const n = (v: number) => v.toLocaleString();
    assert.ok(html.includes(n(12620) + " / " + n(1000000)), "same number formatting as the pop-up");
    assert.ok(new RegExp("Used tokens.*" + n(12620) + ".*Available.*" + n(987380), "s").test(html));
    assert.match(html, /class="context-stack"/, "the coloured bar is always shown");
    assert.match(html, /data-action="sp-toggle-breakdown" aria-expanded="false"/);
    assert.ok(!html.includes("context-cat-label"), "the category list waits behind Breakdown, keeping the card short");
    assert.match(html, /787K until auto-compact/);
    assert.match(html, /data-action="compact-session">Compact now/);

    const stored = withStorage(h);
    const click = (action: string) => {
      const target: any = element({ tagName: "BUTTON" });
      target.attrs["data-action"] = action;
      target.closest = (sel: string) => (sel.includes("[data-action]") ? target : null);
      for (const fn of h.docListeners.click || []) fn({ target, preventDefault() {}, stopPropagation() {} });
    };
    click("sp-toggle-breakdown");
    const open = h.byId["sp-context"].innerHTML;
    assert.match(open, /aria-expanded="true"/);
    assert.match(open, /context-cat-label">System prompt<.*context-cat-pct">0\.2%/s);
    assert.match(open, /Free space/);
    assert.match(open, /Auto-compact buffer/);
    assert.equal(JSON.parse(stored["andromity.sidePanel"]).breakdown, true, "remembered");
  });

  it("fades the panel's edges only while there is more to scroll", () => {
    const h = setup();
    const body: any = element();
    Object.assign(body, { scrollHeight: 1200, clientHeight: 600, scrollTop: 0 });
    h.byId["side-panel-body"] = body;
    h.eval("updateSidePanelScrollEdges()");
    assert.ok(!body.classList.contains("can-scroll-up"));
    assert.ok(body.classList.contains("can-scroll-down"));
    body.scrollTop = 300;
    h.eval("updateSidePanelScrollEdges()");
    assert.ok(body.classList.contains("can-scroll-up") && body.classList.contains("can-scroll-down"));
    body.scrollTop = 600;
    h.eval("updateSidePanelScrollEdges()");
    assert.ok(body.classList.contains("can-scroll-up") && !body.classList.contains("can-scroll-down"));
    Object.assign(body, { scrollHeight: 500, scrollTop: 0 });
    h.eval("updateSidePanelScrollEdges()");
    assert.ok(!body.classList.contains("can-scroll-up") && !body.classList.contains("can-scroll-down"), "no fade when everything fits");
  });

  it("only the panel body scrolls, with no visible scrollbar", () => {
    const css = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatPolishStyles.ts"), "utf8");
    const rule = css.slice(css.indexOf("    .side-panel-body {"), css.indexOf("    .side-panel-body::-webkit-scrollbar"));
    assert.match(rule, /overflow-y: auto;/);
    assert.match(rule, /overscroll-behavior: contain;/);
    assert.match(rule, /scrollbar-width: none;/);
    assert.match(css, /\.side-panel-body::-webkit-scrollbar \{ display: none; \}/);
    const html = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatHtml.ts"), "utf8");
    const aside = html.slice(html.indexOf('<aside class="side-panel"'), html.indexOf("</aside>"));
    assert.ok(aside.indexOf('class="side-panel-header"') < aside.indexOf('id="side-panel-body"'), "the header sits outside the scrolling area");
  });

  it("Environment rows open the matching control, and only safe commands", async () => {
    const h = setup();
    const clicked: string[] = [];
    for (const id of ["btn-prompt-model", "btn-prompt-mode", "btn-prompt-profile", "btn-prompt-reasoning"]) {
      const b: any = element({ tagName: "BUTTON" });
      b.click = () => clicked.push(id);
      h.byId[id] = b;
    }
    const timers: Function[] = [];
    h.sandbox.setTimeout = (fn: Function) => { timers.push(fn); return 0; };
    h.posted.length = 0;
    for (const id of ["model", "mode", "profile", "reasoning", "branch", "folder", "network"]) h.eval(`openEnvironmentControl('${id}')`);
    timers.forEach((fn) => fn());
    assert.deepEqual(clicked, ["btn-prompt-model", "btn-prompt-mode", "btn-prompt-profile", "btn-prompt-reasoning"]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.posted.filter((m: any) => m.type === "side_panel_command"))), [
      { type: "side_panel_command", command: "git.checkout" },
      { type: "side_panel_command", command: "workbench.view.explorer" },
      { type: "side_panel_command", command: "andromity.toggleAirGap" },
    ]);
  });

  it("the Environment card follows a permission mode change", () => {
    const h = setup();
    const label: any = element();
    label.textContent = "SAFE";
    h.byId["prompt-mode-label"] = label;
    const timers: Function[] = [];
    h.sandbox.setTimeout = (fn: Function) => { timers.push(fn); return 0; };
    h.post({ type: "side_panel_data", folder: "agent", changes: { branch: "feature/login", additions: 0, deletions: 0, files: [] } });
    assert.match(h.byId["sp-env"].innerHTML, /Mode<\/span><span class="sp-env-value mode-safe">SAFE/);
    assert.match(h.byId["sp-env"].innerHTML, /Branch<\/span><span class="sp-env-value">feature\/login/);
    label.textContent = "FULL";
    h.eval("currentMode = 'full'; updateModeBadge('full');");
    timers.forEach((fn) => fn());
    assert.match(h.byId["sp-env"].innerHTML, /Mode<\/span><span class="sp-env-value mode-full">FULL/);
  });

  it("the MCP icon and panel actions go to the right place", () => {
    const h = setup();
    const click = (action: string, attrs: Record<string, string> = {}) => {
      const target: any = element({ tagName: "BUTTON" });
      target.attrs["data-action"] = action;
      Object.assign(target.attrs, attrs);
      target.closest = (sel: string) => (sel.includes("[data-action]") ? target : null);
      h.posted.length = 0;
      for (const fn of h.docListeners.click || []) fn({ target, preventDefault() {}, stopPropagation() {} });
      return JSON.parse(JSON.stringify(h.posted));
    };
    assert.deepEqual(click("open-mcp-settings").find((m: any) => m.type === "open_settings"), { type: "open_settings", tab: "mcp" });
    assert.deepEqual(click("sp-open-diff", { "data-path": "src/a.ts" }).find((m: any) => m.type === "open_diff"), { type: "open_diff", filePath: "src/a.ts" });
    assert.ok(click("sp-review-all").some((m: any) => m.type === "open_changes_review"));
  });

  function withStorage(h: ReturnType<typeof setup>) {
    const stored: Record<string, string> = {};
    h.sandbox.localStorage = { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; } };
    return stored;
  }

  it("cards collapse to a one-line summary, and that is remembered", () => {
    const h = setup();
    const stored = withStorage(h);
    h.post({ type: "side_panel_data", mcp: [{ name: "a", status: "running", tools: 1, remote: false }, { name: "b", status: "needs_auth", tools: 0, remote: true }] });
    const mcp = h.byId["sp-mcp"];
    assert.match(mcp.innerHTML, /data-action="sp-toggle-card" data-card="mcp" aria-expanded="true"/);
    assert.match(mcp.innerHTML, /1 needs attention/, "the summary says what needs attention");
    h.eval("setSidePanelCardCollapsed('mcp')");
    assert.ok(mcp.classList.contains("collapsed"));
    assert.match(mcp.innerHTML, /aria-expanded="false"/);
    assert.match(mcp.innerHTML, /1 needs attention/, "a collapsed card keeps its summary");
    assert.deepEqual(JSON.parse(stored["andromity.sidePanel"]).collapsed, ["mcp"]);
    h.eval("setSidePanelCardCollapsed('mcp')");
    assert.ok(!mcp.classList.contains("collapsed"));
  });

  it("the right-click menu chooses which cards show", () => {
    const h = setup();
    const stored = withStorage(h);
    const menu: any = element();
    menu.hidden = true;
    h.byId["sp-menu"] = menu;
    const emptyAll: any = element();
    emptyAll.hidden = true;
    h.byId["sp-empty-all"] = emptyAll;
    h.post({ type: "side_panel_data", folder: "agent", mcp: [], changes: { branch: "dev", additions: 0, deletions: 0, files: [] } });

    h.eval("openSidePanelMenu(100, 100)");
    assert.equal(menu.hidden, false);
    assert.match(menu.innerHTML, /role="menuitemcheckbox" aria-checked="true" data-action="sp-toggle-hidden" data-card="changes"/);
    assert.match(menu.innerHTML, /Collapse all/);

    h.eval("closeSidePanelMenu(); setSidePanelCardHidden('changes')");
    assert.equal(menu.hidden, true);
    assert.equal(h.byId["sp-changes"].hidden, true);
    assert.equal(h.byId["sp-changes"].innerHTML, "");
    assert.deepEqual(JSON.parse(stored["andromity.sidePanel"]).hidden, ["changes"]);
    h.eval("openSidePanelMenu(100, 100)");
    assert.match(menu.innerHTML, /aria-checked="false" data-action="sp-toggle-hidden" data-card="changes"/);

    h.eval("['context', 'mcp', 'env'].forEach(setSidePanelCardHidden)");
    assert.equal(emptyAll.hidden, false, "with every card hidden, the panel says how to get them back");
  });

  it("hiding the panel is remembered", () => {
    const h = setup();
    const body = h.sandbox.document.body;
    const stored: Record<string, string> = {};
    h.sandbox.localStorage = { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; } };
    h.eval("setSidePanelOff(true)");
    assert.ok(body.classList.contains("side-panel-off"));
    assert.equal(stored["andromity.sidePanelOff"], "1");
    assert.deepEqual(JSON.parse(JSON.stringify(h.posted.at(-1))), { type: "side_panel_visibility", off: true });
    h.eval("setSidePanelOff(false)");
    assert.ok(!body.classList.contains("side-panel-off"));
    assert.equal(stored["andromity.sidePanelOff"], "0");
  });

  it("restores the host's hide preference in a new webview, even without local storage", () => {
    const hidden = loadChat({ state: { sidePanelOff: true } });
    assert.ok(hidden.sandbox.document.body.classList.contains("side-panel-off"));
    const shown = loadChat({ state: { sidePanelOff: false }, storage: { "andromity.sidePanelOff": "1" } });
    assert.ok(!shown.sandbox.document.body.classList.contains("side-panel-off"), "the saved host preference wins over old webview storage");
    const migrated = loadChat({ storage: { "andromity.sidePanelOff": "1" } });
    assert.ok(migrated.sandbox.document.body.classList.contains("side-panel-off"));
    assert.ok(migrated.posted.some((m: any) => m.type === "side_panel_visibility" && m.off === true));
  });

  it("syncs visibility across open chats without echoing or reopening on data updates", () => {
    const h = setup();
    const stored = withStorage(h);
    h.posted.length = 0;
    h.post({ type: "side_panel_visibility", off: true });
    h.post({ type: "side_panel_data", mcp: [], folder: "agent" });
    assert.ok(h.sandbox.document.body.classList.contains("side-panel-off"));
    assert.equal(stored["andromity.sidePanelOff"], "1");
    assert.ok(!h.posted.some((m: any) => m.type === "side_panel_visibility"));
    h.post({ type: "side_panel_visibility", off: "false" });
    assert.ok(h.sandbox.document.body.classList.contains("side-panel-off"));
    h.post({ type: "side_panel_visibility", off: false });
    assert.ok(!h.sandbox.document.body.classList.contains("side-panel-off"));
  });

  it("keeps full paths accessible, exposes all changes, and labels server states beyond color", () => {
    const h = setup();
    h.post({ type: "side_panel_data", mcp: [
      { name: "connected", status: "running", tools: 1, remote: true },
      { name: "broken", status: "error", tools: 3, remote: false },
      { name: "disabled", status: "disabled", tools: 5, remote: false },
    ], changes: { branch: "dev", additions: 0, deletions: 0, files: Array.from({ length: 13 }, (_, i) => ({
      path: i === 0 ? 'src/a&b.ts' : 'file' + i + '.ts', status: "??", additions: null, deletions: null,
    })) } });
    const changes = h.byId["sp-changes"].innerHTML;
    assert.match(changes, /aria-label="src\/a&amp;b.ts, new file, open diff"/);
    assert.match(changes, /Workspace root/);
    assert.match(changes, /data-action="sp-review-all">View 8 more changed files<\/button>/);
    assert.equal((changes.match(/class="sp-file"/g) || []).length, 5, "large file lists leave room for other cards");
    const mcp = h.byId["sp-mcp"].innerHTML;
    assert.match(mcp, /Remote · 1 tool/);
    assert.match(mcp, />Running<\/span>/);
    assert.match(mcp, /sp-server-status error/);
    assert.match(mcp, />Error<\/span>/);
    assert.match(mcp, />Off<\/span>/);
    assert.match(mcp, />1 tool available from running servers/);
    h.eval("setSidePanelCardCollapsed('mcp')");
    assert.match(h.byId["sp-mcp"].innerHTML, /aria-controls="sp-body-mcp"/);
    assert.match(h.byId["sp-mcp"].innerHTML, /id="sp-body-mcp" hidden/);
  });

  it("only appears where there is room, and the MCP icon is always in the bottom bar", () => {
    const html = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatHtml.ts"), "utf8");
    assert.match(html, /id="btn-mcp-status" data-action="open-mcp-settings"/);
    const css = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatPolishStyles.ts"), "utf8");
    assert.match(css, /\.side-panel, #btn-top-side-panel \{ display: none; \}/);
    assert.match(css, /@media \(min-width: 1100px\) \{\s*body:not\(\.side-panel-off\) \.side-panel \{/);
    const script = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatClientScript.ts"), "utf8");
    assert.match(script, /SIDE_PANEL_WIDE = [^;]*matchMedia\('\(min-width: 1100px\)'\)/);
  });

  it("docks beside a narrower chat between 1100px and 1500px, keeping the top and bottom bars full width", () => {
    const css = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatPolishStyles.ts"), "utf8");
    const docked = css.match(/@media \(min-width: 1100px\) and \(max-width: 1499\.98px\) \{([\s\S]*?)\n    \}/);
    assert.ok(docked, "docked range rule");
    const reserve = Number(/--sp-reserve: (\d+)px/.exec(docked![1])?.[1]);
    assert.match(docked![1], /body:not\(\.side-panel-off\) \{[^}]*padding-right: var\(--sp-reserve\)/);
    assert.match(docked![1], /\.top-bar,\s*body:not\(\.side-panel-off\) \.status-bar \{ margin-right: calc\(-1 \* var\(--sp-reserve\)\); \}/);
    const panelMin = Number(/width: clamp\((\d+)px/.exec(css)?.[1]);
    const panelRight = Number(/right: (\d+)px;\s*width: clamp/.exec(css)?.[1]);
    assert.ok(reserve >= panelMin + panelRight, "the reserved space covers the panel and its edge gap");
    assert.ok(1100 - reserve >= 700, "the chat keeps a readable width at the narrowest docked size");
  });

  function orderedPanel(h: ReturnType<typeof setup>) {
    const ids = ["context", "changes", "mcp", "env"];
    const cards = ids.map(id => h.byId["sp-" + id]);
    cards.forEach((card, i) => { card.id = "sp-" + ids[i]; card.classList.add("sp-card"); });
    const panel = element({ children: cards, appendChild(card: any) {
      this.children = this.children.filter((child: any) => child !== card);
      this.children.push(card);
    } });
    h.byId["side-panel-body"] = panel;
    return () => panel.children.map((card: any) => card.id.slice(3));
  }

  it("starts expanded and sanitizes old, incomplete, or invalid layout preferences", () => {
    assert.deepEqual(normalizeSidePanelPreferences(null), {
      order: ["context", "changes", "mcp", "env"], hidden: [], collapsed: [], breakdown: false,
    });
    assert.deepEqual(normalizeSidePanelPreferences({ order: ["env", "env", "unknown", 2], hidden: ["mcp", "mcp", "bad"], collapsed: ["context"], breakdown: "true" }), {
      order: ["env", "context", "changes", "mcp"], hidden: ["mcp"], collapsed: ["context"], breakdown: false,
    });
    const h = setup();
    h.post({ type: "side_panel_data", mcp: [], changes: null });
    assert.match(h.byId["sp-mcp"].innerHTML, /aria-expanded="true"/);
    assert.match(h.byId["sp-mcp"].innerHTML, /draggable="true" data-card="mcp" aria-label="Reorder MCP servers"/);
  });

  it("moves sections in either direction, saves the layout, and restores it in a new chat", () => {
    const h = setup();
    const order = orderedPanel(h);
    const stored = withStorage(h);
    h.eval("setSidePanelCardCollapsed('mcp'); setSidePanelCardHidden('changes'); moveSidePanelCard('env', 'context', false)");
    assert.deepEqual(order(), ["env", "context", "changes", "mcp"]);
    h.eval("moveSidePanelCard('context', 'mcp', true)");
    assert.deepEqual(order(), ["env", "changes", "mcp", "context"]);
    const prefs = JSON.parse(stored["andromity.sidePanel"]);
    assert.deepEqual(prefs.collapsed, ["mcp"]);
    assert.deepEqual(prefs.hidden, ["changes"]);
    assert.ok(h.posted.some((m: any) => m.type === "side_panel_preferences"));

    const restored = setup({ state: { sidePanelPreferences: prefs } });
    const restoredOrder = orderedPanel(restored);
    restored.post({ type: "side_panel_data", mcp: [], changes: null });
    assert.deepEqual(restoredOrder(), ["env", "changes", "mcp", "context"]);
    assert.ok(restored.byId["sp-mcp"].classList.contains("collapsed"));
    assert.equal(restored.byId["sp-changes"].hidden, true);
  });

  it("syncs saved layouts without echoing or replacing focused controls on an acknowledgement", () => {
    const h = setup();
    const order = orderedPanel(h);
    h.post({ type: "side_panel_data", mcp: [], changes: null });
    h.posted.length = 0;
    const prefs = { order: ["env", "context", "changes", "mcp"], collapsed: ["mcp"], hidden: [], breakdown: false };
    h.post({ type: "side_panel_preferences", preferences: prefs });
    assert.deepEqual(order(), prefs.order);
    assert.ok(h.byId["sp-mcp"].classList.contains("collapsed"));
    h.byId["sp-mcp"].innerHTML = "focused control";
    h.post({ type: "side_panel_preferences", preferences: prefs });
    assert.equal(h.byId["sp-mcp"].innerHTML, "focused control");
    assert.equal(h.posted.length, 0);
  });
});
