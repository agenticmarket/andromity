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

function harness(extraDocument: Record<string, unknown> = {}) {
  const html = BackgroundTaskPanel.prototype._getHtml.call({
    _processId: "task-1", _command: '<script>alert("test")</script>',
    _panel: { webview: { cspSource: "vscode-webview:" } },
  }) as string;
  const elements = new Map<string, any>();
  for (const id of html.matchAll(/id="([^"]+)"/g)) {
    const listeners = new Map<string, () => void>();
    const el: any = { textContent: '', disabled: false, scrollTop: 0, scrollHeight: 1000, clientHeight: 200,
      classList: { toggle() {} }, setAttribute() {}, remove() {},
      addEventListener: (event: string, fn: () => void) => listeners.set(event, fn), listeners };
    el.replaceChildren = (...nodes: Array<{ textContent: string }>) => {
      el.children = nodes;
      el.textContent = nodes.map((node) => node.textContent).join('');
    };
    elements.set(id[1], el);
  }
  const messages: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1], {
    acquireVsCodeApi: () => ({ postMessage: (msg: unknown) => messages.push(msg) }),
    document: { getElementById: (id: string) => elements.get(id), ...extraDocument },
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

function linkContext() {
  const created: any[] = [];
  return {
    created,
    document: {
      createTextNode: (text: string) => ({ textContent: text }),
      createElement: () => {
        const attrs: Record<string, string> = {};
        const el = { textContent: '', className: '', dataset: {} as Record<string, string>, title: '', tabIndex: -1, attrs,
          setAttribute: (k: string, v: string) => { attrs[k] = v; } };
        created.push(el);
        return el;
      },
    },
  };
}

it("turns URLs in the output into links and asks the extension to open them", () => {
  const ctx = linkContext();
  const h = harness(ctx.document);
  const terminal = h.elements.get('terminal-output');

  const output = "  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m\nDocs (see https://example.com/a_(b)).\nftp://nope";
  h.send({ type: 'logs_update', output });
  assert.equal(terminal.textContent, output, "links keep the visible text unchanged");
  assert.deepEqual(ctx.created.map((el) => el.dataset.url), ["http://localhost:5173/", "https://example.com/a_(b)"]);
  assert.equal(ctx.created[0].className, 'out-link');

  h.send({ type: 'logs_update', output });
  assert.equal(ctx.created.length, 2, "an unchanged poll keeps the existing links");

  const click = (target: unknown) => {
    let prevented = false;
    terminal.listeners.get('click')({ target: { closest: () => target }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(click(ctx.created[0]), true);
  assert.equal(JSON.stringify(h.messages.at(-1)), JSON.stringify({ type: 'open_url', url: "http://localhost:5173/" }));
  const before = h.messages.length;
  assert.equal(click(null), false, "clicks outside a link do nothing");
  assert.equal(h.messages.length, before);
});

it("shows running as shimmering text and drops the shimmer once the task ends", () => {
  const h = harness();
  const toggles: Array<[string, boolean]> = [];
  h.elements.get('status-text').classList = { toggle: (name: string, on: boolean) => toggles.push([name, on]) };
  assert.ok(h.html.includes('<span id="status-text" class="status-shimmer">'));
  assert.ok(h.html.includes('.status-shimmer {'), "the panel carries the shared shimmer styles");
  h.send({ type: 'logs_update', output: "Process 'task-1' | running | 3s elapsed\nCommand: x\n--- last 1 lines ---\nok" });
  h.send({ type: 'process_exited', exit_code: 0 });
  assert.deepEqual(toggles, [['status-shimmer', true], ['status-shimmer', false]]);
  assert.equal(h.elements.get('status-text').textContent, 'Completed');
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
