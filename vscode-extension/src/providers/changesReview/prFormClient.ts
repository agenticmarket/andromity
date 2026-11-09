/* The Create pull request side panel inside the Changes Review webview.
   Injected with toString(), and production builds rename identifiers, so this function
   may only use its parameters and browser built-ins. */

interface PrClientHooks {
  escapeHtml(text: string): string;
  scope(): "turn" | "all";
  selectFile(path: string): void;
}

interface PrVsCodeApi {
  postMessage(message: unknown): void;
}

export function prFormClient(vscode: PrVsCodeApi, hooks: PrClientHooks): void {
  const esc = (value: unknown) => hooks.escapeHtml(value === undefined || value === null ? "" : String(value));
  const icon = (name: string, extra?: string) => '<span class="codicon codicon-' + name + (extra ? " " + extra : "") + '" aria-hidden="true"></span>';
  const openBtn = document.getElementById("pr-open-btn") as HTMLButtonElement | null;
  const sheet = document.getElementById("pr-sheet") as HTMLElement | null;
  const header = document.getElementById("review-header");
  if (!openBtn || !sheet) return;

  let phase = "closed";
  let formKey = "";
  let view: any = null;
  let previewOpen = false;
  let reviewers: string[] = [];
  const dirty: Record<string, boolean> = Object.create(null);
  const fromHost: Record<string, string> = Object.create(null);
  const fieldIds: Record<string, string> = { branchName: "prf-branch", commitMessage: "prf-commit", title: "prf-title-input", description: "prf-desc" };
  const timers: Record<string, ReturnType<typeof setTimeout>> = Object.create(null);
  let lastBaseOptions = "";

  const byId = (id: string) => document.getElementById(id);
  const inputValue = (id: string) => {
    const el = byId(id) as HTMLInputElement | HTMLTextAreaElement | null;
    return el ? el.value : undefined;
  };

  function send(changes: Record<string, unknown>) {
    vscode.postMessage({ type: "pr_update", changes: changes });
  }

  function sendLater(field: string, value: string) {
    if (timers[field]) clearTimeout(timers[field]);
    timers[field] = setTimeout(() => {
      delete timers[field];
      const change: Record<string, unknown> = {};
      change[field] = value;
      send(change);
    }, 250);
  }

  function collect(): Record<string, unknown> {
    const form: Record<string, unknown> = { reviewers: reviewers.slice() };
    const fields: [string, string][] = [["branchName", "prf-branch"], ["commitMessage", "prf-commit"], ["title", "prf-title-input"], ["description", "prf-desc"]];
    for (const [field, id] of fields) {
      const value = inputValue(id);
      if (value !== undefined && dirty[field]) form[field] = value;
    }
    for (const key of Object.keys(timers)) {
      clearTimeout(timers[key]);
      delete timers[key];
    }
    return form;
  }

  function placeSheet() {
    const top = header ? header.getBoundingClientRect().bottom : 44;
    sheet!.style.top = Math.max(0, Math.round(top)) + "px";
  }

  function setButton(state: any) {
    if (!state || typeof state !== "object") return;
    openBtn!.hidden = !state.visible;
    openBtn!.disabled = !state.enabled;
    openBtn!.title = state.reason || "Commit these changes, push them and open a pull request";
    openBtn!.innerHTML = icon("git-pull-request") + " " + esc(state.label || "Create pull request");
  }

  function actionButtons(actions: any[], cls?: string) {
    return (actions || []).map((action: any) =>
      '<button type="button" class="pr-btn ' + (action.primary ? "primary" : "secondary") + (cls ? " " + cls : "") + '" data-pr-action="' + esc(action.id) + '">' + esc(action.label) + "</button>").join("");
  }

  function stepsHtml(steps: any[]) {
    const icons: Record<string, string> = { done: "pass-filled", running: "loading", pending: "circle-large-outline", failed: "error" };
    return '<ul class="pr-steps">' + (steps || []).map((step: any) =>
      '<li class="' + esc(step.status) + '">' + icon(icons[step.status] || "circle-large-outline", step.status === "running" ? "codicon-modifier-spin" : "") +
      "<span>" + esc(step.label) + "</span></li>").join("") + "</ul>";
  }

  function headHtml(title: string, closable: boolean) {
    return '<div class="pr-head"><div class="pr-title">' + icon("git-pull-request") + " <span>" + esc(title) + "</span></div>" +
      (closable ? '<button type="button" class="pr-icon-btn" data-pr-close title="Close" aria-label="Close">' + icon("close") + "</button>" : "") + "</div>";
  }

  // ── Form skeleton: built once per layout; text inputs keep what the user typed ──
  function layoutKey(form: any) {
    return JSON.stringify([form.title, form.showPullFields, form.reviewers.show, form.receipt.show, form.draft.show,
      form.branch.create, !!form.update]);
  }

  function buildForm(form: any) {
    const kept: Record<string, string | undefined> = {
      "prf-branch": inputValue("prf-branch"), "prf-commit": inputValue("prf-commit"),
      "prf-title-input": inputValue("prf-title-input"), "prf-desc": inputValue("prf-desc"),
    };
    const branchField = form.branch.create
      ? '<div class="pr-branch"><span class="pr-chip">new branch</span><input class="pr-input" id="prf-branch" spellcheck="false" maxlength="100" aria-label="New branch name"></div>'
      : '<div class="pr-branch"><code id="prf-current-branch"></code><button type="button" class="pr-link-btn" data-pr-new-branch>Create a new branch instead</button></div>';
    const pull = form.showPullFields
      ? '<section class="pr-section"><div class="pr-label">' + (form.update ? "Receipt" : "Pull request") + "</div>" +
        '<div class="pr-field"><div class="pr-field-label">Title</div><input class="pr-input" id="prf-title-input" maxlength="256" aria-label="Pull request title"></div>' +
        '<div class="pr-field"><div class="pr-field-label"><span>Description</span><span class="pr-ai" id="prf-desc-ai"></span></div>' +
        '<textarea class="pr-textarea" id="prf-desc" rows="7" aria-label="Pull request description"></textarea>' +
        '<p class="pr-help" id="prf-desc-hint"></p><div class="pr-chips" id="prf-chips"></div>' +
        '<div class="pr-desc-actions"><button type="button" class="pr-link-btn" data-pr-draft-description>Draft with AI</button></div></div>' +
        (form.reviewers.show
          ? '<div class="pr-field"><div class="pr-field-label"><span>Reviewers</span><span class="pr-muted">optional</span></div>' +
            '<div class="pr-tokens"><span id="prf-reviewer-tokens"></span><input class="pr-token-input" id="prf-reviewer-input" list="prf-reviewer-list" placeholder="Add a person or org/team" autocomplete="off" spellcheck="false" aria-label="Add a reviewer"></div>' +
            '<datalist id="prf-reviewer-list"></datalist><div id="prf-reviewer-problems"></div></div>'
          : "") +
        "</section>"
      : "";
    sheet!.innerHTML = headHtml(form.title, true) +
      '<div class="pr-body" id="prf-body">' +
      '<section class="pr-section"><div class="pr-row" id="prf-repo"></div><div id="prf-account-note"></div><div id="prf-update"></div>' +
      '<div class="pr-route"><span class="pr-k">Into</span><select class="pr-select" id="prf-base" aria-label="Base branch"></select>' +
      '<span class="pr-k">From</span>' + branchField + "</div>" +
      '<p class="pr-help" id="prf-branch-note"></p><div id="prf-latest"></div><div id="prf-notes"></div></section>' +
      '<section class="pr-section"><div class="pr-label">Files <span class="pr-seg" id="prf-scope"></span></div>' +
      '<div class="pr-files" id="prf-files"></div><p class="pr-help" id="prf-size"></p><p class="pr-help" id="prf-leftover"></p><div id="prf-staged"></div></section>' +
      '<section class="pr-section"><div class="pr-label">Commit message <span class="pr-ai" id="prf-commit-ai"></span></div>' +
      '<textarea class="pr-textarea" id="prf-commit" rows="5" aria-label="Commit message"></textarea>' +
      '<p class="pr-help" id="prf-draft-note"></p><p class="pr-help" id="prf-coauthor"></p></section>' +
      pull +
      (form.receipt.show ? '<section class="pr-section" id="prf-receipt"></section>' : "") +
      '<section class="pr-section" id="prf-checks" hidden></section>' +
      "</div>" +
      '<div class="pr-foot" id="prf-foot"></div>';
    lastBaseOptions = "";
    for (const id of Object.keys(kept)) {
      const el = byId(id) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && kept[id] !== undefined) el.value = kept[id] as string;
    }
    for (const field of Object.keys(fieldIds)) {
      const el = byId(fieldIds[field]) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && !el.value && !dirty[field] && fromHost[field] !== undefined) el.value = fromHost[field];
    }
    wireInputs();
  }

  function wireInputs() {
    const fields: [string, string][] = [["prf-branch", "branchName"], ["prf-commit", "commitMessage"], ["prf-title-input", "title"], ["prf-desc", "description"]];
    for (const [id, field] of fields) {
      const el = byId(id) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) continue;
      el.addEventListener("input", () => {
        dirty[field] = true;
        sendLater(field, el.value);
      });
    }
    const base = byId("prf-base") as HTMLSelectElement | null;
    base?.addEventListener("change", () => send({ base: base.value }));
    const reviewerInput = byId("prf-reviewer-input") as HTMLInputElement | null;
    if (reviewerInput) {
      const add = () => {
        const parts = reviewerInput.value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
        if (!parts.length) return;
        for (const part of parts) {
          if (reviewers.length < 30 && !reviewers.some((r) => r.toLowerCase() === part.toLowerCase())) reviewers.push(part.slice(0, 120));
        }
        reviewerInput.value = "";
        renderTokens();
        send({ reviewers: reviewers.slice() });
      };
      reviewerInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === "," || event.key === "Tab" && reviewerInput.value.trim()) {
          event.preventDefault();
          add();
        } else if (event.key === "Backspace" && !reviewerInput.value && reviewers.length) {
          reviewers.pop();
          renderTokens();
          send({ reviewers: reviewers.slice() });
        }
      });
      reviewerInput.addEventListener("change", add);
      renderTokens();
    }
  }

  function renderTokens() {
    const box = byId("prf-reviewer-tokens");
    if (!box) return;
    box.innerHTML = reviewers.map((name, i) =>
      '<span class="pr-token">' + esc(name.indexOf("/") >= 0 || name.charAt(0) === "@" ? name : "@" + name) +
      '<button type="button" class="x" data-pr-remove-reviewer="' + i + '" aria-label="Remove ' + esc(name) + '">&times;</button></span>').join("");
  }

  function setHtml(id: string, html: string) {
    const el = byId(id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }

  function tagHtml(tag: any) {
    return '<span class="pr-chip ' + esc(tag.tone) + '">' + esc(tag.text) + "</span>";
  }

  function updateForm(form: any) {
    const titleEl = sheet!.querySelector(".pr-title span:last-child");
    if (titleEl) titleEl.textContent = form.title;
    const visibility = form.repo && form.repo.visibility
      ? '<span class="pr-chip ' + (form.repo.visibility === "public" ? "public" : "") + '">' + icon(form.repo.visibility === "public" ? "globe" : "lock") + " " + (form.repo.visibility === "public" ? "Public" : "Private") + "</span>"
      : "";
    const account = !form.account ? ""
      : form.account.kind === "signed_in"
        ? '<span class="pr-muted pr-small">' + icon("account") + " Signed in as <b>@" + esc(form.account.login) + "</b>" +
          (form.account.switchable ? ' · <button type="button" class="pr-link-btn" data-pr-switch-account>Use another account</button>' : "") + "</span>"
        : '<button type="button" class="pr-signin" data-pr-sign-in>' + icon("account") + " " + esc(form.account.label) + "</button>";
    setHtml("prf-repo", (form.repo ? '<span class="pr-repo">' + icon("repo") + " " + esc(form.repo.display) + " " + visibility + "</span>" : '<span class="pr-repo pr-muted">No remote</span>') + account);
    setHtml("prf-account-note", form.accountNote ? '<p class="pr-help warn">' + icon("warning") + " " + esc(form.accountNote) + "</p>" : "");
    setHtml("prf-update", form.update ? '<p class="pr-help">This branch already has an open pull request: <b>#' + esc(form.update.number) + " " + esc(form.update.title) + "</b>. This turn's commit goes onto it; its title and description stay as they are.</p>" : "");

    const base = byId("prf-base") as HTMLSelectElement | null;
    const options = (form.baseOptions || []).join("\n");
    if (base && options !== lastBaseOptions) {
      lastBaseOptions = options;
      base.innerHTML = (form.baseOptions || []).map((name: string) => "<option>" + esc(name) + "</option>").join("");
    }
    if (base && base.value !== form.base) base.value = form.base;
    const current = byId("prf-current-branch");
    if (current) current.textContent = form.branch.current || "";
    setHtml("prf-branch-note", esc(form.branch.note) + (form.branch.nameProblem ? ' <span class="pr-warn-text">' + esc(form.branch.nameProblem) + "</span>" : ""));
    setHtml("prf-latest", form.latest
      ? '<label class="pr-check' + (form.latest.enabled ? "" : " pr-disabled") + '"><input type="checkbox" data-pr-latest' + (form.latest.on ? " checked" : "") + (form.latest.enabled ? "" : " disabled") + "><span>" + esc(form.latest.label) + "</span></label>" +
        (form.latest.note ? '<p class="pr-help warn">' + icon("warning") + " " + esc(form.latest.note) + "</p>" : "")
      : "");
    setHtml("prf-notes", (form.notes || []).map((note: any) => '<p class="pr-help ' + (note.tone === "warn" ? "warn" : "") + '">' + (note.tone === "warn" ? icon("warning") + " " : "") + esc(note.text) + "</p>").join(""));

    setHtml("prf-scope", form.hasTurn
      ? '<button type="button" class="' + (form.scope === "turn" ? "on" : "") + '" data-pr-scope="turn">This turn (' + esc(form.turnCount) + ')</button><button type="button" class="' + (form.scope === "all" ? "on" : "") + '" data-pr-scope="all">All changes (' + esc(form.allCount) + ")</button>"
      : '<span class="on">All changes (' + esc(form.allCount) + ")</span>");
    setHtml("prf-files", (form.files || []).map((file: any) => {
      const status = String(file.status || "M").charAt(0);
      const counts = file.binary ? '<span class="pr-muted">binary</span>'
        : '<span class="a">+' + esc(file.additions) + "</span>" + (file.deletions ? '<span class="d">-' + esc(file.deletions) + "</span>" : "");
      const tags = (file.tags || []).map(tagHtml).join("") +
        (file.notOpened ? '<span class="pr-chip">not opened yet · <button type="button" class="pr-link-btn" data-pr-show="' + esc(file.path) + '">Open</button></span>' : "");
      return '<div class="pr-file' + (file.checked ? "" : " off") + '">' +
        '<input type="checkbox" data-pr-file="' + esc(file.path) + '"' + (file.checked ? " checked" : "") + ' aria-label="Include ' + esc(file.path) + '">' +
        '<span class="pr-status ' + esc(status) + '">' + esc(status) + "</span>" +
        '<button type="button" class="pr-path" data-pr-show="' + esc(file.path) + '" title="' + esc(file.path) + '">' + esc(file.path) + "</button>" +
        '<span class="pr-counts">' + counts + "</span>" +
        (tags ? '<span></span><span></span><div class="pr-tags">' + tags + "</div>" : "") + "</div>";
    }).join("") || '<p class="pr-help">No changed files in this scope.</p>');
    setHtml("prf-size", (form.sizeLine.tone === "warn" ? icon("warning") + " " : "") + esc(form.sizeLine.text));
    byId("prf-size")?.classList.toggle("warn", form.sizeLine.tone === "warn");
    setHtml("prf-leftover", esc(form.leftOverLine || ""));
    setHtml("prf-staged", form.stagedOutside
      ? '<div class="pr-callout"><p>' + icon("warning") + " " + esc(form.stagedOutside.paths.length === 1 ? "1 other file is" : form.stagedOutside.paths.length + " other files are") +
        " already staged and would go into this commit: " + form.stagedOutside.paths.map((p: string) => "<code>" + esc(p) + "</code>").join(", ") + "</p>" +
        '<div class="pr-actions"><button type="button" class="pr-btn ' + (form.stagedOutside.choice === "unstage" ? "primary" : "secondary") + '" data-pr-staged="unstage">Unstage them</button>' +
        '<button type="button" class="pr-btn ' + (form.stagedOutside.choice === "include" ? "primary" : "secondary") + '" data-pr-staged="include">Include them</button></div></div>'
      : "");

    setHtml("prf-commit-ai", form.drafting ? icon("loading", "codicon-modifier-spin") + " Drafting…" : form.commitAi ? icon("sparkle") + " Drafted by AI · edit freely" : "");
    setHtml("prf-draft-note", form.draftNote ? esc(form.draftNote) + ' <button type="button" class="pr-link-btn" data-pr-redraft>Draft again</button>' : "");
    setHtml("prf-coauthor", form.coAuthor ? "Adds <code>Co-authored-by: Andromity</code> · Include Co-Author setting" : "");
    const commit = byId("prf-commit") as HTMLTextAreaElement | null;
    if (commit) commit.disabled = form.drafting && !commit.value;

    setHtml("prf-desc-ai", form.descriptionLabel ? icon("sparkle") + " " + esc(form.descriptionLabel) : "");
    setHtml("prf-desc-hint", esc(form.descriptionHint || ""));
    setHtml("prf-chips", (form.chips || []).map((chip: string) => '<span class="pr-chip public">' + icon("info") + " " + esc(chip) + "</span>").join(""));
    const datalist = byId("prf-reviewer-list");
    if (datalist) {
      const html = (form.reviewers.suggestions || []).map((login: string) => '<option value="' + esc(login) + '"></option>').join("");
      if (datalist.innerHTML !== html) datalist.innerHTML = html;
    }
    setHtml("prf-reviewer-problems", (form.reviewers.problems || []).map((problem: string) => '<p class="pr-help warn">' + esc(problem) + "</p>").join(""));

    if (form.receipt.show) {
      const r = form.receipt;
      setHtml("prf-receipt",
        '<label class="pr-check' + (r.available ? "" : " pr-disabled") + '"><input type="checkbox" data-pr-attach' + (r.attach ? " checked" : "") + (r.available ? "" : " disabled") + "><span>" + esc(r.label) + "</span></label>" +
        (r.available
          ? '<div class="pr-receipt"><div class="pr-receipt-line"><span>' + icon("shield") + " " + esc(r.summary) + '</span><button type="button" class="pr-link-btn" data-pr-preview>' + (previewOpen ? "Hide preview" : "Preview") + "</button></div>" +
            (previewOpen ? '<pre class="pr-receipt-preview">' + esc(r.preview) + "</pre>" : "") + "</div>"
          : '<p class="pr-help">' + esc(r.reason || "") + "</p>") +
        (form.publicNote ? '<p class="pr-help warn">' + icon("globe") + " " + esc(form.publicNote) + "</p>" : "") +
        (form.draft.show ? '<label class="pr-check"><input type="checkbox" data-pr-draft' + (form.draft.on ? " checked" : "") + "><span>Open as draft</span></label>" : ""));
    }

    const checks = byId("prf-checks");
    if (checks) {
      checks.hidden = !form.checks;
      setHtml("prf-checks", form.checks
        ? '<div class="pr-attention"><div class="pr-attention-title">' + icon("warning") + " " + esc(form.checks.items.length === 1 ? "1 thing" : form.checks.items.length + " things") + " to check before you ship this</div><ul>" +
          form.checks.items.map((item: any) => '<li><span class="pr-sev">' + esc(item.label) + "</span> · " + esc(item.text) +
            (item.path ? ': <button type="button" class="pr-link-btn pr-code" data-pr-show="' + esc(item.path) + '">' + esc(item.path) + "</button>" + (item.line ? ", line " + esc(item.line) : "")
              : item.subject ? ": <code>" + esc(item.subject) + "</code>" : "") + "</li>").join("") + "</ul>" +
          (form.checks.notes || []).map((note: string) => '<p class="pr-help">' + esc(note) + "</p>").join("") +
          '<label class="pr-check"><input type="checkbox" data-pr-ack="' + esc(form.checks.key) + '"' + (form.checks.acked ? " checked" : "") + "><span>I've checked these</span></label></div>"
        : "");
    }

    setHtml("prf-foot",
      '<div class="pr-actions"><button type="button" class="pr-btn primary" data-pr-submit="primary"' + (form.primary.enabled ? "" : " disabled") + ">" + icon("git-pull-request") + " " + esc(form.primary.label) + "</button>" +
      (form.secondary || []).map((action: any) =>
        '<button type="button" class="pr-btn secondary" ' + (action.id === "publish" ? 'data-pr-action="publish"' : 'data-pr-submit="' + esc(action.id) + '"') + ">" + esc(action.label) + "</button>").join("") +
      '<button type="button" class="pr-btn ghost" data-pr-close>Cancel</button></div>' +
      (form.disabledReason ? '<div class="pr-why">' + icon("warning") + " " + esc(form.disabledReason) + "</div>" : "") +
      '<div class="pr-plan">' + esc(form.plan) + "</div>");
  }

  function render(next: any) {
    view = next || { phase: "closed" };
    const previous = phase;
    phase = view.phase;
    openBtn!.setAttribute("aria-expanded", String(phase !== "closed"));
    if (phase === "closed") {
      sheet!.hidden = true;
      sheet!.innerHTML = "";
      formKey = "";
      return;
    }
    placeSheet();
    sheet!.hidden = false;
    if (phase === "form") {
      const key = layoutKey(view.form);
      if (previous !== "form" || key !== formKey) {
        if (previous !== "form") {
          for (const field of Object.keys(dirty)) delete dirty[field];
          for (const field of Object.keys(fromHost)) if (previous === "closed" || previous === "loading") delete fromHost[field];
          reviewers = [];
          previewOpen = false;
        }
        formKey = key;
        buildForm(view.form);
      }
      updateForm(view.form);
      return;
    }
    formKey = "";
    if (phase === "loading") {
      sheet!.innerHTML = headHtml("Create pull request", true) + '<div class="pr-body"><p class="pr-loading">' + icon("loading", "codicon-modifier-spin") + " Reading the repository…</p></div>";
    } else if (phase === "blocked") {
      const b = view.blocked || {};
      sheet!.innerHTML = headHtml("Create pull request", true) + '<div class="pr-body"><div class="pr-result bad"><div class="pr-result-title">' + icon("error") + " " + esc(b.title) + "</div><p>" + esc(b.message) + '</p><div class="pr-actions">' + actionButtons(b.actions) + "</div></div></div>";
    } else if (phase === "running") {
      const run = view.run;
      sheet!.innerHTML = headHtml(run.title, false) + '<div class="pr-body">' + stepsHtml(run.steps) + "</div>" +
        '<div class="pr-foot"><div class="pr-actions"><button type="button" class="pr-btn secondary" data-pr-action="cancel"' + (run.cancellable ? "" : " disabled") + ">Cancel</button></div>" +
        (run.note ? '<div class="pr-plan">' + esc(run.note) + "</div>" : "") + "</div>";
    } else if (phase === "done") {
      const done = view.done;
      sheet!.innerHTML = headHtml(done.title, true) + '<div class="pr-body"><div class="pr-result ok"><div class="pr-result-title">' + icon("pass-filled") + " " + esc(done.heading) + "</div>" +
        (done.url ? '<div class="pr-url">' + esc(done.url.replace(/^https:\/\//, "")) + "</div>" : "") +
        (done.lines || []).map((line: string) => "<p>" + esc(line) + "</p>").join("") +
        '<div class="pr-actions">' + actionButtons(done.actions) + "</div></div>" + stepsHtml(done.steps) +
        (done.footnote ? '<p class="pr-help">' + esc(done.footnote) + "</p>" : "") + "</div>" +
        '<div class="pr-foot"><div class="pr-actions"><button type="button" class="pr-btn ghost" data-pr-close>Close</button></div></div>';
    } else if (phase === "failed") {
      const failed = view.failed;
      sheet!.innerHTML = headHtml(failed.title, true) + '<div class="pr-body">' + stepsHtml(failed.steps) +
        '<div class="pr-result bad"><div class="pr-result-title">' + icon("error") + " " + esc(failed.heading) + "</div><p>" + esc(failed.message) + '</p><div class="pr-actions">' + actionButtons(failed.actions) + "</div></div></div>" +
        '<div class="pr-foot"><div class="pr-actions"><button type="button" class="pr-btn ghost" data-pr-close>Close</button></div></div>';
    }
  }

  function setField(field: string, value: unknown) {
    if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(fieldIds, field) || dirty[field]) return;
    fromHost[field] = value;
    const el = byId(fieldIds[field]) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) el.value = value;
  }

  openBtn.addEventListener("click", () => vscode.postMessage({ type: "pr_open", scope: hooks.scope() }));

  sheet.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const el = target.closest("[data-pr-close],[data-pr-action],[data-pr-submit],[data-pr-scope],[data-pr-show],[data-pr-staged],[data-pr-preview],[data-pr-sign-in],[data-pr-switch-account],[data-pr-redraft],[data-pr-draft-description],[data-pr-new-branch],[data-pr-remove-reviewer]") as HTMLElement | null;
    if (!el) return;
    if (el.hasAttribute("data-pr-close")) {
      vscode.postMessage(phase === "running" ? { type: "pr_action", action: "cancel" } : { type: "pr_close" });
    } else if (el.hasAttribute("data-pr-action")) {
      vscode.postMessage({ type: "pr_action", action: el.getAttribute("data-pr-action") });
    } else if (el.hasAttribute("data-pr-submit")) {
      if ((el as HTMLButtonElement).disabled) return;
      vscode.postMessage({ type: "pr_submit", action: el.getAttribute("data-pr-submit"), form: collect() });
    } else if (el.hasAttribute("data-pr-scope")) {
      send({ scope: el.getAttribute("data-pr-scope") });
    } else if (el.hasAttribute("data-pr-show")) {
      hooks.selectFile(el.getAttribute("data-pr-show") || "");
    } else if (el.hasAttribute("data-pr-staged")) {
      send({ stagedChoice: el.getAttribute("data-pr-staged") });
    } else if (el.hasAttribute("data-pr-preview")) {
      previewOpen = !previewOpen;
      if (view && view.form) updateForm(view.form);
    } else if (el.hasAttribute("data-pr-sign-in")) {
      vscode.postMessage({ type: "pr_sign_in" });
    } else if (el.hasAttribute("data-pr-switch-account")) {
      vscode.postMessage({ type: "pr_switch_account" });
    } else if (el.hasAttribute("data-pr-redraft")) {
      delete dirty.commitMessage;
      delete dirty.description;
      vscode.postMessage({ type: "pr_redraft" });
    } else if (el.hasAttribute("data-pr-draft-description")) {
      delete dirty.description;
      vscode.postMessage({ type: "pr_draft_description" });
    } else if (el.hasAttribute("data-pr-new-branch")) {
      send({ createBranch: true });
    } else if (el.hasAttribute("data-pr-remove-reviewer")) {
      const index = Number(el.getAttribute("data-pr-remove-reviewer"));
      if (Number.isInteger(index) && index >= 0 && index < reviewers.length) {
        reviewers.splice(index, 1);
        renderTokens();
        send({ reviewers: reviewers.slice() });
      }
    }
  });

  sheet.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target || target.type !== "checkbox") return;
    if (target.hasAttribute("data-pr-file")) send({ file: { path: target.getAttribute("data-pr-file"), checked: target.checked } });
    else if (target.hasAttribute("data-pr-latest")) send({ fromLatest: target.checked });
    else if (target.hasAttribute("data-pr-attach")) send(view && view.form && view.form.update ? { commentReceipt: target.checked } : { attachReceipt: target.checked });
    else if (target.hasAttribute("data-pr-draft")) send({ draft: target.checked });
    else if (target.hasAttribute("data-pr-ack")) send({ ack: target.checked ? target.getAttribute("data-pr-ack") : null });
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && phase !== "closed" && phase !== "running") vscode.postMessage({ type: "pr_close" });
  });
  window.addEventListener("resize", () => {
    if (phase !== "closed") placeSheet();
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "pr_button") setButton(msg.state);
    else if (msg.type === "pr_view") render(msg.view);
    else if (msg.type === "pr_field") setField(msg.field, msg.value);
    else if (msg.type === "pr_request_open") vscode.postMessage({ type: "pr_open", scope: hooks.scope() });
  });
}
