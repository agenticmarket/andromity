/**
 * Test: Sound Notification Based on Settings Verification
 *
 * Verifies that:
 * 1. Sound is enabled by default.
 * 2. When soundNotifications is true and sound_done is true -> play_sound message is posted.
 * 3. When andromity.soundNotifications setting is false -> play_sound message is NEVER posted.
 * 4. When daemon config has sound_done: false -> play_sound message is NEVER posted.
 * 5. When daemon config has sound_attention: false -> attention sound is NEVER posted.
 * 6. Webview client script handles 'play_sound' message cleanly without crashing and includes synthetic chime fallback.
 * 7. Debounce prevents duplicate audio triggers within 1200ms.
 */
const assert = require("assert");
const vm = require("vm");

console.log("================================================================================");
console.log("Test: Sound Notification Settings & Webview Playback Verification");
console.log("================================================================================");

const Module = require('module');
const origRequire = Module.prototype.require;

let mockConfigValues = {
  soundNotifications: true
};

const mockVscode = {
  Uri: {
    joinPath: (...args) => ({ fsPath: args.map(a => typeof a === 'object' ? (a.fsPath || a.path || '') : a).join('/').replace(/\\/g, '/') }),
    file: (p) => ({ fsPath: p.replace(/\\/g, '/') })
  },
  window: {
    showInformationMessage: () => Promise.resolve(),
    showErrorMessage: () => Promise.resolve(),
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
  },
  languages: {
    onDidChangeDiagnostics: () => ({ dispose: () => {} }),
  },
  workspace: {
    getConfiguration: (sec) => ({
      get: (key, def) => {
        if (sec === "andromity" && key in mockConfigValues) {
          return mockConfigValues[key];
        }
        return def;
      }
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    registerTextDocumentContentProvider: () => ({ dispose: () => {} })
  },
  commands: {
    executeCommand: () => Promise.resolve()
  },
  env: { appRoot: "C:/fake/vscode", clipboard: { writeText: async () => {} } },
};

Module.prototype.require = function(reqPath) {
  if (reqPath === 'vscode') return mockVscode;
  return origRequire.apply(this, arguments);
};

// 1. Load ChatViewProvider
const chatMod = require("../dist-test/src/providers/ChatViewProvider.js");
const ChatViewProvider = chatMod.ChatViewProvider;

const provider = new ChatViewProvider(mockVscode.Uri.file("/test"), { subscriptions: [] });

// 2. Test isSoundEnabled method logic
console.log("\n1. Testing ChatViewProvider.isSoundEnabled logic:");

// A) Default: true
mockConfigValues.soundNotifications = true;
provider._configData = { sound_done: true, sound_attention: true };
assert.strictEqual(provider.isSoundEnabled("done"), true, "Should be enabled by default");
assert.strictEqual(provider.isSoundEnabled("attention"), true, "Should be enabled by default");
console.log("  ✓ Sound enabled when both VS Code setting and daemon config are true");

// B) VS Code setting = false
mockConfigValues.soundNotifications = false;
assert.strictEqual(provider.isSoundEnabled("done"), false, "Should be disabled when VS Code setting is false");
assert.strictEqual(provider.isSoundEnabled("attention"), false, "Should be disabled when VS Code setting is false");
console.log("  ✓ Sound disabled when VS Code setting andromity.soundNotifications is false");

// C) VS Code setting = true, but daemon sound_done = false
mockConfigValues.soundNotifications = true;
provider._configData = { sound_done: false, sound_attention: true };
assert.strictEqual(provider.isSoundEnabled("done"), false, "Should be disabled when daemon sound_done is false");
assert.strictEqual(provider.isSoundEnabled("attention"), true, "Should be enabled for attention when daemon sound_attention is true");
console.log("  ✓ Sound for done is disabled when daemon config sound_done is false");

// D) Daemon sound_attention = false
provider._configData = { sound_done: true, sound_attention: false };
assert.strictEqual(provider.isSoundEnabled("done"), true, "Should be enabled for done");
assert.strictEqual(provider.isSoundEnabled("attention"), false, "Should be disabled when daemon sound_attention is false");
console.log("  ✓ Sound for attention is disabled when daemon config sound_attention is false");

// 3. Test message dispatch to webview based on setting
console.log("\n2. Testing postToWebview dispatch on agent_done & tool_approval:");

let postedToWebview = [];
const mockWebviewView = {
  visible: true,
  webview: {
    postMessage: (msg) => postedToWebview.push(msg)
  }
};
provider._view = mockWebviewView;

// Attach mock RPC client
class MockRpc {
  constructor() { this.handlers = new Map(); }
  on(evt, fn) { if (!this.handlers.has(evt)) this.handlers.set(evt, []); this.handlers.get(evt).push(fn); }
  off() {}
  emit(evt, p) { for (const fn of (this.handlers.get(evt) || [])) fn(p); }
  call() { return Promise.resolve({}); }
}

const rpc = new MockRpc();
provider.setRpcClient(rpc);

// Case A: Sound enabled -> emit agent/done -> play_sound posted
mockConfigValues.soundNotifications = true;
provider._configData = { sound_done: true, sound_attention: true };
postedToWebview = [];
rpc.emit("agent/done", { session_id: "sess_1", turn_files: [] });

const doneSoundMsg = postedToWebview.find(m => m.type === "play_sound" && m.kind === "done");
assert.ok(doneSoundMsg, "Expected play_sound (done) when sound is enabled");
console.log("  ✓ play_sound (done) sent to webview when sound is enabled");

// Case B: Sound disabled via setting -> emit agent/done -> NO play_sound posted
mockConfigValues.soundNotifications = false;
postedToWebview = [];
rpc.emit("agent/done", { session_id: "sess_1", turn_files: [] });

const noSoundMsg = postedToWebview.find(m => m.type === "play_sound");
assert.strictEqual(noSoundMsg, undefined, "play_sound must NOT be sent when soundNotifications is false");
console.log("  ✓ play_sound (done) is NOT sent when soundNotifications is false");

// Case C: Sound attention when tool approval required
mockConfigValues.soundNotifications = true;
provider._configData = { sound_done: true, sound_attention: true };
postedToWebview = [];
rpc.emit("agent/toolApprovalRequired", { session_id: "sess_1", tool_id: "t1", tool_name: "write_file", args: {} });

const attnSoundMsg = postedToWebview.find(m => m.type === "play_sound" && m.kind === "attention");
assert.ok(attnSoundMsg, "Expected play_sound (attention) when tool approval required");
console.log("  ✓ play_sound (attention) sent when tool approval required");

// Case D: Attention sound disabled via daemon config
provider._configData = { sound_done: true, sound_attention: false };
postedToWebview = [];
rpc.emit("agent/toolApprovalRequired", { session_id: "sess_1", tool_id: "t2", tool_name: "write_file", args: {} });

const noAttnMsg = postedToWebview.find(m => m.type === "play_sound");
assert.strictEqual(noAttnMsg, undefined, "play_sound must NOT be sent when sound_attention is false in config");
console.log("  ✓ play_sound (attention) is NOT sent when sound_attention is false");

// 4. Test Webview Client Script execution of play_sound & synthetic chime fallback
console.log("\n3. Testing Webview Script playTone and Synthetic Chime execution:");

const htmlMod = require("../dist-test/src/providers/chatview/chatHtml.js");
const html = htmlMod.getChatViewHtml(
  { asWebviewUri: (u) => u.toString(), cspSource: "vscode-webview:" },
  mockVscode.Uri.file("/test"),
  {}
);

assert.ok(html.includes('id="audio-done"'), "HTML must include audio-done tag");
console.log("  ✓ HTML includes <audio id=\"audio-done\"> tag");

const { getChatClientScript } = require("../dist-test/src/providers/chatview/chatClientScript.js");
const clientScript = getChatClientScript("vscode-resource://icon", {});

let audioPlayedCount = 0;
let syntheticChimePlayedCount = 0;

const mockAudioEl = {
  currentTime: 0,
  play: () => {
    audioPlayedCount++;
    return Promise.resolve();
  }
};

function createMockElement(tag = 'div', id = '') {
  return {
    tagName: tag.toUpperCase(),
    id,
    dataset: {},
    style: {},
    value: '',
    checked: false,
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    appendChild: (c) => c,
    removeChild: (c) => c,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    setAttribute: () => {},
    getAttribute: () => null,
  };
}

const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  acquireVsCodeApi: () => ({ postMessage: () => {} }),
  document: {
    getElementById: (id) => {
      if (id === 'audio-done') return mockAudioEl;
      return createMockElement('div', id);
    },
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    body: createMockElement('body', 'body')
  },
  window: {
    addEventListener: () => {},
    AudioContext: class {
      constructor() { this.currentTime = 0; }
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime: () => {} },
          connect: () => {},
          start: () => { syntheticChimePlayedCount++; },
          stop: () => {}
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
          connect: () => {}
        };
      }
      close() { return Promise.resolve(); }
    }
  },
  Date: Date,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: () => {}
};

sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
sandbox.window.cancelAnimationFrame = sandbox.cancelAnimationFrame;

sandbox.window.document = sandbox.document;
let messageHandler = null;
sandbox.window.addEventListener = (evt, cb) => {
  if (evt === 'message') messageHandler = cb;
};

vm.createContext(sandbox);
vm.runInContext(clientScript, sandbox);

assert.ok(messageHandler, "Webview script must register a message listener");

// Test normal audio play
messageHandler({ data: { type: "play_sound", kind: "done" } });
assert.strictEqual(audioPlayedCount, 1, "audio.play() should be called");
console.log("  ✓ audio.play() called when play_sound message received in webview");

// Test debounce: immediate second call within 1200ms should be ignored
messageHandler({ data: { type: "play_sound", kind: "done" } });
assert.strictEqual(audioPlayedCount, 1, "Duplicate sound within 1200ms must be debounced");
console.log("  ✓ 1200ms debounce successfully prevented duplicate sound triggers");

// Test synthetic chime fallback when audio.play() rejects
mockAudioEl.play = () => Promise.reject(new Error("Autoplay not allowed"));
// Advance time past debounce limit
const origNow = Date.now;
Date.now = () => origNow() + 2000;

messageHandler({ data: { type: "play_sound", kind: "attention" } });

setTimeout(() => {
  assert.strictEqual(syntheticChimePlayedCount, 1, "Synthetic chime should activate when HTML5 audio rejects");
  console.log("  ✓ Web Audio API synthetic chime fallback triggered cleanly when HTML5 audio was blocked");

  console.log("\n================================================================================");
  console.log("SOUND NOTIFICATION TESTS PASSED WITH 100% SUCCESS!");
  console.log("================================================================================");
  process.exit(0);
}, 50);
