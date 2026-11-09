/* The Pull Requests and Issues webview. Injected with toString(), and production builds rename identifiers,
   so this function may only use its parameter and browser built-ins. Text from GitHub is only ever placed
   with text nodes, never as HTML. */

interface RepoVsCodeApi {
  postMessage(message: unknown): void;
}

export function repoViewClient(vscode: RepoVsCodeApi): void {
  const root = document.getElementById("app") as HTMLElement;
  const sheetEl = document.getElementById("sheet") as HTMLElement;
  const backEl = document.getElementById("sheet-back") as HTMLElement;
  const liveEl = document.getElementById("live") as HTMLElement;
  let state: any = null;
  let subtab = "overview";
  let lastFocus: HTMLElement | null = null;
  let lastFocusKey: string | null = null;
  let failSheet: ((text: string) => void) | null = null;
  let sheetOpen = false;
  let filterTimer: any = null;
  let typedText: string | null = null;
  let pendingFocusRow: number | null = null;

  type Child = Node | string | null | undefined | false;
  function h(tag: string, attrs?: Record<string, any> | null, ...children: (Child | Child[])[]): HTMLElement {
    const el = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") el.className = String(value);
        else if (key === "text") el.textContent = String(value);
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : String(value));
      }
    }
    const add = (child: Child | Child[]) => {
      if (Array.isArray(child)) child.forEach(add);
      else if (child instanceof Node) el.appendChild(child);
      else if (typeof child === "string") el.appendChild(document.createTextNode(child));
    };
    children.forEach(add);
    return el;
  }
  const icon = (name: string, cls?: string, label?: string) => {
    const span = h("span", { class: "codicon codicon-" + name + (cls ? " " + cls : ""), "aria-hidden": "true" });
    return label ? [span, h("span", { class: "sr", text: label })] : span;
  };
  const send = (message: any) => vscode.postMessage(message);
  const say = (text: string) => { liveEl.textContent = ""; setTimeout(() => { liveEl.textContent = text; }, 30); };

  function ago(iso: string): string {
    const t = Date.parse(iso);
    if (!isFinite(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " minutes ago";
    if (s < 86400) return Math.round(s / 3600) + " hours ago";
    if (s < 172800) return "yesterday";
    if (s < 30 * 86400) return Math.round(s / 86400) + " days ago";
    if (s < 365 * 86400) return Math.round(s / (30 * 86400)) + " months ago";
    return Math.round(s / (365 * 86400)) + " years ago";
  }
  const when = (iso: string) => h("span", { title: isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : "", text: ago(iso) });

  function hostOf(url: string): string | null {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && !u.username && !u.password ? u.host : null;
    } catch {
      return null;
    }
  }

  /** Inline text, built only from text nodes and a fixed set of elements: `code`, **bold**, *italic*, the tags
   *  sub, sup, b, strong, i, em, code, kbd and br, [links](https://…) and ![images](…) shown as links with their
   *  real site, and #123 references. Any other tag stays visible as text. */
  function inline(text: string, depth?: number): Node[] {
    const level = depth || 0;
    const out: Node[] = [];
    if (level > 6) { out.push(document.createTextNode(text)); return out; }
    const re = /(`[^`\n]{1,500}`)|(!?\[([^\]\n]{0,300})\]\(([^)\s]{1,2048})(?:\s+"[^"\n]*")?\))|(\*\*([^*\n](?:[^*]|\*(?!\*)){0,2000}?)\*\*)|(<(sub|sup|b|strong|i|em|code|kbd)>([\s\S]{0,2000}?)<\/\8>)|(<br\s*\/?>)|((^|[^\w*])\*([^*\s](?:[^*\n]{0,500}?[^*\s])?)\*(?![\w*]))|((^|[\s(])#([1-9][0-9]{0,9})\b)/gi;
    let at = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const lead = m[11] ? m[12] || "" : m[14] ? m[15] || "" : "";
      const before = text.slice(at, m.index) + lead;
      if (before) out.push(document.createTextNode(before));
      if (m[1]) out.push(h("code", { text: m[1].slice(1, -1) }));
      else if (m[2]) {
        const url = m[4];
        const isImage = m[2].charAt(0) === "!";
        const label = m[3] || (isImage ? "image" : url);
        const host = hostOf(url);
        if (host) {
          out.push(h("button", { class: "link", type: "button", title: "Opens " + host + " in your browser", onclick: () => send({ type: "open_link", url: url }) }, (isImage ? "Image: " : "") + label));
          out.push(h("span", { class: "host", text: host }));
        } else {
          out.push(document.createTextNode(label));
          out.push(h("span", { class: "muted", text: " (link removed: not https)" }));
        }
      } else if (m[5]) out.push(h("strong", null, inline(m[6], level + 1)));
      else if (m[7]) {
        const tag = m[8].toLowerCase();
        const name = tag === "b" ? "strong" : tag === "i" ? "em" : tag;
        out.push(name === "code" || name === "kbd" ? h(name, { text: m[9] }) : h(name, null, inline(m[9], level + 1)));
      } else if (m[10]) out.push(h("br"));
      else if (m[11]) out.push(h("em", null, inline(m[13], level + 1)));
      else if (m[14]) out.push(h("span", { class: "ref", text: "#" + m[16] }));
      at = m.index + m[0].length;
    }
    if (at < text.length) out.push(document.createTextNode(text.slice(at)));
    return out;
  }

  /** HTML comments found in one pass (no backtracking), so a long body can't stall the view. */
  function splitComments(source: string): { text: string; comment: boolean }[] {
    const parts: { text: string; comment: boolean }[] = [];
    let at = 0;
    while (at < source.length) {
      const open = source.indexOf("<!--", at);
      if (open < 0) break;
      const close = source.indexOf("-->", open + 4);
      if (close < 0) break;
      if (open > at) parts.push({ text: source.slice(at, open), comment: false });
      parts.push({ text: source.slice(open + 4, close), comment: true });
      at = close + 3;
    }
    if (at < source.length) parts.push({ text: source.slice(at), comment: false });
    return parts;
  }

  function cells(row: string): string[] {
    let s = row.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const out: string[] = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
      if (s[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
      cur += s[i];
    }
    out.push(cur.trim());
    return out;
  }

  /** A Markdown subset rendered with text nodes: headings, paragraphs, lists, task lists, quotes, fenced code,
   *  tables, rules, <details>/<summary>, and HTML comments shown dimmed as "Hidden on GitHub". */
  function markdown(source: string): HTMLElement {
    const box = h("div", { class: "md" });
    const MARK = String.fromCharCode(0);
    const hidden: string[] = [];
    const text = splitComments(source).map((part) => {
      if (!part.comment) return part.text;
      hidden.push(part.text);
      return "\n" + MARK + (hidden.length - 1) + MARK + "\n";
    }).join("");
    const lines = text.split("\n");
    const stack: HTMLElement[] = [box];
    const top = () => stack[stack.length - 1];
    let para: string[] = [];
    let listEl: HTMLElement | null = null;
    const flush = () => {
      if (para.length) top().appendChild(h("p", null, inline(para.join("\n"))));
      para = [];
    };
    const restore = (s: string) => s.split(MARK).map((piece, i) => i % 2 === 1 ? "<!--" + (hidden[Number(piece)] || "") + "-->" : piece).join("");
    const isSep = (s: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(s) && s.indexOf("-") >= 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      const fence = /^\s{0,3}(```|~~~)/.exec(raw);
      if (fence) {
        flush(); listEl = null;
        const code: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) code.push(lines[i++]);
        top().appendChild(h("pre", { class: "code" }, restore(code.join("\n")).replace(/^\n|\n$/g, "")));
        continue;
      }
      const marker = new RegExp("^" + MARK + "(\\d+)" + MARK + "$").exec(trimmed);
      if (marker) {
        flush(); listEl = null;
        const inner = (hidden[Number(marker[1])] || "").trim();
        if (inner) top().appendChild(h("div", { class: "hidden-text", title: "This text is hidden on GitHub's own page" }, h("span", { class: "hidden-label", text: "Hidden on GitHub: " }), inner));
        continue;
      }
      if (!trimmed) { flush(); listEl = null; continue; }
      const open = /^<details(\s+open)?\s*>(.*)$/i.exec(trimmed);
      if (open && stack.length < 8) {
        flush(); listEl = null;
        const det = h("details", { class: "md-details" });
        if (open[1]) det.setAttribute("open", "");
        top().appendChild(det);
        stack.push(det);
        const rest = open[2].trim();
        const sum = /^<summary>([\s\S]*?)<\/summary>(.*)$/i.exec(rest);
        if (sum) { det.appendChild(h("summary", null, inline(sum[1]))); if (sum[2].trim()) para.push(sum[2]); }
        else if (rest) para.push(rest);
        continue;
      }
      const summary = /^<summary>([\s\S]*?)<\/summary>(.*)$/i.exec(trimmed);
      if (summary && top().tagName === "DETAILS" && !top().querySelector("summary")) {
        flush(); listEl = null;
        top().insertBefore(h("summary", null, inline(summary[1])), top().firstChild);
        if (summary[2].trim()) para.push(summary[2]);
        continue;
      }
      if (/^<\/details>$/i.test(trimmed) && stack.length > 1) { flush(); listEl = null; stack.pop(); continue; }
      if (/^\s{0,3}(-\s*){3,}$|^\s{0,3}(\*\s*){3,}$|^\s{0,3}(_\s*){3,}$/.test(raw)) { flush(); listEl = null; top().appendChild(h("hr")); continue; }
      if (raw.indexOf("|") >= 0 && i + 1 < lines.length && isSep(lines[i + 1])) {
        flush(); listEl = null;
        const table = h("table", { class: "md-table" });
        const head = cells(raw);
        table.appendChild(h("thead", null, h("tr", null, head.map((c) => h("th", null, inline(c))))));
        const body = h("tbody");
        i += 2;
        let rows = 0;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0 && rows < 500) {
          const row = cells(lines[i]);
          body.appendChild(h("tr", null, head.map((_c, k) => h("td", null, inline(row[k] || "")))));
          i++; rows++;
        }
        i--;
        table.appendChild(body);
        top().appendChild(h("div", { class: "md-table-wrap" }, table));
        continue;
      }
      const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(raw);
      if (heading) { flush(); listEl = null; top().appendChild(h("p", { class: "md-h md-h" + heading[1].length }, inline(heading[2]))); continue; }
      const item = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(raw);
      if (item) {
        flush();
        const ordered = /\d/.test(item[1]);
        if (!listEl || listEl.tagName !== (ordered ? "OL" : "UL") || listEl.parentElement !== top()) { listEl = h(ordered ? "ol" : "ul"); top().appendChild(listEl); }
        const check = /^\[([ xX])\]\s+(.*)$/.exec(item[2]);
        listEl.appendChild(h("li", null, check ? [check[1] === " " ? "☐ " : "☑ ", ...inline(check[2])] : inline(item[2])));
        continue;
      }
      const quote = /^\s{0,3}>\s?(.*)$/.exec(raw);
      if (quote) { flush(); listEl = null; top().appendChild(h("blockquote", null, inline(quote[1]))); continue; }
      listEl = null;
      para.push(raw);
    }
    flush();
    return box;
  }

  function trustNote(who: string): HTMLElement {
    return h("div", { class: "untrusted" }, icon("shield"), h("span", null, "Written by " + who + " on GitHub and shown as text: no images, scripts or HTML. Only https links are kept, with their real site shown next to them."));
  }

  const aiPattern = /ignore (all )?(previous|prior|above) (instructions|rules)|^\s*system\s*:|you are now|disregard (all|your) (instructions|rules)|developer mode|maintenance mode/im;

  // ---------- list ----------

  function stateIcon(item: any): any {
    if (item.kind === "issue") {
      if (item.state === "closed") return item.stateReason === "not_planned" ? icon("circle-slash", "st-draft", "Closed as not planned") : icon("issue-closed", "st-merged", "Closed");
      return icon("issues", "st-open", "Open issue");
    }
    const map: any = { open: ["git-pull-request", "st-open", "Open"], draft: ["git-pull-request-draft", "st-draft", "Draft"], merged: ["git-merge", "st-merged", "Merged"], closed: ["git-pull-request-closed", "st-closed", "Closed"] };
    const v = map[item.state] || map.open;
    return icon(v[0], v[1], v[2]);
  }

  function checksBit(c: any): HTMLElement | null {
    if (c === "failure") return h("span", { class: "fail" }, icon("error"), " checks failing");
    if (c === "pending") return h("span", { class: "pend" }, icon("clock"), " checks running");
    if (c === "success") return h("span", { class: "pass" }, icon("pass-filled"), " checks pass");
    return null;
  }

  function reviewBit(item: any, me: string | null): HTMLElement | null {
    if (me && item.requestedUsers && item.requestedUsers.indexOf(me) >= 0) return h("span", { class: "tag you", text: "review requested from you" });
    if (item.requestedTeams) return h("span", { class: "tag" }, icon("organization"), item.requestedTeams === 1 ? " team review requested" : " " + item.requestedTeams + " team reviews requested");
    if (item.review === "CHANGES_REQUESTED") return h("span", { class: "fail", text: "changes requested" });
    if (item.review === "APPROVED") return h("span", { class: "pass", text: "approved" });
    return null;
  }

  function labelEl(label: any): HTMLElement {
    const dot = h("i");
    if (label.color && /^#[0-9a-f]{6}$/.test(label.color)) dot.style.background = label.color;
    return h("span", { class: "label" }, dot, label.name);
  }

  function row(item: any): HTMLElement {
    const sel = state.selected === item.number;
    const isMine = state.branch && state.branch.number === item.number && item.kind === "pr";
    const meta = h("div", { class: "meta" }, h("span", { text: "#" + item.number }), h("span", { text: item.author }), when(item.updatedAt), item.labels.map(labelEl),
      isMine ? h("span", { class: "tag you", text: "your branch" }) : null,
      item.kind === "issue" && item.linked && item.linked.length ? h("span", null, icon("git-pull-request"), " #" + item.linked.join(", #")) : null,
      item.kind === "issue" && item.comments ? h("span", null, icon("comment"), " " + item.comments) : null);
    const sig = item.kind === "pr" ? h("div", { class: "sig" }, checksBit(item.checks), reviewBit(item, state.account), item.comments ? h("span", { class: "muted" }, icon("comment"), " " + item.comments) : null) : null;
    const label = (item.kind === "pr" ? "Pull request" : "Issue") + " #" + item.number + ": " + item.title + ", by " + item.author;
    return h("div", {
      class: "row", role: "option", id: "row-" + item.number, "data-n": item.number, "aria-selected": sel ? "true" : "false", tabindex: sel ? "0" : "-1", "aria-label": label,
      onclick: () => choose(item.number, false),
    }, stateIcon(item), h("div", { class: "body" }, h("div", { class: "title", text: item.title }), meta, sig));
  }

  function choose(n: number, focus: boolean) {
    if (focus) pendingFocusRow = n;
    if (state.selected !== n) { subtab = "overview"; send({ type: "select", number: n }); }
    else if (focus) focusRow(n);
  }
  function focusRow(n: number) {
    const el = document.getElementById("row-" + n);
    if (el) { el.focus(); el.scrollIntoView({ block: "nearest" }); }
  }

  function side(): HTMLElement {
    const box = h("div", { class: "side" });
    if (state.branch && state.branch.number) {
      box.appendChild(h("div", { class: "banner" }, icon("git-branch"), h("span", null, "You're on ", h("code", { text: state.branch.name }), ", pull request #" + state.branch.number),
        h("button", { class: "link", type: "button", onclick: () => { if (state.kind !== "pr") send({ type: "kind", kind: "pr" }); choose(state.branch.number, false); } }, "Show")));
    }
    const chips = h("div", { class: "filters", role: "toolbar", "aria-label": "Filters" });
    for (const chip of state.chips) {
      chips.appendChild(h("button", { class: "chip", type: "button", "aria-pressed": state.filter === chip.id ? "true" : "false", onclick: () => send({ type: "filter", filter: chip.id }) },
        chip.label, chip.count === null ? null : h("span", { class: "count", text: String(chip.count) })));
    }
    if (state.filter === "all") {
      const sel = h("select", { "aria-label": "Sort", onchange: (e: any) => send({ type: "sort", sort: e.target.value }) },
        h("option", { value: "updated", text: "Recently updated" }), h("option", { value: "created", text: "Newest" }), h("option", { value: "stale", text: "Least recently updated" })) as HTMLSelectElement;
      sel.value = state.sort;
      chips.appendChild(sel);
    }
    box.appendChild(chips);
    const list = h("div", { class: "list", role: "listbox", "aria-label": state.kind === "pr" ? "Pull requests" : "Issues", "aria-busy": state.loadingList ? "true" : "false" });
    let count = 0;
    for (const group of state.groups) {
      if (!group.items.length) continue;
      if (group.title) list.appendChild(h("div", { class: "group", role: "presentation" }, group.title + " ", h("span", { text: String(group.items.length) })));
      for (const item of group.items) { list.appendChild(row(item)); count++; }
    }
    if (!count) {
      list.appendChild(h("div", { class: "none" }, state.loadingList ? "Loading…" : state.text ? "Nothing matches this filter." : state.kind === "pr"
        ? (state.filter === "foryou" ? "Nothing needs you right now: no reviews requested and no open pull requests of yours." : "No open pull requests.")
        : (state.filter === "assigned" ? "No open issues are assigned to you." : "No open issues.")));
    }
    if (state.more) list.appendChild(h("div", { class: "more" }, h("button", { class: "btn", type: "button", disabled: state.loadingMore, onclick: () => send({ type: "more" }) }, state.loadingMore ? "Loading…" : "Show 50 more")));
    list.addEventListener("keydown", (e: KeyboardEvent) => {
      const rows = Array.prototype.slice.call(list.querySelectorAll(".row")) as HTMLElement[];
      const i = rows.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -1;
      if (to >= 0 && rows[to]) { e.preventDefault(); choose(Number(rows[to].getAttribute("data-n")), true); }
      if (e.key === "Enter") { e.preventDefault(); const t = document.getElementById("detail-title"); if (t) t.focus(); }
    });
    box.appendChild(list);
    return box;
  }

  // ---------- detail ----------

  function mergeWords(s: string): any[] {
    const map: any = {
      CLEAN: ["pass-filled", "pass", "No blockers reported by GitHub"], BLOCKED: ["lock", "pend", "Blocked: GitHub requires more before merging"],
      BEHIND: ["warning", "pend", "Behind the base branch"], DIRTY: ["warning", "fail", "Has conflicts with the base branch"], UNSTABLE: ["warning", "pend", "Non-required checks failing"],
      DRAFT: ["git-pull-request-draft", "muted", "Draft"], HAS_HOOKS: ["pass-filled", "pass", "No blockers reported by GitHub"], UNKNOWN: ["clock", "muted", "Checking with GitHub…"],
      MERGED: ["git-merge", "st-merged", "Merged"], CLOSED: ["git-pull-request-closed", "st-closed", "Closed"],
    };
    return map[s] || map.UNKNOWN;
  }

  function moreMenu(item: any): HTMLElement {
    const wrap = h("span", { class: "menu-wrap" });
    const menu = h("div", { class: "menu", role: "menu", hidden: true },
      h("button", { role: "menuitem", type: "button", onclick: () => { closeMenus(); send({ type: "copy", number: item.number }); } }, icon("copy"), "Copy link"),
      h("button", { role: "menuitem", type: "button", onclick: () => { closeMenus(); send({ type: "open", number: item.number }); } }, icon("link-external"), "Open on GitHub"),
      h("div", { class: "sep" }),
      h("div", { class: "hint", text: item.kind === "pr" ? "Merge, approve, close and labels are on GitHub." : "Comment, assign and close are on GitHub." }));
    const btn = h("button", { class: "btn icon", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "More actions",
      onclick: (e: Event) => {
        e.stopPropagation();
        const open = menu.hidden;
        closeMenus();
        menu.hidden = !open;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) (menu.querySelector("button") as HTMLElement).focus();
      } }, icon("ellipsis"));
    menu.addEventListener("keydown", (e: KeyboardEvent) => {
      const items = Array.prototype.slice.call(menu.querySelectorAll("button")) as HTMLElement[];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); }
      if (e.key === "Escape") { e.stopPropagation(); closeMenus(); btn.focus(); }
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }
  function closeMenus() {
    Array.prototype.forEach.call(document.querySelectorAll(".menu"), (m: HTMLElement) => { m.hidden = true; });
    Array.prototype.forEach.call(document.querySelectorAll("[aria-haspopup=menu]"), (b: HTMLElement) => b.setAttribute("aria-expanded", "false"));
  }

  function person(name: string, extra?: Child): HTMLElement {
    return h("div", { class: "person" }, h("span", { class: "avatar", "aria-hidden": "true", text: name.charAt(0).toUpperCase() }), name, extra || null);
  }

  function commentEl(c: any): HTMLElement {
    return h("div", { class: "cmt" }, h("span", { class: "avatar", "aria-hidden": "true", text: c.author.charAt(0).toUpperCase() }),
      h("div", { class: "cbody" }, h("span", { class: "who", text: c.author }), " ", h("span", { class: "assoc", text: c.association }), " ", h("span", { class: "when" }, when(c.createdAt)), markdown(c.body)));
  }

  function tabs(d: any): HTMLElement {
    const list: any[] = [["overview", "Overview", null], ["files", "Files", d.changedFiles], ["conversation", "Conversation", d.conversation.length + d.threads.filter((t: any) => !t.resolved && !t.outdated).length], ["checks", "Checks", d.checkList.length]];
    const bar = h("div", { class: "tabs", role: "tablist", "aria-label": "Pull request details" });
    list.forEach((t) => {
      bar.appendChild(h("button", { role: "tab", type: "button", id: "tab-" + t[0], "aria-selected": subtab === t[0] ? "true" : "false", tabindex: subtab === t[0] ? "0" : "-1", "aria-controls": "tabpanel",
        onclick: () => { subtab = t[0]; if (subtab === "files") send({ type: "files" }); render(); const b = document.getElementById("tab-" + t[0]); if (b) b.focus(); } },
        t[1], t[2] === null ? null : h("span", { class: "count", text: String(t[2]) })));
    });
    bar.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = list.findIndex((t) => t[0] === subtab);
      const next = list[(i + (e.key === "ArrowRight" ? 1 : list.length - 1)) % list.length][0];
      subtab = next;
      if (next === "files") send({ type: "files" });
      render();
      const b = document.getElementById("tab-" + next);
      if (b) b.focus();
    });
    return bar;
  }

  function prPane(d: any): HTMLElement {
    const pane = h("div", { class: "pane", role: "tabpanel", id: "tabpanel", "aria-labelledby": "tab-" + subtab });
    if (subtab === "files") {
      if (!state.files && !state.filesLoading && !state.filesError) setTimeout(() => send({ type: "files" }), 0);
      if (state.filesLoading && !state.files) pane.appendChild(h("p", { class: "muted", text: "Loading files…" }));
      else if (state.filesError) pane.appendChild(h("p", { class: "fail", text: state.filesError }));
      else if (state.files) {
        const steering = state.files.filter((f: any) => STEERING.test(f.path) || (f.previousPath && STEERING.test(f.previousPath)));
        if (steering.length) {
          pane.appendChild(h("div", { class: "box warn" }, icon("warning", "pend"), " This pull request changes files that control how tools and agents behave in a folder: ",
            steering.slice(0, 12).map((f: any, i: number) => [i ? ", " : "", h("code", { text: f.path })]),
            steering.length > 12 ? " and " + (steering.length - 12) + " more" : "",
            ". Reading it here is safe. Checking it out would put these files in your folder."));
        }
        for (const f of state.files) {
          const head = h("summary", null, h("span", { class: "fstatus " + f.status, text: f.status.charAt(0).toUpperCase() }), " ",
            h("span", { class: "fpath", text: f.previousPath ? f.previousPath + " → " + f.path : f.path }), " ", h("span", { class: "a", text: "+" + f.additions }), " ", h("span", { class: "d", text: "-" + f.deletions }));
          const body = h("div", { class: "patch" });
          if (f.patch === null) body.appendChild(h("p", { class: "muted", text: "No diff shown: the file is binary or too large. Open it on GitHub." }));
          else {
            const pre = h("pre", { class: "diff" });
            const lines = f.patch.split("\n").slice(0, 3000);
            for (const ln of lines) pre.appendChild(h("span", { class: ln.startsWith("+") ? "dl add" : ln.startsWith("-") ? "dl del" : ln.startsWith("@@") ? "dl hunk" : "dl", text: ln + "\n" }));
            body.appendChild(pre);
          }
          pane.appendChild(h("details", { class: "file" }, head, body));
        }
        if (state.filesMore) pane.appendChild(h("p", { class: "muted", text: "Only the first 300 files are shown. Open the pull request on GitHub for the rest." }));
        pane.appendChild(h("p", { class: "muted small", text: "Diffs come from GitHub. Nothing is checked out or run." }));
      }
      return pane;
    }
    if (subtab === "conversation") {
      const open = d.threads.filter((t: any) => !t.resolved && !t.outdated);
      const hidden = d.threads.length - open.length;
      if (!d.conversation.length && !d.threads.length) { pane.appendChild(h("p", { class: "muted", text: "No comments yet." })); return pane; }
      pane.appendChild(trustNote("the commenters"));
      if (d.conversation.length) pane.appendChild(h("div", { class: "thread" }, h("div", { class: "th" }, icon("comment-discussion"), " General comments"), d.conversation.map(commentEl)));
      const show = (window as any).__showHiddenThreads ? d.threads : open;
      for (const t of show) {
        pane.appendChild(h("div", { class: "thread" }, h("div", { class: "th" }, icon("comment"), " ", h("code", { text: t.path + (t.line ? ":" + t.line : "") }), " ",
          h("span", { class: "muted", text: t.resolved ? "resolved" : t.outdated ? "outdated" : "open" })), t.comments.map(commentEl)));
      }
      if (hidden && !(window as any).__showHiddenThreads) {
        pane.appendChild(h("p", { class: "muted" }, hidden + (hidden === 1 ? " resolved or outdated thread is" : " resolved or outdated threads are") + " hidden. ",
          h("button", { class: "link", type: "button", onclick: () => { (window as any).__showHiddenThreads = true; render(); } }, "Show")));
      }
      pane.appendChild(h("p", { class: "muted small", text: "To reply, resolve or react, open it on GitHub." }));
      return pane;
    }
    if (subtab === "checks") {
      if (!d.checkList.length) { pane.appendChild(h("p", { class: "muted", text: "This pull request has no checks." })); return pane; }
      d.checkList.forEach((c: any, i: number) => {
        const s = c.state === "fail" ? ["error", "fail", "failed"] : c.state === "pending" ? ["clock", "pend", "running"] : c.state === "pass" ? ["pass-filled", "pass", "passed"] : ["circle-slash", "muted", c.state];
        pane.appendChild(h("div", { class: "check" }, icon(s[0], s[1], s[2]), h("span", { class: "n" }, c.name, c.required ? h("span", { class: "tag", text: "required" }) : null),
          h("span", { class: "s", text: (s[2].charAt(0).toUpperCase() + s[2].slice(1)) + (c.app ? " · " + c.app : "") }),
          c.url ? h("button", { class: "btn icon", type: "button", "aria-label": "Open " + c.name + " in your browser", title: "Opens " + (hostOf(c.url) || "the check"), onclick: () => send({ type: "open_check", number: d.number, index: i }) }, icon("link-external")) : null));
      });
      pane.appendChild(h("p", { class: "muted small", text: "Check runs and commit statuses from other CI both appear here. Running checks update when you refresh." }));
      return pane;
    }
    pane.appendChild(trustNote(d.author));
    const said = [d.title, d.body].concat(d.conversation.map((c: any) => c.body)).concat(d.threads.flatMap((t: any) => t.comments.map((c: any) => c.body)));
    if (aiPattern.test(said.join("\n"))) pane.appendChild(aiNote());
    pane.appendChild(d.body.trim() ? markdown(d.body) : h("p", { class: "muted", text: "No description." }));
    if (d.bodyCut) pane.appendChild(cutNote(d));
    if (d.closes.length) {
      pane.appendChild(h("div", { class: "section" }, h("h3", { text: "Closes when merged" }), d.closes.map((c: any) => h("div", { class: "linkrow" }, icon("issues", "st-open"), h("span", { text: "#" + c.number + " " + c.title })))));
    }
    const reviewers: HTMLElement[] = [];
    (d.requestedUsers || []).forEach((u: string) => reviewers.push(person(u, h("span", { class: "tag" + (u === state.account ? " you" : ""), text: "requested" }))));
    if (d.requestedTeams) reviewers.push(h("div", { class: "person" }, icon("organization"), d.requestedTeams === 1 ? "A team" : d.requestedTeams + " teams", h("span", { class: "tag", text: "requested" }), h("span", { class: "muted small", text: " (team names need GitHub's read:org permission)" })));
    d.reviews.forEach((r: any) => reviewers.push(person(r.author, h("span", { class: r.state === "APPROVED" ? "pass" : r.state === "CHANGES_REQUESTED" ? "fail" : "muted", text: r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes requested" : r.state.toLowerCase().replace(/_/g, " ") }))));
    pane.appendChild(h("div", { class: "section" }, h("h3", { text: "Reviewers" }), reviewers.length ? h("div", { class: "people" }, reviewers) : h("span", { class: "muted", text: "None yet" })));
    return pane;
  }

  function cutNote(d: any): HTMLElement {
    return h("p", { class: "muted" }, "The text is longer than 60,000 characters, so only the start is shown here. ",
      h("button", { class: "link", type: "button", onclick: () => send({ type: "open", number: d.number }) }, "Read the rest on GitHub"));
  }

  const STEERING = /(^|\/)(AGENTS\.md|CLAUDE\.md|GEMINI\.md|andromity\.md|\.cursorrules|\.windsurfrules|copilot-instructions\.md|\.pre-commit-config\.ya?ml|package\.json|Makefile|\.gitattributes|\.gitmodules)$|(^|\/)(\.vscode|\.andromity|\.husky|\.cursor|\.claude|\.github\/workflows|\.devcontainer)\//i;

  function aiNote(): HTMLElement {
    return h("div", { class: "box warn" }, icon("warning", "pend"), " This text contains instructions aimed at an AI. Andromity reads GitHub text only in read-only chats: they can't edit files, run commands or post anything.");
  }

  function detail(): HTMLElement {
    const box = h("div", { class: "detail", id: "detail" });
    const d = state.detail;
    if (!d) {
      if (state.detailError) box.appendChild(h("div", { class: "none" }, h("p", { class: "fail", text: state.detailError }), h("button", { class: "btn", type: "button", onclick: () => send({ type: "select", number: state.selected }) }, "Try again")));
      else if (state.detailLoading || state.selected !== null) box.appendChild(h("div", { class: "none", text: "Loading…" }));
      else box.appendChild(h("div", { class: "none", text: state.kind === "pr" ? "Choose a pull request." : "Choose an issue." }));
      return box;
    }
    const isPr = d.kind === "pr";
    const live = d.state === "open" || d.state === "draft";
    const head = h("div", { class: "dhead" });
    head.appendChild(h("h1", { class: "dtitle", id: "detail-title", tabindex: "-1" }, d.title + " ", h("span", { class: "num", text: "#" + d.number })));
    const pill = isPr
      ? ({ open: ["git-pull-request", "st-open", "Open"], draft: ["git-pull-request-draft", "st-draft", "Draft"], merged: ["git-merge", "st-merged", "Merged"], closed: ["git-pull-request-closed", "st-closed", "Closed"] } as any)[d.state]
      : d.state === "open" ? ["issues", "st-open", "Open"] : d.stateReason === "not_planned" ? ["circle-slash", "st-draft", "Closed as not planned"] : ["issue-closed", "st-merged", "Closed as completed"];
    const meta = h("div", { class: "dmeta" }, h("span", { class: "pill " + pill[1] }, icon(pill[0]), pill[2]), h("span", { class: "avatar", "aria-hidden": "true", text: d.author.charAt(0).toUpperCase() }), h("b", { text: d.author }), h("span", { class: "assoc", text: d.association }));
    if (isPr) {
      meta.appendChild(h("span", null, "wants to merge " + d.commits + " commit" + (d.commits === 1 ? "" : "s") + " into ", h("code", { text: d.baseRef }), " from ", h("code", { text: (d.crossRepository && d.headOwner ? d.headOwner + ":" : "") + d.headRef })));
    } else meta.appendChild(h("span", { text: "opened this" }));
    meta.appendChild(h("span", null, "· updated ", when(d.updatedAt)));
    if (isPr && state.branch && state.branch.number === d.number) meta.appendChild(h("span", { class: "tag you", text: "checked out here" }));
    head.appendChild(meta);
    if (isPr) {
      const failing = d.checkList.filter((c: any) => c.state === "fail");
      const running = d.checkList.filter((c: any) => c.state === "pending");
      const checks = failing.length ? h("span", { class: "fail" }, icon("error"), " " + failing.length + " failing" + (failing.some((c: any) => c.required) ? ", required" : ""))
        : running.length ? h("span", { class: "pend" }, icon("clock"), " " + running.length + " running")
        : d.checkList.length ? h("span", { class: "pass" }, icon("pass-filled"), " all " + d.checkList.length + " pass") : h("span", { class: "muted", text: "none" });
      const reviewWord = d.review === "CHANGES_REQUESTED" ? h("span", { class: "fail", text: "changes requested" }) : d.review === "APPROVED" ? h("span", { class: "pass", text: "approved" }) : d.review === "REVIEW_REQUIRED" ? h("span", { class: "pend", text: "required" }) : h("span", { class: "muted", text: "not required" });
      const mw = mergeWords(d.mergeState);
      head.appendChild(h("div", { class: "line", role: "group", "aria-label": "Status" },
        h("span", null, h("span", { class: "k", text: "Checks " }), checks), h("span", null, h("span", { class: "k", text: "Reviews " }), reviewWord),
        h("span", null, h("span", { class: "k", text: "Merge " }), icon(mw[0], mw[1]), " ", h("span", { class: mw[1], text: mw[2] }))));
    } else {
      head.appendChild(h("div", { class: "line" },
        h("span", null, h("span", { class: "k", text: "Assignees " }), d.assignees.length ? d.assignees.join(", ") : h("span", { class: "muted", text: "no one" })),
        h("span", null, h("span", { class: "k", text: "Labels " }), d.labels.length ? d.labels.map(labelEl) : h("span", { class: "muted", text: "none" })),
        h("span", null, h("span", { class: "k", text: "Pull requests " }), d.closedBy.length ? d.closedBy.map((c: any) => "#" + c.number).join(", ") : h("span", { class: "muted", text: "none yet" }))));
    }
    const actions = h("div", { class: "actions" });
    const mine = state.account && d.author === state.account;
    if (isPr && live && !mine) actions.appendChild(h("button", { class: "btn primary", type: "button", "data-focus": "review", onclick: () => openSheet("review", d) }, icon("sparkle"), "Review with Andromity"));
    actions.appendChild(h("button", { class: "btn" + (isPr && live && !mine ? "" : " primary"), type: "button", "data-focus": "ask", onclick: () => openSheet("ask", d) }, icon("comment-discussion"), "Ask Andromity"));
    actions.appendChild(moreMenu(d));
    head.appendChild(actions);
    box.appendChild(head);
    if (isPr) {
      box.appendChild(tabs(d));
      box.appendChild(prPane(d));
    } else {
      const pane = h("div", { class: "pane" });
      pane.appendChild(trustNote(d.author));
      if (aiPattern.test(d.title + "\n" + d.body + "\n" + d.conversation.map((c: any) => c.body).join("\n"))) pane.appendChild(aiNote());
      pane.appendChild(d.body.trim() ? markdown(d.body) : h("p", { class: "muted", text: "No description." }));
      if (d.bodyCut) pane.appendChild(cutNote(d));
      if (d.conversation.length) pane.appendChild(h("div", { class: "section" }, h("h3", { text: "Comments" }), h("div", { class: "thread" }, d.conversation.map(commentEl))));
      box.appendChild(pane);
    }
    return box;
  }

  // ---------- sheets ----------

  function readOnlyBox(what: string, d: any): HTMLElement {
    const size = d.kind === "pr" ? " The diff is " + (d.additions + d.deletions) + " changed lines." : "";
    return h("div", { class: "box" }, h("b", null, icon("shield"), " Read-only chat"), h("ul", null,
      h("li", { text: what + " go to the model as untrusted text, marked as written by someone else on GitHub." }),
      h("li", { text: "The chat can read your repository but can't edit files, run commands or post anything." }),
      h("li", null, "Sent to your chat model, ", h("code", { text: state.model }), "." + size)));
  }

  function openSheet(kind: string, d: any) {
    lastFocus = document.activeElement as HTMLElement;
    lastFocusKey = lastFocus && lastFocus.getAttribute ? lastFocus.getAttribute("data-focus") : null;
    sheetEl.textContent = "";
    const isPr = d.kind === "pr";
    const title = kind === "review" ? "Review pull request #" + d.number + " with Andromity" : "Ask Andromity about " + (isPr ? "pull request" : "issue") + " #" + d.number;
    const ta = h("textarea", { id: "sheet-text", rows: "4", maxlength: "4000", placeholder: kind === "review" ? "For example: correctness of the totals" : "Ask anything about #" + d.number }) as HTMLTextAreaElement;
    const body = h("div", { class: "sb" });
    if (kind === "review") {
      body.appendChild(h("div", { class: "kv" }, h("span", { class: "k", text: "Pull request" }), h("span", { text: "#" + d.number + ", " + d.changedFiles + " files, +" + d.additions + " -" + d.deletions }),
        d.crossRepository && d.headOwner ? h("span", { class: "k", text: "From a fork" }) : null, d.crossRepository && d.headOwner ? h("span", { text: d.headOwner }) : null));
      body.appendChild(h("div", { class: "field" }, h("label", { for: "sheet-text", text: "Anything to focus on? (optional)" }), ta));
      body.appendChild(readOnlyBox("Its description, diff and comments", d));
      body.appendChild(h("div", { class: "box" }, h("b", { text: "After the review" }), h("ul", null,
        h("li", null, h("b", { text: "Edit and post" }), " opens the review as a document you can change."),
        h("li", { text: "Posting is your click, and always a plain comment review: it never approves or requests changes." }))));
    } else {
      body.appendChild(h("div", { class: "field" }, h("label", { for: "sheet-text", text: "Your question" }), ta));
      const sugg = h("div", { class: "suggest", role: "group", "aria-label": "Suggestions" });
      (state.suggestions[d.kind] || []).forEach((s: string) => sugg.appendChild(h("button", { class: "chip", type: "button", onclick: () => { ta.value = s; ta.focus(); update(); } }, s)));
      body.appendChild(sugg);
      body.appendChild(readOnlyBox(isPr ? "Its description, diff, comments and check results" : "Its title, text and comments", d));
    }
    const go = h("button", { class: "btn primary", type: "button" }, icon("sparkle"), kind === "review" ? "Start review" : "Ask") as HTMLButtonElement;
    const update = () => { if (kind === "ask") go.disabled = !ta.value.trim(); };
    ta.addEventListener("input", update);
    update();
    const failLine = h("p", { class: "fail", role: "alert", hidden: true });
    body.appendChild(failLine);
    failSheet = (text: string) => { failLine.textContent = text; failLine.hidden = false; go.disabled = false; update(); };
    go.addEventListener("click", () => {
      if (go.disabled) return;
      go.disabled = true;
      failLine.hidden = true;
      send(kind === "review" ? { type: "review", number: d.number, focus: ta.value } : { type: "ask", number: d.number, question: ta.value });
    });
    ta.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go.click(); } });
    sheetEl.appendChild(h("div", { class: "sh" }, icon(kind === "review" ? "sparkle" : "comment-discussion"), h("h2", { id: "sheet-title", text: title }),
      h("button", { class: "x", type: "button", "aria-label": "Close", onclick: closeSheet }, icon("close"))));
    sheetEl.appendChild(body);
    sheetEl.appendChild(h("div", { class: "sf" }, h("span", { class: "note", text: "Opens a new chat." }), h("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"), go));
    sheetEl.hidden = false;
    backEl.hidden = false;
    sheetOpen = true;
    ta.focus();
  }
  function closeSheet() {
    sheetEl.hidden = true;
    backEl.hidden = true;
    sheetOpen = false;
    failSheet = null;
    const again = lastFocusKey ? root.querySelector('[data-focus="' + lastFocusKey + '"]') as HTMLElement | null : null;
    if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
    else if (again) again.focus();
  }
  backEl.addEventListener("click", closeSheet);
  sheetEl.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
    if (e.key !== "Tab") return;
    const f = Array.prototype.slice.call(sheetEl.querySelectorAll("button, textarea, input, select")).filter((x: any) => !x.disabled) as HTMLElement[];
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });

  // ---------- top ----------

  function topbar(): HTMLElement {
    const bar = h("div", { class: "topbar" });
    if (state.repo) {
      bar.appendChild(h("button", { class: "chip", type: "button", title: state.repo.switchable ? "Choose another repository" : "Repository", disabled: !state.repo.switchable, onclick: () => send({ type: "repo" }) },
        icon("repo"), h("b", { text: state.repo.owner + "/" + state.repo.repo }), state.repo.switchable ? icon("chevron-down", "muted") : null));
    }
    if (state.account) bar.appendChild(h("button", { class: "chip", type: "button", title: "GitHub account used for this view. Click to use another account.", onclick: () => send({ type: "empty_action", id: "another" }) }, icon("account"), state.account));
    if (state.status !== "ready") {
      bar.appendChild(h("div", { class: "spacer" }));
      if (state.status === "empty") bar.appendChild(h("button", { class: "btn", type: "button", onclick: () => send({ type: "empty_action", id: "retry" }) }, icon("refresh"), "Refresh"));
      return bar;
    }
    const seg = h("div", { class: "seg", role: "tablist", "aria-label": "What to show" });
    [["pr", "Pull requests", "git-pull-request", state.totals.pr], ["issue", "Issues", "issues", state.totals.issue]].forEach((t: any) => {
      seg.appendChild(h("button", { role: "tab", type: "button", "aria-selected": state.kind === t[0] ? "true" : "false", onclick: () => { if (state.kind !== t[0]) { subtab = "overview"; send({ type: "kind", kind: t[0] }); } } },
        icon(t[2]), t[1], t[3] === null ? null : h("span", { class: "count", text: String(t[3]) })));
    });
    bar.appendChild(seg);
    const input = h("input", { id: "filter", type: "search", maxlength: "200", placeholder: "Filter, or GitHub search: label:bug author:name", "aria-label": "Filter" }) as HTMLInputElement;
    input.value = typedText !== null ? typedText : state.text;
    input.addEventListener("input", () => {
      typedText = input.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => { send({ type: "text", text: input.value }); }, 450);
    });
    bar.appendChild(h("label", { class: "search" }, icon("search"), input));
    bar.appendChild(h("div", { class: "spacer" }));
    if (state.updatedAt) bar.appendChild(h("span", { class: "updated", title: new Date(state.updatedAt).toLocaleString() }, state.loadingList ? "Updating…" : "Updated " + ago(new Date(state.updatedAt).toISOString())));
    bar.appendChild(h("button", { class: "btn", type: "button", onclick: () => send({ type: "refresh" }), disabled: state.loadingList }, icon("refresh"), "Refresh"));
    return bar;
  }

  function emptyView(): HTMLElement {
    const e = state.empty;
    return h("div", { class: "empty" }, icon(e.kind === "signedout" || e.kind === "notfound" ? "account" : e.kind === "sso" ? "shield" : e.kind === "oauth" ? "organization" : e.kind === "offline" ? "debug-disconnect" : e.kind === "airgap" ? "lock" : "repo"),
      h("h2", { text: e.title }), h("p", { text: e.text }), e.detail ? h("p", { class: "detail-line" }, "Details: ", h("code", { text: e.detail })) : null,
      e.actions.length ? h("div", { class: "row-actions" }, e.actions.map((a: any) => h("button", { class: "btn" + (a.primary ? " primary" : ""), type: "button", onclick: () => send({ type: "empty_action", id: a.id }) }, a.label))) : null);
  }

  function render() {
    if (!state) return;
    const active = document.activeElement as HTMLElement | null;
    const activeId = active && active.id;
    const listEl = root.querySelector(".list") as HTMLElement | null;
    const detailEl = root.querySelector(".detail") as HTMLElement | null;
    const listScroll = listEl ? listEl.scrollTop : 0;
    const detailScroll = detailEl ? detailEl.scrollTop : 0;
    const selStart = active && active.id === "filter" ? (active as HTMLInputElement).selectionStart : null;
    root.textContent = "";
    root.appendChild(topbar());
    if (state.notice) root.appendChild(h("div", { class: "notice", role: "status" }, icon("warning"), state.notice));
    if (state.status === "empty" && state.empty) root.appendChild(emptyView());
    else if (state.status === "loading") root.appendChild(h("div", { class: "empty" }, h("p", { text: "Loading pull requests and issues…" })));
    else root.appendChild(h("div", { class: "main" }, side(), detail()));
    const newList = root.querySelector(".list") as HTMLElement | null;
    const newDetail = root.querySelector(".detail") as HTMLElement | null;
    if (newList) newList.scrollTop = listScroll;
    if (newDetail && detailEl && detailEl.getAttribute("data-key") === String(state.kind + state.selected)) newDetail.scrollTop = detailScroll;
    if (newDetail) newDetail.setAttribute("data-key", String(state.kind + state.selected));
    if (pendingFocusRow !== null && state.selected === pendingFocusRow) { focusRow(pendingFocusRow); pendingFocusRow = null; }
    else if (activeId && !sheetOpen) {
      const again = document.getElementById(activeId) as HTMLElement | null;
      if (again) {
        again.focus();
        if (activeId === "filter" && selStart !== null) (again as HTMLInputElement).setSelectionRange(selStart, selStart);
      }
    }
  }

  document.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest(".menu-wrap")) closeMenus(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheetOpen) closeMenus(); });
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "state") {
      const prev = state;
      state = msg.state;
      if (typedText !== null && typedText === state.text) typedText = null;
      if (!prev || prev.kind !== state.kind || prev.selected !== state.selected) { subtab = "overview"; (window as any).__showHiddenThreads = false; }
      if (subtab === "files" && state.kind !== "pr") subtab = "overview";
      render();
      if (prev && prev.loadingList && !state.loadingList && state.status === "ready") say((state.kind === "pr" ? "Pull requests" : "Issues") + " updated.");
    } else if (msg.type === "done") {
      failSheet = null;
      closeSheet();
      say(String(msg.text || ""));
    } else if (msg.type === "failed") {
      if (failSheet) failSheet(String(msg.text || "It didn't start. Try again."));
      say(String(msg.text || ""));
    } else if (msg.type === "open_sheet" && state && state.detail && state.detail.number === msg.number && (msg.sheet === "review" || msg.sheet === "ask")) {
      openSheet(msg.sheet, state.detail);
    }
  });
  send({ type: "ready" });
}
