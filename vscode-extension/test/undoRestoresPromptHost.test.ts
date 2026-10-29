import { describe, it } from "node:test";
import assert from "node:assert/strict";

const Module = require("module");
const originalRequire = Module.prototype.require;
const shown: string[] = [];
let rollbackAnswer: string | undefined = "Yes, Rollback";
const workspace: any = {
  workspaceFolders: [{ uri: { fsPath: "D:/repo" } }], textDocuments: [],
  registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
};
Module.prototype.require = function (name: string) {
  if (name === "vscode") return {
    workspace,
    window: {
      showWarningMessage: async (message: string) => { shown.push(message); return rollbackAnswer; },
      showInformationMessage: (message: string) => { shown.push(message); },
      showErrorMessage: (message: string) => { shown.push(message); },
    },
    commands: { executeCommand: async () => {} },
    Uri: { file: (p: string) => ({ fsPath: p }), joinPath: (...parts: any[]) => ({ fsPath: parts.map(String).join("/") }) },
  };
  if (["/SettingsPanel.js", "/WaterfallPanel.js", "/PlanEditorPanel.js", "/BackgroundTaskPanel.js"].some(s => name.endsWith(s))) return {};
  return originalRequire.apply(this, arguments as any);
};
import { handlePromptImageMessage, isImageDataUri, undonePromptOf } from "../src/integrations/promptImages.js";
import { DiffManager } from "../src/integrations/DiffManager.js";
import { ChatViewProvider } from "../src/providers/ChatViewProvider.js";
import { SessionTabPanel } from "../src/panels/SessionTabPanel.js";

const NAME = "0123456789abcdef.jpg";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4A==";
const MAX_BASE64 = Math.ceil(8 * 1024 * 1024 / 3) * 4;

describe("the undone prompt from the engine's reply", () => {
  it("keeps the text and only image data, at most five images, in order", () => {
    const images = ["javascript:alert(1)", PNG, "data:image/svg+xml;base64,PHN2Zz4=", "https://example.com/a.png",
      "data:text/html;base64,PGI+", JPEG, 7, null, "data:image/png,raw", PNG, JPEG, PNG, JPEG];
    assert.deepEqual(undonePromptOf({ success: true, undone_prompt: { text: "fix it", images } } as any),
      { text: "fix it", images: [PNG, JPEG, PNG, JPEG, PNG] });
  });

  it("is nothing when there is neither text nor an image", () => {
    for (const undone_prompt of [undefined, null, "fix it", 5, { text: "", images: [] }, { text: "  \n", images: ["javascript:1"] },
      { images: "x" }, { text: ["a"], images: {} }]) {
      assert.equal(undonePromptOf({ success: true, undone_prompt } as any), undefined, JSON.stringify(undone_prompt));
    }
    assert.equal(undonePromptOf(undefined), undefined);
    assert.equal(undonePromptOf(null), undefined);
  });

  it("keeps an image-only prompt with empty text", () => {
    assert.deepEqual(undonePromptOf({ success: true, undone_prompt: { text: 3, images: [PNG] } } as any), { text: "", images: [PNG] });
  });

  it("accepts each type's 8 MB image as the engine encodes it and nothing longer", () => {
    for (const mime of ["png", "jpeg", "gif", "webp"]) {
      const exact = `data:image/${mime};base64,` + "A".repeat(MAX_BASE64);
      assert.equal(isImageDataUri(exact), true, mime);
      assert.equal(isImageDataUri(`data:image/${mime};base64,` + "A".repeat(MAX_BASE64 + 4)), false, mime);
    }
  });

  it("refuses look-alike image data", () => {
    for (const value of ["DATA:IMAGE/PNG;BASE64,AAAA", " data:image/png;base64,AAAA", "data:image/png;charset=x,AAAA",
      "data:image/x-png;base64,AAAA", "data:image/pngx;base64,AAAA", new String(PNG), { toString: () => PNG }]) {
      assert.equal(isImageDataUri(value), false, String(value));
    }
  });
});

describe("the viewer's request for a full-size image", () => {
  function rpc(reply: (params: any) => any) {
    const calls: any[] = [];
    return { calls, client: { call: async (method: string, params: any) => { calls.push({ method, params }); return reply(params); } } as any };
  }

  it("asks the engine for the session shown and passes back only image data", async () => {
    for (const [uri, expected] of [[PNG, PNG], ["javascript:alert(1)", null], ["data:image/svg+xml;base64,PHN2Zz4=", null], [undefined, null]]) {
      const { calls, client } = rpc(() => ({ success: true, uri }));
      const posts: any[] = [];
      assert.equal(await handlePromptImageMessage(client, { type: "load_prompt_image", name: NAME }, "sess-1", e => posts.push(e)), true);
      assert.deepEqual(calls, [{ method: "session.image", params: { session_id: "sess-1", name: NAME, project_path: "D:/repo" } }]);
      assert.deepEqual(posts, [{ type: "prompt_image", session_id: "sess-1", name: NAME, uri: expected }]);
    }
  });

  it("answers with no image when the engine refuses or fails", async () => {
    for (const reply of [() => ({ success: false, uri: PNG }), () => null, () => { throw new Error("C:\\Users\\me\\secret"); }]) {
      const { client } = rpc(reply);
      const posts: any[] = [];
      await handlePromptImageMessage(client, { type: "load_prompt_image", name: NAME }, "sess-1", e => posts.push(e));
      assert.deepEqual(posts, [{ type: "prompt_image", session_id: "sess-1", name: NAME, uri: null }]);
    }
  });

  it("never sends the engine a name that is not of the image store's form", async () => {
    const { calls, client } = rpc(() => ({ success: true, uri: PNG }));
    const posts: any[] = [];
    for (const name of ["../" + NAME, "..\\" + NAME, "C:\\Windows\\win.ini", "\\\\server\\share\\" + NAME, NAME.toUpperCase(),
      NAME + "\n", NAME + ".", " " + NAME, NAME + "/..", "images/" + NAME, "0123456789abcdef.png", undefined, null, 7,
      [NAME], { toString: () => NAME }]) {
      assert.equal(await handlePromptImageMessage(client, { type: "load_prompt_image", name }, "sess-1", e => posts.push(e)), true);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(posts, []);
  });

  it("asks nothing without a session and leaves other messages alone", async () => {
    const { calls, client } = rpc(() => ({ success: true, uri: PNG }));
    const posts: any[] = [];
    await handlePromptImageMessage(client, { type: "load_prompt_image", name: NAME }, "", (e: any) => posts.push(e));
    assert.deepEqual(calls, []);
    assert.deepEqual(posts, [{ type: "prompt_image", session_id: "", name: NAME, uri: null }]);
    assert.equal(await handlePromptImageMessage(client, { type: "undo_turn", name: NAME }, "sess-1", (e: any) => posts.push(e)), false);
    assert.deepEqual(calls, []);
  });
});

describe("undo hands the undone prompt to the chat", () => {
  const reply = { success: true, popped_messages: 2, turns_undone: 1, target_turn_index: 0, git_status: "Restored snapshot abc",
    undone_prompt: { text: "fix it", images: [PNG, "javascript:alert(1)"] } };

  it("DiffManager returns the engine's reply on success and nothing otherwise", async () => {
    const manager = (result: any) => new DiffManager({ call: async () => { if (result instanceof Error) throw result; return result; } } as any,
      { subscriptions: [] } as any);
    assert.deepEqual(await manager(reply).undoLastTurn("s", 0, 1), reply);
    assert.equal(await manager({ success: false, error: "no" }).undoLastTurn("s"), undefined);
    assert.equal(await manager(new Error("down")).undoLastTurn("s"), undefined);
    rollbackAnswer = undefined;
    try {
      assert.equal(await manager(reply).undoLastTurn("s"), undefined, "cancelled");
    } finally {
      rollbackAnswer = "Yes, Rollback";
    }
    workspace.textDocuments = [{ isDirty: true }];
    try {
      assert.equal(await manager(reply).undoLastTurn("s"), undefined, "unsaved editors");
    } finally {
      workspace.textDocuments = [];
    }
  });

  function provider(undone: any) {
    const order: string[] = [];
    const posts: any[] = [];
    const value: any = Object.create(ChatViewProvider.prototype);
    Object.assign(value, {
      _currentSessionId: "s1",
      _diffManager: { undoLastTurn: async () => { order.push("undo"); return undone; } },
      _loadSession: async () => { order.push("load"); },
      _postToWebview: (event: any) => { order.push("post:" + event.type); posts.push(event); },
      _rpcClient: { call: async (method: string, params: any) => { order.push(method + ":" + params.session_id); return { success: true, uri: PNG }; } },
    });
    return { value, order, posts };
  }

  it("Undo to here in the sidebar posts the prompt after the chat reloads", async () => {
    const { value, order, posts } = provider(reply);
    await value._handleWebviewMessage({ type: "undo_turn", turnIndex: 0, totalTurns: 1 });
    assert.deepEqual(order.filter(o => !o.startsWith("telemetry")).slice(0, 3), ["undo", "load", "post:turn_undone"]);
    assert.deepEqual(posts.at(-1).undonePrompt, { text: "fix it", images: [PNG] });
  });

  it("posts no undo note when the undo did not happen", async () => {
    const { value, posts } = provider(undefined);
    await value._handleWebviewMessage({ type: "undo_turn", turnIndex: 0, totalTurns: 1 });
    assert.equal(posts.filter(p => p.type === "turn_undone").length, 0);
  });

  it("the command palette's undo posts the prompt after the chat reloads", async () => {
    const { value, order, posts } = provider(reply);
    await value.requestUndoTurn();
    assert.deepEqual(order.slice(0, 3), ["undo", "load", "post:turn_undone"]);
    assert.deepEqual(posts.at(-1), { type: "turn_undone", turnsUndone: 1, undonePrompt: { text: "fix it", images: [PNG] } });
  });

  it("the command palette posts nothing when there was nothing to undo", async () => {
    const { value, posts } = provider({ success: true, turns_undone: 0, popped_messages: 0, git_status: "No turns" });
    await value.requestUndoTurn();
    assert.equal(posts.filter(p => p.type === "turn_undone").length, 0);
  });

  it("the sidebar asks for images of the session it shows", async () => {
    const { value, order, posts } = provider(reply);
    await value._handleWebviewMessage({ type: "load_prompt_image", name: NAME });
    assert.ok(order.includes("session.image:s1"), order.join());
    assert.deepEqual(posts.at(-1), { type: "prompt_image", session_id: "s1", name: NAME, uri: PNG });
  });

  function tab(undone: any) {
    const order: string[] = [];
    const posts: any[] = [];
    const value: any = Object.create(SessionTabPanel.prototype);
    Object.assign(value, {
      _sessionId: "tab-session",
      _viewProvider: { undoSession: async (id: string) => { order.push("undo:" + id); return undone; } },
      _loadSession: async () => { order.push("load"); },
      _postMessage: (event: any) => { order.push("post:" + event.type); posts.push(event); },
      _rpcClient: { call: async (method: string, params: any) => { order.push(method + ":" + params.session_id); return { success: true, uri: JPEG }; } },
    });
    return { value, order, posts };
  }

  it("a pop-out tab undoes its own session and posts the prompt after it reloads", async () => {
    const { value, order, posts } = tab(reply);
    await value._handleMessage({ type: "undo_turn", turnIndex: 0, turnsToUndo: 1 });
    assert.deepEqual(order.filter(o => !o.startsWith("telemetry")).slice(0, 3), ["undo:tab-session", "load", "post:turn_undone"]);
    assert.deepEqual(posts.at(-1).undonePrompt, { text: "fix it", images: [PNG] });
  });

  it("a pop-out tab asks for images of its own session, not the sidebar's", async () => {
    const { value, order, posts } = tab(reply);
    await value._handleMessage({ type: "load_prompt_image", name: NAME });
    assert.ok(order.includes("session.image:tab-session"), order.join());
    assert.deepEqual(posts.at(-1), { type: "prompt_image", session_id: "tab-session", name: NAME, uri: JPEG });
  });
});
