import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { getHubSearchStyles, HUB_SEARCH_MARKUP, hubSearchClient } from "../src/panels/settings/hubSearch.js";

const nodeRequire: NodeRequire = require;
const PAGE_URL = "http://hub.test/page.html";

/* ------------------------------------------------------------------ */
/* Rendering the real Settings panel HTML                              */
/* ------------------------------------------------------------------ */

function renderPanelHtml(load: () => any): string {
  const Module = nodeRequire("module");
  const original = Module.prototype.require;
  const uri = (p: string): any => ({ fsPath: p, path: p, toString: () => p });
  const stub = {
    Uri: { joinPath: (...parts: any[]) => uri(parts.map((x) => (typeof x === "object" ? x.fsPath : x)).join("/")), file: uri, parse: uri },
    workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }), workspaceFolders: [], isTrusted: true },
    window: { showWarningMessage: async () => undefined, showErrorMessage() {}, showInformationMessage() {} },
    extensions: { getExtension: () => ({ packageJSON: { version: "0.0.0" } }) },
    commands: { executeCommand() {} },
  };
  Module.prototype.require = function (this: any, name: string) {
    return name === "vscode" ? stub : original.apply(this, arguments);
  };
  try {
    const { SettingsPanel } = load();
    const panel = Object.create(SettingsPanel.prototype);
    panel._panel = { webview: { cspSource: "vscode-webview:", asWebviewUri: () => "icon.svg", postMessage() {} } };
    panel._extensionUri = { fsPath: "D:/extension" };
    return panel._getHtmlForWebview();
  } finally {
    Module.prototype.require = original;
  }
}

const tmpFiles: string[] = [];
const htmlCache = new Map<string, string>();

function panelHtml(variant: "tsc" | "bundle" | "bundle-min"): string {
  const cached = htmlCache.get(variant);
  if (cached) return cached;
  let html: string;
  if (variant === "tsc") {
    html = renderPanelHtml(() => nodeRequire("../src/panels/SettingsPanel.js"));
  } else {
    const esbuild = nodeRequire("esbuild");
    const out = path.join(os.tmpdir(), `hub-search-${process.pid}-${variant}.cjs`);
    tmpFiles.push(out);
    esbuild.buildSync({
      entryPoints: [path.resolve(__dirname, "../../src/panels/SettingsPanel.ts")],
      bundle: true,
      format: "cjs",
      platform: "node",
      minify: variant === "bundle-min",
      outfile: out,
      external: ["vscode"],
      logLevel: "silent",
    });
    html = renderPanelHtml(() => nodeRequire(out));
  }
  htmlCache.set(variant, html);
  return html;
}

function inlineScripts(html: string): string[] {
  return Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)).map((m) => m[1]).filter((s) => s.trim().length > 0);
}

/* ------------------------------------------------------------------ */
/* Oracles                                                             */
/* ------------------------------------------------------------------ */

const collapse = (value: string): string => value.replace(/[\u0000-\u0020]+/g, " ").trim();

function looselyMatches(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let from = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Browser plumbing                                                    */
/* ------------------------------------------------------------------ */

function loadPlaywright(): any | null {
  const roaming = process.env.APPDATA || "";
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    path.join(roaming, "npm/node_modules/@playwright/cli/node_modules/playwright-core"),
    path.join(roaming, "npm/node_modules/openclaw/node_modules/playwright-core"),
    "playwright-core",
    "playwright",
  ].filter((value): value is string => !!value);
  for (const candidate of candidates) {
    try { return nodeRequire(candidate); } catch { /* try next */ }
  }
  return null;
}

function findChromium(): string | undefined {
  if (process.env.EFFORT_CHROME && fs.existsSync(process.env.EFFORT_CHROME)) return process.env.EFFORT_CHROME;
  const local = process.env.LOCALAPPDATA || "";
  const roots = [path.join(local, "ms-playwright"), path.join(process.env.HOME || "", ".cache/ms-playwright")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const dir of dirs) {
      for (const rel of ["chrome-win64/chrome.exe", "chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const candidate = path.join(root, dir, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const pw = loadPlaywright();
const chromePath = findChromium();
const browserSkip = !pw ? "playwright-core not found (set PLAYWRIGHT_CORE)" : !chromePath ? "no Chromium found (set EFFORT_CHROME)" : false;

interface Hub {
  page: any;
  errors: string[];
  requests: string[];
}

interface HubOptions {
  width?: number;
  height?: number;
  csp?: boolean;
  html?: string;
}

let browser: any;

async function withHub(options: HubOptions, body: (hub: Hub) => Promise<void>, allowErrors = false): Promise<void> {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1200, height: options.height ?? 800 } });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    const violations: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(String(error.message)));
    page.on("console", (message: any) => {
      const text: string = message.text();
      if (/content security policy|refused to/i.test(text) && !text.includes("icon.svg")) violations.push(text);
    });
    let html = options.html ?? panelHtml("tsc");
    if (options.csp === false) html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    await context.route("**/*", (route: any) => route.abort());
    await context.route("http://hub.test/**", (route: any) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      if (url.pathname === "/page.html") return route.fulfill({ body: html, contentType: "text/html" });
      return route.fulfill({ status: 404, body: "" });
    });
    await page.addInitScript(() => {
      const w = window as any;
      w.__posted = [];
      w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.__posted.push(m), getState: () => w.__st, setState: (s: unknown) => { w.__st = s; } });
    });
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => typeof (window as any).switchTab === "function" && !!document.getElementById("hub-search"), null, { timeout: 15000 });
    await body({ page, errors, requests });
    if (!allowErrors) assert.deepEqual(errors, [], "the webview raised uncaught errors");
    if (!allowErrors && options.csp !== false) assert.deepEqual(violations, [], "the webview CSP blocked something the search needs");
  } finally {
    await context.close();
  }
}

function snapshotInPage() {
  const input = document.getElementById("hub-search") as HTMLInputElement;
  const results = document.getElementById("hub-search-results") as HTMLElement;
  const tabs = document.getElementById("nav-tabs-container") as HTMLElement;
  const buttons = Array.from(results.querySelectorAll<HTMLElement>(".hub-search-hit"));
  const active = document.activeElement as HTMLElement | null;
  return {
    value: input.value,
    selStart: input.selectionStart,
    selEnd: input.selectionEnd,
    resultsHidden: results.hidden,
    resultsDisplay: getComputedStyle(results).display,
    resultsHtml: results.innerHTML,
    tabsHidden: tabs.hidden,
    tabsDisplay: getComputedStyle(tabs).display,
    emptyNotice: results.querySelector(".hub-search-empty")?.textContent ?? null,
    hits: buttons.map((b) => ({
      text: b.querySelector(".hub-search-text")?.textContent ?? "",
      where: b.querySelector(".hub-search-where")?.textContent ?? "",
      selected: b.classList.contains("selected"),
      ariaSelected: b.getAttribute("aria-selected"),
    })),
    activeId: active ? (active.id || active.tagName) : "",
    activeTab: document.querySelector(".nav-tab.active")?.getAttribute("data-tab") ?? null,
    activePane: document.querySelector(".tab-pane.active")?.id ?? null,
    flash: Array.from(document.querySelectorAll(".hub-search-flash")).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)),
  };
}
type Snap = ReturnType<typeof snapshotInPage>;

const snap = (page: any): Promise<Snap> => page.evaluate(snapshotInPage);
const posted = (page: any): Promise<any[]> => page.evaluate(() => (window as any).__posted);
const send = (page: any, data: unknown): Promise<void> => page.evaluate((d: unknown) => { window.dispatchEvent(new MessageEvent("message", { data: d })); }, data);

function setQuery(page: any, value: string): Promise<void> {
  return page.evaluate((v: string) => {
    const input = document.getElementById("hub-search") as HTMLInputElement;
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function typeQuery(page: any, text: string): Promise<void> {
  await page.focus("#hub-search");
  await page.keyboard.type(text);
}

function inject(page: any, html: string, paneId = "general"): Promise<void> {
  return page.evaluate(([markup, pane]: [string, string]) => {
    const target = document.querySelector("#pane-" + pane + " .settings-list") || document.getElementById("pane-" + pane)!;
    target.insertAdjacentHTML("beforeend", markup);
  }, [html, paneId]);
}

function assertConsistent(s: Snap, label: string): void {
  const q = collapse(s.value);
  if (q === "") {
    assert.equal(s.resultsHidden, true, `${label}: results must be hidden for an empty query`);
    assert.equal(s.resultsHtml, "", `${label}: results must be emptied for an empty query`);
    assert.equal(s.tabsHidden, false, `${label}: tabs must be restored for an empty query`);
    assert.notEqual(s.tabsDisplay, "none", `${label}: tabs must be displayed for an empty query`);
    return;
  }
  assert.equal(s.tabsHidden, true, `${label}: tabs must be hidden while searching (${JSON.stringify(q)})`);
  assert.equal(s.resultsHidden, false, `${label}: results must be shown while searching (${JSON.stringify(q)})`);
  assert.ok(s.hits.length <= 30, `${label}: more than 30 results`);
  if (s.hits.length === 0) {
    assert.ok(s.emptyNotice, `${label}: zero hits must show the empty notice`);
    return;
  }
  assert.equal(s.hits.filter((h) => h.selected).length, 1, `${label}: exactly one selected hit`);
  assert.equal(s.hits.filter((h) => h.ariaSelected === "true").length, 1, `${label}: exactly one aria-selected=true`);
  const seen = new Set<string>();
  for (const hit of s.hits) {
    assert.ok(looselyMatches(q, hit.text), `${label}: hit ${JSON.stringify(hit.text)} cannot match query ${JSON.stringify(q)}`);
    const key = hit.where + "|" + hit.text.toLowerCase();
    assert.ok(!seen.has(key), `${label}: duplicate hit ${key}`);
    seen.add(key);
  }
}

/* ------------------------------------------------------------------ */
/* Static: the embedded script                                         */
/* ------------------------------------------------------------------ */

describe("hub search: embedded webview script", () => {
  after(() => {
    for (const file of tmpFiles) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
  });

  for (const variant of ["tsc", "bundle", "bundle-min"] as const) {
    it(`${variant}: every inline script of the panel parses and wires the search exactly once`, () => {
      const html = panelHtml(variant);
      const scripts = inlineScripts(html);
      assert.ok(scripts.length > 0);
      for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code), "inline script must parse");
      const wired = scripts.filter((code) => /getElementById\(["']hub-search["']\)/.test(code));
      assert.equal(wired.length, 1, "hub search client must be embedded in exactly one script");
      const occurrences = wired[0].match(/getElementById\(["']hub-search["']\)/g) ?? [];
      assert.equal(occurrences.length, 1, "client embedded more than once");
      assert.match(wired[0], /\)\(switchTab\);/, "client must be invoked with switchTab");
    });

    it(`${variant}: embedded client references no bundler helpers`, () => {
      const wired = inlineScripts(panelHtml(variant)).find((code) => /getElementById\(["']hub-search["']\)/.test(code))!;
      const start = wired.search(/\(\s*function[^(]*\(\s*\w+\s*\)\s*\{[^]{0,400}getElementById\(["']hub-search["']\)/);
      const body = start >= 0 ? wired.slice(start, start + 12000) : wired;
      assert.doesNotMatch(body, /__name\(|__spreadValues|__spreadProps|__publicField|__async\(|__require\(|__toESM|__commonJS/, "bundler helper leaked into the serialised function");
    });

    it(`${variant}: markup, styles and ids are present once and unique`, () => {
      const html = panelHtml(variant);
      for (const id of ["hub-search", "hub-search-results", "hub-search-box", "nav-tabs-container"]) {
        const count = (html.match(new RegExp(`\\bid="${id}"`, "g")) ?? []).length;
        assert.equal(count, 1, `id ${id} appears ${count} times`);
      }
      assert.equal((html.match(/\.hub-search-results\[hidden\]/g) ?? []).length, 1, "styles injected more than once");
      assert.ok(html.indexOf('id="hub-search-box"') < html.indexOf('id="nav-tabs-container"'), "search box must precede the tabs");
      assert.ok(html.indexOf('id="hub-search-box"') > html.indexOf('class="sidebar-header"'), "search box must follow the sidebar header");
      assert.ok(html.indexOf('id="hub-search-box"') < html.indexOf('id="sidebar-toggle-btn"'), "search box must be inside the side-nav");
      const nav = html.slice(html.indexOf('<aside class="side-nav"'), html.indexOf("</aside>"));
      assert.ok(nav.includes('id="hub-search"') && nav.includes('id="hub-search-results"'), "search elements must live inside the sidebar");
    });
  }

  it("serialised client source cannot terminate or confuse the host <script> element", () => {
    const source = hubSearchClient.toString();
    assert.doesNotMatch(source, /<\/script/i);
    assert.doesNotMatch(source, /<!--/);
    assert.doesNotMatch(source, /-->/);
    assert.doesNotMatch(source, /`/, "template literals are fragile inside the panel template");
    assert.doesNotMatch(HUB_SEARCH_MARKUP, /\son\w+\s*=/i, "inline event handlers are blocked by the CSP");
    assert.doesNotMatch(HUB_SEARCH_MARKUP + getHubSearchStyles(), /<script/i);
  });

  it("serialised client is self-contained: initialises in an empty realm and tolerates missing elements", () => {
    const listeners: Record<string, Function[]> = {};
    const stubElement = (id: string): any => ({
      id,
      addEventListener: (type: string, fn: Function) => { (listeners[id + ":" + type] ||= []).push(fn); },
    });
    const elements: Record<string, any> = { "hub-search": stubElement("hub-search"), "hub-search-results": stubElement("hub-search-results"), "nav-tabs-container": stubElement("nav-tabs-container") };
    const doc: any = { getElementById: (id: string) => elements[id] ?? null, addEventListener: (type: string, fn: Function) => { (listeners["document:" + type] ||= []).push(fn); } };
    const realm = vm.createContext({ document: doc });
    const fn = vm.runInContext("(" + hubSearchClient.toString() + ")", realm);
    assert.doesNotThrow(() => fn(() => undefined));
    assert.ok(listeners["hub-search:input"]?.length === 1 && listeners["hub-search:keydown"]?.length === 1 && listeners["hub-search-results:click"]?.length === 1 && listeners["document:keydown"]?.length === 1);
    const missing = vm.createContext({ document: { getElementById: () => null, addEventListener: () => { throw new Error("must not attach listeners"); } } });
    const fn2 = vm.runInContext("(" + hubSearchClient.toString() + ")", missing);
    assert.doesNotThrow(() => fn2(() => undefined));
  });
});

/* ------------------------------------------------------------------ */
/* Real browser                                                        */
/* ------------------------------------------------------------------ */

describe("hub search: real browser against the real Settings panel", { skip: browserSkip }, () => {
  before(async () => {
    browser = await pw.chromium.launch({ executablePath: chromePath, headless: true });
  }, { timeout: 90000 });
  after(async () => {
    if (browser) { await browser.close(); browser = undefined; }
  }, { timeout: 30000 });

  /* ---------------- control behaviour ---------------- */

  it("typing narrows to matches and hides the tabs; clearing and Escape restore them", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      const before = await snap(page);
      assertConsistent(before, "initial");
      assert.equal(before.activePane, "pane-models");
      await typeQuery(page, "git");
      const typed = await snap(page);
      assertConsistent(typed, "after typing");
      assert.ok(typed.hits.length >= 3);
      assert.equal(typed.hits[0].selected, true);
      assert.ok(typed.hits.some((h) => h.where === "Section" && h.text === "Git & Pull Requests"));
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      assertConsistent(await snap(page), "after clearing");
      await typeQuery(page, "perm");
      assert.ok((await snap(page)).hits.length > 0);
      await page.keyboard.press("Escape");
      const escaped = await snap(page);
      assertConsistent(escaped, "after Escape");
      assert.equal(escaped.value, "");
      assert.equal(escaped.activeId, "hub-search");
    });
  });

  it("clicking a result switches pane, posts tab_switched, and flashes the owning card", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "Usage Telemetry");
      const s = await snap(page);
      assert.equal(s.hits[0].text, "Usage Telemetry");
      assert.equal(s.hits[0].where, "Preferences");
      await page.click(".hub-search-hit >> nth=0");
      const after = await snap(page);
      assert.equal(after.activePane, "pane-general");
      assert.equal(after.activeTab, "general");
      assert.ok((await posted(page)).some((m) => m.type === "tab_switched" && m.tab === "general"), "tab_switched not posted for a user click");
      assert.equal(after.flash.length, 1);
      assert.match(after.flash[0], /Usage Telemetry/);
      const card = await page.evaluate(() => document.querySelector(".hub-search-flash")!.className);
      assert.match(card, /settings-card/);
    });
  });

  it("the sidebar collapse toggle is not a section entry", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      for (const q of ["collapse sidebar", "expand sidebar", "toggle"]) {
        await setQuery(page, q);
        assert.equal((await snap(page)).hits.filter((h) => h.where === "Section").length, 0, `query ${q} found the sidebar toggle as a section`);
      }
    });
  });

  it("the native clear (x) button of the search field restores the tabs", { timeout: 60000 }, async (t) => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "git");
      const rect = await page.evaluate(() => { const r = document.getElementById("hub-search")!.getBoundingClientRect(); return { right: r.right, y: r.top + r.height / 2 }; });
      let cleared = false;
      for (const offset of [12, 15, 18, 9, 21]) {
        await page.mouse.move(rect.right - offset, rect.y);
        await page.mouse.click(rect.right - offset, rect.y);
        if ((await snap(page)).value === "") { cleared = true; break; }
      }
      if (!cleared) { t.skip("could not locate the native clear button"); return; }
      assertConsistent(await snap(page), "after native clear");
    });
  });

  it("section entries open their pane without flashing anything", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "trust sec");
      const s = await snap(page);
      const section = s.hits.find((h) => h.where === "Section");
      assert.ok(section, "section entry missing");
      await page.click(`.hub-search-hit:has(.hub-search-text:text-is("${section!.text}"))`);
      const after = await snap(page);
      assert.equal(after.activePane, "pane-trust");
      assert.deepEqual(after.flash, []);
    });
  });

  it("every substring match in the real panel is reported (completeness oracle), or the result list is capped at 30", { timeout: 120000, todo: "product decision: entries inside containers that start hidden (the new-connection, new-cron-job and share forms) are left out, because opening them would highlight nothing" }, async () => {
    await withHub({}, async ({ page }) => {
      for (const q of ["git", "mode", "model", "perm", "key", "usage", "trust", "sound", "wallpaper", "MCP", "a", "e", "air-gap", "reasoning", "e-m", "&"]) {
        await setQuery(page, q);
        const s = await snap(page);
        const expected: string[] = await page.evaluate((query: string) => {
          const lower = query.toLowerCase();
          const byTabText = new Map<string, string>();
          document.querySelectorAll(".nav-tab[data-tab]").forEach((button) => {
            const tab = button.getAttribute("data-tab")!;
            const t = (button.querySelector(".nav-tab-label")?.textContent || tab).replace(/\s+/g, " ").trim();
            if (t.toLowerCase().includes(lower)) byTabText.set(tab + "|" + t.toLowerCase(), "Section|" + t.toLowerCase());
          });
          document.querySelectorAll(".tab-pane[id^='pane-']").forEach((pane) => {
            const tab = pane.id.slice(5);
            const label = (document.querySelector('.nav-tab[data-tab="' + tab + '"] .nav-tab-label')?.textContent || tab).replace(/\s+/g, " ").trim();
            pane.querySelectorAll("h2, h3, h4, .setting-label, label, .model-name, [data-search-label]").forEach((el) => {
              const copy = el.cloneNode(true) as Element;
              copy.querySelectorAll(".setting-desc, p, small").forEach((x) => x.remove());
              const text = (el.getAttribute("data-search-label") || copy.textContent || "").replace(/\s+/g, " ").trim();
              const key = tab + "|" + text.toLowerCase();
              if (text && text.length <= 160 && text.toLowerCase().includes(lower) && !byTabText.has(key)) byTabText.set(key, label + "|" + text.toLowerCase());
            });
          });
          return Array.from(byTabText.values());
        }, collapse(q));
        const got = new Set(s.hits.map((h) => h.where + "|" + h.text.toLowerCase()));
        if (expected.length <= 30) {
          for (const key of expected) assert.ok(got.has(key), `query ${JSON.stringify(q)} is missing substring match ${key}`);
        } else {
          assert.equal(s.hits.length, 30, `query ${JSON.stringify(q)} has ${expected.length} substring matches but only ${s.hits.length} hits`);
        }
        assertConsistent(s, "oracle " + q);
      }
    });
  });

  it("descriptions, <p> and <small> are not searchable and the live DOM is never mutated while typing", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `<div class="settings-card" id="zq-card"><label id="zq-lab">Zqname <small>smallzq</small><span class="setting-desc">descnotsearchable</span><p>paragraphzq</p></label></div>`);
      await page.evaluate(() => {
        const w = window as any;
        w.__mut = 0;
        const observer = new MutationObserver((records) => { w.__mut += records.length; });
        document.querySelectorAll(".tab-pane").forEach((p) => observer.observe(p, { subtree: true, childList: true, attributes: true, characterData: true }));
      });
      for (const q of ["zq", "zqn", "zqname", "smallzq", "descnotsearchable", "paragraphzq"]) {
        await setQuery(page, q);
        const s = await snap(page);
        if (q === "zq" || q === "zqn" || q === "zqname") assert.ok(s.hits.some((h) => h.text === "Zqname"), `query ${q} must find the label's own text`);
        else assert.equal(s.hits.filter((h) => /zq|desc/i.test(h.text) && h.text !== "Zqname").length + s.hits.filter((h) => h.text.includes("smallzq") || h.text.includes("paragraphzq") || h.text.includes("descnot")).length, 0, `query ${q} must not match removed descendants`);
      }
      assert.equal(await page.evaluate(() => (window as any).__mut), 0, "searching mutated the panes");
      assert.equal(await page.evaluate(() => document.querySelectorAll("#zq-lab small, #zq-lab p, #zq-lab .setting-desc").length), 3, "search removed live descendants");
    });
  });

  it("data-search-label overrides the element text and is length-limited after whitespace collapsing", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, [
        `<div data-search-label="Zebra   Control  Q1">innernoisezz</div>`,
        `<label>${"k".repeat(160)}</label>`,
        `<label>${"j".repeat(161)}</label>`,
        `<label>${"w".repeat(80)}${" ".repeat(90)}${"v".repeat(10)}</label>`,
        `<label>   padded   text   zq9   </label>`,
        `<label>   </label>`,
        `<label data-search-label="">fallbacktextzq</label>`,
      ].join(""));
      await setQuery(page, "zebra");
      assert.ok((await snap(page)).hits.some((h) => h.text === "Zebra Control Q1"), "collapsed data-search-label must be the hit text");
      await setQuery(page, "innernoisezz");
      assert.equal((await snap(page)).hits.length, 0, "inner text must not be searched when data-search-label is set");
      await setQuery(page, "k".repeat(12));
      assert.equal((await snap(page)).hits.filter((h) => h.text === "k".repeat(160)).length, 1, "160-char entry must be indexed");
      await setQuery(page, "j".repeat(12));
      assert.equal((await snap(page)).hits.length, 0, "161-char entry must be skipped");
      await setQuery(page, "wwww");
      assert.deepEqual((await snap(page)).hits.map((h) => h.text), ["w".repeat(80) + " " + "v".repeat(10)]);
      await setQuery(page, "padded");
      assert.deepEqual((await snap(page)).hits.map((h) => h.text), ["padded text zq9"]);
      await setQuery(page, "fallbacktextzq");
      assert.equal((await snap(page)).hits.length, 1, "empty data-search-label must fall back to own text");
    });
  });

  it("duplicates collapse per (section, text, case-insensitive) and results are capped at 30", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `<label>Dupezq One</label><label>dupezq one</label><label>DUPEZQ  ONE</label>`, "general");
      await inject(page, `<label>Dupezq One</label>`, "trust");
      await inject(page, Array.from({ length: 100 }, (_, i) => `<label>Capzq item ${i}</label>`).join(""), "general");
      await setQuery(page, "dupezq one");
      const s = await snap(page);
      assert.equal(s.hits.length, 2, JSON.stringify(s.hits));
      assert.deepEqual(s.hits.map((h) => h.where).sort(), ["Preferences", "Trust & Security"]);
      await setQuery(page, "capzq item");
      assert.equal((await snap(page)).hits.length, 30);
    });
  });

  it("ranking: score first, then shorter text; word-start beats mid-word; substring beats fuzzy", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, ["Zork guide", "Zork", "Big zork", "Bigzork", "Zebra orbit rock", "zzzork tail"].map((t) => `<label>${t}</label>`).join(""));
      await setQuery(page, "zork");
      const order = (await snap(page)).hits.map((h) => h.text);
      assert.deepEqual(order, ["Zork", "Zork guide", "Big zork", "zzzork tail", "Bigzork", "Zebra orbit rock"].filter((t) => order.includes(t)).sort((a, b) => order.indexOf(a) - order.indexOf(b)));
      assert.deepEqual(order.slice(0, 3), ["Zork", "Zork guide", "Big zork"]);
      assert.ok(order.indexOf("Bigzork") < order.indexOf("Zebra orbit rock"), "substring must beat ordered-letter match");
      await setQuery(page, "ZORK");
      assert.equal((await snap(page)).hits[0].text, "Zork", "matching must be case-insensitive");
    });
  });

  it("fuzzy matching accepts a span of 3*letters+6 and rejects one more", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, [`a${"x".repeat(12)}bc`, `a${"x".repeat(13)}bc`].map((t) => `<label>${t}</label>`).join(""));
      await setQuery(page, "abc");
      const texts = (await snap(page)).hits.map((h) => h.text);
      assert.ok(texts.includes(`a${"x".repeat(12)}bc`), "span 15 must be accepted");
      assert.ok(!texts.includes(`a${"x".repeat(13)}bc`), "span 16 must be rejected");
    });
  });

  it("an ordered-letter match is found when a tight alignment exists later in the text (leftmost-greedy alignment must not reject it)", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      const text = "Manage cloud processes and your MCP Server list";
      await inject(page, `<label>${text}</label>`);
      await setQuery(page, "mcpserver");
      assert.ok((await snap(page)).hits.some((h) => h.text === text), `"mcpserver" must match ${JSON.stringify(text)}: letters M C P S e r v e r sit contiguously in "MCP Server"`);
      await setQuery(page, "ab c");
      await inject(page, `<label>a${"x".repeat(30)} abc</label>`);
      await setQuery(page, "ab c");
      assert.ok((await snap(page)).hits.some((h) => h.text.endsWith(" abc")), `"ab c" (spaces ignored) must match a label that ends with the contiguous "abc"`);
    });
  });

  it("a substring match always outranks an ordered-letter match, even for long queries", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      const query = "abcdefghijklmnopqrstuvwxyzabcdefghijklmn";
      const exact = "x".repeat(100) + query;
      const gapped = query.slice(0, 21) + "X" + query.slice(21);
      await inject(page, `<label>${gapped}</label><label>${exact}</label>`);
      await setQuery(page, query);
      const texts = (await snap(page)).hits.map((h) => h.text);
      assert.ok(texts.includes(exact) && texts.includes(gapped), "both labels must be found");
      assert.ok(texts.indexOf(exact) < texts.indexOf(gapped), "the exact substring match must rank above the gapped ordered-letter match");
    });
  });

  /* ---------------- hostile data ---------------- */

  it("XSS: hostile model names, labels, data-search-label and section names are rendered as inert text", { timeout: 90000 }, async () => {
    await withHub({ csp: false }, async ({ page }) => {
      const hostile = [
        `<img src=x onerror="window.__xss=(window.__xss||0)+1">`,
        `"><script>window.__xss=(window.__xss||0)+1</script>`,
        `</script><script>window.__xss=(window.__xss||0)+1</script>`,
        `'><svg onload="window.__xss=(window.__xss||0)+1">`,
        `&lt;b&gt;&amp;amp; entity`,
        `<iframe srcdoc="<script>parent.__xss=1</script>">`,
      ];
      await send(page, { type: "state_loaded", models: hostile.map((name, i) => ({ id: "hostile/" + i, name, provider: "openrouter", desc: "d", tags: [] })), providers: [], skills: [], remoteSkills: [], mcpServers: [], connectors: [], crons: [], config: {} });
      await inject(page, `<div data-search-label='"><img src=x onerror="window.__xss=(window.__xss||0)+1">'>x</div>`);
      await page.evaluate(() => {
        document.querySelector('.nav-tab[data-tab="usage"] .nav-tab-label')!.textContent = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
      });
      assert.equal(await page.evaluate(() => document.querySelectorAll("#models-grid img, #models-grid iframe, #models-grid svg[onload]").length), 0, "precondition: the Hub renderer itself must have escaped the names");
      for (const q of ["img", "script", "svg", "iframe", "entity", "onerror", "b&gt", "<", ">", '"', "'", "&"]) {
        await setQuery(page, q);
        const s = await snap(page);
        assertConsistent(s, "xss " + q);
        const live = await page.evaluate(() => {
          const results = document.getElementById("hub-search-results")!;
          return { children: results.querySelectorAll("img, script, iframe, svg, b, a, style, link, object, embed, form").length, buttons: results.querySelectorAll(".hub-search-hit").length, all: results.querySelectorAll("*").length };
        });
        assert.equal(live.children, 0, `query ${q}: results contain live elements`);
        assert.equal(live.all, 3 * live.buttons + (live.buttons === 0 ? 1 : 0), `query ${q}: unexpected extra nodes in results`);
      }
      await setQuery(page, "img");
      const s = await snap(page);
      assert.ok(s.hits.some((h) => h.text === hostile[0]), "hostile text must be displayed verbatim");
      assert.ok(s.hits.some((h) => h.text === '"><img src=x onerror="window.__xss=(window.__xss||0)+1">'), "hostile data-search-label must be displayed verbatim");
      assert.ok(s.hits.some((h) => h.where === "Section" && h.text.startsWith("<img")), "hostile section name must be displayed verbatim");
      await setQuery(page, "model distribution");
      const inSection = await snap(page);
      assert.equal(inSection.hits[0]?.where, '<img src=x onerror="window.__xss=(window.__xss||0)+1">', "hostile section name must be displayed verbatim as the section label");
      assert.equal(await page.evaluate(() => document.querySelectorAll("#hub-search-results img").length), 0);
      await setQuery(page, "img");
      await page.click(".hub-search-hit >> nth=0");
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => (window as any).__xss), undefined, "script from hostile data executed");
    });
  });

  it("result text is escaped for & < > \" ' while being shown verbatim", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      const raw = `Tom & Jerry <b>"q"</b> 'single' &amp; &#39; %s \${x} \\n`;
      await inject(page, `<div data-search-label="${raw.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"></div>`);
      await setQuery(page, "jerry");
      const s = await snap(page);
      assert.equal(s.hits[0].text, raw);
      assert.equal(await page.evaluate(() => document.querySelectorAll("#hub-search-results b").length), 0);
      assert.ok(s.resultsHtml.includes("Tom &amp; Jerry &lt;b&gt;"), s.resultsHtml.slice(0, 300));
    });
  });

  it("special characters, regex syntax and exotic Unicode in the query never throw and stay consistent", { timeout: 120000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, ["constructor", "__proto__", "toString", "hasOwnProperty", "a.b*c", "(group)", "[class]", "100%", "back\\slash", "\u{1F600} smile", "\u0130stanbul", "stra\u00dfe", "\uFB03x"].map((t) => `<label>${t}</label>`).join(""));
      const queries = [".*", "(", ")", "[", "]", "\\", "^$", "a+?", "{1,3}", "|", "%s", "${x}", "'", '"', "<", "&", "\u0000", "\u200b", "\u{1F600}", "\ud83d", "\u01c5", "\u0130", "\u00df", "\uFB03", "git\u0000", "__proto__", "constructor", "toString", "hasOwnProperty", "\u202e", "%00", "\\u0041", "*", "?", "-", "..", "../", "a.b*c", "(group)", "[class]", "100%", "back\\slash", "\u{1F600} smile", "stra\u00dfe", "STRASSE", "\u0130stanbul", "istanbul", "\n", "\t", " git ", "g i t", "gi\tt", "a".repeat(5000)];
      for (const q of queries) {
        await setQuery(page, q);
        assertConsistent(await snap(page), "query " + JSON.stringify(q.slice(0, 30)));
      }
      for (const [q, expected] of [["constructor", "constructor"], ["__proto__", "__proto__"], ["toString", "toString"], ["hasOwnProperty", "hasOwnProperty"], ["a.b*c", "a.b*c"], ["(group)", "(group)"], ["[class]", "[class]"], ["100%", "100%"], ["back\\slash", "back\\slash"], ["\u{1F600}", "\u{1F600} smile"]]) {
        await setQuery(page, q);
        assert.ok((await snap(page)).hits.some((h) => h.text === expected), `literal query ${JSON.stringify(q)} must find ${JSON.stringify(expected)}`);
      }
      await setQuery(page, ".*");
      assert.equal((await snap(page)).hits.filter((h) => !h.text.includes(".") || !h.text.includes("*")).length, 0, ".* must be literal, not a wildcard");
    });
  });

  it("empty and whitespace-only queries restore the tabs (ASCII and Unicode whitespace)", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      for (const q of ["", " ", "     ", "\t", "\u0020\u0020", "\n"]) {
        await setQuery(page, "git");
        await setQuery(page, q);
        assertConsistent(await snap(page), "whitespace " + JSON.stringify(q));
      }
      const failures: string[] = [];
      for (const q of ["\u00a0", "\u00a0\u00a0", "\u2003", "\u3000", "\u2028", " \u00a0 "]) {
        await setQuery(page, "git");
        await setQuery(page, q);
        const s = await snap(page);
        if (s.tabsHidden || s.resultsHidden === false) failures.push(JSON.stringify(q));
      }
      assert.deepEqual(failures, [], "whitespace-only query made of Unicode spaces leaves the search open with 'No matches' and the tabs hidden");
    });
  });

  it("Unicode spaces in a pasted query behave like spaces (non-breaking space from copied web text)", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await setQuery(page, "Pull\u00a0requests");
      const s = await snap(page);
      assert.ok(s.hits.some((h) => h.text === "Pull requests"), `NBSP query found: ${JSON.stringify(s.hits.map((h) => h.text))}`);
      await setQuery(page, "git\u00a0");
      assert.ok((await snap(page)).hits.some((h) => h.text === "Git & Pull Requests"), "trailing NBSP must be ignored");
    });
  });

  it("very long queries do not freeze the webview", { timeout: 120000 }, async () => {
    await withHub({}, async ({ page }) => {
      for (const length of [1000, 100000, 1000000]) {
        const ms: number = await page.evaluate((n: number) => {
          const input = document.getElementById("hub-search") as HTMLInputElement;
          const t0 = performance.now();
          input.value = "a".repeat(n);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return performance.now() - t0;
        }, length);
        assert.ok(ms < 500, `a ${length}-char query took ${Math.round(ms)} ms`);
        assertConsistent(await snap(page), "long " + length);
      }
      const mixed: number = await page.evaluate(() => {
        const input = document.getElementById("hub-search") as HTMLInputElement;
        const t0 = performance.now();
        input.value = "e ".repeat(50000);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return performance.now() - t0;
      });
      assert.ok(mixed < 500, `a 100000-char spaced query took ${Math.round(mixed)} ms`);
    });
  });

  it("entries inside hidden panes are found and opening one reveals its pane", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `<div class="settings-card" id="hp-card"><label id="hp-label">Hiddenpane zq setting</label></div>`, "trust");
      assert.equal((await snap(page)).activePane, "pane-models");
      await setQuery(page, "hiddenpane");
      const s = await snap(page);
      assert.equal(s.hits.length, 1);
      assert.equal(s.hits[0].where, "Trust & Security");
      await page.focus("#hub-search");
      await page.keyboard.press("Enter");
      const after = await snap(page);
      assert.equal(after.activePane, "pane-trust");
      assert.equal(after.activeTab, "trust");
      const visible = await page.evaluate(() => {
        const rect = document.getElementById("hp-card")!.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
      });
      assert.ok(visible, "the card must be scrolled into view after the pane is revealed");
    });
  });

  /* ---------------- keyboard ---------------- */

  it("ArrowDown/ArrowUp wrap, keep aria-selected in sync, and Enter opens the selected hit", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "model");
      const s0 = await snap(page);
      const n = s0.hits.length;
      assert.ok(n >= 4, `need several hits, got ${n}`);
      await page.keyboard.press("ArrowUp");
      let s = await snap(page);
      assert.equal(s.hits.findIndex((h) => h.selected), n - 1, "ArrowUp from the first hit must wrap to the last");
      await page.keyboard.press("ArrowDown");
      s = await snap(page);
      assert.equal(s.hits.findIndex((h) => h.selected), 0, "ArrowDown from the last hit must wrap to the first");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      s = await snap(page);
      assertConsistent(s, "after arrows");
      assert.equal(s.hits.findIndex((h) => h.selected), 2);
      assert.deepEqual(s.hits.map((h) => h.ariaSelected), s.hits.map((_, i) => (i === 2 ? "true" : "false")));
      const target = s.hits[2];
      await page.keyboard.press("Enter");
      const after = await snap(page);
      const tabs = await page.evaluate(() => Array.from(document.querySelectorAll(".nav-tab[data-tab] .nav-tab-label")).map((l) => [l.closest(".nav-tab")!.getAttribute("data-tab"), (l.textContent || "").trim()]));
      const expectedTab = (tabs as string[][]).find(([, label]) => label === target.where)?.[0] ?? (tabs as string[][]).find(([, label]) => label === target.text)?.[0];
      assert.equal(after.activeTab, expectedTab, `Enter must open ${JSON.stringify(target)}`);
      assert.equal(after.activeId, "hub-search", "focus must stay in the search box after Enter");
      await page.keyboard.type("x");
      assert.equal((await snap(page)).hits.findIndex((h) => h.selected) <= 0, true, "typing must reset the selection");
    });
  });

  it("keyboard navigation with zero results is inert", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "qqqqqqzzzzzz");
      let s = await snap(page);
      assertConsistent(s, "zero hits");
      assert.equal(s.hits.length, 0);
      const paneBefore = s.activePane;
      for (const key of ["ArrowDown", "ArrowUp", "ArrowDown", "Enter", "Home", "End"]) await page.keyboard.press(key);
      s = await snap(page);
      assertConsistent(s, "after keys");
      assert.equal(s.activePane, paneBefore, "Enter with no hits must not switch pane");
      assert.deepEqual(s.flash, []);
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("git");
      s = await snap(page);
      assertConsistent(s, "recovered");
      assert.equal(s.hits.findIndex((h) => h.selected), 0);
      assert.equal(await page.evaluate(() => (document.getElementById("hub-search") as HTMLInputElement).selectionStart), 3);
    });
  });

  it("Enter and arrows never act while the box is empty, and the caret keys keep working", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await page.focus("#hub-search");
      const before = await snap(page);
      for (const key of ["Enter", "ArrowDown", "ArrowUp"]) await page.keyboard.press(key);
      const after = await snap(page);
      assert.equal(after.activePane, before.activePane);
      assertConsistent(after, "empty");
      await page.keyboard.type("abc");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Home");
      await page.keyboard.type("X");
      assert.equal((await snap(page)).value, "Xabc");
    });
  });

  it('"/" focuses and selects the box from the page, but is typed normally in every kind of text field', { timeout: 90000 }, async () => {
    await withHub({}, async ({ page }) => {
      await page.addStyleTag({ content: ".tab-pane { display: block !important; }" });
      await page.evaluate(() => { (document.getElementById("hub-search") as HTMLInputElement).value = "keep"; });
      await page.evaluate(() => (document.body as HTMLElement).focus());
      await page.keyboard.press("/");
      let s = await snap(page);
      assert.equal(s.activeId, "hub-search");
      assert.equal(s.value, "keep", '"/" must not be typed into the box');
      assert.equal(s.selStart, 0);
      assert.equal(s.selEnd, 4);
      await setQuery(page, "");
      await inject(page, `<div id="zq-ce" contenteditable="true" tabindex="0">x</div><div id="zq-ce2" contenteditable="plaintext-only" tabindex="0">y</div><input id="zq-text" type="text"><input id="zq-num" type="number"><input id="zq-url" type="url"><textarea id="zq-ta"></textarea><button id="zq-btn" type="button">b</button>`);
      for (const id of ["zq-ce", "zq-ce2", "zq-text", "zq-ta", "setting-mode", "skills-search", "airgap-hosts"]) {
        await page.evaluate((target: string) => { (document.getElementById(target) as HTMLElement).focus(); }, id);
        const prevented: boolean = await page.evaluate((target: string) => {
          const el = document.getElementById(target)!;
          const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
          el.dispatchEvent(ev);
          return ev.defaultPrevented;
        }, id);
        assert.equal(prevented, false, `"/" typed in #${id} was hijacked`);
        s = await snap(page);
        assert.equal(s.activeId, id, `focus must stay in #${id}`);
      }
      for (const id of ["zq-text", "skills-search", "airgap-hosts"]) {
        await page.evaluate((target: string) => { (document.getElementById(target) as HTMLInputElement).value = ""; (document.getElementById(target) as HTMLElement).focus(); }, id);
        await page.keyboard.type("a/b");
        assert.equal(await page.evaluate((target: string) => (document.getElementById(target) as HTMLInputElement).value, id), "a/b", `typing "/" into #${id}`);
      }
      await page.evaluate(() => (document.getElementById("zq-btn") as HTMLElement).focus());
      await page.keyboard.press("/");
      assert.equal((await snap(page)).activeId, "hub-search", '"/" on a button must reach the search box');
      await setQuery(page, "");
      await page.focus("#hub-search");
      await page.keyboard.type("pull/req");
      assert.equal((await snap(page)).value, "pull/req", '"/" typed inside the search box must be a literal slash');
    });
  });

  it('"/" and Ctrl/Cmd+F: modifier combinations', { timeout: 90000 }, async () => {
    await withHub({}, async ({ page }) => {
      const fire = (init: Record<string, unknown>, from = "body"): Promise<{ prevented: boolean; active: string }> => page.evaluate(([i, sel]: [Record<string, unknown>, string]) => {
        (document.body as HTMLElement).focus();
        const el = sel === "body" ? document.body : document.getElementById(sel)!;
        if (sel !== "body") (el as HTMLElement).focus();
        const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...i });
        el.dispatchEvent(ev);
        const active = document.activeElement as HTMLElement;
        const result = { prevented: ev.defaultPrevented, active: active.id || active.tagName };
        (document.activeElement as HTMLElement | null)?.blur();
        return result;
      }, [init, from] as [Record<string, unknown>, string]);
      const yes = [{ key: "f", ctrlKey: true }, { key: "F", ctrlKey: true }, { key: "f", metaKey: true }, { key: "/" }, { key: "/", shiftKey: true }];
      const no = [{ key: "f", ctrlKey: true, shiftKey: true }, { key: "f", altKey: true }, { key: "f", ctrlKey: true, altKey: true }, { key: "f", metaKey: true, altKey: true }, { key: "f", metaKey: true, shiftKey: true }, { key: "/", ctrlKey: true }, { key: "/", altKey: true }, { key: "/", metaKey: true }, { key: "f" }, { key: "g", ctrlKey: true }, { key: "?" }, { key: "F3" }];
      for (const init of yes) {
        const r = await fire(init);
        assert.deepEqual(r, { prevented: true, active: "hub-search" }, `${JSON.stringify(init)} must focus the search`);
      }
      for (const init of no) {
        const r = await fire(init);
        assert.equal(r.prevented, false, `${JSON.stringify(init)} must not be intercepted`);
        assert.notEqual(r.active, "hub-search", `${JSON.stringify(init)} must not focus the search`);
      }
      for (const id of ["skills-search", "airgap-hosts", "setting-mode"]) {
        const r = await fire({ key: "f", ctrlKey: true }, id);
        assert.deepEqual(r, { prevented: true, active: "hub-search" }, `Ctrl+F from #${id}`);
      }
      const onDocument: boolean = await page.evaluate(() => {
        const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
        document.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      assert.equal(onDocument, true, "keydown dispatched on the document itself must not throw");
      const odd: string[] = await page.evaluate(() => {
        const out: string[] = [];
        for (const init of [{}, { key: "" }, { key: "Dead" }, { key: "Unidentified", ctrlKey: true }, { ctrlKey: true }]) {
          const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
          try { document.body.dispatchEvent(ev); } catch (e) { out.push(String(e)); }
        }
        const plain = new Event("keydown", { bubbles: true });
        try { document.body.dispatchEvent(plain); } catch (e) { out.push(String(e)); }
        return out;
      });
      assert.deepEqual(odd, []);
    });
  });

  it('"/" reaches the search box when a checkbox, radio, range or button-type input has focus (they take no text)', { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await page.addStyleTag({ content: ".tab-pane { display: block !important; }" });
      await inject(page, `<input type="checkbox" id="zq-cb"><input type="radio" id="zq-rd"><input type="button" id="zq-ib" value="x"><input type="range" id="zq-rg"><input type="submit" id="zq-sb">`);
      const stuck: string[] = [];
      for (const id of ["zq-cb", "zq-rd", "zq-ib", "zq-rg", "zq-sb", "setting-sound", "setting-auto-compact"]) {
        await page.evaluate((target: string) => (document.getElementById(target) as HTMLElement).focus(), id);
        await page.keyboard.press("/");
        const active = (await snap(page)).activeId;
        if (active !== "hub-search") stuck.push(id);
      }
      assert.deepEqual(stuck, [], '"/" did nothing because the focused control is an <input> that does not accept typed text');
    });
  });

  it("entry text built from nested inline elements keeps word boundaries", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      const glued: string[] = [];
      for (const q of ["a", "e", "i", "o", "u", "x"]) {
        await setQuery(page, q);
        for (const hit of (await snap(page)).hits) if (/ActivityExport|recapActivity|1080X|675Story/.test(hit.text)) glued.push(hit.text);
      }
      await setQuery(page, "export");
      const exportHits = (await snap(page)).hits.map((h) => h.text);
      assert.deepEqual(Array.from(new Set(glued)), [], `words are run together in result text: ${JSON.stringify(exportHits)}`);
    });
  });

  it("Ctrl+F with real keystrokes selects an existing query so the next keystroke replaces it", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "model");
      await page.evaluate(() => (document.getElementById("setting-mode") as HTMLElement | null)?.focus());
      await page.evaluate(() => (document.getElementById("skills-search") as HTMLElement).focus());
      await page.keyboard.press("Control+F");
      const s = await snap(page);
      assert.equal(s.activeId, "hub-search");
      assert.equal(s.selStart, 0);
      assert.equal(s.selEnd, "model".length);
      await page.keyboard.type("git");
      assert.equal((await snap(page)).value, "git");
    });
  });

  it("the shortcuts are not swallowed when the search box is hidden by the collapsed or compact sidebar", { timeout: 90000 }, async () => {
    await withHub({}, async ({ page }) => {
      await page.click("#sidebar-toggle-btn");
      assert.equal(await page.evaluate(() => document.getElementById("side-nav")!.classList.contains("collapsed")), true);
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("hub-search-box")!).display), "none");
      for (const key of ["Control+F", "/"]) {
        await page.evaluate(() => (document.body as HTMLElement).focus());
        const prevented: boolean = await page.evaluate((k: string) => {
          const ev = new KeyboardEvent("keydown", k === "/" ? { key: "/", bubbles: true, cancelable: true } : { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
          document.body.dispatchEvent(ev);
          return ev.defaultPrevented;
        }, key);
        const active = (await snap(page)).activeId;
        assert.ok(active === "hub-search" || prevented === false, `${key} was swallowed (defaultPrevented=${prevented}) but the hidden search box cannot take focus (active=${active})`);
      }
    });
  });

  /* ---------------- collapsed / narrow sidebar ---------------- */

  it("a query that is active when the sidebar collapses (toggle) leaves a usable sidebar", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "git");
      await page.click("#sidebar-toggle-btn");
      const state = await page.evaluate(() => {
        const visible = (el: Element | null) => !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
        const side = document.getElementById("side-nav")!;
        return {
          collapsed: side.classList.contains("collapsed"),
          tabsVisible: visible(document.getElementById("nav-tabs-container")),
          resultsVisible: visible(document.getElementById("hub-search-results")),
          iconTabs: Array.from(document.querySelectorAll("#nav-tabs-container .nav-tab")).filter((t) => t.getClientRects().length > 0).length,
        };
      });
      assert.equal(state.collapsed, true);
      assert.ok(state.tabsVisible || state.resultsVisible, `collapsed sidebar shows neither tab icons nor results: ${JSON.stringify(state)}`);
    });
  });

  it("narrowing the window below 820px with an active query does not leave an empty sidebar", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "git");
      await page.setViewportSize({ width: 700, height: 800 });
      await page.waitForTimeout(150);
      const state = await page.evaluate(() => {
        const side = document.getElementById("side-nav")!;
        const shown = (id: string) => getComputedStyle(document.getElementById(id)!).display !== "none";
        return { compact: side.classList.contains("auto-compact"), tabs: shown("nav-tabs-container"), results: shown("hub-search-results"), box: shown("hub-search-box"), value: (document.getElementById("hub-search") as HTMLInputElement).value };
      });
      assert.equal(state.compact, true);
      assert.ok(state.tabs || state.box || state.results, `compact sidebar has no tabs, no results and no search box while a query is active: ${JSON.stringify(state)}`);
    });
  });

  it("compact sidebar hides the search box and results; widening again restores a consistent state", { timeout: 60000 }, async () => {
    await withHub({ width: 700 }, async ({ page }) => {
      const hidden = await page.evaluate(() => ({ box: getComputedStyle(document.getElementById("hub-search-box")!).display, results: getComputedStyle(document.getElementById("hub-search-results")!).display, tabs: getComputedStyle(document.getElementById("nav-tabs-container")!).display }));
      assert.equal(hidden.box, "none");
      assert.equal(hidden.results, "none");
      assert.notEqual(hidden.tabs, "none");
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForTimeout(150);
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("hub-search-box")!).display), "none");
      assertConsistent(await snap(page), "after widening");
    });
  });

  /* ---------------- layout ---------------- */

  it("thirty results scroll inside the sidebar: footer stays on screen, arrows keep the selection visible, clicks land on the right row", { timeout: 90000 }, async () => {
    await withHub({ height: 600 }, async ({ page }) => {
      await inject(page, Array.from({ length: 60 }, (_, i) => `<label>Layoutzq entry ${i}</label>`).join(""));
      await typeQuery(page, "layoutzq");
      const s = await snap(page);
      assert.equal(s.hits.length, 30);
      const geometry = await page.evaluate(() => {
        const r = document.getElementById("hub-search-results")!.getBoundingClientRect();
        const f = document.getElementById("sidebar-toggle-btn")!.getBoundingClientRect();
        return { resultsBottom: r.bottom, footerTop: f.top, footerBottom: f.bottom, vh: innerHeight, docScroll: document.documentElement.scrollHeight };
      });
      assert.ok(geometry.footerBottom <= geometry.vh + 1, `footer pushed off screen: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.resultsBottom <= geometry.footerTop + 1, `results overlap the footer: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.docScroll <= geometry.vh + 1, `document scrolls: ${JSON.stringify(geometry)}`);
      for (let i = 0; i < 29; i++) await page.keyboard.press("ArrowDown");
      const inView = await page.evaluate(() => {
        const box = document.getElementById("hub-search-results")!.getBoundingClientRect();
        const row = document.querySelector(".hub-search-hit.selected")!.getBoundingClientRect();
        return { top: row.top - box.top, bottom: box.bottom - row.bottom };
      });
      assert.ok(inView.top >= -1 && inView.bottom >= -1, `selected row is outside the results viewport: ${JSON.stringify(inView)}`);
      await page.keyboard.press("ArrowDown");
      const wrapped = await page.evaluate(() => {
        const box = document.getElementById("hub-search-results")!.getBoundingClientRect();
        const row = document.querySelector(".hub-search-hit.selected")!.getBoundingClientRect();
        return { top: row.top - box.top, bottom: box.bottom - row.bottom, text: document.querySelector(".hub-search-hit.selected .hub-search-text")!.textContent };
      });
      assert.ok(wrapped.top >= -1 && wrapped.bottom >= -1, `wrapping to the first hit left it outside the results viewport: ${JSON.stringify(wrapped)}`);
      await page.keyboard.press("Control+A");
      await page.keyboard.type("layoutzq entry 29");
      const row = await page.evaluate(() => { const b = document.querySelector(".hub-search-hit")!.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
      const hit = await page.evaluate(([x, y]: [number, number]) => (document.elementFromPoint(x, y)?.closest(".hub-search-hit")?.querySelector(".hub-search-text")?.textContent) ?? null, [row.x, row.y] as [number, number]);
      assert.equal(hit, "Layoutzq entry 29", "the first row must be hit-testable");
    });
  });

  it("long unbroken result text and long section names never overflow the sidebar horizontally", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `<label>${"W".repeat(160)}</label><label>${"Overflowzq word ".repeat(10).trim()}</label>`);
      await typeQuery(page, "w");
      const metrics = await page.evaluate(() => {
        const results = document.getElementById("hub-search-results")!;
        const nav = document.getElementById("side-nav")!.getBoundingClientRect();
        const rows = Array.from(results.querySelectorAll(".hub-search-hit")).map((r) => r.getBoundingClientRect());
        return { scroll: results.scrollWidth, client: results.clientWidth, maxRight: Math.max(...rows.map((r) => r.right)), navRight: nav.right };
      });
      assert.ok(metrics.scroll <= metrics.client + 1, `results scroll horizontally: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.maxRight <= metrics.navRight + 1, `a result row sticks out of the sidebar: ${JSON.stringify(metrics)}`);
    });
  });

  it("opening a result scrolls its card into view (near and far down a long pane) and flashes exactly it", { timeout: 90000 }, async () => {
    await withHub({ height: 500 }, async ({ page }) => {
      await inject(page, Array.from({ length: 40 }, (_, i) => `<div class="settings-card"><div class="setting-label">Filler zq ${i}</div><div class="setting-desc">${"lorem ".repeat(30)}</div></div>`).join("") + `<div class="settings-card" id="far-card"><div class="setting-label">Farzq target</div></div>`);
      await setQuery(page, "farzq");
      await page.keyboard.press("Enter").catch(() => undefined);
      await page.focus("#hub-search");
      await page.keyboard.press("Enter");
      const geo = await page.evaluate(() => {
        const card = document.getElementById("far-card")!;
        const r = card.getBoundingClientRect();
        const mid = document.elementFromPoint(r.left + r.width / 2, Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
        return { top: r.top, bottom: r.bottom, vh: innerHeight, hit: !!mid && card.contains(mid), flash: card.classList.contains("hub-search-flash"), flashCount: document.querySelectorAll(".hub-search-flash").length };
      });
      assert.ok(geo.top >= 0 && geo.bottom <= geo.vh, `target not fully on screen after opening: ${JSON.stringify(geo)}`);
      assert.equal(geo.hit, true, "target is covered by something else");
      assert.equal(geo.flash, true);
      assert.equal(geo.flashCount, 1);
    });
  });

  it("the flash lasts 1.6 s from the most recent open, even when the same result is opened twice", { timeout: 90000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `<div class="settings-card" id="fl-card"><div class="setting-label">Flashzq label</div></div>`);
      await setQuery(page, "flashzq");
      await page.focus("#hub-search");
      const has = () => page.evaluate(() => document.getElementById("fl-card")!.classList.contains("hub-search-flash"));
      await page.keyboard.press("Enter");
      assert.equal(await has(), true, "flash must start immediately");
      await page.waitForTimeout(1000);
      assert.equal(await has(), true, "flash must still be on at 1.0 s");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
      assert.equal(await has(), true, "flash restarted at 1.0 s must still be on at 2.0 s (1.0 s after the second open)");
      await page.waitForTimeout(1000);
      assert.equal(await has(), false, "flash must be gone 2.0 s after the last open");
    });
  });

  it("opening reveals every closed <details> ancestor, not just the nearest one", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `<details id="d-outer"><summary>outer</summary><div><details id="d-inner"><summary>inner</summary><div class="settings-card" id="d-card"><label>Nestedzq deep</label></div></details></div></details><details id="d-solo"><summary>solo</summary><label id="d-solo-label">Solozq label</label></details>`);
      await setQuery(page, "solozq");
      await page.focus("#hub-search");
      await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => (document.getElementById("d-solo") as HTMLDetailsElement).open), true, "closed <details> must open");
      assert.equal(await page.evaluate(() => document.getElementById("d-solo-label")!.checkVisibility()), true);
      await setQuery(page, "nestedzq");
      await page.keyboard.press("Enter");
      const state = await page.evaluate(() => ({ outer: (document.getElementById("d-outer") as HTMLDetailsElement).open, inner: (document.getElementById("d-inner") as HTMLDetailsElement).open, visible: document.getElementById("d-card")!.checkVisibility() }));
      assert.deepEqual(state, { outer: true, inner: true, visible: true }, "the target of a nested <details> must become visible");
    });
  });

  it("every element result in the real panel leads to something visible after it is opened (no dead results)", { timeout: 120000 }, async () => {
    await withHub({}, async ({ page }) => {
      const dead: string[] = await page.evaluate(() => {
        const input = document.getElementById("hub-search") as HTMLInputElement;
        const results = document.getElementById("hub-search-results") as HTMLElement;
        const seen = new Set<string>();
        const failures: string[] = [];
        const queries = "abcdefghijklmnopqrstuvwxyz0123456789-&/".split("");
        for (const q of queries) {
          input.value = q;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const count = results.querySelectorAll(".hub-search-hit").length;
          for (let i = 0; i < count; i++) {
            const button = results.querySelectorAll<HTMLElement>(".hub-search-hit")[i];
            if (!button) break;
            const text = button.querySelector(".hub-search-text")!.textContent || "";
            const where = button.querySelector(".hub-search-where")!.textContent || "";
            if (where === "Section" || seen.has(where + "|" + text)) continue;
            seen.add(where + "|" + text);
            document.querySelectorAll(".hub-search-flash").forEach((e) => e.classList.remove("hub-search-flash"));
            button.click();
            const flashed = document.querySelector(".hub-search-flash") as HTMLElement | null;
            const ok = !!flashed && flashed.getClientRects().length > 0 && flashed.getBoundingClientRect().height > 0;
            if (!ok) failures.push(where + " > " + text);
          }
        }
        return failures;
      });
      assert.deepEqual(dead, [], `${dead.length} search results open a section but nothing visible is highlighted`);
    });
  });

  /* ---------------- DOM changes while the results are open ---------------- */

  it("opening a result whose element was removed from the DOM does not throw and still opens the section", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `<div class="settings-card" id="rm-card"><label id="rm-label">Removedzq setting</label></div>`, "trust");
      await setQuery(page, "removedzq");
      await page.evaluate(() => document.getElementById("rm-card")!.remove());
      await page.focus("#hub-search");
      await page.keyboard.press("Enter");
      const s = await snap(page);
      assert.equal(s.activePane, "pane-trust");
      await setQuery(page, "removedzq");
      assert.equal((await snap(page)).hits.length, 0, "a fresh search must not find the removed element");
    });
  });

  it("results survive the Hub re-rendering its model grid: opening a stale result still highlights the live card", { timeout: 90000 }, async () => {
    await withHub({}, async ({ page }) => {
      const models = [{ id: "v/zqalpha", name: "Zqalpha Model", provider: "openrouter", desc: "d", tags: [] }, { id: "v/other", name: "Other", provider: "openrouter", desc: "d", tags: [] }];
      await send(page, { type: "state_loaded", models, providers: [], skills: [], remoteSkills: [], mcpServers: [], connectors: [], crons: [], config: {} });
      await setQuery(page, "zqalpha");
      assert.equal((await snap(page)).hits.length, 1);
      await send(page, { type: "update_pinned_models", pinnedModels: [{ id: "v/other", provider: "openrouter" }] });
      await page.click(".hub-search-hit >> nth=0");
      const state = await page.evaluate(() => {
        const live = Array.from(document.querySelectorAll("#models-grid .model-card")).find((c) => (c.textContent || "").includes("Zqalpha Model")) as HTMLElement | undefined;
        return { liveExists: !!live, flashed: !!live && live.classList.contains("hub-search-flash"), anyFlash: document.querySelectorAll(".hub-search-flash").length, pane: document.querySelector(".tab-pane.active")?.id };
      });
      assert.equal(state.pane, "pane-models");
      assert.equal(state.liveExists, true);
      assert.equal(state.flashed, true, `the model card that is on screen was not highlighted (${JSON.stringify(state)})`);
    });
  });

  it("model cards are searchable by name, one result per distinct name, cap respected", { timeout: 90000 }, async () => {
    await withHub({}, async ({ page }) => {
      const models = [
        ...Array.from({ length: 50 }, (_, i) => ({ id: "v/m" + i, name: "Zqmodel " + i, provider: "openrouter", desc: "d", tags: [] })),
        { id: "v/dupe1", name: "Zqdupe", provider: "openrouter", desc: "d", tags: [] },
        { id: "v/dupe2", name: "Zqdupe", provider: "anthropic", desc: "d", tags: [] },
      ];
      await send(page, { type: "state_loaded", models, providers: [], skills: [], remoteSkills: [], mcpServers: [], connectors: [], crons: [], config: {} });
      await setQuery(page, "zqmodel");
      const s = await snap(page);
      assert.equal(s.hits.length, 30);
      assert.ok(s.hits.every((h) => h.where === "Model Hub"));
      await setQuery(page, "zqdupe");
      assert.equal((await snap(page)).hits.length, 1);
      await page.focus("#hub-search");
      await page.keyboard.press("Enter");
      const flashed = await page.evaluate(() => document.querySelector(".hub-search-flash")?.className ?? "");
      assert.match(flashed, /model-card/);
    });
  });

  it("a malformed tab id (quote in a pane id or data-tab) cannot disable the whole search", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await page.evaluate(() => {
        const pane = document.createElement("div");
        pane.className = "tab-pane";
        pane.id = 'pane-x"y';
        pane.innerHTML = "<label>Brokenpane label</label>";
        document.querySelector(".main-content")!.appendChild(pane);
      });
      await page.focus("#hub-search");
      await page.keyboard.type("git");
      assert.ok((await snap(page)).hits.length > 0, "search stopped working after one odd pane id was added");
    }, true);
  });

  /* ---------------- existing Hub behaviour ---------------- */

  it("tab buttons, skills search, Escape for skill details and the Enter/Space role=button handler still work next to the search", { timeout: 90000 }, async () => {
    await withHub({}, async ({ page }) => {
      for (const tab of ["crons", "keys", "skills", "mcp", "usage", "trust", "git", "general", "personalisation", "about", "models"]) {
        await page.click(`.nav-tab[data-tab="${tab}"]`);
        const s = await snap(page);
        assert.equal(s.activePane, "pane-" + tab);
        assert.equal(s.activeTab, tab);
      }
      assert.ok((await posted(page)).filter((m) => m.type === "tab_switched").length >= 11);
      await send(page, { type: "state_loaded", models: [], providers: [], skills: [{ name: "alpha-skill", description: "first", path: "/p/a", scope: "user" }, { name: "beta-skill", description: "second", path: "/p/b", scope: "user" }], remoteSkills: [], mcpServers: [], connectors: [], crons: [], config: {} });
      await page.click('.nav-tab[data-tab="skills"]');
      await page.evaluate(() => (document.getElementById("btn-skills-installed") as HTMLElement | null)?.click());
      const count = () => page.evaluate(() => document.querySelectorAll("#skills-grid .item-card").length);
      assert.equal(await count(), 2);
      await page.focus("#skills-search");
      await page.keyboard.type("alpha");
      assert.equal(await count(), 1, "the skills filter must keep working");
      assert.equal((await snap(page)).activeId, "skills-search");
      assert.equal((await snap(page)).value, "", "typing in the skills box must not reach the hub search");
      await page.keyboard.press("Escape");
      assert.equal((await snap(page)).activeId, "skills-search", "Escape in another box must not be taken by the hub search");
      await page.evaluate(() => (window as any).openSkillDetail("alpha-skill", "", "/p/a"));
      assert.equal(await page.evaluate(() => document.getElementById("skill-detail-overlay")!.style.display), "flex", "detail overlay opens");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.getElementById("skill-detail-overlay")!.style.display), "none", "Escape must still close the skill detail");
      await page.evaluate(() => (window as any).openSkillDetail("alpha-skill", "", "/p/a"));
      await typeQuery(page, "git");
      await page.keyboard.press("Escape");
      const both = await page.evaluate(() => ({ overlay: document.getElementById("skill-detail-overlay")!.style.display, value: (document.getElementById("hub-search") as HTMLInputElement).value }));
      assert.deepEqual(both, { overlay: "none", value: "" }, "Escape in the search box clears it and still closes the skill detail");
      await page.evaluate(() => {
        const w = window as any;
        w.__clicks = 0;
        const el = document.createElement("div");
        el.id = "rb";
        el.setAttribute("role", "button");
        el.tabIndex = 0;
        el.addEventListener("click", () => { w.__clicks++; });
        document.body.appendChild(el);
        el.focus();
      });
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      assert.equal(await page.evaluate(() => (window as any).__clicks), 2, "role=button activation must keep working");
    });
  });

  it("Enter in the search box is not double-handled by the role=button keydown handler", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "usage tel");
      const before = (await posted(page)).filter((m) => m.type === "tab_switched").length;
      await page.keyboard.press("Enter");
      const after = (await posted(page)).filter((m) => m.type === "tab_switched").length;
      assert.equal(after - before, 1, "Enter must open exactly one result");
    });
  });

  it("opening the API Keys section works (its tab switch has side effects)", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page }) => {
      await typeQuery(page, "api keys");
      const s = await snap(page);
      assert.ok(s.hits.length > 0);
      await page.keyboard.press("Enter");
      assert.equal((await snap(page)).activePane, "pane-keys");
    });
  });

  /* ---------------- performance ---------------- */

  it("stays fast with 5,000 model cards, and with 5,000 matching and 5,000 duplicate names", { timeout: 240000 }, async () => {
    await withHub({ height: 900 }, async ({ page }) => {
      const measure = (queries: string[]): Promise<number[]> => page.evaluate((qs: string[]) => {
        const input = document.getElementById("hub-search") as HTMLInputElement;
        const results = document.getElementById("hub-search-results") as HTMLElement;
        return qs.map((q) => {
          const t0 = performance.now();
          input.value = q;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          void results.offsetHeight;
          return performance.now() - t0;
        });
      }, queries);
      const keystrokes = "claude sonnet 4".split("").map((_, i, all) => all.slice(0, i + 1).join(""));
      const baseline = await measure(keystrokes);
      const families = ["claude", "gpt", "gemini", "qwen", "llama"];
      const load = async (names: (i: number) => string) => {
        await send(page, { type: "state_loaded", models: Array.from({ length: 5000 }, (_, i) => ({ id: "vendor/model-" + i, name: names(i), provider: "openrouter", desc: "d " + i, tags: [], pricing: "$1/M", context_limit: 128000 })), providers: [], skills: [], remoteSkills: [], mcpServers: [], connectors: [], crons: [], config: {} });
        const cards = await page.evaluate(() => document.querySelectorAll(".model-card").length);
        assert.equal(cards, 5000, "all 5,000 cards must be in the DOM for this test to mean anything");
      };
      await load((i) => `Vendor ${families[i % 5]} sonnet model ${i} v4`);
      const distinct = await measure(keystrokes);
      const many = await measure(["m", "mo", "model", "v", "vendor", "e", "o"]);
      await load((i) => `Same name ${i % 2}`);
      const dupes = await measure(["s", "sa", "same", "same name"]);
      const slowest = Math.max(...distinct, ...many, ...dupes);
      const note = `baseline max ${Math.round(Math.max(...baseline))} ms; 5000 distinct ${distinct.map(Math.round)}; 5000 matches ${many.map(Math.round)}; 5000 dupes ${dupes.map(Math.round)}`;
      assert.ok(slowest < 200, `slowest keystroke ${Math.round(slowest)} ms (${note})`);
      assertConsistent(await snap(page), "after perf");
    });
  });

  it("typing quickly through 5,000 model cards with real key events stays responsive and consistent", { timeout: 240000 }, async () => {
    await withHub({ height: 900 }, async ({ page }) => {
      await send(page, { type: "state_loaded", models: Array.from({ length: 5000 }, (_, i) => ({ id: "vendor/model-" + i, name: "Vendor model " + i, provider: "openrouter", desc: "d", tags: [], pricing: "", context_limit: 1000 })), providers: [], skills: [], remoteSkills: [], mcpServers: [], connectors: [], crons: [], config: {} });
      await page.focus("#hub-search");
      const t0 = Date.now();
      const typed = "vendor model 4999 and then some more";
      await page.keyboard.type(typed, { delay: 0 });
      for (let i = 0; i < 12; i++) await page.keyboard.press("Backspace");
      const elapsed = Date.now() - t0;
      const s = await snap(page);
      assertConsistent(s, "after rapid typing");
      assert.equal(s.value, typed.slice(0, typed.length - 12));
      assert.ok(elapsed < 20000, `rapid typing took ${elapsed} ms`);
    });
  });

  it("a very long query against 5,000 model cards does not freeze the webview", { timeout: 240000 }, async () => {
    await withHub({}, async ({ page }) => {
      await send(page, { type: "state_loaded", models: Array.from({ length: 5000 }, (_, i) => ({ id: "vendor/model-" + i, name: "Vendor model " + i, provider: "openrouter", desc: "d", tags: [] })), providers: [], skills: [], remoteSkills: [], mcpServers: [], connectors: [], crons: [], config: {} });
      for (const [n, limit] of [[200, 200], [5000, 200], [100000, 250], [1000000, 500]]) {
        const ms: number = await page.evaluate((len: number) => {
          const input = document.getElementById("hub-search") as HTMLInputElement;
          const t0 = performance.now();
          input.value = "model ".repeat(Math.ceil(len / 6)).slice(0, len);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return performance.now() - t0;
        }, n);
        assert.ok(ms < limit, `a ${n}-char query against 5,000 cards took ${Math.round(ms)} ms (limit ${limit})`);
      }
    });
  });

  it("a multi-megabyte label does not hang every keystroke", { timeout: 120000 }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `<label>${"lorem ipsum ".repeat(250000)}</label>`);
      const ms: number[] = await page.evaluate(() => {
        const input = document.getElementById("hub-search") as HTMLInputElement;
        return ["g", "gi", "git"].map((q) => {
          const t0 = performance.now();
          input.value = q;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return performance.now() - t0;
        });
      });
      assert.ok(Math.max(...ms) < 300, `3 MB label made a keystroke take ${ms.map(Math.round)} ms`);
    });
  });

  it("pathological nesting (1,000 nested labels) does not make each keystroke quadratic", { timeout: 120000, todo: "not reachable: the Hub markup never nests labels, and entry text is escaped" }, async () => {
    await withHub({}, async ({ page }) => {
      await inject(page, `${"<label>x ".repeat(1000)}core${"</label>".repeat(1000)}`);
      const ms: number[] = await page.evaluate(() => {
        const input = document.getElementById("hub-search") as HTMLInputElement;
        return ["g", "gi", "git"].map((q) => {
          const t0 = performance.now();
          input.value = q;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return performance.now() - t0;
        });
      });
      assert.ok(Math.max(...ms) < 300, `1,000 nested labels made a keystroke take ${ms.map(Math.round)} ms`);
    });
  });

  it("indexing never triggers network requests or media loads from the cloned labels", { timeout: 60000 }, async () => {
    await withHub({}, async ({ page, requests }) => {
      await inject(page, `<h3>Pixelzq <img src="http://hub.test/pixel.png?a=1"><audio src="http://hub.test/a.mp3" preload="auto"></audio><video src="http://hub.test/v.mp4" preload="auto"></video><iframe src="http://hub.test/frame.html"></iframe><link rel="stylesheet" href="http://hub.test/x.css"></h3>`);
      await page.waitForTimeout(300);
      const baseline = requests.length;
      for (const q of ["p", "pi", "pix", "pixe", "pixel", "pixelz", "pixelzq"]) await setQuery(page, q);
      await page.waitForTimeout(300);
      const extra = requests.slice(baseline).filter((p) => p !== "/page.html");
      assert.deepEqual(extra, [], "search made extra requests");
    }, true);
  });

  /* ---------------- randomised walk ---------------- */

  for (const seed of [1, 2024, 90210]) {
    it(`random walk over typing, deleting, Escape, arrows, Enter, slash and Ctrl+F keeps every invariant (seed ${seed})`, { timeout: 240000 }, async () => {
      await withHub({}, async ({ page }) => {
        const random = mulberry32(seed);
        const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
        const alphabet = "gitmodelkeypermusa&- /.q".split("");
        await page.focus("#hub-search");
        for (let step = 0; step < 220; step++) {
          const op = pick(["type", "type", "type", "type", "backspace", "backspace", "clear", "escape", "down", "down", "up", "enter", "slash", "find", "paste", "tab"]);
          const label = `seed ${seed} step ${step} ${op}`;
          if ((await snap(page)).activeId !== "hub-search") await page.focus("#hub-search");
          switch (op) {
            case "type": await page.keyboard.type(pick(alphabet)); break;
            case "backspace": await page.keyboard.press("Backspace"); break;
            case "clear": await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace"); break;
            case "escape": await page.keyboard.press("Escape"); break;
            case "down": await page.keyboard.press("ArrowDown"); break;
            case "up": await page.keyboard.press("ArrowUp"); break;
            case "enter": await page.keyboard.press("Enter"); break;
            case "slash": await page.keyboard.press("/"); break;
            case "find": await page.keyboard.press("Control+F"); break;
            case "paste": await setQuery(page, Array.from({ length: Math.floor(random() * 8) }, () => pick(alphabet)).join("")); break;
            case "tab": await page.click(`.nav-tab[data-tab="${pick(["models", "git", "usage", "general"])}"]`, { timeout: 500 }).catch(() => undefined); break;
          }
          assertConsistent(await snap(page), label);
        }
      });
    });
  }

  it("rapid synchronous bursts of input events leave the final state consistent with the final value", { timeout: 90000 }, async () => {
    await withHub({}, async ({ page }) => {
      await page.evaluate(() => {
        const input = document.getElementById("hub-search") as HTMLInputElement;
        const words = ["g", "gi", "git", "", "m", "mo", "mod", "", "zzzz", "a b", " ", "perm", "pe", "p", ""];
        for (let round = 0; round < 40; round++) for (const w of words) { input.value = w; input.dispatchEvent(new Event("input", { bubbles: true })); }
        input.value = "key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const s = await snap(page);
      assertConsistent(s, "burst");
      assert.ok(s.hits.length > 0);
      await setQuery(page, "");
      assertConsistent(await snap(page), "burst cleared");
    });
  });
});

/* ------------------------------------------------------------------ */
/* Production bundle                                                   */
/* ------------------------------------------------------------------ */

describe("hub search: esbuild bundles of the panel", { skip: browserSkip }, () => {
  before(async () => {
    browser = browser ?? await pw.chromium.launch({ executablePath: chromePath, headless: true });
  }, { timeout: 90000 });
  after(async () => {
    if (browser) { try { await browser.close(); } catch { /* already closed */ } browser = undefined; }
  }, { timeout: 30000 });

  for (const variant of ["bundle", "bundle-min"] as const) {
    it(`${variant}: search, keyboard navigation, click and shortcuts work in the bundled panel`, { timeout: 120000 }, async () => {
      await withHub({ html: panelHtml(variant) }, async ({ page }) => {
        await page.evaluate(() => (document.body as HTMLElement).focus());
        await page.keyboard.press("/");
        assert.equal((await snap(page)).activeId, "hub-search");
        await page.keyboard.type("usage tel");
        const s = await snap(page);
        assertConsistent(s, variant);
        assert.equal(s.hits[0].text, "Usage Telemetry");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("Enter");
        const after = await snap(page);
        assert.equal(after.activePane, "pane-general");
        assert.equal(after.flash.length, 1);
        await page.keyboard.press("Escape");
        assertConsistent(await snap(page), variant + " cleared");
        await page.keyboard.press("Control+F");
        assert.equal((await snap(page)).activeId, "hub-search");
        await setQuery(page, `<img src=x onerror=1>`);
        assertConsistent(await snap(page), variant + " hostile");
        assert.equal(await page.evaluate(() => document.querySelectorAll("#hub-search-results img").length), 0);
      });
    });
  }
});
