import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelInfo } from "../src/server/types.js";

describe("Model Catalog & Tagging Unit Tests", () => {
  function categorizeModel(model: ModelInfo): string[] {
    const tags = new Set<string>(model.tags || []);
    if (model.is_free || model.id.includes(":free")) {
      tags.add("free");
    }
    const idLower = model.id.toLowerCase();
    if (["code", "coder", "starcoder", "codestral"].some((k) => idLower.includes(k))) {
      tags.add("coding");
    }
    if (["r1", "reason", "o1", "o3", "o4", "thinking", "qwq"].some((k) => idLower.includes(k))) {
      tags.add("reasoning");
    }
    if (["vision", "vl", "4o", "gemini-2", "claude-3", "pixtral"].some((k) => idLower.includes(k))) {
      tags.add("vision");
    }
    if (["claude-3.7", "claude-3-7", "gpt-4o", "gemini-2.0", "deepseek-r1"].some((k) => idLower.includes(k))) {
      tags.add("flagship");
    }
    return Array.from(tags);
  }

  function formatContextLimit(limit?: number): string {
    if (!limit) return "";
    if (limit >= 1000000) return (limit / 1000000).toFixed(1).replace(/\.0$/, "") + "M ctx";
    if (limit >= 1000) return Math.round(limit / 1000) + "K ctx";
    return `${limit} ctx`;
  }

  it("should categorize free tier models correctly", () => {
    const model: ModelInfo = {
      id: "deepseek/deepseek-r1:free",
      name: "DeepSeek R1 (free)",
      provider: "openrouter",
      is_free: true,
      context_limit: 131072,
    };
    const tags = categorizeModel(model);
    assert.ok(tags.includes("free"));
    assert.ok(tags.includes("reasoning"));
  });

  it("should categorize coding specialist models correctly", () => {
    const model: ModelInfo = {
      id: "qwen/qwen-2.5-coder-32b-instruct",
      name: "Qwen 2.5 Coder 32B",
      provider: "openrouter",
      context_limit: 131072,
    };
    const tags = categorizeModel(model);
    assert.ok(tags.includes("coding"));
  });

  it("should categorize reasoning and flagship models correctly", () => {
    const model: ModelInfo = {
      id: "anthropic/claude-3.7-sonnet",
      name: "Claude 3.7 Sonnet",
      provider: "openrouter",
      context_limit: 200000,
    };
    const tags = categorizeModel(model);
    assert.ok(tags.includes("flagship"));
    assert.ok(tags.includes("vision"));
  });

  it("should format context limits into human-readable shorthand", () => {
    assert.equal(formatContextLimit(1048576), "1M ctx");
    assert.equal(formatContextLimit(2000000), "2M ctx");
    assert.equal(formatContextLimit(131072), "131K ctx");
    assert.equal(formatContextLimit(200000), "200K ctx");
    assert.equal(formatContextLimit(32768), "33K ctx");
  });
});
