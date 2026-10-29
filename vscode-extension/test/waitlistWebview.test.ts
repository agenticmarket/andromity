import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { element, loadChat, stub } from "./helpers/chatHarness.js";

type FakeNode = Record<string, any>;

const WANTS = [
  { id: "higher_limit", label: "Higher daily limit" },
  { id: "faster", label: "Faster responses" },
  { id: "other", label: "Something else" },
];
const HEARD = [
  { id: "marketplace", label: "VS Code Marketplace" },
  { id: "friend", label: "Friend or colleague" },
];
const OFFER = "Need more? Join the waitlist";
const JOINED = "On the waitlist ✓";

function el(tagName: string, textContent = "", opts: { classes?: string[]; attrs?: Record<string, string> } = {}): FakeNode {
  return {
    nodeType: 1, tagName, textContent, childNodes: [],
    classList: { contains: (c: string) => (opts.classes || []).includes(c) },
    getAttribute: (name: string) => (opts.attrs || {})[name] ?? null,
  };
}

/** A backend error card as DOMParser would return it. */
function parserFor(attrs: Record<string, string>) {
  const parts: Record<string, FakeNode> = {
    ".error-card-body": { ...el("DIV"), childNodes: [el("DIV", "You have reached your daily limit.")] },
    ".error-badge": el("SPAN", "QUOTA LIMIT"),
    ".error-title": el("SPAN", "Daily Limit Reached"),
  };
  const buttons = [el("BUTTON", "Open Settings", { attrs: { "data-action": "open-settings" } })];
  const card = {
    getAttribute: (name: string) => attrs[name] ?? null,
    querySelector: (selector: string) => parts[selector] ?? null,
    querySelectorAll: (selector: string) => (selector.includes("[data-action]") ? buttons : []),
  };
  return class {
    parseFromString() {
      return { querySelector: (selector: string) => (selector === ".andromity-error-card" ? card : null) };
    }
  };
}

function offerButton() {
  const label = element({ textContent: OFFER });
  return element({ tagName: "BUTTON", disabled: false, label, querySelector: (sel: string) => (sel === ".waitlist-offer-label" ? label : null) });
}

/** The real chat script with just enough DOM for the waitlist card, its inputs and the offers on the page. */
function page() {
  const chat = loadChat();
  const created: any[] = [];
  const inputs: Record<string, any> = {
    "waitlist-wants-note": element({ tagName: "INPUT", value: "" }),
    "waitlist-heard-note": element({ tagName: "INPUT", value: "" }),
  };
  const offers = [offerButton(), offerButton()];
  const doc = chat.sandbox.document;
  doc.createElement = (tag: string) => {
    const node = element({ tagName: tag.toUpperCase(), removed: false, remove() { this.removed = true; } });
    created.push(node);
    return node;
  };
  const card = () => created.find((node) => node.id === "waitlist-card" && !node.removed) ?? null;
  doc.getElementById = (id: string) => (id === "waitlist-card" ? card() : id in inputs ? inputs[id] : id in chat.byId ? chat.byId[id] : stub());
  doc.querySelectorAll = (selector: string) => (selector === ".waitlist-offer" ? offers : []);
  doc.querySelector = (selector: string) => (selector === ".prompt-box" ? chat.promptBox : null);
  const click = (action: string, attrs: Record<string, string> = {}) => {
    const target = element({ tagName: "BUTTON" });
    target.setAttribute("data-action", action);
    for (const [name, value] of Object.entries(attrs)) target.setAttribute(name, value);
    target.closest = (selector: string) => (selector === "[data-action]" ? target : null);
    const event = { target, preventDefault() {}, stopPropagation() {} };
    for (const listener of chat.docListeners.click || []) listener(event);
    return target;
  };
  const posted = (type: string) => chat.posted.filter((m: any) => m.type === type).map((m: unknown) => JSON.parse(JSON.stringify(m)));
  const html = () => String(card()?.innerHTML ?? "");
  return { chat, card, inputs, offers, click, posted, html };
}

function openForm(p: ReturnType<typeof page>, extra: Record<string, unknown> = {}) {
  p.chat.post({ type: "waitlist_form", joined: false, wants: WANTS, heardFrom: HEARD, ...extra });
}

describe("waitlist offer on error cards", () => {
  const rebuild = (p: ReturnType<typeof page>, attrs: Record<string, string>) => {
    p.chat.sandbox.DOMParser = parserFor(attrs);
    return String(p.chat.eval("errorCardFromMarkup('<div class=\"andromity-error-card\"></div>')"));
  };

  it("adds the offer to a daily-limit card whose error carries join_waitlist, and notes it once", () => {
    const p = page();
    const card = rebuild(p, { "data-error-type": "quota_exceeded", "data-error-action": "join_waitlist" });
    assert.match(card, /<div class="error-card-actions">.*data-action="open-settings".*data-action="join-waitlist"[^>]*>.*Need more\? Join the waitlist<\/span><\/button><\/div>/);
    assert.ok(!/data-action="join-waitlist"[^>]*disabled/.test(card));
    rebuild(p, { "data-error-type": "quota_exceeded", "data-error-action": "join_waitlist" });
    assert.equal(p.posted("waitlist_offer_shown").length, 1);
  });

  it("leaves every other card alone", () => {
    const cards: Record<string, string>[] = [
      { "data-error-type": "quota_exceeded" },
      { "data-error-type": "quota_exceeded", "data-error-action": "JOIN_WAITLIST" },
      { "data-error-type": "quota_exceeded", "data-error-action": "join_waitlist " },
      { "data-error-type": "quota_exceeded", "data-error-action": "join_waitlist_now" },
      { "data-error-type": "rate_limit", "data-error-action": "join_waitlist" },
      { "data-error-type": "service_busy", "data-error-action": "join_waitlist" },
      { "data-error-type": "model_unavailable", "data-error-action": "join_waitlist" },
    ];
    for (const attrs of cards) {
      const p = page();
      const card = rebuild(p, attrs);
      assert.ok(!card.includes("join-waitlist"), JSON.stringify(attrs));
      assert.equal(p.posted("waitlist_offer_shown").length, 0, JSON.stringify(attrs));
    }
  });

  it("shows the offer as joined, without noting it, once the extension says so", () => {
    const p = page();
    p.chat.post({ type: "waitlist_state", joined: true });
    const card = rebuild(p, { "data-error-type": "quota_exceeded", "data-error-action": "join_waitlist" });
    assert.match(card, /data-action="join-waitlist" disabled>.*On the waitlist ✓/);
    assert.equal(p.posted("waitlist_offer_shown").length, 0);
  });

  it("asks the extension for the form, but not after joining", () => {
    const p = page();
    p.click("join-waitlist");
    assert.deepEqual(p.posted("waitlist_open"), [{ type: "waitlist_open" }]);
    p.chat.post({ type: "waitlist_state", joined: true });
    p.click("join-waitlist");
    assert.equal(p.posted("waitlist_open").length, 1);
  });
});

describe("waitlist form in the chat", () => {
  it("renders both questions with the choices escaped and the note limits of the worker", () => {
    const p = page();
    openForm(p, {
      wants: [...WANTS, { id: 'x" onclick="alert(1)', label: '<img src=x onerror="alert(1)">' }, { id: 7, label: "seven" }, null, "faster"],
      heardFrom: [...HEARD, { id: "blog", label: "</div><script>alert(1)</script>" }],
    });
    const html = p.html();
    assert.ok(html.includes("What would you want?") && html.includes("Where did you hear about Andromity?"));
    for (const choice of [...WANTS, ...HEARD]) assert.ok(html.includes(`data-id="${choice.id}"`), choice.id);
    assert.ok(!html.includes("<img"), "labels are escaped");
    assert.ok(!html.includes("<script"), "labels are escaped");
    assert.ok(!html.includes('" onclick="'), "ids cannot break out of their attribute");
    assert.ok(!html.includes("seven"), "choices that are not id and label strings are dropped");
    assert.match(html, /id="waitlist-wants-note" maxlength="300"/);
    assert.match(html, /id="waitlist-heard-note" maxlength="200"/);
    assert.ok(!/email/i.test(html.replace("No email needed", "")), "the form never asks for an email");
  });

  it("caps how many choices a page will draw", () => {
    const p = page();
    openForm(p, { wants: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, label: `Choice ${i}` })) });
    assert.equal((p.html().match(/data-action="waitlist-want"/g) || []).length, 12);
  });

  it("sends only the picked answers and notes, once", () => {
    const p = page();
    openForm(p);
    p.click("waitlist-want", { "data-id": "faster" });
    p.click("waitlist-want", { "data-id": "other" });
    p.click("waitlist-want", { "data-id": "faster" });
    p.click("waitlist-want", { "data-id": "made_up" });
    p.click("waitlist-want", { "data-id": "higher_limit" });
    p.click("waitlist-heard", { "data-id": "marketplace" });
    p.click("waitlist-heard", { "data-id": "friend" });
    p.click("waitlist-heard", { "data-id": "reddit" });
    p.inputs["waitlist-wants-note"].value = "more turns";
    p.inputs["waitlist-heard-note"].value = "a colleague";
    p.click("waitlist-send");
    p.click("waitlist-send");
    p.click("waitlist-want", { "data-id": "faster" });
    const sent = p.posted("waitlist_join");
    assert.equal(sent.length, 1, "a second click while sending sends nothing");
    assert.deepEqual(sent[0], {
      type: "waitlist_join", wants: ["other", "higher_limit"], wants_note: "more turns", heard_from: "friend", heard_note: "a colleague",
    });
    assert.match(p.html(), /Joining…/);
  });

  it("asks for the missing answer instead of sending", () => {
    const p = page();
    openForm(p);
    p.click("waitlist-send");
    assert.match(p.html(), /role="alert">Pick at least one thing you&#39;d want\.</);
    p.click("waitlist-want", { "data-id": "faster" });
    p.click("waitlist-send");
    assert.match(p.html(), /role="alert">Pick where you heard about Andromity\.</);
    assert.equal(p.posted("waitlist_join").length, 0);
  });

  it("after a join, every offer on the page reads 'On the waitlist ✓' and stays disabled", () => {
    const p = page();
    openForm(p);
    p.click("waitlist-want", { "data-id": "faster" });
    p.click("waitlist-heard", { "data-id": "friend" });
    p.click("waitlist-send");
    p.chat.post({ type: "waitlist_result", ok: true });
    assert.match(p.html(), /You&#39;re on the waitlist|You're on the waitlist/);
    for (const offer of p.offers) {
      assert.equal(offer.disabled, true);
      assert.equal(offer.label.textContent, JOINED);
    }
    p.click("join-waitlist");
    assert.equal(p.posted("waitlist_open").length, 0);
  });

  it("shows a failed join's message escaped and lets the person try again", () => {
    const p = page();
    openForm(p);
    p.click("waitlist-want", { "data-id": "faster" });
    p.click("waitlist-heard", { "data-id": "friend" });
    p.click("waitlist-send");
    p.chat.post({ type: "waitlist_result", ok: false, error: '<img src=x onerror="alert(1)"> try later' });
    const html = p.html();
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; try later"));
    assert.ok(p.offers.every((offer) => offer.disabled !== true), "offers stay open after a failure");
    p.click("waitlist-send");
    assert.equal(p.posted("waitlist_join").length, 2);
  });

  it("closing the form while it sends still marks the offers joined when the result arrives", () => {
    const p = page();
    openForm(p);
    p.click("waitlist-want", { "data-id": "faster" });
    p.click("waitlist-heard", { "data-id": "friend" });
    p.click("waitlist-send");
    p.click("waitlist-close");
    assert.equal(p.card(), null);
    p.chat.post({ type: "waitlist_result", ok: true });
    assert.ok(p.offers.every((offer) => offer.disabled === true && offer.label.textContent === JOINED));
  });

  it("opening the form again after joining shows that you joined instead of the questions", () => {
    const p = page();
    openForm(p, { joined: true });
    assert.ok(!p.html().includes("waitlist-send"));
    assert.ok(p.offers.every((offer) => offer.disabled === true));
    p.click("waitlist-want", { "data-id": "faster" });
    p.click("waitlist-send");
    assert.equal(p.posted("waitlist_join").length, 0);
  });

  it("follows the joined state the extension sends", () => {
    const p = page();
    p.chat.post({ type: "waitlist_state", joined: true });
    assert.ok(p.offers.every((offer) => offer.disabled === true && offer.label.textContent === JOINED));
    p.chat.post({ type: "waitlist_state", joined: "true" });
    assert.ok(p.offers.every((offer) => offer.disabled === false && offer.label.textContent === OFFER), "only a real true counts");
  });
});

describe("waitlist offer on the onboarding Andromity card", () => {
  it("sits in the Andromity trial card", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatHtml.ts"), "utf8");
    const trial = source.slice(source.indexOf('id="onboarding-trial-section"'), source.indexOf("<!-- Step 2"));
    assert.ok(trial.includes('data-action="join-waitlist"'));
    assert.ok(trial.includes(OFFER));
    assert.equal((source.match(/data-action="join-waitlist"/g) || []).length, 1);
  });

  it("is noted once when the onboarding shows, and not for people who joined", () => {
    const p = page();
    p.chat.eval("toggleOnboarding(true)");
    p.chat.eval("toggleOnboarding(false)");
    p.chat.eval("toggleOnboarding(true)");
    assert.equal(p.posted("waitlist_offer_shown").length, 1);

    const joined = page();
    joined.chat.post({ type: "waitlist_state", joined: true });
    joined.chat.eval("toggleOnboarding(true)");
    assert.equal(joined.posted("waitlist_offer_shown").length, 0);
  });
});
