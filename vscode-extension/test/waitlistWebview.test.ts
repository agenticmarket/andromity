import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { element, loadChat, stub } from "./helpers/chatHarness.js";
import { getChatClientScript } from "../src/providers/chatview/chatClientScript.js";

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
  const onboarding = element({ style: { display: "none" } });
  const quotaCards: any[] = [];
  const chatMessages = element({
    querySelectorAll: (selector: string) => (selector === '.andromity-error-card[data-error-type="quota_exceeded"]' ? quotaCards : []),
    querySelector: () => null,
  });
  const chat = loadChat({ elements: {
    "onboarding-guide-section": onboarding, "ready-hero-section": element({ style: { display: "flex" } }), "chat-messages": chatMessages,
  } });
  /** A daily-limit card already in the chat, as the engine's reply text left it. */
  const addQuotaCard = () => {
    const actions = element({
      querySelector: (selector: string) => (selector === '[data-action="join-waitlist"]' && actions.inserted.some((h: string) => h.includes('data-action="join-waitlist"')) ? {} : null),
    });
    quotaCards.push(element({ querySelector: (selector: string) => (selector === ".error-card-actions" ? actions : null) }));
    return actions;
  };
  const finishTurn = (fields: Record<string, unknown>) =>
    chat.post({ type: "agent_done", session_id: "s", outcome: "error", error_type: "quota_exceeded", error_action: "join_waitlist", ...fields });
  const created: any[] = [];
  const inputs: Record<string, any> = {
    "waitlist-wants-note": element({ tagName: "INPUT", value: "" }),
    "waitlist-heard-note": element({ tagName: "INPUT", value: "" }),
  };
  const onboardingOffer = offerButton();
  onboardingOffer.hidden = true;
  onboardingOffer.classList.add("onboarding-waitlist-offer");
  const offers = [offerButton(), offerButton(), onboardingOffer];
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
  return { chat, card, inputs, offers, onboarding, onboardingOffer, click, posted, html, addQuotaCard, finishTurn };
}

function openForm(p: ReturnType<typeof page>, extra: Record<string, unknown> = {}) {
  p.chat.post({ type: "waitlist_form", joined: false, wants: WANTS, heardFrom: HEARD, ...extra });
}

describe("waitlist offer on error cards", () => {
  const rebuild = (p: ReturnType<typeof page>, attrs: Record<string, string>) => {
    p.chat.sandbox.DOMParser = parserFor(attrs);
    return String(p.chat.eval("errorCardFromMarkup('<div class=\"andromity-error-card\"></div>')"));
  };

  it("agent_done with quota_exceeded and join_waitlist adds the offer to the last daily-limit card, once", () => {
    const p = page();
    const older = p.addQuotaCard();
    const latest = p.addQuotaCard();
    p.finishTurn({});
    assert.equal(older.inserted.length, 0, "only the newest daily-limit card gets the offer");
    assert.equal(latest.inserted.length, 1);
    assert.match(latest.inserted[0], /^<button class="btn-error-secondary waitlist-offer" data-action="join-waitlist">.*Need more\? Join the waitlist<\/span><\/button>$/);
    assert.equal(p.posted("waitlist_offer_shown").length, 1);
    p.finishTurn({});
    assert.equal(latest.inserted.length, 1, "a second agent_done does not add a second offer");
    assert.equal(p.posted("waitlist_offer_shown").length, 1);
  });

  it("card markup alone never adds the offer, even a perfect daily-limit card that names join_waitlist", () => {
    const p = page();
    const card = rebuild(p, { "data-error-type": "quota_exceeded", "data-error-action": "join_waitlist" });
    assert.ok(card.includes('data-error-type="quota_exceeded"'), "the card itself is still rebuilt");
    assert.ok(!card.includes("join-waitlist"), card);
    assert.equal(p.posted("waitlist_offer_shown").length, 0);
  });

  it("the offer needs this session's agent_done with exactly that type and action", () => {
    const refused: Record<string, unknown>[] = [
      { error_type: "rate_limit" },
      { error_type: "service_busy" },
      { error_type: "sign_in_invalid" },
      { error_type: "QUOTA_EXCEEDED" },
      { error_type: undefined },
      { error_action: "JOIN_WAITLIST" },
      { error_action: "join_waitlist " },
      { error_action: "join-waitlist" },
      { error_action: "join_waitlist\" onclick=\"alert(1)" },
      { error_action: "<img src=x onerror=alert(1)>" },
      { error_action: ["join_waitlist"] },
      { error_action: { toString: () => "join_waitlist" } },
      { error_action: null },
      { outcome: "success" },
      { outcome: undefined },
      { session_id: "another-session" },
    ];
    for (const fields of refused) {
      const p = page();
      const actions = p.addQuotaCard();
      p.finishTurn(fields);
      assert.equal(actions.inserted.length, 0, JSON.stringify(fields));
      assert.equal(p.posted("waitlist_offer_shown").length, 0, JSON.stringify(fields));
    }
  });

  it("without a daily-limit card in the chat, agent_done adds nothing anywhere", () => {
    const p = page();
    p.finishTurn({});
    assert.equal(p.posted("waitlist_offer_shown").length, 0);
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
    const actions = p.addQuotaCard();
    p.finishTurn({});
    assert.equal(actions.inserted.length, 1);
    assert.match(actions.inserted[0], /data-action="join-waitlist" disabled>.*On the waitlist ✓/);
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

  it("asks people not to include contact details", () => {
    const p = page();
    openForm(p);
    assert.ok(p.html().includes("No email needed. Please don&#39;t include contact details.") || p.html().includes("No email needed. Please don't include contact details."));
  });
});

/** A DOMParser that reads the card's attributes from the markup it is given, like the real one. */
class MarkupParser {
  parseFromString(markup: string) {
    const open = /<div class="andromity-error-card"([^>]*)>/.exec(markup);
    if (!open) return { querySelector: () => null };
    const attrs: Record<string, string> = {};
    for (const m of open[1].matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
    const card = {
      getAttribute: (name: string) => attrs[name] ?? null,
      querySelector: (selector: string) => (selector === ".error-card-body" ? { ...el("DIV"), childNodes: [el("DIV", "Limit reached.")] } : null),
      querySelectorAll: () => [],
    };
    return { querySelector: (selector: string) => (selector === ".andromity-error-card" ? card : null) };
  }
}

const CARD = '<div class="andromity-error-card" data-error-type="quota_exceeded" data-error-action="join_waitlist" data-retryable="true">'
  + '<div class="error-card-body">You have reached your daily limit.</div></div>';

describe("the page never marks the waitlist offered itself", () => {
  it("a daily-limit card gets its offer from agent_done and still sends no offered flag", () => {
    const p = page();
    p.chat.sandbox.DOMParser = MarkupParser;
    const html = String(p.chat.eval(`renderMarkdown(${JSON.stringify("\n" + CARD)})`));
    assert.ok(!html.includes('data-action="join-waitlist"'), "the reply text alone does not offer the waitlist");
    assert.equal(p.posted("waitlist_offer_shown").length, 0);
    const actions = p.addQuotaCard();
    p.finishTurn({});
    assert.ok(actions.inserted.some((h: string) => h.includes('data-action="join-waitlist"')), "the engine's turn result adds it");
    assert.equal(p.posted("waitlist_offer_shown").length, 1);
    assert.equal(p.posted("waitlist_offered").length, 0);
  });

  it("card markup a model prints in a reply, a code block or mid-line sends no offered flag", () => {
    const fence = "`".repeat(3);
    for (const reply of [
      `Sure, here is what that error looks like:\n${CARD}\nAnything else?`,
      `${CARD}`,
      `Here is the card:\n${fence}html\n${CARD}\n${fence}\n`,
      `Inline ${CARD} text`,
      CARD.replace(' data-error-action="join_waitlist"', ""),
      CARD.replace("quota_exceeded", "rate_limit"),
    ]) {
      const p = page();
      p.chat.sandbox.DOMParser = MarkupParser;
      p.chat.eval(`renderMarkdown(${JSON.stringify(reply)})`);
      assert.equal(p.posted("waitlist_offered").length, 0, reply.slice(0, 60));
    }
  });

  it("the page script has no way to post the offered flag", () => {
    const script = getChatClientScript("icon.svg", { currentSessionId: "s", currentModel: "m", currentProvider: "p", currentMode: "safe", currentProfile: "builder", currentReasoning: "medium" });
    assert.ok(!script.includes("waitlist_offered"));
  });
});

describe("waitlist offer on the onboarding Andromity card", () => {
  it("sits hidden in the Andromity trial card", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "providers", "chatview", "chatHtml.ts"), "utf8");
    const trial = source.slice(source.indexOf('id="onboarding-trial-section"'), source.indexOf("<!-- Step 2"));
    assert.match(trial, /<button type="button" class="onboarding-waitlist-offer waitlist-offer" data-action="join-waitlist" hidden>/);
    assert.ok(trial.includes(OFFER));
    assert.equal((source.match(/data-action="join-waitlist"/g) || []).length, 1);
  });

  it("stays hidden until the extension says the gateway offered the waitlist", () => {
    const p = page();
    p.chat.post({ type: "waitlist_state", joined: false, offered: false });
    assert.equal(p.onboardingOffer.hidden, true);
    p.chat.post({ type: "waitlist_state", joined: false, offered: "yes" });
    assert.equal(p.onboardingOffer.hidden, true, "only a real true counts");
    p.chat.post({ type: "waitlist_state", joined: false, offered: true });
    assert.equal(p.onboardingOffer.hidden, false);
    assert.equal(p.onboardingOffer.disabled, false);
    p.chat.post({ type: "waitlist_state", joined: true, offered: false });
    assert.equal(p.onboardingOffer.hidden, false, "people who joined see 'On the waitlist'");
    assert.equal(p.onboardingOffer.disabled, true);
    const other = p.offers[0];
    p.chat.post({ type: "waitlist_state", joined: false, offered: false });
    assert.notEqual(other.hidden, true, "the daily-limit card's offer is never hidden by the flag");
  });

  it("is noted only when the onboarding shows an offered waitlist, and once", () => {
    const p = page();
    p.chat.eval("toggleOnboarding(true)");
    assert.equal(p.posted("waitlist_offer_shown").length, 0, "not offered yet");
    p.chat.post({ type: "waitlist_state", joined: false, offered: true });
    assert.equal(p.posted("waitlist_offer_shown").length, 1, "noted when the flag arrives while onboarding shows");
    p.chat.eval("toggleOnboarding(false)");
    p.chat.eval("toggleOnboarding(true)");
    assert.equal(p.posted("waitlist_offer_shown").length, 1);

    const hidden = page();
    hidden.chat.post({ type: "waitlist_state", joined: false, offered: true });
    assert.equal(hidden.posted("waitlist_offer_shown").length, 0, "nothing noted while onboarding is not shown");
    hidden.chat.eval("toggleOnboarding(true)");
    assert.equal(hidden.posted("waitlist_offer_shown").length, 1);

    const joined = page();
    joined.chat.post({ type: "waitlist_state", joined: true, offered: true });
    joined.chat.eval("toggleOnboarding(true)");
    assert.equal(joined.posted("waitlist_offer_shown").length, 0);
  });
});

