import { strict as assert } from "node:assert";
import { test } from "node:test";
import vm from "node:vm";
import { getStreamingRenderScript } from "../src/providers/chatview/streamingRender.js";

function makeElement(): any {
  const el: any = {
    children: [] as any[],
    parentNode: null,
    isConnected: true,
    className: "",
    _html: "",
    appendChild(child: any) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    insertAdjacentHTML(_position: string, html: string) {
      el._html += html;
    },
  };
  const detachChildren = () => {
    for (const child of el.children) child.parentNode = null;
    el.children = [];
  };
  Object.defineProperty(el, "innerHTML", {
    get: () => el._html,
    set: (value: string) => { detachChildren(); el._html = value; },
  });
  Object.defineProperty(el, "textContent", {
    get: () => el.children.map((c: any) => c.data ?? c.textContent ?? "").join("") || el._html,
    set: (value: string) => { detachChildren(); el._html = value; },
  });
  return el;
}

function sandbox() {
  const frames: Array<() => void> = [];
  const parsed: string[] = [];
  const elementsById = new Map<string, any>();
  const context: any = {
    document: {
      createElement: () => makeElement(),
      createTextNode: (data: string) => ({ data, parentNode: null, appendData(more: string) { this.data += more; } }),
      getElementById: (id: string) => elementsById.get(id) ?? null,
    },
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    cancelAnimationFrame: () => { frames.length = 0; },
    renderMarkdown: (md: string) => { parsed.push(md); return "<md>" + md + "</md>"; },
    scrollToBottomIfNeeded: () => {},
    updateToolTarget: () => {},
    sessionLiveBuffer: new Map(),
    console,
  };
  vm.createContext(context);
  vm.runInContext(getStreamingRenderScript(), context);
  const runFrame = () => { const pending = frames.splice(0); for (const cb of pending) cb(); };
  return { context, frames, parsed, runFrame, elementsById };
}

test("many deltas within one frame cause a single render", () => {
  const { context, frames, parsed, runFrame } = sandbox();
  const el = makeElement();
  el._blockText = "";
  for (const token of ["Hel", "lo ", "wor", "ld"]) {
    el._blockText += token;
    context.queueTextRender(el);
  }
  assert.equal(frames.length, 1);
  runFrame();
  assert.deepEqual(parsed, ["Hello world"]);
});

test("completed blocks are parsed once; only the unfinished tail is re-parsed", () => {
  const { context, parsed, runFrame } = sandbox();
  const el = makeElement();
  el._blockText = "First paragraph.\n\nSecond";
  context.queueTextRender(el);
  runFrame();
  el._blockText += " paragraph continues";
  context.queueTextRender(el);
  runFrame();
  assert.equal(parsed.filter((md) => md.includes("First")).length, 1);
  assert.equal(parsed.at(-1), "Second paragraph continues");
});

test("blank lines inside a code fence never split the fence", () => {
  const { context, parsed, runFrame } = sandbox();
  const el = makeElement();
  const fence = "```";
  el._blockText = "Intro\n\n" + fence + "py\na = 1\n\nb = 2\n";
  context.queueTextRender(el);
  runFrame();
  assert.ok(parsed.includes("Intro\n\n"));
  assert.equal(parsed.at(-1), fence + "py\na = 1\n\nb = 2\n");
});

test("settling replaces incremental output with one full render", () => {
  const { context, parsed, runFrame } = sandbox();
  const el = makeElement();
  el._blockText = "A\n\nB";
  context.queueTextRender(el);
  runFrame();
  el._blockText += "C";
  context.queueTextRender(el);
  context.settleStreamingRender();
  assert.equal(el.innerHTML, "<md>A\n\nBC</md>");
  assert.equal(parsed.at(-1), "A\n\nBC");
  assert.equal(el._streamStable, null);
});

test("stream text appends through one text node", () => {
  const { context } = sandbox();
  const el = makeElement();
  context.appendStreamText(el, "abc");
  context.appendStreamText(el, "def");
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0].data, "abcdef");
});

test("stream tasks are deduplicated per key within a frame", () => {
  const { context, runFrame } = sandbox();
  const calls: string[] = [];
  context.queueStreamTask("k", () => calls.push("first"));
  context.queueStreamTask("k", () => calls.push("second"));
  context.queueStreamTask("other", () => calls.push("other"));
  runFrame();
  assert.deepEqual(calls, ["second", "other"]);
});

test("background session deltas are merged instead of stored per token", () => {
  const { context } = sandbox();
  for (const text of ["a", "b", "c"]) context.bufferLiveEvent("s", { t: "text_delta", text });
  context.bufferLiveEvent("s", { t: "tool_start", tool_id: "1", tool_name: "x" });
  for (const chunk of ["{", "}"]) context.bufferLiveEvent("s", { t: "tool_delta", tool_id: "1", chunk });
  context.bufferLiveEvent("s", { t: "text_delta", text: "d" });
  const buf = context.sessionLiveBuffer.get("s");
  assert.deepEqual(JSON.parse(JSON.stringify(buf)), [
    { t: "text_delta", text: "abc" },
    { t: "tool_start", tool_id: "1", tool_name: "x" },
    { t: "tool_delta", tool_id: "1", chunk: "{}" },
    { t: "text_delta", text: "d" },
  ]);
});
