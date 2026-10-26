import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { getChatActivityScript } from "../src/providers/chatview/chatActivityRow.js";

function load() {
  const window: any = {};
  const document: any = {
    addEventListener() {},
    createElement: () => ({ className: "", textContent: "", title: "" }),
  };
  vm.runInNewContext(getChatActivityScript(), { window, document, escapeHtml: (s: string) => s, postToVsCode() {} });
  return window;
}

function card() {
  const inserted: any[] = [];
  const statusTag = { parentNode: { insertBefore: (el: any) => inserted.push(el) } };
  return {
    inserted,
    querySelector: (sel: string) => (sel === ".tool-tag" ? statusTag : sel === ".tool-external-tag" ? inserted[0] || null : null),
  };
}

it("labels web and MCP tool output and leaves local tools alone", () => {
  const w = load();
  const web = card();
  w.markExternalToolCard(web, '<external_content source="web_search">\nUntrusted content…');
  assert.equal(web.inserted.length, 1);
  assert.equal(web.inserted[0].className, "tool-external-tag");
  assert.equal(web.inserted[0].textContent, "From the web");
  w.markExternalToolCard(web, '<external_content source="web_search">');
  assert.equal(web.inserted.length, 1, "labelled once");

  const mcp = card();
  w.markExternalToolCard(mcp, '<external_content source="mcp:github">\n...');
  assert.equal(mcp.inserted[0].textContent, "External tool");
  assert.match(mcp.inserted[0].title, /MCP server github/);

  const local = card();
  w.markExternalToolCard(local, "file text that mentions <external_content source=\"x\"> later");
  w.markExternalToolCard(local, undefined);
  assert.equal(local.inserted.length, 0);
});
