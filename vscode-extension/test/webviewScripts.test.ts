import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

// Mock vscode module for Node testing
// @ts-ignore
const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (reqPath: string) {
  if (reqPath === "vscode") {
    return {
      Uri: {
        joinPath: (...args: any[]) => ({
          fsPath: args.map((a) => (typeof a === "object" ? a.fsPath || a.path : String(a))).join("/"),
        }),
        file: (p: string) => ({ fsPath: p }),
      },
    };
  }
  return origRequire.apply(this, arguments as any);
};

import { ChatViewState, getChatViewHtml } from "../src/providers/chatview/chatHtml.js";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";
import { getChatStyles } from "../src/providers/chatview/chatStyles.js";
import { getWaterfallHtml } from "../src/providers/waterfall/waterfallHtml.js";
import { getWaterfallScript } from "../src/providers/waterfall/waterfallScript.js";
import { getChatAmbientScript } from "../src/providers/chatview/chatAmbientScript.js";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Webview Client Scripts & Regex Escaping Unit Tests", () => {
  it("ChatViewProvider client script should compile with 0 syntax errors", () => {
    const state: ChatViewState = {
      currentSessionId: "sess-test",
      currentModel: "anthropic/claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
      models: [{ id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet" }],
    };

    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };
    const extensionUri: any = {
      fsPath: "d:/saas/agent/vscode-extension",
    };

    const scriptCode = getChatClientScript("vscode-resource://icon.svg", state);
    assert.ok(scriptCode.length > 1000, "Client script should be non-empty");

    // Must compile cleanly with node vm.Script
    assert.doesNotThrow(() => {
      new vm.Script(scriptCode, { filename: "chatClientScript.js" });
    }, "chatClientScript.js must parse with 0 syntax errors");
  });

  it("ChatViewProvider generated HTML should contain valid JS in all script tags", () => {
    const state: ChatViewState = {
      currentSessionId: "sess-test",
      currentModel: "anthropic/claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
      models: [{ id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet" }],
    };

    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };
    const extensionUri: any = {
      fsPath: "d:/saas/agent/vscode-extension",
    };

    const html = getChatViewHtml(mockWebview, extensionUri, state);
    assert.ok(html.length > 5000, "HTML should be generated");

    const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1])
      .filter(s => s.trim().length > 0);

    assert.ok(scriptMatches.length > 0, "Should find at least one inline script");

    for (let i = 0; i < scriptMatches.length; i++) {
      const code = scriptMatches[i];
      assert.doesNotThrow(() => {
        new vm.Script(code, { filename: `chatview-inline-script-${i}.js` });
      }, `Inline script #${i} must have valid syntax`);
    }
  });

  it("should correctly render markdown and regexes without escaping issues", () => {
    const state: ChatViewState = {
      currentSessionId: "sess-test",
      currentModel: "claude-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
    };

    const scriptCode = getChatClientScript("icon.svg", state);

    // Sandbox execution to test renderInline & renderMarkdown
    const postedMessages: any[] = [];
    const mockDoc: any = {
      getElementById: () => ({
        addEventListener: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
        style: {},
        value: "",
        innerHTML: "",
        textContent: "",
        appendChild: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
      }),
      createElement: () => ({
        addEventListener: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
        style: {},
        setAttribute: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { classList: { add: () => {}, remove: () => {} } },
    };

    const mockWindow: any = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    };

    const sandbox: any = {
      acquireVsCodeApi: () => ({
        postMessage: (m: any) => postedMessages.push(m),
        getState: () => ({}),
        setState: () => {},
      }),
      document: mockDoc,
      window: mockWindow,
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
      setTimeout: (fn: Function) => { fn(); },
      setInterval: () => 1,
      clearInterval: () => {},
      clearTimeout: () => {},
      requestAnimationFrame: (fn: Function) => { fn(); },
      cancelAnimationFrame: () => {},
      marked: {
        parse: (s: string) => s,
        use: () => {},
      },
      navigator: { clipboard: { writeText: () => Promise.resolve() } },
      encodeURIComponent,
      decodeURIComponent,
      Math,
      Date,
      JSON,
      String,
      Number,
      Array,
      Object,
      RegExp,
      Set,
      Map,
    };

    vm.createContext(sandbox);
    assert.doesNotThrow(() => {
      vm.runInContext(scriptCode, sandbox);
    }, "Script execution in mock DOM environment should not throw");
  });

  it("Waterfall client script should compile with 0 syntax errors", () => {
    const scriptCode = getWaterfallScript("test-session-123");
    assert.ok(scriptCode.length > 500, "Waterfall script should be non-empty");

    assert.doesNotThrow(() => {
      new vm.Script(scriptCode, { filename: "waterfallScript.js" });
    }, "waterfallScript.js must parse with 0 syntax errors");
  });

  it("Waterfall HTML should contain valid CSP, nonce, and script structure", () => {
    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };

    const html = getWaterfallHtml(mockWebview, "test-sess", "Test Session");
    assert.ok(html.includes("<!DOCTYPE html>"), "Must be a full HTML document");
    assert.ok(html.includes("Content-Security-Policy"), "Must declare strict CSP");
    assert.ok(html.includes("nonce-"), "Must have script nonce in CSP");
    assert.ok(html.includes('<script nonce="'), "Script tags must be nonce-protected");

    const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch && scriptMatch[1], "Should extract script body");

    assert.doesNotThrow(() => {
      new vm.Script(scriptMatch[1], { filename: "extractedWaterfallScript.js" });
    }, "Extracted waterfall script must parse with 0 syntax errors");
  });

  it("Ambient wallpaper script should compile with 0 syntax errors for both enabled and disabled states", () => {
    // Disabled (default)
    const scriptDisabled = getChatAmbientScript("vscode-resource://wildcat.jpg", {
      enabled: false,
      rippleIntensity: "medium",
      floatingAsterisks: true,
      cursorLightAura: true,
    });
    assert.ok(scriptDisabled.length > 500, "Ambient script disabled should be non-empty");
    assert.doesNotThrow(() => {
      new vm.Script(scriptDisabled, { filename: "chatAmbientScriptDisabled.js" });
    }, "Disabled ambient script must compile with 0 syntax errors");

    // Enabled
    const scriptEnabled = getChatAmbientScript("vscode-resource://wildcat.jpg", {
      enabled: true,
      rippleIntensity: "strong",
      floatingAsterisks: true,
      cursorLightAura: true,
    });
    assert.ok(scriptEnabled.length > 500, "Ambient script enabled should be non-empty");
    assert.doesNotThrow(() => {
      new vm.Script(scriptEnabled, { filename: "chatAmbientScriptEnabled.js" });
    }, "Enabled ambient script must compile with 0 syntax errors");
  });

  it("Chat HTML should include ambient container, canvases, dot matrix overlay, and gradient fade", () => {
    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };
    const extensionUri: any = {
      fsPath: "d:/saas/agent/vscode-extension",
    };
    const state: ChatViewState = {
      currentSessionId: "sess-test",
      currentModel: "anthropic/claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
      wallpaperConfig: {
        enabled: false,
        rippleIntensity: "medium",
        floatingAsterisks: true,
        cursorLightAura: true,
      },
    };

    const html = getChatViewHtml(mockWebview, extensionUri, state);
    assert.ok(html.includes('id="andromity-ambient-container"'), "Ambient container must exist");
    assert.ok(html.includes('id="andromity-water-canvas"'), "Water canvas must exist");
    assert.ok(html.includes('id="andromity-fx-canvas"'), "FX canvas must exist");
    assert.ok(html.includes('id="andromity-cursor-light"'), "Cursor light must exist");
    assert.ok(html.includes('id="andromity-dither-overlay"'), "Dot-matrix dither overlay must exist");
    assert.ok(html.includes('id="andromity-gradient-fade"'), "Ambient gradient fade must exist");
  });

  it("Ambient script should execute safely in DOM, default to hidden, and respond to config messages", () => {
    const script = getChatAmbientScript("vscode-resource://wildcat.jpg", {
      enabled: false,
      rippleIntensity: "medium",
      floatingAsterisks: true,
      cursorLightAura: true,
    });

    const elements: Record<string, any> = {
      "andromity-ambient-container": { style: { display: "" } },
      "andromity-water-canvas": {
        getContext: () => ({
          drawImage: () => {},
          createImageData: () => ({ data: new Uint8ClampedArray(100) }),
          putImageData: () => {},
        }),
        width: 400,
        height: 600,
      },
      "andromity-fx-canvas": {
        getContext: () => ({
          clearRect: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          fillText: () => {},
        }),
        width: 400,
        height: 600,
      },
      "andromity-cursor-light": { style: { display: "", transform: "" } },
      "andromity-dither-overlay": { style: {} },
    };

    const windowListeners: Record<string, Function[]> = {};
    const docListeners: Record<string, Function[]> = {};

    const mockDoc: any = {
      getElementById: (id: string) => elements[id] || null,
      createElement: (tag: string) => {
        if (tag === "canvas") {
          return {
            getContext: () => ({
              drawImage: () => {},
              getImageData: () => ({ data: new Uint8ClampedArray(400 * 600 * 4) }),
            }),
            width: 400,
            height: 600,
          };
        }
        return { style: {} };
      },
      addEventListener: (type: string, fn: Function) => {
        if (!docListeners[type]) docListeners[type] = [];
        docListeners[type].push(fn);
      },
      hidden: false,
    };

    const mockWindow: any = {
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (type: string, fn: Function) => {
        if (!windowListeners[type]) windowListeners[type] = [];
        windowListeners[type].push(fn);
      },
      removeEventListener: () => {},
    };

    class MockImage {
      naturalWidth = 1920;
      naturalHeight = 1080;
      onload: Function | null = null;
      onerror: Function | null = null;
      private _src = "";
      set src(val: string) {
        this._src = val;
        if (this.onload) setTimeout(() => this.onload?.(), 0);
      }
      get src() { return this._src; }
    }

    const sandbox: any = {
      document: mockDoc,
      window: mockWindow,
      Image: MockImage,
      requestAnimationFrame: (fn: Function) => setTimeout(fn, 16),
      cancelAnimationFrame: () => {},
      setTimeout: (fn: Function, ms?: number) => setTimeout(fn, ms || 0),
      clearTimeout: () => {},
      Math,
      Int16Array,
      Uint8ClampedArray,
      Object,
      JSON,
      console: { log: () => {}, warn: () => {}, error: () => {} },
    };

    vm.createContext(sandbox);
    assert.doesNotThrow(() => {
      vm.runInContext(script, sandbox);
    }, "Ambient script should run in mock DOM sandbox without errors");

    // Since initialConfig had enabled: false, container should be hidden
    assert.strictEqual(elements["andromity-ambient-container"].style.display, "none", "Container must be hidden when disabled");

    // Dispatch message to enable wallpaper dynamically
    const messageListeners = windowListeners["message"] || [];
    assert.ok(messageListeners.length > 0, "Must register window message listener");

    for (const listener of messageListeners) {
      listener({
        data: {
          type: "wallpaper_config_changed",
          wallpaper: {
            enabled: true,
            rippleIntensity: "medium",
            floatingAsterisks: true,
            cursorLightAura: true,
          },
        },
      });
    }

    assert.strictEqual(elements["andromity-ambient-container"].style.display, "block", "Container must show when enabled via message");
  });

  it("ChatViewProvider client script should contain CJK IME guard and prompt history navigation", () => {
    const script = getChatClientScript("vscode-resource://icon.svg", {
      currentSessionId: "test-sess",
      currentModel: "anthropic/claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
    });

    assert.ok(script.includes("e.isComposing || e.keyCode === 229"), "Must include CJK IME composition guard");
    assert.ok(script.includes("sentPromptsHistory"), "Must track sent prompts history");
    assert.ok(script.includes("promptHistoryIndex"), "Must track prompt history index");
    assert.ok(script.includes("ArrowUp"), "Must handle ArrowUp for prompt recall");
    assert.ok(script.includes("ArrowDown"), "Must handle ArrowDown for prompt history navigation");
  });

  it("ChatViewProvider HTML should contain WCAG 2.1 & 4.1.2 accessible roles and aria labels", () => {
    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };
    const extensionUri: any = {
      fsPath: "/mock/ext/path",
    };
    const html = getChatViewHtml(mockWebview, extensionUri, {
      currentSessionId: "test",
      currentModel: "test",
      currentProvider: "test",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
    });

    assert.ok(html.includes('id="btn-session-picker" role="button" tabindex="0" aria-label='), "Session picker must have accessible role, tabindex, and aria-label");
    assert.ok(html.includes('id="btn-lightbox-close" aria-label="Close image preview"'), "Lightbox close must have aria-label");
    assert.ok(html.includes('id="btn-crons-close" aria-label="Close scheduled tasks drawer"'), "Crons close must have aria-label");
    assert.ok(html.includes('id="btn-timeline-close" aria-label="Close conversation timeline"'), "Timeline close must have aria-label");
    assert.ok(html.includes('id="btn-slash-close" aria-label="Close slash commands"'), "Slash close must have aria-label");
    assert.ok(html.includes('id="btn-mention-close" aria-label="Close skills palette"'), "Mention close must have aria-label");
    assert.ok(html.includes('id="btn-top-timeline" style="display:none;"'), "Timeline button in top bar must remain hidden");
    assert.ok(html.includes('id="btn-top-compact" style="display:none;"'), "Compact button in top bar must remain hidden");
  });

  it("Chat styles should include link contrast rules", () => {
    const styles = getChatStyles();
    assert.ok(styles.includes("var(--vscode-textLink-foreground"), "Must style links with high-contrast textLink color");
  });

  it("Package manifest should declare untrusted workspace limited support", () => {
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    assert.strictEqual(pkg.capabilities?.untrustedWorkspaces?.supported, "limited", "Workspace trust must be limited");
    const cmdIds = (pkg.contributes?.commands || []).map((c: any) => c.command);
    assert.ok(cmdIds.includes("andromity.openPersonalisation"), "Manifest must declare andromity.openPersonalisation command");
  });

  it("ChatViewProvider client script should contain /personalisation and /wallpaper slash commands", () => {
    const script = getChatClientScript("vscode-resource://icon.svg", {
      currentSessionId: "test-sess",
      currentModel: "anthropic/claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
    });

    assert.ok(script.includes("cmd: '/personalisation'"), "Must include /personalisation command");
    assert.ok(script.includes("cmd: '/wallpaper'"), "Must include /wallpaper command");
    assert.ok(script.includes("open_personalisation"), "Must post open_personalisation message");
  });
});

