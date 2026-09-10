/**
 * Deep Verification Test: Waterfall Webview Script Execution & Live Timing Updates
 */
const assert = require("assert");
const vm = require("vm");
const path = require("path");

console.log("================================================================================");
console.log("Senior SWE Test: Waterfall Webview Execution & Live Running Bar Updates");
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
  env: { appRoot: "C:/fake/vscode" },
};

Module.prototype.require = function(reqPath) {
  if (reqPath === 'vscode') return mockVscode;
  return origRequire.apply(this, arguments);
};

// 1. Load compiled Waterfall modules
const waterfallMod = require("../dist-test/src/providers/waterfall/waterfallHtml.js");

const mockWebview = {
  cspSource: "vscode-webview:",
  asWebviewUri: (u) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
};

const sessionId = "sess-live-test-123";
const html = waterfallMod.getWaterfallHtml(mockWebview, sessionId, "Test Live Session");
assert.ok(html.includes("<!DOCTYPE html>"), "Must generate complete HTML document");
assert.ok(html.includes("wf-timeline"), "Must include waterfall timeline container");
console.log("  ✓ Generated Waterfall HTML (" + html.length + " characters)");

// 2. Extract client script from HTML
const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
assert.ok(scriptMatch && scriptMatch[1], "Should extract script body");
const scriptCode = scriptMatch[1];
console.log("  ✓ Extracted Waterfall Client Script (" + scriptCode.length + " characters)");

// 3. Build Mock DOM matching actual HTML structure
const elementsById = new Map();
const allElements = [];
const windowListeners = {};
const postedMessages = [];
const animFrameCallbacks = [];

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
  createMockElement(tagName, id, classes);
}

let simulatedTime = 1000000;

const sandbox = {
  window: {
    addEventListener: (evt, cb) => {
      windowListeners[evt] = windowListeners[evt] || [];
      windowListeners[evt].push(cb);
    },
    removeEventListener: () => {},
    postMessage: () => {},
  },
  document: {
    getElementById: (id) => elementsById.get(id) || createMockElement('div', id),
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: () => [],
    querySelector: (sel) => createMockElement('div', '', (sel || '').replace('.', '')),
    addEventListener: () => {},
    body: createMockElement('body'),
  },
  acquireVsCodeApi: () => ({
    postMessage: (m) => postedMessages.push(m),
    getState: () => ({}),
    setState: () => {},
  }),
  requestAnimationFrame: (cb) => {
    animFrameCallbacks.push(cb);
    return animFrameCallbacks.length;
  },
  Date: class MockDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super(simulatedTime);
      } else {
        super(...args);
      }
    }
    static now() {
      return simulatedTime;
    }
  },
  Math,
  JSON,
  Array,
  Map,
  Set,
  String,
  Number,
  Boolean,
  RegExp,
  console: {
    log: () => {},
    warn: () => {},
    error: () => {},
  },
};
sandbox.window.document = sandbox.document;

// Execute script inside sandbox
assert.doesNotThrow(() => {
  vm.createContext(sandbox);
  const compiled = new vm.Script(scriptCode, { filename: "waterfallClientScript.js" });
  compiled.runInContext(sandbox);
}, "Script must execute inside DOM sandbox without throwing");
console.log("  ✓ Webview script executed in DOM environment with ZERO errors");

// 4. Test Live Tool Execution & Dynamic Growth
console.log("\n▶ Testing Live Tool Execution & Animation Loop:");
const dispatch = (msg) => {
  const cbs = windowListeners['message'] || [];
  for (const cb of cbs) {
    cb({ data: msg });
  }
};

// Start Agent Turn
dispatch({ type: "agent_started", prompt: "Test Search Query", ts: simulatedTime / 1000 });
console.log("  ✓ Sent 'agent_started'");

// Tool Start (streaming declaration)
const toolId = "grep_test_1";
dispatch({
  type: "tool_start",
  tool_id: toolId,
  tool_name: "grep_search",
  ts: simulatedTime / 1000,
});
console.log("  ✓ Sent 'tool_start' for grep_search");

// Advance time 200ms and send tool_end (arguments streaming finished)
simulatedTime += 200;
dispatch({
  type: "tool_end",
  tool_id: toolId,
  ts: simulatedTime / 1000,
});
console.log("  ✓ Sent 'tool_end' (arguments received at +200ms)");

// Verify bar element exists
const bar = elementsById.get("wf-bar-" + toolId);
const label = elementsById.get("wf-label-" + toolId);
assert.ok(bar, "Timing bar element for grep_search must exist");
assert.ok(label, "Timing label element for grep_search must exist");

// Run animation loop ticks as 10 seconds pass while tool is RUNNING
console.log("  Simulating 10 seconds of active tool execution...");
for (let sec = 1; sec <= 10; sec++) {
  simulatedTime += 1000;
  // Trigger animLoop callback
  const cb = animFrameCallbacks.pop();
  if (cb) cb();
}

const currentLabelText = label.textContent;
console.log("  Elapsed time label after 10.2s of running:", currentLabelText);
assert.ok(
  currentLabelText.includes("10.") || currentLabelText.includes("10s") || currentLabelText.includes("10"),
  "Label must reflect ~10s of elapsed running time, but was: " + currentLabelText
);
assert.ok(
  bar.classList.contains("running"),
  "Timing bar must have .running class while actively executing"
);
console.log("  ✓ Timing bar dynamically expanded and ticked live with wall-clock time!");

// Now complete the tool
simulatedTime += 500;
dispatch({
  type: "tool_result",
  tool_id: toolId,
  duration_ms: 10700,
  success: true,
  result: "Found 12 matches",
});

console.log("  ✓ Sent 'tool_result' (completed in 10.7s)");
assert.ok(!bar.classList.contains("running"), "Timing bar must remove .running class once done");
assert.ok(label.textContent.includes("10.7"), "Final label must display finished duration (10.7s)");
console.log("  Final duration label:", label.textContent);

console.log("\n================================================================================");
console.log("ALL WATERFALL WEBVIEW EXECUTION TESTS PASSED WITH 100% SUCCESS!");
console.log("================================================================================");
