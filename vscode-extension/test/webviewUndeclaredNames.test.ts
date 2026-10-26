import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as ts from "typescript";

// @ts-ignore
const Module = require("module");
const origRequire = Module.prototype.require;
const uri = (p: string) => ({ fsPath: p, path: p, toString: () => p });
const anything = (): any => new Proxy(function () {}, {
  get: (_t, key) => key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : anything(),
  apply: () => anything(),
  construct: () => anything(),
});
const mockVscode: any = new Proxy({
  Uri: { joinPath: (base: any, ...parts: string[]) => uri([base.fsPath, ...parts].join("/")), file: uri, parse: uri },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), workspaceFolders: [] },
  window: { activeColorTheme: { kind: 2 } },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  EventEmitter: class { event() {} fire() {} },
}, { get: (target: any, key) => key in target ? target[key] : anything() });
Module.prototype.require = function (reqPath: string) {
  if (reqPath === "vscode") return mockVscode;
  return origRequire.apply(this, arguments as any);
};

import { getChatViewHtml } from "../src/providers/chatview/chatHtml.js";
import { getWaterfallScript } from "../src/providers/waterfall/waterfallScript.js";
import { getFingerprintScript } from "../src/providers/fingerprint/fingerprintScript.js";
import { getReviewClientScript } from "../src/providers/changesReview/reviewClientScript.js";
import { SettingsPanel } from "../src/panels/SettingsPanel.js";
import { PlanEditorPanel } from "../src/panels/PlanEditorPanel.js";
import { PlanViewProvider } from "../src/providers/PlanViewProvider.js";

const webview: any = { cspSource: "vscode-webview:", asWebviewUri: (u: any) => uri("media/" + path.basename(u.fsPath)) };
const extensionUri: any = uri("/ext");

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(s => s.trim());
}

function bareScript(source: string): string {
  return source.replace(/^\s*<script[^>]*>/i, "").replace(/<\/script>\s*$/i, "");
}

function privateHtml(Ctor: any, method: string, args: unknown[]): string {
  const self = Object.assign(Object.create(Ctor.prototype), { _panel: { webview }, _view: { webview }, _extensionUri: extensionUri });
  return Ctor.prototype[method].apply(self, args);
}

/** Names the page reads but never declares: each one throws a ReferenceError at runtime. */
function undeclaredNames(scripts: string[]): string[] {
  const files = new Map(scripts.map((text, i) => [`/page/s${i}.js`, text]));
  const options: ts.CompilerOptions = {
    allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], skipLibCheck: true, types: [],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = f => files.has(f) || ts.sys.fileExists(f);
  host.readFile = f => files.get(f) ?? readFile(f);
  host.getSourceFile = (f, lang, onError, create) => files.has(f)
    ? ts.createSourceFile(f, files.get(f)!, lang, true, ts.ScriptKind.JS)
    : getSourceFile(f, lang, onError, create);
  const program = ts.createProgram([...files.keys()], options, host);
  const windowGlobals = new Set(scripts.flatMap(s => [...s.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1])));
  const known = new Set(["acquireVsCodeApi", "marked", ...windowGlobals]);
  const missing = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (!files.has(sf.fileName)) continue;
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (d.code !== 2304 && d.code !== 2552) continue;
      const name = /Cannot find name '([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, "\n"))?.[1];
      if (name && !known.has(name)) {
        const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
        missing.add(`${name} (${path.basename(sf.fileName)}:${line + 1})`);
      }
    }
  }
  return [...missing].sort();
}

describe("Webview scripts reference only declared names", () => {
  const pages: Record<string, () => string[]> = {
    chat: () => inlineScripts(getChatViewHtml(webview, extensionUri, {
      currentSessionId: "s1", currentModel: "auto", currentProvider: "andromity",
      currentMode: "SAFE", currentProfile: "builder", currentReasoning: "auto",
    })),
    waterfall: () => [bareScript(getWaterfallScript("s1"))],
    fingerprint: () => [bareScript(getFingerprintScript("s1"))],
    changesReview: () => [bareScript(getReviewClientScript())],
    settings: () => inlineScripts(privateHtml(SettingsPanel, "_getHtmlForWebview", [])),
    planEditor: () => inlineScripts(privateHtml(PlanEditorPanel, "_getHtmlForWebview", [webview])),
    planView: () => inlineScripts(privateHtml(PlanViewProvider, "_getHtmlForWebview", [webview])),
  };

  for (const [name, scripts] of Object.entries(pages)) {
    it(`${name} page has no undeclared identifiers`, () => {
      const found = scripts();
      assert.ok(found.length > 0, `${name} produced no script`);
      assert.deepEqual(undeclaredNames(found), []);
    });
  }

  it("detects a name that is read but never declared", () => {
    assert.deepEqual(undeclaredNames(["const a = 1; if (missingThing) { a; }"]), ["missingThing (s0.js:1)"]);
    assert.deepEqual(undeclaredNames(["window.helper = () => 1; helper();"]), []);
  });
});
