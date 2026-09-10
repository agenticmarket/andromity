const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

console.log("================================================================================");
console.log("Senior SWE Test: Waterfall Trace Past Session Reconstruction");
console.log("================================================================================");

const Module = require('module');
const origRequire = Module.prototype.require;
const mockVscode = {
  Uri: {
    joinPath: (...args) => ({ fsPath: args.map(a => typeof a === 'object' ? (a.fsPath || a.path || '') : a).join('/').replace(/\\/g, '/') }),
    file: (p) => ({ fsPath: p.replace(/\\/g, '/') })
  },
  window: {},
  workspace: {},
  commands: {},
};

Module.prototype.require = function(reqPath) {
  if (reqPath === 'vscode') return mockVscode;
  return origRequire.apply(this, arguments);
};

// 1. Generate Waterfall HTML
const waterfallMod = require('../dist-test/src/providers/waterfall/waterfallHtml.js');
const mockWebview = {
  cspSource: 'vscode-webview:',
  asWebviewUri: (u) => 'vscode-resource://' + (u.fsPath || u.path || String(u))
};

const html = waterfallMod.getWaterfallHtml(mockWebview, "sess-test-waterfall", "Test Waterfall Session");
assert.ok(html.includes("<!DOCTYPE html>"), "Must be a valid HTML document");

// 2. Extract Waterfall JS
const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
assert.ok(scriptMatch && scriptMatch[1], "Should extract script body");
const scriptCode = scriptMatch[1];
console.log(`[PASS] Extracted Waterfall Script (${scriptCode.length} characters)`);

// 3. Build Mock DOM for Waterfall Script
const elementsById = new Map();
const allElements = [];
const windowListeners = {};
const postedMessages = [];

function createMockElement(tagName, id = '', classStr = '') {
  let _innerHTML = '';
  let _textContent = '';
  const listeners = {};
  const attrs = {};

  const el = {
    tagName: tagName.toUpperCase(),
    id,
    dataset: {},
    style: {},
    classList: {
      _classes: new Set(),
      add: (...classes) => classes.forEach(c => el.classList._classes.add(c)),
      remove: (...classes) => classes.forEach(c => el.classList._classes.delete(c)),
      toggle: (c, force) => {
        if (force !== undefined) {
          if (force) el.classList._classes.add(c);
          else el.classList._classes.delete(c);
          return force;
        }
        if (el.classList._classes.has(c)) {
          el.classList._classes.delete(c);
          return false;
        } else {
          el.classList._classes.add(c);
          return true;
        }
      },
      contains: (c) => el.classList._classes.has(c)
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
  allElements.push(el);
  return el;
}

// Extract tags from HTML
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
  const el = createMockElement(tagName, id, classes);
}

const sandbox = {
  console: {
    log: (...args) => console.log('    [Waterfall Log]', ...args),
    warn: (...args) => console.warn('    [Waterfall Warn]', ...args),
    error: (...args) => console.error('    [Waterfall Error]', ...args),
  },
  acquireVsCodeApi: () => ({
    postMessage: (msg) => postedMessages.push(msg)
  }),
  document: {
    getElementById: (id) => elementsById.get(id) || createMockElement('div', id),
    createElement: (tag) => createMockElement(tag),
    addEventListener: (evt, cb) => {
      windowListeners[evt] = windowListeners[evt] || [];
      windowListeners[evt].push(cb);
    },
    querySelectorAll: (sel) => allElements.filter(e => e.classList.contains(sel.replace('.', ''))),
    querySelector: (sel) => createMockElement('div', '', (sel || '').replace('.', '')),
  },
  window: {
    addEventListener: (evt, cb) => {
      windowListeners[evt] = windowListeners[evt] || [];
      windowListeners[evt].push(cb);
    },
    postMessage: (data) => {
      const cbs = windowListeners['message'] || [];
      for (const cb of cbs) cb({ data });
    }
  },
  setTimeout: (cb) => { if (typeof cb === 'function') cb(); return 1; },
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent,
  escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  requestAnimationFrame: (cb) => 1
};
sandbox.window.document = sandbox.document;

// 4. Run Script in VM
const context = vm.createContext(sandbox);
const script = new vm.Script(scriptCode, { filename: 'waterfallScript.js' });
script.runInContext(context);
console.log("[PASS] Waterfall Script initialized in VM with 0 errors");

// 5. Test Past Session Reconstruction (Simulating user's multi-step turn)
console.log("\nTesting session_history dispatch with multi-step tool calls...");

const baseTs = 1725820000000; // Reference epoch
const sessionPayload = {
  id: "sess-test-waterfall",
  model: "qwen/qwen3.7-flash",
  provider: "openrouter",
  token_total: 58707,
  context_tokens: 16384,
  status: "idle",
  messages: [
    // Turn 1: User says "hi"
    {
      role: "user",
      content: "hi",
      ts: new Date(baseTs).toISOString()
    },
    // LLM Call 1: Runs for 3.12s and calls list_dir
    {
      role: "assistant",
      content: "I will list the workspace directory.",
      duration: 3.12,
      ts: new Date(baseTs + 3120).toISOString(),
      tool_calls: [
        {
          id: "call_list_dir_1",
          function: { name: "list_dir", arguments: '{"path": "."}' }
        }
      ]
    },
    // Tool Result for list_dir (executed in 400ms: 3.12s -> 3.52s)
    {
      role: "tool",
      tool_call_id: "call_list_dir_1",
      content: '["package.json", "src", "tsconfig.json"]',
      ts: new Date(baseTs + 3520).toISOString()
    },
    // LLM Call 2: Runs for 2.01s (elapsed 5.53s) and calls read_file
    {
      role: "assistant",
      content: "Now reading package.json...",
      duration: 5.53, // Cumulative turn duration
      ts: new Date(baseTs + 5530).toISOString(),
      tool_calls: [
        {
          id: "call_read_file_1",
          function: { name: "read_file", arguments: '{"file": "package.json"}' }
        }
      ]
    },
    // Tool Result for read_file (executed in 400ms: 5.53s -> 5.93s)
    {
      role: "tool",
      tool_call_id: "call_read_file_1",
      content: '{"name": "andromity-agent"}',
      ts: new Date(baseTs + 5930).toISOString()
    },
    // LLM Call 3: Runs for 1.64s (elapsed 7.57s) and outputs final response
    {
      role: "assistant",
      content: "Hey! I'm Andromity, your elite AI coding assistant.",
      duration: 7.57, // Cumulative turn duration
      ts: new Date(baseTs + 7570).toISOString()
    }
  ]
};

// Dispatch session_history
sandbox.window.postMessage({
  type: "session_history",
  session: sessionPayload
});

// Retrieve state from sandbox
const state = sandbox.window.__waterfallState;
assert.ok(state, "state object must exist in waterfall context");
assert.strictEqual(state.turns.size, 1, "Expected exactly 1 turn to be reconstructed");

const turn = state.turns.get("turn_1");
assert.ok(turn, "Turn 1 must be present");
console.log(`[PASS] Turn 1 reconstructed: query="${turn.query}", spansCount=${turn.spans.length}`);

// 6. Verify Sequential Integrity (Zero Overlaps)
console.log("\nVerifying timeline sequential order of spans:");
assert.strictEqual(turn.spans.length, 5, `Expected 5 spans (LLM1, Tool1, LLM2, Tool2, LLM3), got ${turn.spans.length}`);

const span0 = turn.spans[0]; // LLM 1
const span1 = turn.spans[1]; // list_dir
const span2 = turn.spans[2]; // LLM 2
const span3 = turn.spans[3]; // read_file
const span4 = turn.spans[4]; // LLM 3

console.log(`  Span 0 [${span0.type}]: ${span0.name} | ${(span0.startTime - turn.startTime)}ms -> ${(span0.endTime - turn.startTime)}ms (dur: ${span0.durationMs}ms)`);
console.log(`  Span 1 [${span1.type}]: ${span1.name} | ${(span1.startTime - turn.startTime)}ms -> ${(span1.endTime - turn.startTime)}ms (dur: ${span1.durationMs}ms)`);
console.log(`  Span 2 [${span2.type}]: ${span2.name} | ${(span2.startTime - turn.startTime)}ms -> ${(span2.endTime - turn.startTime)}ms (dur: ${span2.durationMs}ms)`);
console.log(`  Span 3 [${span3.type}]: ${span3.name} | ${(span3.startTime - turn.startTime)}ms -> ${(span3.endTime - turn.startTime)}ms (dur: ${span3.durationMs}ms)`);
console.log(`  Span 4 [${span4.type}]: ${span4.name} | ${(span4.startTime - turn.startTime)}ms -> ${(span4.endTime - turn.startTime)}ms (dur: ${span4.durationMs}ms)`);

// Check Span 0 (LLM 1)
assert.strictEqual(span0.startTime, turn.startTime, "Span 0 should start at turn start (0ms)");
assert.strictEqual(span0.durationMs, 3120, "Span 0 duration should be 3120ms");
assert.strictEqual(span0.endTime, turn.startTime + 3120, "Span 0 should end at 3120ms");

// Check Span 1 (list_dir)
assert.strictEqual(span1.startTime, span0.endTime, "Span 1 (list_dir) MUST start immediately when Span 0 finishes (3120ms)");
assert.strictEqual(span1.durationMs, 400, "Span 1 (list_dir) duration should be 400ms");
assert.strictEqual(span1.endTime, turn.startTime + 3520, "Span 1 should end at 3520ms");

// Check Span 2 (LLM 2) - NO LONGER STARTS AT 0s!
assert.strictEqual(span2.startTime, span1.endTime, "Span 2 (LLM 2) MUST start when Span 1 completes (3520ms), NOT at 0ms!");
assert.strictEqual(span2.durationMs, 2010, "Span 2 duration should be delta duration (2010ms), NOT full cumulative 5530ms!");
assert.strictEqual(span2.endTime, turn.startTime + 5530, "Span 2 should end at 5530ms");

// Check Span 3 (read_file)
assert.strictEqual(span3.startTime, span2.endTime, "Span 3 (read_file) MUST start when Span 2 completes (5530ms)");
assert.strictEqual(span3.durationMs, 400, "Span 3 duration should be 400ms");
assert.strictEqual(span3.endTime, turn.startTime + 5930, "Span 3 should end at 5930ms");

// Check Span 4 (LLM 3) - NO LONGER STARTS AT 0s!
assert.strictEqual(span4.startTime, span3.endTime, "Span 4 (LLM 3) MUST start when Span 3 completes (5930ms), NOT at 0ms!");
assert.strictEqual(span4.durationMs, 1640, "Span 4 duration should be delta duration (1640ms), NOT full cumulative 7570ms!");
assert.strictEqual(span4.endTime, turn.startTime + 7570, "Span 4 should end at 7570ms");

// Check Totals
console.log(`\nTotals: Duration=${state.totals.durationMs}ms, LLM=${state.totals.llmMs}ms, Tool=${state.totals.toolMs}ms`);
assert.strictEqual(state.totals.durationMs, 7570, "Total turn duration must equal 7570ms");
assert.strictEqual(state.totals.llmMs, 3120 + 2010 + 1640, "Total LLM ms must equal sum of LLM spans (6770ms)");
assert.strictEqual(state.totals.toolMs, 400 + 400, "Total tool ms must equal sum of tool spans (800ms)");
assert.strictEqual(state.totals.llmMs + state.totals.toolMs, state.totals.durationMs, "LLM ms + Tool ms must equal Total durationMs");

console.log("[PASS] All sequential timeline assertions verified with ZERO overlaps!");
console.log("================================================================================");
console.log("WATERFALL PAST SESSION RECONSTRUCTION VERIFIED 100% SUCCESFULLY!");
console.log("================================================================================");
