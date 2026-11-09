// Independent adversarial tests for the chat's per-turn "N File Changed" card: createFilesChangedCard(files, turnStats),
// statForPath, the agent_done handler and the history reload by turn_key. A card shows only its own turn's counts and
// never another turn's; hostile stats never become markup.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classList, loadChat, recording } from "./helpers/chatHarness.js";

function chat() {
  const made: any[] = [];
  const el = (tag = "div") => {
    const children: any[] = [];
    const adopt = (c: any) => { if (c && typeof c === "object") { try { c.parentNode = node; c.parentElement = node; } catch { /* stub */ } } return c; };
    const drop = (c: any) => { const at = children.indexOf(c); if (at >= 0) children.splice(at, 1); return c; };
    const base: any = {
      tagName: String(tag).toUpperCase(), children, childNodes: children, parentNode: null, parentElement: null,
      previousElementSibling: null, previousSibling: null, nextSibling: null, textContent: "", className: "",
      appendChild(c: any) { drop(c); children.push(adopt(c)); return c; }, append(...c: any[]) { c.forEach((x) => base.appendChild(x)); },
      insertBefore(c: any) { drop(c); children.unshift(adopt(c)); return c; }, prepend(...c: any[]) { c.forEach((x) => base.insertBefore(x)); },
      remove() { const parent = node.parentNode; if (parent && typeof parent.removeChild === "function") parent.removeChild(node); },
      removeChild(c: any) { return drop(c); }, replaceChildren(...c: any[]) { children.length = 0; c.forEach((x) => base.appendChild(x)); },
      contains: (c: any) => children.includes(c),
    };
    for (const name of ["firstChild", "firstElementChild"]) Object.defineProperty(base, name, { get: () => children[0] ?? null });
    for (const name of ["lastChild", "lastElementChild"]) Object.defineProperty(base, name, { get: () => children[children.length - 1] ?? null });
    Object.defineProperty(base, "childElementCount", { get: () => children.length });
    const attrs: Record<string, string> = {};
    Object.assign(base, {
      hidden: false, style: {}, value: "", classList: classList(), attrs, isConnected: true, innerHTML: "", nextElementSibling: null, dataset: {},
      addEventListener() {}, removeEventListener() {}, getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      setAttribute: (k: string, v: unknown) => { attrs[k] = String(v); }, removeAttribute: (k: string) => { delete attrs[k]; },
      hasAttribute: (k: string) => k in attrs, closest: () => null, querySelector: () => null, querySelectorAll: () => [], matches: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement(_w: string, c: any) { return base.appendChild(c); }, focus() {}, click() {}, scrollIntoView() {},
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    });
    const node = recording(base);
    made.push(node);
    return node;
  };
  const h = loadChat({ elements: { "chat-messages": el() } });
  h.sandbox.document.createElement = el;
  const cards = () => made.filter((n) => n.className === "files-changed-card");
  const rows = (card: any) => card.children.find((c: any) => c.className === "files-changed-list").children;
  const counts = (row: any) => {
    const html = String(row.innerHTML);
    const add = /files-stat-add">\+(\d+)/.exec(html);
    const del = /files-stat-del">-(\d+)/.exec(html);
    return { add: add ? Number(add[1]) : null, del: del ? Number(del[1]) : null, html };
  };
  return { h, cards, rows, counts };
}

const stat = (path: string, additions: number | null, deletions: number | null) => ({ path, status: "M", additions, deletions, binary: additions === null });

describe("statForPath", () => {
  it("does not take year.py's counts for leap_year.py", () => {
    const { h } = chat();
    const find = h.eval("statForPath");
    assert.equal(find([stat("year.py", 5, 0)], "D:/proj/leap_year.py"), null);
    assert.equal(find([stat("year.py", 5, 0)], "D:/proj/year.py")?.additions, 5);
  });

  it("matches the longest path: a/x.py's counts are not shown for b/a/x.py", () => {
    // git lists a/x.py before b/a/x.py; the absolute path of b/a/x.py ends with "/a/x.py" too.
    const { h } = chat();
    const find = h.eval("statForPath");
    const got = find([stat("a/x.py", 1, 0), stat("b/a/x.py", 9, 9)], "D:/proj/b/a/x.py");
    assert.equal(got?.path, "b/a/x.py", `b/a/x.py's row would show ${got?.path}'s counts`);
  });

  it("ignores junk entries", () => {
    const { h } = chat();
    const find = h.eval("statForPath");
    assert.equal(find([null, 3, { path: 7 }, { path: "" }], "D:/proj/a.py"), null);
    assert.equal(find("not a list", "D:/proj/a.py"), null);
  });
});

describe("the card", () => {
  it("shows the turn's own counts, and Diff without numbers for a file with none", () => {
    const { h, rows, counts } = chat();
    const card = h.eval("createFilesChangedCard")(new Set(["D:\\proj\\src\\a.py", "D:/proj/img.png", "D:/proj/outside.txt"]),
      [stat("src/a.py", 3, 1), stat("img.png", null, null)]);
    const [a, img, outside] = rows(card).map(counts);
    assert.deepEqual([a.add, a.del], [3, 1]);
    assert.deepEqual([img.add, img.del], [null, null]);
    assert.match(img.html, /Diff/);
    assert.deepEqual([outside.add, outside.del], [null, null]);
  });

  it("hostile names and counts never become markup", () => {
    const { h, rows } = chat();
    const name = "D:/proj/<img src=x onerror=alert(1)>.py";
    const card = h.eval("createFilesChangedCard")(new Set([name]), [
      { path: "<img src=x onerror=alert(1)>.py", additions: "<img src=y onerror=alert(2)>", deletions: 1, binary: false },
    ]);
    const html = String(rows(card)[0].innerHTML);
    assert.ok(!/<img/i.test(html), html);
  });

  it("a later turn never gets the counts of a turn whose agent_done came after its card was drawn", () => {
    // Stop is pressed; after 4 s the cancel fallback ends the turn in the view (endAssistantTurn). The engine then
    // finishes that turn and sends agent_done with its counts while no turn is shown. The next turn is cancelled.
    const { h, cards, rows, counts } = chat();
    h.eval("currentSessionId = 's';");
    h.post({ type: "agent_started", session_id: "s", input_id: "in-1", prompt: "one", turn_index: 0 });
    h.eval("turnEditedFiles.add('D:/proj/a.py'); endAssistantTurn();");
    h.post({ type: "agent_done", session_id: "s", outcome: "success", turn_files: ["a.py"], turn_file_stats: [stat("a.py", 70, 30)] });
    h.post({ type: "agent_started", session_id: "s", input_id: "in-2", prompt: "two", turn_index: 1 });
    h.eval("turnEditedFiles.add('D:/proj/a.py');");
    h.post({ type: "agent_cancelled", session_id: "s" });
    const last = cards().at(-1);
    assert.ok(last, "the second turn drew a card");
    const shown = counts(rows(last)[0]);
    assert.deepEqual([shown.add, shown.del], [null, null], `turn two's card shows turn one's counts: ${shown.html}`);
  });

  it("a steering message that splits a turn doesn't reuse a previous turn's counts", () => {
    const { h, cards, rows, counts } = chat();
    h.eval("currentSessionId = 's';");
    // agent_done for a turn whose card was never drawn (no turn shown) leaves counts behind...
    h.post({ type: "agent_done", session_id: "s", outcome: "success", turn_files: ["a.py"], turn_file_stats: [stat("a.py", 11, 0)] });
    h.post({ type: "agent_started", session_id: "s", input_id: "in-3", prompt: "three", turn_index: 2 });
    h.eval("turnEditedFiles.add('D:/proj/a.py');");
    h.post({ type: "input_applied", session_id: "s", input_id: "steer-1" });
    const last = cards().at(-1);
    assert.ok(last, "the split drew a card");
    const shown = counts(rows(last)[0]);
    assert.deepEqual([shown.add, shown.del], [null, null], shown.html);
  });

  it("agent_done for another chat doesn't touch this chat's next card", () => {
    const { h, cards, rows, counts } = chat();
    h.eval("currentSessionId = 's';");
    h.post({ type: "agent_started", session_id: "s", input_id: "in-1", prompt: "one", turn_index: 0 });
    h.post({ type: "agent_done", session_id: "other", outcome: "success", turn_files: ["a.py"], turn_file_stats: [stat("a.py", 5, 5)] });
    h.eval("turnEditedFiles.add('D:/proj/a.py');");
    h.post({ type: "agent_done", session_id: "s", outcome: "success", turn_files: [], turn_file_stats: [stat("a.py", 2, 0)] });
    const shown = counts(rows(cards().at(-1))[0]);
    assert.deepEqual([shown.add, shown.del], [2, null]);
  });
});

describe("history reload", () => {
  function turn(key: string | null, id: string, file: string) {
    return [
      { role: "user", content: `change ${file}`, ts: "2026-11-09T10:00:00Z", ...(key ? { turn_key: key } : {}) },
      { role: "assistant", content: "", ts: "2026-11-09T10:00:01Z", tool_calls: [{ id, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: file, content: "x" }) } }] },
      { role: "tool", tool_call_id: id, name: "write_file", content: "Wrote file", ts: "2026-11-09T10:00:02Z" },
      { role: "assistant", content: "Done.", ts: "2026-11-09T10:00:03Z" },
    ];
  }

  it("each card shows its own stored turn's counts; a turn without stored counts shows Diff only", () => {
    const { h, cards, rows, counts } = chat();
    const keyA = "a".repeat(32), keyB = "b".repeat(32);
    h.post({
      type: "session_loaded",
      session: {
        id: "s", status: "idle",
        messages: [...turn(keyA, "t1", "D:/proj/src/a.py"), ...turn(keyB, "t2", "D:/proj/src/a.py"), ...turn(null, "t3", "D:/proj/src/a.py")],
        receipt_turns: [
          { turn_index: 0, turn_key: keyA, file_stats: [stat("src/a.py", 4, 2)] },
          { turn_index: 1, turn_key: keyB },
        ],
      },
    });
    const drawn = cards().map((card) => counts(rows(card)[0]));
    assert.equal(drawn.length, 3, "one card per turn");
    assert.deepEqual(drawn.map((c) => [c.add, c.del]), [[4, 2], [null, null], [null, null]]);
  });
});

describe("paths as the model wrote them", () => {
  it("a tool path in another letter case than git's still finds the turn's counts (Windows and macOS file systems ignore case)", () => {
    const { h } = chat();
    const find = h.eval("statForPath");
    assert.equal(find([stat("src/App.tsx", 6, 2)], "D:/proj/src/app.tsx")?.additions, 6);
  });
});
