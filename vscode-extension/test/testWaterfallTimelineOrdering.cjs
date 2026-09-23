/**
 * Test: Waterfall Timeline Ordering & Reopen Monotonicity Verification
 *
 * Reproduces and verifies the fix for the user-reported bug:
 * When Waterfall is closed during an active turn and reopened:
 * 1. session_history delivers historical spans (e.g. read_file 400ms).
 * 2. activeTurnEvents replays live spans (e.g. grep_search 213ms, grep_search 43ms).
 * 3. In the UI timeline, grep_search MUST NOT appear in the past (to the left of read_file).
 * 4. The timing bars must be strictly monotonic: span[N+1].leftPercent >= span[N].leftPercent.
 */
const assert = require("assert");
const vm = require("vm");

console.log("================================================================================");
console.log("Test: Waterfall Timeline Ordering & Visual Monotonicity on Mid-Turn Reopen");
console.log("================================================================================");

const Module = require('module');
const origRequire = Module.prototype.require;
const mockVscode = {
  Uri: {
    joinPath: (...args) => ({ fsPath: args.map(a => typeof a === 'object' ? (a.fsPath || a.path || '') : a).join('/').replace(/\\/g, '/') }),
    file: (p) => ({ fsPath: p.replace(/\\/g, '/') })
  },
  window: {},
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
  commands: {},
  env: { appRoot: "C:/fake/vscode", clipboard: { writeText: async () => {} } },
};

Module.prototype.require = function(reqPath) {
  if (reqPath === 'vscode') return mockVscode;
  return origRequire.apply(this, arguments);
};

const waterfallMod = require("../dist-test/src/providers/waterfall/waterfallHtml.js");
const panelMod = require("../dist-test/src/panels/WaterfallPanel.js");
const WaterfallTraceStore = panelMod.WaterfallTraceStore;

// Mock RPC Client
class MockRpcClient {
  constructor() {
    this.handlers = new Map();
  }
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }
  off(event, handler) {
    if (!this.handlers.has(event)) return;
    this.handlers.set(event, this.handlers.get(event).filter(h => h !== handler));
  }
  emit(event, params) {
    const list = this.handlers.get(event) || [];
    for (const h of list) h(params);
  }
}

const mockRpc = new MockRpcClient();
WaterfallTraceStore.init(mockRpc);

const sessionId = "sess_timeline_monotonicity_test";
const baseTs = 1750000000000; // t0

// 1. Setup DOM environment for Waterfall webview
const elementsById = new Map();
const createdElements = [];

function createMockElement(tag, id = '', classStr = '') {
  let _innerHTML = '';
  let _textContent = '';
  const attrs = {};
  const listeners = {};

  const el = {
    tagName: tag.toUpperCase(),
    id: id,
    dataset: {},
    style: {},
    classList: {
      _classes: new Set(),
      add: (c) => el.classList._classes.add(c),
      remove: (c) => el.classList._classes.delete(c),
      contains: (c) => el.classList._classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (el.classList._classes.has(c)) el.classList._classes.delete(c);
          else el.classList._classes.add(c);
        } else if (force) el.classList._classes.add(c);
        else el.classList._classes.delete(c);
      }
    },
    get className() { return [...el.classList._classes].join(' '); },
    set className(val) {
      el.classList._classes.clear();
      (val || '').split(/\s+/).filter(Boolean).forEach(c => el.classList._classes.add(c));
    },
    get innerHTML() { return _innerHTML; },
    set innerHTML(val) {
      _innerHTML = String(val);
      _textContent = _innerHTML.replace(/<[^>]+>/g, '');
    },
    get textContent() { return _textContent; },
    set textContent(val) {
      _textContent = String(val);
      _innerHTML = String(val);
    },
    addEventListener: (evt, cb) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
    },
    removeEventListener: () => {},
    dispatchEvent: (evt) => {
      const cbs = listeners[evt.type || evt] || [];
      for (const cb of cbs) cb(evt);
    },
    setAttribute: (k, v) => {
      attrs[k] = String(v);
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
        el.dataset[camel] = String(v);
      }
    },
    getAttribute: (k) => attrs[k] || null,
    appendChild: (child) => child,
    removeChild: (child) => child,
    querySelectorAll: () => [],
    querySelector: (sel) => createMockElement('div', '', (sel || '').replace('.', ''))
  };

  (classStr || '').split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c));
  if (id) elementsById.set(id, el);
  createdElements.push(el);
  return el;
}

const mockWebview = { asWebviewUri: (u) => u };
const html = waterfallMod.getWaterfallHtml(mockWebview, sessionId, "Test Session", mockVscode.Uri.file("/test"));
const scriptMatch = html.match(/<script(?:\s+nonce="[^"]*")?>([\s\S]*?)<\/script>/i);
assert.ok(scriptMatch, "Failed to extract script from getWaterfallHtml");
const clientScript = scriptMatch[1];

const tagRegex = /<([a-z0-9-]+)([^>]*)>/gi;
let tagMatch;
while ((tagMatch = tagRegex.exec(html)) !== null) {
  const tagName = tagMatch[1];
  if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'style') continue;
  const attrs = tagMatch[2];
  const idMatch = attrs.match(/id=["']([^"']+)["']/i);
  const classMatch = attrs.match(/class=["']([^"']+)["']/i);
  const id = idMatch ? idMatch[1] : '';
  const classes = classMatch ? classMatch[1] : '';
  createMockElement(tagName, id, classes);
}

const postedMessages = [];
const sandbox = {
  console: {
    log: () => {},
    warn: () => {},
    error: (...args) => console.error('    [Webview Error]', ...args),
  },
  acquireVsCodeApi: () => ({
    postMessage: (msg) => postedMessages.push(msg)
  }),
  document: {
    getElementById: (id) => elementsById.get(id) || createMockElement('div', id),
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: (sel) => createdElements.filter(e => e.classList.contains(sel.replace('.', ''))),
    querySelector: (sel) => createMockElement('div', '', (sel || '').replace('.', '')),
    addEventListener: () => {},
    body: createMockElement('body', 'body')
  },
  window: {
    addEventListener: () => {},
    postMessage: (msg) => {
      if (sandbox.onmessageHandler) sandbox.onmessageHandler({ data: msg });
    }
  },
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: () => {},
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {}
};

sandbox.window.addEventListener = (evt, cb) => {
  if (evt === 'message') sandbox.onmessageHandler = cb;
};

vm.createContext(sandbox);
vm.runInContext(clientScript, sandbox);

// 2. Simulate Turn 1:
// First, prompt starts
mockRpc.emit("agent/started", {
  session_id: sessionId,
  prompt: "Audit litellm",
  ts: baseTs / 1000
});

// Assistant 1 starts and emits read_file
mockRpc.emit("waterfall/llmStart", {
  session_id: sessionId,
  turn_id: "turn_1_llm_1",
  model: "qwen/qwen3.7-flash",
  ts: (baseTs + 100) / 1000
});

mockRpc.emit("waterfall/llmEnd", {
  session_id: sessionId,
  turn_id: "turn_1_llm_1",
  model: "qwen/qwen3.7-flash",
  duration_ms: 2500,
  tool_calls: [{ id: "call_rf_1", function: { name: "read_file", arguments: "{}" } }],
  ts: (baseTs + 2600) / 1000
});

mockRpc.emit("agent/toolStart", {
  session_id: sessionId,
  tool_id: "call_rf_1",
  tool_name: "read_file",
  tool_args: "{}",
  ts: (baseTs + 2650) / 1000
});

mockRpc.emit("agent/toolResult", {
  session_id: sessionId,
  tool_id: "call_rf_1",
  tool_name: "read_file",
  result: "content",
  duration_ms: 400,
  ts: (baseTs + 3050) / 1000
});

// Now while Waterfall panel is CLOSED:
// Turn continues! Assistant 2 calls grep_search (213ms) and grep_search (43ms)
mockRpc.emit("waterfall/llmStart", {
  session_id: sessionId,
  turn_id: "turn_1_llm_2",
  model: "qwen/qwen3.7-flash",
  ts: (baseTs + 3100) / 1000
});

mockRpc.emit("waterfall/llmEnd", {
  session_id: sessionId,
  turn_id: "turn_1_llm_2",
  model: "qwen/qwen3.7-flash",
  duration_ms: 3000,
  tool_calls: [
    { id: "call_grep_1", function: { name: "grep_search", arguments: '{"q": "auth"}' } },
    { id: "call_grep_2", function: { name: "grep_search", arguments: '{"q": "budget"}' } }
  ],
  ts: (baseTs + 6100) / 1000
});

mockRpc.emit("agent/toolStart", {
  session_id: sessionId,
  tool_id: "call_grep_1",
  tool_name: "grep_search",
  tool_args: '{"q": "auth"}',
  ts: (baseTs + 6150) / 1000
});

mockRpc.emit("agent/toolResult", {
  session_id: sessionId,
  tool_id: "call_grep_1",
  tool_name: "grep_search",
  result: "matches 1",
  duration_ms: 213,
  ts: (baseTs + 6363) / 1000
});

mockRpc.emit("agent/toolStart", {
  session_id: sessionId,
  tool_id: "call_grep_2",
  tool_name: "grep_search",
  tool_args: '{"q": "budget"}',
  ts: (baseTs + 6400) / 1000
});

mockRpc.emit("agent/toolResult", {
  session_id: sessionId,
  tool_id: "call_grep_2",
  tool_name: "grep_search",
  result: "matches 2",
  duration_ms: 43,
  ts: (baseTs + 6443) / 1000
});

// 3. Reopen Waterfall tab during the running session!
// WaterfallPanel dispatches:
// A) session_history with what's committed in SQLite DB:
const sessionHistoryPayload = {
  id: sessionId,
  status: "running",
  model: "qwen/qwen3.7-flash",
  messages: [
    { role: "user", content: "Audit litellm", ts: new Date(baseTs).toISOString() },
    {
      role: "assistant",
      content: "Reading file...",
      duration: 2.6,
      ts: new Date(baseTs + 2600).toISOString(),
      tool_calls: [{ id: "call_rf_1", function: { name: "read_file", arguments: "{}" } }]
    },
    {
      role: "tool",
      tool_call_id: "call_rf_1",
      content: "content",
      ts: new Date(baseTs + 3050).toISOString()
    }
    // Assistant 2 and grep_search are not yet committed to DB because turn is in-flight!
  ]
};

sandbox.window.postMessage({
  type: "session_history",
  session: sessionHistoryPayload
});

// B) Active turn events from WaterfallTraceStore replayed to the webview:
const activeTurnEvents = WaterfallTraceStore.getActiveTurnEvents(sessionId);
assert.ok(activeTurnEvents.length > 0, "Active turn events must be captured in store");

for (const ev of activeTurnEvents) {
  if (ev.type === "agent_started") continue;
  // Skip committed events
  if (ev.type === "waterfall_llm_start" && ev.turn_id === "turn_1_llm_1") continue;
  if (ev.type === "waterfall_llm_end" && ev.turn_id === "turn_1_llm_1") continue;
  if (ev.tool_id === "call_rf_1") continue;
  sandbox.window.postMessage(ev);
}

// 4. Inspect the resulting Waterfall state and timing bars
const state = sandbox.window.__waterfallState;
assert.ok(state, "Waterfall state must exist");

const turn = [...state.turns.values()][0];
assert.ok(turn, "Turn 1 must exist");
console.log(`Turn 1 spans count: ${turn.spans.length}`);

console.log("\nInspecting Spans & Visual Timing Bar Positions:");
const barPositions = [];

for (let i = 0; i < turn.spans.length; i++) {
  const span = turn.spans[i];
  const barEl = elementsById.get('wf-bar-' + span.id);
  assert.ok(barEl, `Bar element must exist for span ${span.id}`);

  const leftPercent = parseFloat(barEl.style.left) || 0;
  const widthPercent = parseFloat(barEl.style.width) || 0;
  barPositions.push({
    index: i,
    id: span.id,
    type: span.type,
    name: span.name,
    durationMs: span.durationMs,
    startTime: span.startTime - turn.startTime,
    leftPercent,
    widthPercent
  });
  console.log(`  [${i}] ${span.type.padEnd(4)}: ${span.name.padEnd(16)} | left: ${leftPercent.toFixed(1).padStart(5)}%, width: ${widthPercent.toFixed(1).padStart(5)}%, dur: ${span.durationMs}ms`);
}

// 5. Assert Monotonic Ordering
console.log("\nVerifying Strict Timeline Monotonicity:");
for (let i = 1; i < barPositions.length; i++) {
  const prev = barPositions[i - 1];
  const curr = barPositions[i];

  assert.ok(
    curr.leftPercent >= prev.leftPercent - 0.01,
    `Timeline Inversion Detected! Span [${i}] (${curr.name}) leftPercent (${curr.leftPercent}%) is to the LEFT of Span [${i-1}] (${prev.name}) leftPercent (${prev.leftPercent}%)!`
  );
  console.log(`  ✓ Span [${i}] ${curr.name} (${curr.leftPercent.toFixed(1)}%) is positioned at or to the right of Span [${i-1}] ${prev.name} (${prev.leftPercent.toFixed(1)}%)`);
}

// Ensure grep_search is positioned AFTER read_file
const rfBar = barPositions.find(b => b.name === "read_file");
const grep1Bar = barPositions.find(b => b.name === "grep_search");

assert.ok(rfBar, "read_file span must exist");
assert.ok(grep1Bar, "grep_search span must exist");
assert.ok(
  grep1Bar.leftPercent >= rfBar.leftPercent,
  `grep_search (${grep1Bar.leftPercent}%) must be positioned after read_file (${rfBar.leftPercent}%)`
);
console.log(`\n  ✓ Key Assertion Passed: grep_search (${grep1Bar.leftPercent.toFixed(1)}%) is correctly to the right of read_file (${rfBar.leftPercent.toFixed(1)}%)!`);

console.log("================================================================================");
console.log("TIMELINE MONOTONIC ORDERING TEST PASSED WITH 100% SUCCESS!");
console.log("================================================================================");
process.exit(0);
