import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import Module from "node:module";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (id, ...args) {
  return id === "vscode" ? {} : originalLoad.call(this, id, ...args);
};
const { BackgroundTaskPanel } = require("../src/panels/BackgroundTaskPanel.js");
loader._load = originalLoad;

function harness() {
  const html = BackgroundTaskPanel.prototype._getHtml.call({
    _processId: "task-1", _command: '<script>alert("test")</script>',
    _panel: { webview: { cspSource: "vscode-webview:" } },
  }) as string;
  const elements = new Map<string, any>();
  for (const id of html.matchAll(/id="([^"]+)"/g)) {
    const listeners = new Map<string, () => void>();
    elements.set(id[1], { textContent: '', disabled: false, scrollTop: 0, scrollHeight: 1000, clientHeight: 200,
      classList: { toggle() {} }, setAttribute() {}, remove() {},
      addEventListener: (event: string, fn: () => void) => listeners.set(event, fn), listeners });
  }
  const messages: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1], {
    acquireVsCodeApi: () => ({ postMessage: (msg: unknown) => messages.push(msg) }),
    document: { getElementById: (id: string) => elements.get(id) },
    window: { addEventListener: (_event: string, fn: typeof receive) => { receive = fn; } },
    setInterval: () => 1, clearInterval() {}, Date,
  });
  return { html, elements, messages, send: (data: unknown) => receive({ data }) };
}

it("shows clean output and daemon elapsed time while keeping command text inert", () => {
  const h = harness();
  assert.ok(h.html.includes('&lt;script&gt;'));
  h.send({ type: 'logs_update', output: "Process 'task-1' | running | 75s elapsed\nCommand: echo test\n--- last 1 lines ---\n<script>output</script>" });
  assert.equal(h.elements.get('terminal-output').textContent, '<script>output</script>');
  assert.equal(h.elements.get('timer-text').textContent, '1m 15s');
  assert.equal(h.elements.get('status-text').textContent, 'Running');
});

it("keeps cleared output hidden on repeated polls and copies only visible output", () => {
  const h = harness();
  const poll = (text: string) => h.send({ type: 'logs_update', output: text });
  poll('line one');
  h.elements.get('btn-clear').onclick();
  poll('line one');
  assert.equal(h.elements.get('terminal-output').textContent, '');
  poll('line one\nline two');
  assert.equal(h.elements.get('terminal-output').textContent, 'line one\nline two');
  h.elements.get('btn-copy').onclick();
  assert.equal(JSON.stringify(h.messages.at(-1)), JSON.stringify({ type: 'copy_text', text: 'line one\nline two' }));
});

it("preserves reading position and restores Stop after a failed request", () => {
  const h = harness();
  const terminal = h.elements.get('terminal-output');
  terminal.scrollTop = 120;
  terminal.listeners.get('scroll')();
  h.send({ type: 'logs_update', output: 'new output' });
  assert.equal(terminal.scrollTop, 120);
  h.elements.get('btn-stop').onclick();
  assert.equal(h.elements.get('btn-stop').disabled, true);
  h.send({ type: 'task_error', message: 'Could not stop this task. Try again.', stop_failed: true });
  assert.equal(h.elements.get('btn-stop').disabled, false);
});

it("detects an already exited process and retains its status through final output", () => {
  const h = harness();
  h.send({ type: 'logs_update', output: "Process 'task-1' | exited (code 2) | 4s elapsed\nCommand: test\n--- last 1 lines ---\nfailed" });
  assert.equal(h.elements.get('status-text').textContent, 'Failed');
  assert.equal(h.elements.get('exit-summary').textContent, 'Exit code 2');
  h.send({ type: 'process_exited', exit_code: 1, was_killed: true, duration: 4 });
  h.send({ type: 'logs_update', output: 'final output' });
  assert.equal(h.elements.get('status-text').textContent, 'Stopped');
  assert.equal(h.elements.get('terminal-output').textContent, 'final output');
});

it("renders a stable task heading and accessible output and Stop controls in the composer", () => {
  const script = getChatClientScript('icon.svg', { currentSessionId: 'test', currentModel: 'test',
    currentProvider: 'test', currentMode: 'safe', currentProfile: 'builder', currentReasoning: 'medium' });
  const nodes = new Map<string, any>();
  const document = { getElementById: (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', style: {},
      addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} } });
    return nodes.get(id);
  }, querySelector: () => ({ classList: { add() {}, remove() {} } }) };
  vm.runInNewContext(script.slice(script.indexOf("const bgProcessStrip ="), script.indexOf("const zeroWorkspaceLabel =")) + `
    activeBgProcesses.set('task-1', {command: '<test> command', startTime: Date.now()});
    updateBgProcessStripUI();
  `, { document, vscode: {}, setInterval: () => 1, clearInterval() {},
    escapeHtml: (text: string) => text.replace(/</g, '&lt;').replace(/>/g, '&gt;') });
  assert.equal(nodes.get('bg-strip-title').textContent, 'Background task');
  assert.equal(nodes.get('btn-bg-stop-all').style.display, 'none');
  assert.ok(nodes.get('bg-process-list').innerHTML.includes('aria-label="Open output for task task-1"'));
  assert.ok(nodes.get('bg-process-list').innerHTML.includes('aria-label="Stop task task-1"'));
  assert.ok(nodes.get('bg-process-list').innerHTML.includes('&lt;test&gt; command'));
});
