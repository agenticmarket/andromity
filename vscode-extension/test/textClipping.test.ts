import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Single-line text keeps its descenders", () => {
  it("no clipped one-line style in the chat view uses a line height that cuts off g, j and y", () => {
    const dir = join(__dirname, "..", "..", "src", "providers", "chatview");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter(f => /Styles\.ts$|turnRail\.ts$/.test(f))) {
      const css = readFileSync(join(dir, file), "utf8");
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const clips = /overflow:\s*hidden/.test(body) && /(white-space:\s*nowrap|text-overflow)/.test(body);
        const tight = /line-height:\s*(0?\.\d+|1(\.[01]\d*)?)\s*;/.test(body);
        if (clips && tight) offenders.push(`${file}: ${selector.trim().split("\n").pop()!.trim()}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
