const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Mock vscode module
const Module = require('module');
const origRequire = Module.prototype.require;
const mockVscode = {
  Uri: {
    joinPath: (...args) => ({ fsPath: args.map(a => typeof a === 'object' ? a.fsPath : a).join('/') }),
    file: (p) => ({ fsPath: p })
  },
  window: {},
  workspace: {},
  commands: {},
  EventEmitter: class { event() {} fire() {} }
};
Module.prototype.require = function(reqPath) {
  if (reqPath === 'vscode') return mockVscode;
  return origRequire.apply(this, arguments);
};

const mod = require('../dist/providers/ChatViewProvider.js');
const provider = new mod.ChatViewProvider({ fsPath: 'd:/saas/agent/vscode-extension' }, null);
const mockWebview = {
  cspSource: 'vscode-webview:',
  asWebviewUri: (u) => 'vscode-resource://' + (u.fsPath || u)
};
const html = provider._getHtmlForWebview(mockWebview);

console.log(`HTML generated, length: ${html.length}`);

// Extract scripts
const scriptMatch = html.match(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/i);
if (!scriptMatch) {
  console.error("NO SCRIPT FOUND IN HTML!");
  process.exit(1);
}

const js = scriptMatch[1];
console.log(`Extracted JS length: ${js.length}`);

// Create realistic DOM environment
const postedMessages = [];
const elements = new Map();

function createMockElement(tagName, id) {
  const listeners = {};
  const el = {
    tagName: tagName.toUpperCase(),
    id: id || '',
    value: '',
    style: {},
    classList: {
      _classes: new Set(),
      add: (c) => el.classList._classes.add(c),
      remove: (c) => el.classList._classes.delete(c),
      toggle: (c) => el.classList._classes.has(c) ? el.classList._classes.delete(c) : el.classList._classes.add(c),
      contains: (c) => el.classList._classes.has(c),
    },
    innerHTML: '',
    textContent: '',
    scrollHeight: 500,
    scrollTop: 0,
    clientHeight: 400,
    selectionStart: 0,
    parentElement: null,
    children: [],
    contains: (other) => true,
    closest: (selector) => {
      if (selector.startsWith('#') && selector.slice(1) === el.id) return el;
      if (selector.startsWith('.') && el.classList.contains(selector.slice(1))) return el;
      if (selector === '[data-action]') return el.getAttribute('data-action') ? el : null;
      return null;
    },
    getAttribute: (attr) => el._attrs ? el._attrs[attr] : null,
    setAttribute: (attr, val) => {
      if (!el._attrs) el._attrs = {};
      el._attrs[attr] = val;
    },
    addEventListener: (evt, handler) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(handler);
    },
    dispatchEvent: (evt) => {
      const handlers = listeners[evt.type] || [];
      handlers.forEach(h => h(evt));
    },
    appendChild: (child) => {
      el.children.push(child);
      child.parentElement = el;
      return child;
    },
    querySelector: (sel) => createMockElement('div', ''),
    querySelectorAll: (sel) => [],
    focus: () => {},
    click: () => el.dispatchEvent({ type: 'click', target: el, preventDefault: () => {}, stopPropagation: () => {} })
  };
  return el;
}

const mockDoc = {
  getElementById: (id) => {
    if (!elements.has(id)) {
      elements.set(id, createMockElement('div', id));
    }
    return elements.get(id);
  },
  createElement: (tag) => createMockElement(tag, ''),
  addEventListener: (evt, handler) => {
    if (!mockDoc._listeners) mockDoc._listeners = {};
    if (!mockDoc._listeners[evt]) mockDoc._listeners[evt] = [];
    mockDoc._listeners[evt].push(handler);
  },
  dispatchEvent: (evt) => {
    const handlers = (mockDoc._listeners && mockDoc._listeners[evt.type]) || [];
    handlers.forEach(h => h(evt));
  },
  querySelectorAll: () => [],
  querySelector: () => createMockElement('div', '')
};

const mockWindow = {
  addEventListener: (evt, handler) => {
    if (!mockWindow._listeners) mockWindow._listeners = {};
    if (!mockWindow._listeners[evt]) mockWindow._listeners[evt] = [];
    mockWindow._listeners[evt].push(handler);
  },
  dispatchEvent: (evt) => {
    const handlers = (mockWindow._listeners && mockWindow._listeners[evt.type]) || [];
    handlers.forEach(h => h(evt));
  }
};

const sandbox = {
  acquireVsCodeApi: () => ({
    postMessage: (m) => {
      postedMessages.push(m);
      console.log('  -> vscode.postMessage:', JSON.stringify(m));
    }
  }),
  document: mockDoc,
  window: mockWindow,
  console: console,
  setTimeout: (fn, ms) => { try { fn(); } catch(e) { console.error('setTimeout Error:', e); } },
  setInterval: () => 123,
  clearInterval: () => {},
  clearTimeout: () => {},
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent,
  Math: Math,
  Date: Date,
  JSON: JSON,
  String: String,
  Number: Number,
  Array: Array,
  Object: Object,
  RegExp: RegExp,
  Set: Set,
  Map: Map,
};

vm.createContext(sandbox);

try {
  vm.runInContext(js, sandbox);
  console.log('\n[PASS] Script executed initial load with NO ERRORS!');
} catch (e) {
  console.error('\n[FAIL] SCRIPT INITIAL EXECUTION ERROR:', e);
  process.exit(1);
}

// Test typing "/"
console.log('\nTesting typing "/" in prompt input...');
const input = mockDoc.getElementById('prompt-input');
input.value = '/';
input.dispatchEvent({ type: 'input' });

// Test typing "@"
console.log('Testing typing "@" in prompt input...');
input.value = '@';
input.dispatchEvent({ type: 'input' });

// Test clicking Send
console.log('Testing send message...');
input.value = 'Hello world';
const sendBtn = mockDoc.getElementById('btn-send');
sendBtn.click();

// Test incoming message from extension host
console.log('Testing incoming "init_state" message from extension host...');
mockWindow.dispatchEvent({
  type: 'message',
  data: {
    type: 'init_state',
    sessionId: 'test-session-123',
    models: [{ id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet' }],
    skills: [{ name: 'test-skill', description: 'A test skill' }],
    model: 'anthropic/claude-3.7-sonnet',
    mode: 'safe',
    profile: 'builder',
    reasoningEffort: 'medium'
  }
});

console.log('\nALL WEBVIEW INTERACTION TESTS PASSED CLEANLY!');
