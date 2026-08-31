import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RpcClient } from "../src/server/RpcClient.js";

describe("RpcClient Unit Tests", () => {
  it("should send formatted JSON-RPC request and resolve on success response", async () => {
    let sentMessage = "";
    const client = new RpcClient((msg) => {
      sentMessage = msg;
    });

    const promise = client.call("config.get", { key: "model" });

    const parsed = JSON.parse(sentMessage.trim());
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.method, "config.get");
    assert.deepEqual(parsed.params, { key: "model" });
    assert.ok(parsed.id);

    // Simulate backend response
    client.handleIncomingMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        result: { model: "anthropic/claude-3.7-sonnet" },
      }) + "\n"
    );

    const result = await promise;
    assert.deepEqual(result, { model: "anthropic/claude-3.7-sonnet" });
  });

  it("should reject promise when RPC error is returned", async () => {
    let sentMessage = "";
    const client = new RpcClient((msg) => {
      sentMessage = msg;
    });

    const promise = client.call("invalid.method", {});
    const parsed = JSON.parse(sentMessage.trim());

    client.handleIncomingMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32601, message: "Method not found" },
      }) + "\n"
    );

    await assert.rejects(async () => {
      await promise;
    }, /Method not found/);
  });

  it("should emit notifications correctly", async () => {
    const client = new RpcClient(() => {});
    let receivedDelta = "";

    client.on("agent/textDelta", (params) => {
      receivedDelta += params.text;
    });

    client.handleIncomingMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent/textDelta",
        params: { text: "Hello, " },
      }) + "\n"
    );

    client.handleIncomingMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent/textDelta",
        params: { text: "World!" },
      }) + "\n"
    );

    assert.equal(receivedDelta, "Hello, World!");
  });

  it("should not throw when the daemon sends a reserved 'error' notification", async () => {
    const client = new RpcClient(() => {});
    const starEvents: string[] = [];
    client.on("*", (method) => starEvents.push(method));

    // Before the fix this crashed the extension host with
    // "Unhandled 'error' event" since no 'error' listener exists.
    client.handleIncomingMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "error",
        params: { message: "boom" },
      }) + "\n"
    );

    client.handleIncomingMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "newListener",
        params: {},
      }) + "\n"
    );

    client.handleIncomingMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "removeListener",
        params: {},
      }) + "\n"
    );

    // Reserved methods are suppressed from direct emission...
    client.handleIncomingMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent/done",
        params: {},
      }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(starEvents.includes("error"));
    assert.ok(starEvents.includes("newListener"));
    assert.ok(starEvents.includes("removeListener"));
    assert.ok(starEvents.includes("agent/done"));
  });

  it("should still deliver normal notifications after reserved ones were received", async () => {
    const client = new RpcClient(() => {});
    let done = false;
    client.on("agent/done", () => {
      done = true;
    });

    client.handleIncomingMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "error", params: {} }) + "\n"
    );
    client.handleIncomingMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "agent/done", params: {} }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(done);
  });

  it("should salvage notifications from lines corrupted by non-JSON daemon output", async () => {
    const logs: string[] = [];
    const client = new RpcClient(() => {}, { log: (m) => logs.push(m) });
    let done = false;
    client.on("agent/done", () => {
      done = true;
    });

    // Simulate a frozen-binary library printing to stdout without a newline,
    // so the garbage lands on the SAME line as the next JSON-RPC notification.
    client.handleIncomingMessage(
      "some library warning without newline" +
        JSON.stringify({ jsonrpc: "2.0", method: "agent/done", params: {} }) +
        "\n"
    );
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(done, "agent/done should have been salvaged and delivered");
    assert.ok(
      logs.some((l) => l.includes("Salvaged JSON")),
      "salvage should be logged to the provided sink"
    );
  });

  it("should log (not throw) on fully garbage lines", () => {
    const logs: string[] = [];
    const client = new RpcClient(() => {}, { log: (m) => logs.push(m) });

    client.handleIncomingMessage("total garbage\r\n\x00\x01\x02\n");

    assert.ok(
      logs.some((l) => l.includes("Failed to parse message")),
      "garbage should be logged to the provided sink"
    );
  });

  it("should assemble fragmented large JSON messages correctly across multiple chunks", async () => {
    let sentMessage = "";
    const client = new RpcClient((msg) => {
      sentMessage = msg;
    });

    const promise = client.call("config.list_models", {});
    const parsed = JSON.parse(sentMessage.trim());

    // Generate large JSON response (100KB)
    const largeModels = Array.from({ length: 300 }, (_, i) => ({
      id: `provider/model-${i}`,
      name: `Model ${i}`,
      desc: "Large model description to test multi-chunk stream buffering",
    }));

    const fullResponse = JSON.stringify({
      jsonrpc: "2.0",
      id: parsed.id,
      result: largeModels,
    }) + "\n";

    // Split into 3 small chunks
    const chunk1 = fullResponse.slice(0, 5000);
    const chunk2 = fullResponse.slice(5000, 15000);
    const chunk3 = fullResponse.slice(15000);

    client.handleIncomingMessage(chunk1);
    client.handleIncomingMessage(chunk2);
    client.handleIncomingMessage(chunk3);

    const result = await promise;
    assert.equal(result.length, 300);
    assert.equal(result[0].id, "provider/model-0");
  });
});
