const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

console.log("================================================================================");
console.log("ChatView Script Diagnostic: Finding Webview Runtime Errors via Node.js");
console.log("================================================================================");

// ── Mock VS Code Environment for Node.js ─────────────────────────────────────
const Module = require('module');
const origRequire = Module.prototype.require;
const mockVscode = {
  Uri: {
    joinPath: (...args) => ({
      fsPath: args.map(a => typeof a === 'object' ? (a.fsPath || a.path || '') : a).join('/').replace(/\\/g, '/')
    }),
    file: (p) => ({ fsPath: p.replace(/\\/g, '/') })
  },
  window: {},
  workspace: {
    getConfiguration: () => ({
      get: (k, d) => d
    })
  },
  commands: {},
  EventEmitter: class { event() {} fire() {} }
};

Module.prototype.require = function(reqPath) {
  if (reqPath === 'vscode') return mockVscode;
  return origRequire.apply(this, arguments);
};

const chatHtmlMod = require('../dist-test/src/providers/chatview/chatHtml.js');
const mockWebview = {
  cspSource: 'vscode-webview:',
  asWebviewUri: (u) => 'vscode-resource://' + (u.fsPath || u)
};
const mockExtUri = { fsPath: 'd:/saas/agent/vscode-extension' };
const initialChatState = {
  currentSessionId: 'sess-diagnostic-1',
  currentModel: 'claude-3-7-sonnet',
  currentProvider: 'anthropic',
  currentMode: 'safe',
  currentProfile: 'builder',
  currentReasoning: 'medium',
  models: [
    { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'anthropic' }
  ]
};

const chatHtml = chatHtmlMod.getChatViewHtml(mockWebview, mockExtUri, initialChatState);
assert(chatHtml && chatHtml.length > 5000, "Failed to generate ChatView HTML");
console.log(`Generated ChatView HTML (${chatHtml.length} characters)`);

// Extract script blocks
const scriptMatches = [...chatHtml.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];
console.log(`Found ${scriptMatches.length} inline script tags.`);

// Track errors
const scriptErrors = [];

// DOM Simulation
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
    value: '',
    checked: false,
    disabled: false,
    type: 'text',
    style: {},
    childNodes: [],
    parentElement: null,
    parentNode: null,
    classList: {
      _classes: new Set((classStr || '').split(/\s+/).filter(Boolean)),
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
    remove: () => {
      if (el.parentElement) {
        el.parentElement.removeChild(el);
      }
    },
    contains: (node) => {
      if (!node) return false;
      if (el === node) return true;
      if (el.childNodes) {
        return el.childNodes.some(c => c === node || (c.contains && c.contains(node)));
      }
      return false;
    },
    get innerHTML() { return _innerHTML; },
    set innerHTML(val) {
      _innerHTML = String(val);
      _textContent = _innerHTML.replace(/<[^>]+>/g, '');
      el.childNodes = [];
      const tagRe = /<([a-z0-9-]+)([^>]*)>/gi;
      let tm;
      while ((tm = tagRe.exec(_innerHTML)) !== null) {
        const tName = tm[1];
        if (tName.toLowerCase() === 'script' || tName.toLowerCase() === 'style') continue;
        const attrs = tm[2];
        const idMatch = attrs.match(/id=["']([^"']+)["']/i);
        const classMatch = attrs.match(/class=["']([^"']+)["']/i);
        const subId = idMatch ? idMatch[1] : '';
        const classes = classMatch ? classMatch[1] : '';
        const subEl = createMockElement(tName, subId, classes);
        subEl.parentElement = el;
        subEl.parentNode = el;
        el.childNodes.push(subEl);
        if (subId) elementsById.set(subId, subEl);
      }
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
    removeEventListener: (evt, cb) => {
      if (listeners[evt]) {
        listeners[evt] = listeners[evt].filter(f => f !== cb);
      }
    },
    dispatchEvent: (evt) => {
      if (typeof evt === 'string') evt = { type: evt };
      evt.target = el;
      evt.currentTarget = el;
      evt.stopPropagation = () => {};
      evt.preventDefault = () => {};

      const cbs = listeners[evt.type] || [];
      for (const cb of cbs) {
        try {
          cb.call(el, evt);
        } catch (err) {
          console.error(`  [Element Exception in #${el.id || el.tagName} on '${evt.type}']:`, err);
          scriptErrors.push({ phase: `Element event ${evt.type}`, error: err });
        }
      }

      // Bubble up to document / window
      const docCbs = windowListeners[evt.type] || [];
      for (const cb of docCbs) {
        try {
          cb.call(sandbox.window, evt);
        } catch (err) {
          console.error(`  [Delegated Window/Doc Exception on '${evt.type}']:`, err);
          scriptErrors.push({ phase: `Window event ${evt.type}`, error: err });
        }
      }
    },
    click: () => el.dispatchEvent({ type: 'click' }),
    focus: () => el.dispatchEvent({ type: 'focus' }),
    blur: () => el.dispatchEvent({ type: 'blur' }),
    setAttribute: (k, v) => {
      attrs[k] = String(v);
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
        el.dataset[camel] = String(v);
      }
    },
    getAttribute: (k) => attrs[k] || null,
    removeAttribute: (k) => {
      delete attrs[k];
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
        delete el.dataset[camel];
      }
    },
    hasAttribute: (k) => k in attrs,
    closest: (selector) => {
      if (!selector) return null;
      let curr = el;
      while (curr) {
        if (selector.startsWith('.')) {
          if (curr.classList && curr.classList.contains(selector.slice(1))) return curr;
        } else if (selector.startsWith('#')) {
          if (curr.id === selector.slice(1)) return curr;
        } else if (selector.startsWith('[')) {
          const m = selector.match(/\[([a-z0-9-]+)(?:=["']?([^"']*)["']?)?\]/i);
          if (m) {
            const attr = m[1];
            const val = m[2];
            if (val !== undefined ? curr.getAttribute && curr.getAttribute(attr) === val : curr.hasAttribute && curr.hasAttribute(attr)) {
              return curr;
            }
          }
        } else if (curr.tagName && curr.tagName.toLowerCase() === selector.toLowerCase()) {
          return curr;
        }
        curr = curr.parentElement;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      const results = [];
      function match(e) {
        if (sel.startsWith('.')) {
          if (e.classList && e.classList.contains(sel.slice(1))) results.push(e);
        } else if (sel.startsWith('#')) {
          if (e.id === sel.slice(1)) results.push(e);
        } else if (sel.startsWith('[')) {
          const m = sel.match(/\[([a-z0-9-]+)(?:=["']?([^"']*)["']?)?\]/i);
          if (m) {
            const attr = m[1];
            const val = m[2];
            if (val !== undefined ? e.getAttribute && e.getAttribute(attr) === val : e.hasAttribute && e.hasAttribute(attr)) {
              results.push(e);
            }
          }
        } else if (e.tagName && e.tagName.toLowerCase() === sel.toLowerCase()) {
          results.push(e);
        }
        if (e.childNodes) {
          for (const c of e.childNodes) match(c);
        }
      }
      match(el);
      return results;
    },
    querySelector: (sel) => {
      const list = el.querySelectorAll(sel);
      return list.length > 0 ? list[0] : null;
    },
    appendChild: (child) => {
      if (child) {
        child.parentElement = el;
        child.parentNode = el;
        el.childNodes.push(child);
        allElements.push(child);
        if (child.id) elementsById.set(child.id, child);
      }
      return child;
    },
    removeChild: (child) => {
      const idx = el.childNodes.indexOf(child);
      if (idx !== -1) {
        el.childNodes.splice(idx, 1);
        child.parentElement = null;
        child.parentNode = null;
      }
      return child;
    },
    replaceWith: (newEl) => {
      if (el.parentElement) {
        const idx = el.parentElement.childNodes.indexOf(el);
        if (idx !== -1) {
          el.parentElement.childNodes[idx] = newEl;
          newEl.parentElement = el.parentElement;
          newEl.parentNode = el.parentElement;
          if (newEl.id) elementsById.set(newEl.id, newEl);
          allElements.push(newEl);
        }
      }
    },
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 24, bottom: 24, right: 100 }),
    getContext: (type) => ({
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      fillRect: () => {},
      clearRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
    })
  };

  (classStr || '').split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c));
  if (id) elementsById.set(id, el);
  allElements.push(el);
  return el;
}

// Parse existing tags from HTML
const tagRegex = /<([a-z0-9-]+)([^>]*)>/gi;
let tagMatch;
while ((tagMatch = tagRegex.exec(chatHtml)) !== null) {
  const tagName = tagMatch[1];
  if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'style') continue;
  const attrs = tagMatch[2];
  const idMatch = attrs.match(/id=["']([^"']+)["']/i);
  const classMatch = attrs.match(/class=["']([^"']+)["']/i);
  const id = idMatch ? idMatch[1] : '';
  const classes = classMatch ? classMatch[1] : '';
  const el = createMockElement(tagName, id, classes);

  const attrRegex = /([a-z0-9-]+)=["']([^"']*)["']/gi;
  let am;
  while ((am = attrRegex.exec(attrs)) !== null) {
    el.setAttribute(am[1], am[2]);
    if (am[1].toLowerCase() === 'type') el.type = am[2];
    if (am[1].toLowerCase() === 'value') el.value = am[2];
  }
}

// Ensure critical chat container hierarchy
const messagesEl = elementsById.get('messages') || createMockElement('div', 'messages');
const chatContainer = elementsById.get('chat-container') || createMockElement('div', 'chat-container');
chatContainer.appendChild(messagesEl);

const sandbox = {
  console: {
    log: (...args) => console.log('    [Webview Log]', ...args),
    warn: (...args) => console.warn('    [Webview Warn]', ...args),
    error: (...args) => {
      console.error('    [Webview Error]', ...args);
      scriptErrors.push({ phase: 'console.error', error: args.join(' ') });
    },
  },
  acquireVsCodeApi: () => ({
    postMessage: (msg) => postedMessages.push(msg),
    getState: () => ({}),
    setState: () => {}
  }),
  document: {
    getElementById: (id) => elementsById.get(id) || null,
    addEventListener: (evt, cb) => {
      windowListeners[evt] = windowListeners[evt] || [];
      windowListeners[evt].push(cb);
    },
    removeEventListener: (evt, cb) => {
      if (windowListeners[evt]) {
        windowListeners[evt] = windowListeners[evt].filter(f => f !== cb);
      }
    },
    querySelectorAll: (sel) => {
      return allElements.filter(e => {
        if (sel.startsWith('.')) return e.classList.contains(sel.slice(1));
        if (sel.startsWith('#')) return e.id === sel.slice(1);
        if (sel.includes('[data-start-ts]')) return e.hasAttribute('data-start-ts');
        if (sel.startsWith('[')) {
          const m = sel.match(/\[([a-z0-9-]+)(?:=["']?([^"']*)["']?)?\]/i);
          if (m) {
            const attr = m[1];
            const val = m[2];
            return val !== undefined ? e.getAttribute(attr) === val : e.hasAttribute(attr);
          }
        }
        return e.tagName.toLowerCase() === sel.toLowerCase();
      });
    },
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elementsById.get(sel.slice(1)) || null;
      return allElements.find(e => {
        if (sel.startsWith('.')) return e.classList.contains(sel.slice(1));
        if (sel.includes('[data-start-ts]')) return e.hasAttribute('data-start-ts');
        return e.tagName.toLowerCase() === sel.toLowerCase();
      }) || null;
    },
    createElement: (tag) => createMockElement(tag),
    body: elementsById.get('body') || createMockElement('body', 'body')
  },
  window: {
    addEventListener: (evt, cb) => {
      windowListeners[evt] = windowListeners[evt] || [];
      windowListeners[evt].push(cb);
    },
    removeEventListener: (evt, cb) => {
      if (windowListeners[evt]) {
        windowListeners[evt] = windowListeners[evt].filter(f => f !== cb);
      }
    },
    postMessage: (data) => {
      const cbs = windowListeners['message'] || [];
      for (const cb of cbs) cb({ data });
    },
    onerror: null
  },
  localStorage: {
    _store: new Map(),
    getItem: (k) => sandbox.localStorage._store.get(k) || null,
    setItem: (k, v) => sandbox.localStorage._store.set(k, String(v)),
    removeItem: (k) => sandbox.localStorage._store.delete(k),
    clear: () => sandbox.localStorage._store.clear()
  },
  setTimeout: (cb, ms) => {
    // Synchronous execution for deterministic tests
    if (typeof cb === 'function') {
      try { cb(); } catch (err) {
        console.error('  [setTimeout Exception]:', err);
        scriptErrors.push({ phase: 'setTimeout', error: err });
      }
    }
    return 1;
  },
  clearTimeout: () => {},
  setInterval: (cb, ms) => 1,
  clearInterval: () => {},
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent,
  Image: class {
    constructor() {
      this.src = '';
      this.onload = null;
      this.onerror = null;
    }
  },
  Date: Date,
  Math: Math,
  JSON: JSON,
  requestAnimationFrame: (cb) => { if (typeof cb === 'function') cb(); }
};

sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.console = sandbox.console;
sandbox.window.setTimeout = sandbox.setTimeout;
sandbox.window.clearTimeout = sandbox.clearTimeout;
sandbox.window.setInterval = sandbox.setInterval;
sandbox.window.clearInterval = sandbox.clearInterval;
sandbox.window.location = { reload() {} };
sandbox.global = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);

// ── Execute all inline script tags in order ──────────────────────────────────
console.log("\n--- Compiling and Executing Inline Scripts ---");
let scriptIdx = 0;
for (const match of scriptMatches) {
  scriptIdx++;
  const code = match[1];
  if (!code.trim()) continue;
  try {
    const s = new vm.Script(code, { filename: `inline-script-${scriptIdx}.js` });
    s.runInContext(context);
    console.log(`  ✓ Inline script #${scriptIdx} (${code.length} chars) executed without compilation errors`);
  } catch (err) {
    console.error(`  ✕ FATAL: Inline script #${scriptIdx} threw during evaluation:`, err);
    scriptErrors.push({ phase: `Script #${scriptIdx} execution`, error: err });
  }
}

// Function to dispatch message to webview
function dispatchWebviewMessage(msg) {
  const cbs = windowListeners['message'] || [];
  for (const cb of cbs) {
    try {
      cb({ data: msg });
    } catch (err) {
      console.error(`  ✕ EXCEPTION in message handler for '${msg.type}':`, err);
      scriptErrors.push({ phase: `Message '${msg.type}'`, error: err });
    }
  }
}

// ── Run Scenario 1: Initial State & Onboarding ───────────────────────────────
console.log("\n--- Scenario 1: Initial State & Model Setup ---");
dispatchWebviewMessage({
  type: 'init_state',
  sessionId: 'sess-diagnostic-1',
  activeModel: 'claude-3-7-sonnet',
  activeProvider: 'anthropic',
  providers: [
    { id: 'anthropic', name: 'Anthropic', has_key: true },
    { id: 'openai', name: 'OpenAI', has_key: false }
  ],
  models: [
    { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'anthropic' }
  ]
});

// ── Run Scenario 2: Tool Execution Flow (File Edit & Activity Row) ───────────
console.log("\n--- Scenario 2: Tool Execution (write_file & replace_file_content) ---");
dispatchWebviewMessage({
  type: 'tool_start',
  session_id: 'sess-diagnostic-1',
  tool_id: 'tool-call-1',
  tool_name: 'replace_file_content'
});

dispatchWebviewMessage({
  type: 'tool_delta',
  session_id: 'sess-diagnostic-1',
  tool_id: 'tool-call-1',
  chunk: JSON.stringify({
    TargetFile: 'd:/saas/agent/src/test.py',
    TargetContent: 'def old(): pass',
    ReplacementContent: 'def new():\n    return 42'
  })
});

dispatchWebviewMessage({
  type: 'tool_end',
  session_id: 'sess-diagnostic-1',
  tool_id: 'tool-call-1'
});

dispatchWebviewMessage({
  type: 'tool_result',
  session_id: 'sess-diagnostic-1',
  tool_id: 'tool-call-1',
  result: 'Successfully replaced content',
  duration_ms: 250,
  success: true
});

// ── Run Scenario 3: Shell Exec Activity Row & Output Toggle ──────────────────
console.log("\n--- Scenario 3: Shell Command Tool & Output Box ---");
dispatchWebviewMessage({
  type: 'tool_start',
  session_id: 'sess-diagnostic-1',
  tool_id: 'tool-call-2',
  tool_name: 'shell_exec'
});

dispatchWebviewMessage({
  type: 'tool_delta',
  session_id: 'sess-diagnostic-1',
  tool_id: 'tool-call-2',
  chunk: JSON.stringify({
    command: 'git status'
  })
});

dispatchWebviewMessage({
  type: 'tool_end',
  session_id: 'sess-diagnostic-1',
  tool_id: 'tool-call-2'
});

dispatchWebviewMessage({
  type: 'tool_result',
  session_id: 'sess-diagnostic-1',
  tool_id: 'tool-call-2',
  result: 'On branch main\nnothing to commit',
  duration_ms: 110,
  success: true
});

// ── Run Scenario 4: User Interacting with Generated Activity Rows ────────────
console.log("\n--- Scenario 4: User Clicks on Diff & File Links ---");
const diffBtn = sandbox.document.querySelector('.activity-diff-btn');
if (diffBtn) {
  console.log("  Found .activity-diff-btn, triggering click event...");
  diffBtn.click();
} else {
  console.log("  Notice: .activity-diff-btn not found");
}

const fileRow = sandbox.document.querySelector('.activity-row-file');
if (fileRow) {
  console.log("  Found .activity-row-file, triggering click event...");
  fileRow.click();
} else {
  console.log("  Notice: .activity-row-file not found");
}

const cmdRow = sandbox.document.querySelector('.activity-row-command');
if (cmdRow) {
  console.log("  Found .activity-row-command, triggering click event...");
  cmdRow.click();
} else {
  console.log("  Notice: .activity-row-command not found");
}

// ── Run Scenario 5: Turn Completion & Question Handling ──────────────────────
console.log("\n--- Scenario 5: Thinking, Text Delta, Questions & Turn Finish ---");
dispatchWebviewMessage({
  type: 'thinking_delta',
  session_id: 'sess-diagnostic-1',
  text: 'Analyzing codebase structure...'
});

dispatchWebviewMessage({
  type: 'text_delta',
  session_id: 'sess-diagnostic-1',
  text: 'Task complete! All files modified successfully.'
});

dispatchWebviewMessage({
  type: 'done',
  session_id: 'sess-diagnostic-1',
  usage: { total_tokens: 200 }
});

dispatchWebviewMessage({
  type: 'ask_questions',
  session_id: 'sess-diagnostic-1',
  questions: [
    { question: 'Do you want to proceed?', options: ['Yes', 'No'] }
  ]
});

// ── Run Scenario 6: Subagent Flow ────────────────────────────────────────────
console.log("\n--- Scenario 6: Subagent Lifecycle (Start, Progress, Complete) ---");
dispatchWebviewMessage({
  type: 'subagent_start',
  session_id: 'sess-diagnostic-1',
  agent_id: 'sub-agent-99',
  name: 'code-reviewer',
  goal: 'Review all git changes'
});

dispatchWebviewMessage({
  type: 'subagent_delta',
  session_id: 'sess-diagnostic-1',
  agent_id: 'sub-agent-99',
  chunk: 'Checking syntax in src/test.py...'
});

dispatchWebviewMessage({
  type: 'subagent_done',
  session_id: 'sess-diagnostic-1',
  agent_id: 'sub-agent-99',
  status: 'completed',
  result: 'All checks passed successfully'
});

// ── Run Scenario 7: Question Navigation & Submission ─────────────────────────
console.log("\n--- Scenario 7: Answering Interactive Questions ---");
const questionOptions = sandbox.document.querySelectorAll('.question-option-row');
if (questionOptions.length > 0) {
  console.log(`  Found ${questionOptions.length} question options, clicking first option...`);
  questionOptions[0].click();
}
const submitQuestionBtn = sandbox.document.querySelector('.questions-submit-btn') || sandbox.document.querySelector('#questions-submit');
if (submitQuestionBtn) {
  console.log("  Clicking question submit button...");
  submitQuestionBtn.click();
}

// ── Run Scenario 8: Tool Approval Flow ───────────────────────────────────────
console.log("\n--- Scenario 8: Tool Permission Approval Dialog ---");
dispatchWebviewMessage({
  type: 'tool_approval_required',
  session_id: 'sess-diagnostic-1',
  tool_name: 'shell_exec',
  command: 'rm -rf temp_cache'
});

const allowBtn = sandbox.document.querySelector('.perm-btn-allow') || sandbox.document.querySelector('[data-action="allow"]');
if (allowBtn) {
  console.log("  Found allow button, clicking...");
  allowBtn.click();
}

// ── Run Scenario 9: User Prompt Submission ───────────────────────────────────
console.log("\n--- Scenario 9: User Input & Send Button ---");
const promptInput = sandbox.document.getElementById('prompt-input') || sandbox.document.getElementById('chat-input');
const sendBtn = sandbox.document.getElementById('send-btn') || sandbox.document.querySelector('.send-button');
if (promptInput) {
  promptInput.value = 'Fix the bug in chatview';
  promptInput.dispatchEvent({ type: 'input' });
  if (sendBtn) {
    console.log("  Clicking send button...");
    sendBtn.click();
  }
}

// ── Run Scenario 10: Plan Updates ────────────────────────────────────────────
console.log("\n--- Scenario 10: Live Plan Updates ---");
dispatchWebviewMessage({
  type: 'plan_updated',
  session_id: 'sess-diagnostic-1',
  plan: {
    steps: [
      { id: '1', title: 'Diagnose issue with Node', status: 'completed' },
      { id: '2', title: 'Fix template string escape', status: 'in_progress' }
    ]
  }
});

// ── Run Scenario 11: Error Events ────────────────────────────────────────────
console.log("\n--- Scenario 11: Stream Errors & API Failures ---");
dispatchWebviewMessage({
  type: 'error',
  session_id: 'sess-diagnostic-1',
  message: 'Simulated API rate limit exceeded'
});

// ── Run Scenario 12: Session Switch ──────────────────────────────────────────
console.log("\n--- Scenario 12: Session Switch & History Hydration ---");
dispatchWebviewMessage({
  type: 'session_init',
  session_id: 'sess-diagnostic-2',
  name: 'New Session 2',
  model: 'claude-3-7-sonnet'
});

// ── Run Scenario 13: Live Timer Tick ─────────────────────────────────────────
console.log("\n--- Scenario 13: Live Timer Tick Inspection ---");
const cardsWithStartTs = sandbox.document.querySelectorAll('[data-start-ts]');
console.log(`  Cards with [data-start-ts]: ${cardsWithStartTs.length}`);
cardsWithStartTs.forEach(card => {
  const ts = parseInt(card.getAttribute('data-start-ts') || '0', 10);
  const elapsed = Math.floor((Date.now() - ts) / 1000);
  const elapsedEl = card.querySelector('.tool-elapsed');
  if (elapsedEl) {
    elapsedEl.textContent = elapsed + 's';
  }
});

// ── Report Results ───────────────────────────────────────────────────────────
console.log("\n================================================================================");
console.log(`Diagnostic Complete! Total Errors Encountered: ${scriptErrors.length}`);
if (scriptErrors.length > 0) {
  console.error("Errors detail:");
  for (const e of scriptErrors) {
    console.error(`- [${e.phase}]:`, e.error);
  }
  process.exit(1);
} else {
  console.log("ALL 13 DEEP SCENARIOS PASSED WITH ZERO SCRIPT ERRORS!");
  process.exit(0);
}
