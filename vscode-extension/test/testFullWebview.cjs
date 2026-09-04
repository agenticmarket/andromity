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
const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(m => m[1])
  .filter(s => s.trim().length > 0);

if (scriptMatches.length === 0) {
  console.error("NO NON-EMPTY INLINE SCRIPT FOUND IN HTML!");
  process.exit(1);
}

const js = scriptMatches[0];
console.log(`Extracted JS length: ${js.length}`);

// Create realistic DOM environment
const postedMessages = [];
const elements = new Map();
let globalLastCopiedText = '';

function createMockElement(tagName, id) {
  let _rawInnerHTML = '';
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
      toggle: (c) => {
        if (el.classList._classes.has(c)) {
          el.classList._classes.delete(c);
          return false;
        } else {
          el.classList._classes.add(c);
          return true;
        }
      },
      contains: (c) => el.classList._classes.has(c),
    },
    get className() {
      return [...el.classList._classes].join(' ');
    },
    set className(val) {
      el.classList._classes.clear();
      (val || '').split(/\s+/).filter(Boolean).forEach(c => el.classList._classes.add(c));
    },
    get innerHTML() { return _rawInnerHTML; },
    set innerHTML(htmlStr) {
      _rawInnerHTML = htmlStr;
      el.children = [];
      const tagRegex = /<([a-z0-9]+)([^>]*)>/gi;
      let m;
      while ((m = tagRegex.exec(htmlStr)) !== null) {
        const tag = m[1];
        const attrs = m[2];
        if (tag === 'svg' || tag === 'path' || tag === 'rect' || tag === 'polyline' || tag === 'line') continue;
        const child = createMockElement(tag, '');
        const classMatch = attrs.match(/class=["']([^"']+)["']/i);
        if (classMatch) {
          classMatch[1].trim().split(/\s+/).forEach(c => child.classList.add(c));
        }
        const idMatch = attrs.match(/id=["']([^"']+)["']/i);
        if (idMatch) child.id = idMatch[1];
        const actionMatch = attrs.match(/data-action=["']([^"']+)["']/i);
        if (actionMatch) child.setAttribute('data-action', actionMatch[1]);
        el.appendChild(child);
      }
    },
    textContent: '',
    scrollHeight: 500,
    scrollTop: 0,
    clientHeight: 400,
    selectionStart: 0,
    parentElement: null,
    children: [],
    contains: (other) => true,
    closest: (selector) => {
      let cur = el;
      while (cur) {
        if (selector.startsWith('#') && cur.id === selector.slice(1)) return cur;
        if (selector.startsWith('.') && cur.classList && cur.classList.contains(selector.slice(1))) return cur;
        if (selector === '[data-action]' && cur.getAttribute && cur.getAttribute('data-action')) return cur;
        if (selector.startsWith('[data-action="') && cur.getAttribute && cur.getAttribute('data-action') === selector.slice(14, -2)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    getAttribute: (attr) => el._attrs ? el._attrs[attr] : null,
    setAttribute: (attr, val) => {
      if (!el._attrs) el._attrs = {};
      el._attrs[attr] = val;
    },
    removeAttribute: (attr) => {
      if (el._attrs) delete el._attrs[attr];
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
    removeChild: (child) => {
      el.children = el.children.filter(c => c !== child);
      child.parentElement = null;
      return child;
    },
    remove: () => {
      if (el.parentElement) {
        el.parentElement.children = el.parentElement.children.filter(c => c !== el);
      }
    },
    querySelectorAll: (sel) => {
      const results = [];
      function walk(node) {
        for (const ch of (node.children || [])) {
          let match = false;
          if (sel.startsWith('.')) {
            const classes = sel.slice(1).split('.');
            if (classes.every(c => ch.classList && ch.classList.contains(c))) match = true;
          }
          if (sel.startsWith('#') && ch.id === sel.slice(1)) match = true;
          if (sel === '[data-action]' && ch.getAttribute && ch.getAttribute('data-action')) match = true;
          if (match) results.push(ch);
          walk(ch);
        }
      }
      walk(el);
      return results;
    },
    querySelector: (sel) => {
      return el.querySelectorAll(sel)[0] || null;
    },
    focus: () => {},
    scrollTo: () => {},
    scrollBy: () => {},
    click: () => {
      const evt = { type: 'click', target: el, preventDefault: () => {}, stopPropagation: () => {} };
      el.dispatchEvent(evt);
      mockDoc.dispatchEvent(evt);
    }
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
  querySelectorAll: (sel) => {
    const results = [];
    for (const el of elements.values()) {
      results.push(...el.querySelectorAll(sel));
    }
    return results;
  },
  querySelector: (sel) => {
    return mockDoc.querySelectorAll(sel)[0] || null;
  }
};

const mockWindow = {
  addEventListener: (evt, handler) => {
    if (!mockWindow._listeners) mockWindow._listeners = {};
    if (!mockWindow._listeners[evt]) mockWindow._listeners[evt] = [];
    mockWindow._listeners[evt].push(handler);
  },
  dispatchEvent: (evt) => {
    const handlers = (mockWindow._listeners && mockWindow._listeners[evt.type]) || [];
    handlers.forEach(h => {
      try {
        h(evt);
      } catch (e) {
        console.error('Error inside window event handler for', evt.type, ':', e);
      }
    });
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
  requestAnimationFrame: (fn) => { try { fn(); } catch(e) {} },
  cancelAnimationFrame: () => {},
  marked: { parse: (s) => s, use: () => {} },
  navigator: {
    clipboard: {
      writeText: (txt) => {
        globalLastCopiedText = txt;
        return Promise.resolve();
      }
    }
  },
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

// Test incoming session_loaded
console.log('\nTesting incoming "session_loaded" with prompts, images, thinking, and tools...');
mockWindow.dispatchEvent({
  type: 'message',
  data: {
    type: 'session_loaded',
    session: {
      id: 'test-session-123',
      name: 'Test Session',
      messages: [
        {
          role: 'user',
          content: 'This is a long user message that is definitely going to exceed two hundred and twenty characters in total length so that the client script will mark it as clamped and attach an expand button for the user to toggle. It has additional sentences to easily exceed the threshold and trigger expand.',
          images: ['data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...'],
          ts: '2026-09-04T12:00:00.000Z'
        },
        {
          role: 'assistant',
          thinking: 'Analyzing user request and files...',
          duration: 4.2,
          ts: '2026-09-04T12:00:04.200Z',
          tool_calls: [
            {
              id: 'call_1',
              tool_name: 'view_file',
              arguments: { AbsolutePath: 'd:/test.txt' },
              tool_result: 'File contents here'
            }
          ],
          content: 'I analyzed the file and here is the explanation.'
        }
      ]
    }
  }
});

const chatContainer = mockDoc.getElementById('chat-messages');
console.log(`Chat container has ${chatContainer.children.length} message wrappers.`);

const promptExpandBtn = chatContainer.querySelector('.prompt-expand-btn');
if (promptExpandBtn) {
  console.log('[PASS] Found prompt-expand-btn on long message.');
  const textContent = chatContainer.querySelector('.prompt-text-content');
  console.log('Clamped before click:', textContent.classList.contains('clamped'));
  promptExpandBtn.click();
  console.log('Clamped after click (should be false):', textContent.classList.contains('clamped'));
  console.log('Button text after click:', promptExpandBtn.textContent);
  if (!textContent.classList.contains('clamped') && promptExpandBtn.textContent === 'Show less ▴') {
    console.log('[PASS] Prompt expansion toggle worked cleanly!');
  } else {
    console.error('[FAIL] Prompt expansion toggle failed!');
    process.exit(1);
  }
} else {
  console.error('[FAIL] prompt-expand-btn not found!');
  process.exit(1);
}

const thinkingCard = chatContainer.querySelector('.thinking-card');
if (thinkingCard) {
  console.log('[PASS] Found thinking card.');
  const thinkingHdr = thinkingCard.querySelector('.thinking-header');
  console.log('Thinking expanded before click:', thinkingCard.classList.contains('expanded'));
  thinkingHdr.click();
  console.log('Thinking expanded after click:', thinkingCard.classList.contains('expanded'));
  if (thinkingCard.classList.contains('expanded')) {
    console.log('[PASS] Thinking card expand toggle worked cleanly!');
  } else {
    console.error('[FAIL] Thinking card toggle failed!');
    process.exit(1);
  }
} else {
  console.error('[FAIL] thinking-card not found!');
  process.exit(1);
}

const toolSeq = chatContainer.querySelector('.tool-sequence');
if (toolSeq) {
  console.log('[PASS] Found tool sequence.');
  const toolSeqHdr = toolSeq.querySelector('.tool-seq-header');
  console.log('Tool sequence collapsed before click:', toolSeq.classList.contains('collapsed'));
  toolSeqHdr.click();
  console.log('Tool sequence collapsed after click (should be false):', toolSeq.classList.contains('collapsed'));
  if (!toolSeq.classList.contains('collapsed')) {
    console.log('[PASS] Tool sequence expand toggle worked cleanly!');
  } else {
    console.error('[FAIL] Tool sequence toggle failed!');
    process.exit(1);
  }
} else {
  console.error('[FAIL] tool-sequence not found!');
  process.exit(1);
}

// Test Session Switching
console.log('\nTesting session switching by loading a new session...');
mockWindow.dispatchEvent({
  type: 'message',
  data: {
    type: 'session_loaded',
    session: {
      id: 'test-session-456',
      name: 'Second Session',
      messages: [
        {
          role: 'user',
          content: 'Short question here.',
          ts: '2026-09-04T12:10:00.000Z'
        },
        {
          role: 'assistant',
          thinking: 'Second thinking session...',
          duration: 1.8,
          ts: '2026-09-04T12:10:01.800Z',
          content: 'Second answer.'
        }
      ]
    }
  }
});

const newThinkingCard = chatContainer.querySelector('.thinking-card');
if (newThinkingCard) {
  console.log('[PASS] Found thinking card in switched session.');
  const newThinkingHdr = newThinkingCard.querySelector('.thinking-header');
  newThinkingHdr.click();
  console.log('Second session thinking expanded after click:', newThinkingCard.classList.contains('expanded'));
  if (newThinkingCard.classList.contains('expanded')) {
    console.log('[PASS] Thinking card in switched session toggles cleanly!');
  } else {
    console.error('[FAIL] Switched session thinking card toggle failed!');
    process.exit(1);
  }
}

// Test Assistant Copy Button
console.log('\nTesting assistant copy button...');
const assistantWrap = chatContainer.querySelectorAll('.message-wrap.assistant')[0];
if (assistantWrap) {
  const copyBtn = assistantWrap.querySelector('.msg-copy-btn');
  if (copyBtn) {
    copyBtn.click();
    console.log('Copied text:', JSON.stringify(globalLastCopiedText));
    if (globalLastCopiedText === 'Second answer.') {
      console.log('[PASS] Assistant response copy button copied full response text!');
    } else {
      console.error('[FAIL] Assistant copy button failed to copy full response:', globalLastCopiedText);
      process.exit(1);
    }
  }
}

console.log('\nALL WEBVIEW INTERACTION TESTS PASSED CLEANLY!');
