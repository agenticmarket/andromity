/** Fuzzy search across the Andromity Hub: section names, settings and whatever each section has listed. */

export const HUB_SEARCH_MARKUP = `
    <div class="hub-search" id="hub-search-box">
      <input id="hub-search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" placeholder="Search the Hub" aria-label="Search the Hub" aria-controls="hub-search-results" autocomplete="off" spellcheck="false">
    </div>
    <div class="hub-search-results" id="hub-search-results" role="listbox" aria-label="Search results" hidden></div>`;

export function getHubSearchStyles(): string {
  return `
    .hub-search { padding: 10px 8px 0; }
    .hub-search input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 9px;
      font-size: 12px;
      color: var(--text-main, inherit);
      background: rgba(var(--tint), 0.04);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      outline: none;
    }
    .hub-search input:focus { border-color: var(--accent, #38bdf8); }
    .hub-search-results {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px;
      flex: 1;
      overflow-y: auto;
    }
    .hub-search-results[hidden], .nav-tabs[hidden] { display: none !important; }
    .side-nav.collapsed .nav-tabs[hidden],
    .side-nav.auto-compact .nav-tabs[hidden] { display: flex !important; }
    .hub-search-hit {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      padding: 6px 9px;
      border-radius: 4px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-main, inherit);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      width: 100%;
    }
    .hub-search-hit:hover, .hub-search-hit.selected {
      background: rgba(var(--tint), 0.06);
      border-color: rgba(var(--tint), 0.08);
    }
    .hub-search-text { overflow-wrap: anywhere; }
    .hub-search-where { font-size: 10.5px; color: var(--text-muted); }
    .hub-search-empty { padding: 6px 9px; font-size: 12px; color: var(--text-muted); }
    .hub-search-flash { outline: 2px solid var(--accent, #38bdf8); outline-offset: 2px; transition: outline-color 0.4s ease; }
    .side-nav.collapsed .hub-search,
    .side-nav.auto-compact .hub-search,
    .side-nav.collapsed .hub-search-results,
    .side-nav.auto-compact .hub-search-results { display: none !important; }
  `;
}

/** Runs inside the Hub webview. Self-contained, because it is injected with toString(). */
export function hubSearchClient(switchTab: (tab: string, fromUser: boolean) => void): void {
  const input = document.getElementById("hub-search") as HTMLInputElement | null;
  const results = document.getElementById("hub-search-results");
  const tabsList = document.getElementById("nav-tabs-container");
  if (!input || !results || !tabsList) return;

  const ENTRY_SELECTOR = "h2, h3, h4, .setting-label, label, .model-name, [data-search-label]";
  const REMOVED_PARTS = ".setting-desc, p, small";
  const TEXT_INPUT_TYPES = ["", "text", "search", "email", "url", "password", "number", "tel"];
  const MAX_RESULTS = 30;
  const MAX_TEXT = 160;
  const MAX_SPREAD = 3;
  const MAX_ALIGNMENTS = 20;
  const FUZZY_CEILING = 499;
  const FLASH_MS = 1600;
  type Entry = { tab: string; text: string; where: string; el: Element | null; score: number };
  let hits: Entry[] = [];
  let selected = 0;
  const flashTimers = new Map<Element, ReturnType<typeof setTimeout>>();

  const isWordChar = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch);
  const collapse = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const escape = (value: string): string => value
    .split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;")
    .split('"').join("&quot;").split("'").join("&#39;");

  const align = (q: string, t: string, start: number): number => {
    let total = 0;
    let from = start;
    let run = 0;
    let letters = 0;
    for (const ch of q) {
      if (ch === " ") {
        run = 0;
        continue;
      }
      const found = t.indexOf(ch, from);
      if (found === -1) return -1;
      letters += 1;
      run = found === from ? run + 1 : 0;
      total += 1 + Math.min(run, 5) * 3 + (found === 0 || !isWordChar(t[found - 1]) ? 5 : 0);
      from = found + 1;
    }
    return from - start > letters * MAX_SPREAD + 6 ? -1 : Math.min(total, FUZZY_CEILING);
  };

  const score = (q: string, t: string): number => {
    const direct = t.indexOf(q);
    if (direct !== -1) return 1000 - Math.min(direct, 500) + (direct === 0 || !isWordChar(t[direct - 1]) ? 200 : 0);
    const first = q.replace(/ /g, "")[0];
    if (!first) return -1;
    let best = -1;
    let start = t.indexOf(first);
    for (let tries = 0; start !== -1 && tries < MAX_ALIGNMENTS; tries += 1) {
      best = Math.max(best, align(q, t, start));
      start = t.indexOf(first, start + 1);
    }
    return best;
  };

  const ownText = (el: Element): string => {
    let source: Element = el;
    if (el.querySelector(REMOVED_PARTS)) {
      source = el.cloneNode(true) as Element;
      source.querySelectorAll(REMOVED_PARTS).forEach((part) => part.remove());
    }
    const parts: string[] = [];
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.nodeValue || "");
    return parts.join(" ");
  };

  const sectionName = (tab: string): string => {
    for (const button of Array.from(document.querySelectorAll(".nav-tab[data-tab]"))) {
      if ((button as HTMLElement).dataset.tab === tab) {
        const label = button.querySelector(".nav-tab-label");
        return collapse((label || button).textContent || "");
      }
    }
    return tab;
  };

  const hiddenInside = (el: Element, pane: Element, known: Map<Element, boolean>): boolean => {
    if (el === pane) return false;
    const cached = known.get(el);
    if (cached !== undefined) return cached;
    const hidden = (el as HTMLElement).hidden || getComputedStyle(el).display === "none"
      || (!!el.parentElement && hiddenInside(el.parentElement, pane, known));
    known.set(el, hidden);
    return hidden;
  };

  const collect = (): Entry[] => {
    const entries: Entry[] = [];
    const known = new Map<Element, boolean>();
    document.querySelectorAll(".nav-tab[data-tab]").forEach((button) => {
      const tab = (button as HTMLElement).dataset.tab || "";
      if (tab) entries.push({ tab, text: sectionName(tab), where: "Section", el: null, score: 0 });
    });
    document.querySelectorAll(".tab-pane[id^='pane-']").forEach((pane) => {
      const tab = pane.id.slice("pane-".length);
      const where = sectionName(tab);
      pane.querySelectorAll(ENTRY_SELECTOR).forEach((el) => {
        if (hiddenInside(el, pane, known)) return;
        const text = collapse(el.getAttribute("data-search-label") || ownText(el));
        if (text && text.length <= MAX_TEXT) entries.push({ tab, text, where, el, score: 0 });
      });
    });
    return entries;
  };

  const searchBoxShown = (): boolean => input.getClientRects().length > 0;

  const mark = (): void => {
    results.querySelectorAll(".hub-search-hit").forEach((el, i) => {
      el.classList.toggle("selected", i === selected);
      el.setAttribute("aria-selected", i === selected ? "true" : "false");
    });
    const current = results.querySelectorAll(".hub-search-hit")[selected] as HTMLElement | undefined;
    if (current) {
      input.setAttribute("aria-activedescendant", current.id);
      if (typeof current.scrollIntoView === "function") current.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const render = (): void => {
    const query = collapse(input.value).toLowerCase();
    if (!query) {
      hits = [];
      results.hidden = true;
      results.innerHTML = "";
      tabsList.hidden = false;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const seen = new Set<string>();
    const found: Entry[] = [];
    if (query.length <= MAX_TEXT) {
      for (const entry of collect()) {
        const value = score(query, entry.text.toLowerCase());
        if (value < 0) continue;
        const key = entry.tab + "|" + entry.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ ...entry, score: value });
      }
    }
    found.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    hits = found.slice(0, MAX_RESULTS);
    selected = 0;
    tabsList.hidden = true;
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
    results.innerHTML = hits.length
      ? hits.map((hit, i) => '<button type="button" class="hub-search-hit" role="option" id="hub-search-hit-' + i + '" data-index="' + i + '">' +
          '<span class="hub-search-text">' + escape(hit.text) + '</span>' +
          '<span class="hub-search-where">' + escape(hit.where) + '</span></button>').join("")
      : '<div class="hub-search-empty" role="status">No matches</div>';
    mark();
  };

  const liveElement = (hit: Entry): Element | null => {
    if (!hit.el || hit.el.isConnected) return hit.el;
    const again = collect().find((entry) => entry.el && entry.tab === hit.tab && entry.text === hit.text);
    return again ? again.el : null;
  };

  const flash = (target: Element): void => {
    const previous = flashTimers.get(target);
    if (previous) clearTimeout(previous);
    target.classList.add("hub-search-flash");
    flashTimers.set(target, setTimeout(() => {
      target.classList.remove("hub-search-flash");
      flashTimers.delete(target);
    }, FLASH_MS));
  };

  const open = (hit: Entry | undefined): void => {
    if (!hit) return;
    switchTab(hit.tab, true);
    const el = liveElement(hit);
    if (!el) return;
    for (let details = el.closest("details"); details; details = details.parentElement ? details.parentElement.closest("details") : null) {
      (details as HTMLDetailsElement).open = true;
    }
    const target = el.closest(".settings-card, .model-card") || el;
    if (typeof (target as HTMLElement).scrollIntoView === "function") (target as HTMLElement).scrollIntoView({ block: "center" });
    flash(target);
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" && hits.length) {
      e.preventDefault();
      selected = (selected + 1) % hits.length;
      mark();
    } else if (e.key === "ArrowUp" && hits.length) {
      e.preventDefault();
      selected = (selected - 1 + hits.length) % hits.length;
      mark();
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(hits[selected]);
    } else if (e.key === "Escape") {
      input.value = "";
      render();
    }
  });
  results.addEventListener("click", (e: Event) => {
    const button = (e.target as Element | null)?.closest(".hub-search-hit") as HTMLElement | null;
    if (button) open(hits[Number(button.dataset.index)]);
  });
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tag = target ? target.tagName : "";
    const typing = !!target && (target.isContentEditable || tag === "TEXTAREA" || tag === "SELECT"
      || (tag === "INPUT" && TEXT_INPUT_TYPES.includes(((target as HTMLInputElement).getAttribute("type") || "").toLowerCase())));
    const find = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f";
    const slash = e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey;
    if ((find || slash) && searchBoxShown()) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}
