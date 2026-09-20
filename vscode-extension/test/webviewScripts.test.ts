import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";

// Mock vscode module for Node testing
// @ts-ignore
const Module = require("module");
const origRequire = Module.prototype.require;
const mockVscode: any = {
  Uri: {
    joinPath: (...args: any[]) => ({
      fsPath: args.map((a) => (typeof a === "object" ? a.fsPath || a.path : String(a))).join("/"),
    }),
    file: (p: string) => ({ fsPath: p }),
  },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
    workspaceFolders: [{ uri: { fsPath: "D:/mock/ws" } }],
  },
  window: {
    showWarningMessage: async () => "Yes, Rollback",
    showInformationMessage: () => {},
    showErrorMessage: () => {},
  },
  commands: {
    executeCommand: () => {},
  },
};
Module.prototype.require = function (reqPath: string) {
  if (reqPath === "vscode") {
    return mockVscode;
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
    assert.ok(script.includes("cmd: '/pet'"), "Must include /pet command");
    assert.ok(script.includes("open_personalisation"), "Must post open_personalisation message");
  });

  it("ChatViewProvider generated HTML should include animated pixel-art companion element", () => {
    const html = getChatViewHtml(
      { asWebviewUri: (uri: any) => uri, cspSource: "'self'" } as any,
      { fsPath: "/mock/path" } as any,
      {
        currentSessionId: "test-sess",
        currentModel: "anthropic/claude-3.7-sonnet",
        currentProvider: "anthropic",
        currentMode: "safe",
        currentProfile: "builder",
        currentReasoning: "medium",
      }
    );

    assert.ok(html.includes('id="chat-mascot-home-slot"'), "HTML must include chat-mascot-home-slot container");
    assert.ok(html.includes('id="chat-mascot"'), "HTML must include chat-mascot container");
    assert.ok(html.includes('id="mascot-bubble"'), "HTML must include mascot-bubble");
    assert.ok(html.includes('class="mascot-svg"'), "HTML must include inline SVG pixel-art sprite");
    assert.ok(html.includes('id="profile-mascot-perch"'), "HTML must include profile-mascot-perch");
    assert.ok(html.includes('id="top-header-mascot-perch"'), "HTML must include top-header-mascot-perch");
    assert.ok(html.includes('id="edge-mascot-perch"'), "HTML must include edge-mascot-perch");
    assert.ok(html.includes('id="mascot-drag-layer"'), "HTML must include the free-play mascot drag layer");
    assert.ok(html.includes('class="mascot-xeyes"'), "HTML must include the dizzy pixel X-eyes layer");

    const script = getChatClientScript("vscode-resource://icon.svg", {
      currentSessionId: "test-sess",
      currentModel: "claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
    });
    assert.ok(script.includes('function hopMascotTo('), "Client script must implement hopMascotTo");
    assert.ok(script.includes('tool-seq-mascot-perch'), "Client script must manage tool-seq-mascot-perch");
    assert.ok(script.includes('assistant-mascot-perch'), "Client script must manage assistant-mascot-perch");
    assert.ok(script.includes('interruptMascotToWork'), "Client script must implement interruptMascotToWork");
    assert.ok(script.includes('function attachMascotPlayPhysics('), "Client script must wire playground gestures");
    assert.ok(script.includes('function throwMascot('), "Client script must implement throwMascot");
    assert.ok(script.includes('function mascotJump('), "Client script must implement mascotJump");
    assert.ok(script.includes('function recallMascotHome('), "Client script must implement recallMascotHome");
    assert.ok(script.includes('function spawnMascotParticles('), "Client script must implement mascot particles");
    assert.ok(script.includes('setPointerCapture'), "Client script must capture the pointer while carrying the pet");
    assert.ok(script.includes("'pointercancel'"), "Client script must recover from cancelled pointer gestures");
    assert.ok(script.includes('MASCOT_PHYSICS'), "Client script must expose tunable mascot physics constants");
    assert.ok(script.includes("cmd: '/play'"), "Client script must expose the /play pet trick command");
    assert.ok(script.includes("cmd: '/fetch'"), "Client script must expose the /fetch recall command");

    const styles = getChatStyles();
    assert.ok(styles.includes('.mascot-drag-layer'), "Styles must define the free-play drag layer");
    assert.ok(styles.includes('mascotDustPuff'), "Styles must define the impact dust puff animation");
    assert.ok(styles.includes('.chat-mascot.is-dizzy'), "Styles must define the dizzy state");
    assert.ok(styles.includes('.chat-mascot.is-zooming'), "Styles must define the zoomies state");
    assert.ok(styles.includes('.mascot-particle'), "Styles must define reaction particles");
  });

  it("Andro-Pet playground should drag, throw, bounce, jump and settle in a mock DOM", () => {
    const state: any = {
      currentSessionId: "test-sess",
      currentModel: "claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
    };
    const fullScript = getChatClientScript("vscode-resource://icon.svg", state);
    const startIdx = fullScript.indexOf("const MASCOT_SIZE = 32;");
    const endIdx = fullScript.indexOf("function updateOnboardingVisibility()");
    assert.ok(startIdx > 0 && endIdx > startIdx, "Playground module must be embedded in the client script");
    const moduleCode = fullScript.slice(startIdx, endIdx);

    const build = (reducedMotion: boolean) => {
      const makeEl = (id: string): any => {
        const el: any = {
          id,
          parentElement: null,
          children: [] as any[],
          classes: new Set<string>(),
          listeners: {} as Record<string, Function[]>,
          rect: { left: 0, top: 468 },
          style: { setProperty: (k: string, v: string) => { el.style[k] = v; } },
          appendChild(child: any) {
            if (child.parentElement && child.parentElement.children) {
              const at = child.parentElement.children.indexOf(child);
              if (at >= 0) child.parentElement.children.splice(at, 1);
            }
            child.parentElement = el;
            el.children.push(child);
            return child;
          },
          removeChild(child: any) {
            const at = el.children.indexOf(child);
            if (at >= 0) el.children.splice(at, 1);
            child.parentElement = null;
            return child;
          },
          setAttribute() {},
          getBoundingClientRect() {
            return {
              left: el.rect.left,
              top: el.rect.top,
              width: 32,
              height: 32,
              right: el.rect.left + 32,
              bottom: el.rect.top + 32,
            };
          },
          setPointerCapture() {},
          releasePointerCapture() {},
          addEventListener(type: string, fn: Function) {
            (el.listeners[type] = el.listeners[type] || []).push(fn);
          },
        };
        el.classList = {
          add: (...names: string[]) => names.forEach((c) => el.classes.add(c)),
          remove: (...names: string[]) => names.forEach((c) => el.classes.delete(c)),
          contains: (c: string) => el.classes.has(c),
        };
        return el;
      };

      const mascot = makeEl("chat-mascot");
      const layer = makeEl("mascot-drag-layer");
      const homeSlot = makeEl("chat-mascot-home-slot");
      homeSlot.appendChild(mascot);

      const elements: Record<string, any> = {
        "chat-mascot": mascot,
        "mascot-drag-layer": layer,
        "chat-mascot-home-slot": homeSlot,
      };
      const timers: Array<{ fn: Function; ms: number }> = [];
      const frames: Function[] = [];
      let clock = 0;

      const sandbox: any = {
        document: {
          getElementById: (id: string) => elements[id] || null,
          querySelector: (sel: string) =>
            sel === ".top-bar"
              ? { getBoundingClientRect: () => ({ top: 0, bottom: 40, height: 40 }) }
              : sel === ".input-section"
                ? { getBoundingClientRect: () => ({ top: 500, bottom: 590, height: 90 }) }
                : null,
          createElement: () => makeEl("particle"),
          addEventListener: () => {},
          hidden: false,
        },
        window: {
          innerWidth: 800,
          innerHeight: 600,
          matchMedia: () => ({ matches: reducedMotion, addEventListener: () => {} }),
          addEventListener: () => {},
          removeEventListener: () => {},
        },
        Math,
        Date,
        Object,
        JSON,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout: (fn: Function, ms?: number) => timers.push({ fn, ms: ms || 0 }),
        clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
        requestAnimationFrame: (fn: Function) => frames.push(fn),
        cancelAnimationFrame: () => {},
        chatMascotEl: mascot,
        isRunning: false,
        isMascotOnTurn: false,
        isMascotRoaming: false,
        lastMascotActivityTime: 0,
        petMascot: () => { sandbox.petted = (sandbox.petted || 0) + 1; },
        showMascotBubble: () => {},
        hopMascotTo: (target: any) => { sandbox.hopTarget = target; target.appendChild(mascot); },
      };

      vm.createContext(sandbox);
      vm.runInContext(moduleCode, sandbox);

      const pos = () => {
        const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(String(mascot.style.transform));
        return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
      };
      const runFrames = (count: number) => {
        const seen: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < count; i++) {
          const pending = frames.splice(0, frames.length);
          if (!pending.length) break;
          clock += 16;
          pending.forEach((fn) => fn(clock));
          const p = pos();
          if (p) seen.push(p);
        }
        return seen;
      };
      const flushTimers = (ms: number) => {
        const due = timers.splice(0, timers.length).filter((t) => t.ms <= ms);
        due.forEach((t) => t.fn());
        return due.map((t) => t.ms);
      };

      return { sandbox, mascot, layer, homeSlot, timers, pos, runFrames, flushTimers, pendingFrames: () => frames.length };
    };

    const pet = build(false);
    const field = pet.sandbox.getMascotPlayField();
    assert.strictEqual(field.minX, 0, "Left wall must be the viewport edge");
    assert.strictEqual(field.maxX, 768, "Right wall must keep the 32px pet inside the viewport");
    assert.strictEqual(field.groundY, 468, "Ground must be the top of the prompt card");
    assert.strictEqual(field.ceilingY, 42, "Ceiling must sit just below the chat header");

    pet.sandbox.beginMascotGrab({ button: 0, pointerId: 1, clientX: 24, clientY: 470, cancelable: true });
    assert.ok(pet.mascot.classList.contains("is-grabbed"), "Pointer down must lift the pet into the grabbed state");
    pet.sandbox.updateMascotGrab({ pointerId: 1, clientX: 26, clientY: 470, cancelable: true });
    assert.ok(!pet.mascot.classList.contains("is-dragging"), "Movement under the threshold must stay a pet, not a drag");
    pet.sandbox.endMascotGrab({ pointerId: 1 });
    assert.strictEqual(pet.sandbox.petted, 1, "A grab without travel must pet the mascot");

    pet.sandbox.beginMascotGrab({ button: 0, pointerId: 2, clientX: 24, clientY: 470, cancelable: true });
    pet.sandbox.updateMascotGrab({ pointerId: 2, clientX: 400, clientY: 300, cancelable: true });
    pet.sandbox.updateMascotGrab({ pointerId: 2, clientX: 700, clientY: 120, cancelable: true });
    assert.strictEqual(
      pet.pendingFrames(),
      1,
      "Pointer events must coalesce into a single animation frame instead of one paint per event"
    );
    // Drag painting is coalesced into one animation frame, so flush it before releasing.
    pet.runFrames(1);
    assert.strictEqual(pet.pendingFrames(), 0, "The coalesced drag paint must be consumed by the frame");
    assert.ok(pet.mascot.classList.contains("is-dragging"), "Dragging must promote the pet into the carry state");
    assert.strictEqual(pet.mascot.parentElement, pet.layer, "A carried pet must move into the playground layer");
    assert.ok(
      String(pet.mascot.style.transform).indexOf("translate3d") === 0,
      "A carried pet must be positioned by transform"
    );

    pet.sandbox.endMascotGrab({ pointerId: 2 });
    assert.ok(pet.mascot.classList.contains("is-flying"), "Releasing a carried pet must throw it");

    const trajectory = pet.runFrames(1200);
    assert.ok(trajectory.length > 5, "A thrown pet must keep moving under physics");
    assert.ok(
      Math.min(...trajectory.map((p) => p.x)) >= 0 && Math.max(...trajectory.map((p) => p.x)) <= 768,
      "A thrown pet must bounce off the walls without escaping the viewport"
    );
    assert.ok(Math.min(...trajectory.map((p) => p.y)) < 468, "A thrown pet must bounce upward off the ground line");
    assert.ok(pet.mascot.classList.contains("is-resting"), "A thrown pet must settle back to rest");
    assert.strictEqual(pet.pos()!.y, 468, "A settled pet must rest exactly on the ground line");
    assert.ok(pet.timers.some((t) => t.ms === 30000), "A settled pet must schedule its auto-toddle-home timer");
    assert.strictEqual(pet.sandbox.hopTarget, undefined, "A settled pet must keep playing until the timer elapses");

    pet.flushTimers(30000);
    assert.strictEqual(pet.sandbox.hopTarget, pet.homeSlot, "Auto-return must dock the pet back to its home slot");

    pet.sandbox.mascotJump();
    pet.flushTimers(200);
    assert.ok(pet.mascot.classList.contains("is-flying"), "A jump must launch the pet through the physics loop");
    const hopTrajectory = pet.runFrames(1200);
    assert.ok(hopTrajectory.some((p) => p.y < 400), "A jump must arc above the ground line");
    assert.ok(pet.mascot.classList.contains("is-resting"), "A jumping pet must land and settle again");

    // Air-drop test: drag high into the air, pause, and release without velocity
    pet.sandbox.beginMascotGrab({ button: 0, pointerId: 4, clientX: 24, clientY: 470, cancelable: true });
    pet.sandbox.updateMascotGrab({ pointerId: 4, clientX: 320, clientY: 160, cancelable: true });
    pet.runFrames(1);
    assert.ok(pet.mascot.classList.contains("is-dragging"), "Must be dragging in the air");
    pet.sandbox.endMascotGrab({ pointerId: 4 });
    assert.ok(pet.mascot.classList.contains("is-flying"), "Releasing in air must drop under gravity");
    const dropTrajectory = pet.runFrames(1200);
    assert.ok(dropTrajectory.length > 5, "Air drop must produce a falling physics trajectory");
    assert.ok(pet.mascot.classList.contains("is-resting"), "Air-dropped pet must bounce and settle back to rest");
    assert.strictEqual(pet.pos()!.y, 468, "Air-dropped pet must settle cleanly on ground ledge");

    const calm = build(true);
    calm.sandbox.beginMascotGrab({ button: 0, pointerId: 3, clientX: 10, clientY: 470, cancelable: true });
    calm.sandbox.updateMascotGrab({ pointerId: 3, clientX: 200, clientY: 260, cancelable: true });
    calm.sandbox.endMascotGrab({ pointerId: 3 });
    assert.ok(!calm.mascot.classList.contains("is-flying"), "Reduced motion must skip throw physics");
    assert.ok(calm.mascot.classList.contains("is-resting"), "Reduced motion must snap the pet straight to rest");
    calm.sandbox.mascotZoomies();
    assert.ok(!calm.mascot.classList.contains("is-flying"), "Reduced motion must skip the zoomies trick");

    // Verify throw velocity calculation detects real directional momentum
    pet.sandbox.beginMascotGrab({ button: 0, pointerId: 5, clientX: 20, clientY: 470, cancelable: true });
    pet.sandbox.updateMascotGrab({ pointerId: 5, clientX: 100, clientY: 400, cancelable: true });
    pet.sandbox.updateMascotGrab({ pointerId: 5, clientX: 300, clientY: 200, cancelable: true });
    pet.runFrames(1);
    const vel = pet.sandbox.computeMascotThrowVelocity();
    assert.ok(Math.hypot(vel.x, vel.y) > 0, "Velocity must be non-zero after a drag movement");

    // Verify particle pool recycles freed nodes indefinitely beyond maxParticles limit
    for (let i = 0; i < 35; i++) {
      pet.sandbox.spawnMascotParticles("sparkle", 100, 100, 2);
      pet.flushTimers(1500);
    }
    const recycledNode = pet.sandbox.acquireMascotParticle("heart");
    assert.ok(recycledNode !== null, "Particle pool must reuse freed nodes instead of starving after 24 spawns");
    if (recycledNode) pet.sandbox.releaseMascotParticle(recycledNode);
  });

  it("PlanEditorPanel generated HTML should contain valid JS in all script tags", () => {
    // @ts-ignore
    const { PlanEditorPanel } = require("../src/panels/PlanEditorPanel.js");
    const mockWebview: any = {
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => "vscode-resource://" + (u.fsPath || u.path || String(u)),
    };
    const extensionUri: any = {
      fsPath: "d:/saas/agent/vscode-extension",
    };

    const panelObj = Object.create(PlanEditorPanel.prototype);
    panelObj._extensionUri = extensionUri;
    panelObj._currentPlan = { title: "Test Plan", status: "pending", steps: [] };

    const html = panelObj._getHtmlForWebview(mockWebview);
    assert.ok(html.length > 500, "HTML should be generated");

    const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1])
      .filter(s => s.trim().length > 0);

    assert.ok(scriptMatches.length > 0, "Should find at least one inline script in PlanEditorPanel");

    for (let i = 0; i < scriptMatches.length; i++) {
      const code = scriptMatches[i];
      assert.doesNotThrow(() => {
        new vm.Script(code, { filename: `plan-editor-script-${i}.js` });
      }, `PlanEditorPanel script #${i} must have valid syntax`);
    }
  });

  it("chatClientScript should attach data-turn-index and dispatch targeted turn rollback", () => {
    const state: ChatViewState = {
      currentSessionId: "sess-undo",
      currentModel: "anthropic/claude-3.7-sonnet",
      currentProvider: "anthropic",
      currentMode: "safe",
      currentProfile: "builder",
      currentReasoning: "medium",
      models: [{ id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet" }],
    };
    const scriptCode = getChatClientScript("icon.svg", state);
    assert.ok(scriptCode.includes("data-turn-index"), "Script must set data-turn-index on user prompt messages");
    assert.ok(scriptCode.includes("turnsToUndo"), "Script must calculate turnsToUndo");
    assert.ok(scriptCode.includes("undo_turn"), "Script must post undo_turn message");

    // Test the undo calculation logic directly
    const mockChatContainer = {
      querySelectorAll: (sel: string) => {
        if (sel === ".message-wrap.user") {
          return [
            { id: "turn-0" },
            { id: "turn-1" },
            { id: "turn-2" },
            { id: "turn-3" },
          ];
        }
        return [];
      },
    };

    const allUserWraps = mockChatContainer.querySelectorAll(".message-wrap.user");
    const totalTurns = allUserWraps.length;
    assert.strictEqual(totalTurns, 4, "Should have 4 user turns");

    // Case 1: Click Turn 2 (3rd turn, index 2)
    const clickedWrap = allUserWraps[2];
    const turnIndex = allUserWraps.indexOf(clickedWrap);
    const turnsToUndo = (turnIndex >= 0 && totalTurns > 0) ? (totalTurns - turnIndex) : 1;
    assert.strictEqual(turnIndex, 2, "Turn index must be 2 for 3rd turn");
    assert.strictEqual(turnsToUndo, 2, "Must undo 2 turns (Turn 3 and Turn 2)");

    // Case 2: Click Turn 0 (1st turn, index 0)
    const turn0 = allUserWraps[0];
    const idx0 = allUserWraps.indexOf(turn0);
    const undo0 = (idx0 >= 0 && totalTurns > 0) ? (totalTurns - idx0) : 1;
    assert.strictEqual(idx0, 0);
    assert.strictEqual(undo0, 4, "Must undo all 4 turns back to clean state");

    // Case 3: Click Turn 3 (4th turn, index 3)
    const turn3 = allUserWraps[3];
    const idx3 = allUserWraps.indexOf(turn3);
    const undo3 = (idx3 >= 0 && totalTurns > 0) ? (totalTurns - idx3) : 1;
    assert.strictEqual(idx3, 3);
    assert.strictEqual(undo3, 1, "Must undo 1 turn");
  });

  it("DiffManager should send turn_index and turns_to_undo to session.undo RPC", async () => {
    // @ts-ignore
    const { DiffManager } = require("../src/integrations/DiffManager.js");
    let calledMethod = "";
    let calledParams: any = null;

    const mockRpcClient: any = {
      call: async (method: string, params: any) => {
        calledMethod = method;
        calledParams = params;
        return { success: true, popped_messages: 4, turns_undone: 2, target_turn_index: 2, git_status: "Restored snapshot abc1234" };
      },
    };

    // Mock vscode.window.showWarningMessage to simulate user clicking "Yes, Rollback"
    const vscode = require("vscode");
    const origWarning = vscode.window?.showWarningMessage;
    vscode.window = vscode.window || {};
    let promptShown = "";
    vscode.window.showWarningMessage = async (msg: string) => {
      promptShown = msg;
      return "Yes, Rollback";
    };
    vscode.window.showInformationMessage = () => {};
    vscode.commands = vscode.commands || {};
    vscode.commands.executeCommand = () => {};
    vscode.workspace = vscode.workspace || {};
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "D:/mock/ws" } }];
    vscode.workspace.registerTextDocumentContentProvider = () => ({ dispose: () => {} });

    try {
      const diffMgr = new DiffManager(mockRpcClient, { subscriptions: [] } as any);
      const result = await diffMgr.undoLastTurn("sess-target", 2, 2);

      assert.strictEqual(result, true, "undoLastTurn must return true on success");
      assert.strictEqual(calledMethod, "session.undo");
      assert.strictEqual(calledParams.session_id, "sess-target");
      assert.strictEqual(calledParams.turn_index, 2);
      assert.strictEqual(calledParams.turns_to_undo, 2);
      assert.ok(promptShown.includes("Undo 2 turns"), "Confirmation modal should specify number of turns being undone");
    } finally {
      if (origWarning) {
        vscode.window.showWarningMessage = origWarning;
      }
    }
  });
});


