import * as vscode from "vscode";
import { currentAirGap } from "../../airgapState.js";
import { branchPrefix, isValidBranchName } from "../../integrations/pullRequest/branchName.js";
import { DEFAULT_SIZE_WARNING_LINES } from "../../integrations/pullRequest/checks.js";

export interface GitSettingsState {
  includeAssistedBy: boolean;
  branchPrefix: string;
  attachReceipt: boolean;
  draftWithAI: boolean;
  sizeWarningLines: number;
  github: { status: "signed_in" | "signed_out" | "air_gap"; account: string | null };
}

type GitSettingKey = "includeAssistedBy" | "pullRequest.branchPrefix" | "pullRequest.attachReceipt" | "pullRequest.draftWithAI" | "pullRequest.sizeWarningLines";

export async function gitSettingsState(): Promise<GitSettingsState> {
  const config = vscode.workspace.getConfiguration("andromity");
  const size = config.get<number>("pullRequest.sizeWarningLines", DEFAULT_SIZE_WARNING_LINES);
  let github: GitSettingsState["github"] = { status: "air_gap", account: null };
  if (!currentAirGap().enabled) {
    try {
      const session = await vscode.authentication.getSession("github", ["repo"], { createIfNone: false, silent: true });
      github = session ? { status: "signed_in", account: session.account.label.slice(0, 100) } : { status: "signed_out", account: null };
    } catch {
      github = { status: "signed_out", account: null };
    }
  }
  return {
    includeAssistedBy: config.get<boolean>("includeAssistedBy", false) === true,
    branchPrefix: branchPrefix(config.get("pullRequest.branchPrefix")),
    attachReceipt: config.get<boolean>("pullRequest.attachReceipt", true) !== false,
    draftWithAI: config.get<boolean>("pullRequest.draftWithAI", true) !== false,
    sizeWarningLines: typeof size === "number" && Number.isFinite(size) && size >= 0 ? Math.floor(size) : DEFAULT_SIZE_WARNING_LINES,
    github,
  };
}

/** Saves one Git setting after checking it. Returns a plain reason when the value is refused. */
export async function applyGitSetting(key: unknown, value: unknown): Promise<string | null> {
  const config = vscode.workspace.getConfiguration("andromity");
  const save = (name: GitSettingKey, next: unknown) => config.update(name, next, vscode.ConfigurationTarget.Global);
  switch (key) {
    case "includeAssistedBy":
    case "pullRequest.attachReceipt":
    case "pullRequest.draftWithAI":
      if (typeof value !== "boolean") return "Choose on or off.";
      await save(key, value);
      return null;
    case "pullRequest.branchPrefix": {
      if (typeof value !== "string") return "Enter a prefix.";
      const prefix = value.trim();
      if (prefix && (prefix.length > 40 || !isValidBranchName(prefix + "x"))) {
        return "Use letters, numbers, dots, dashes, underscores and slashes, at most 40 characters, for example andromity/ or yourname/.";
      }
      await save(key, prefix);
      return null;
    }
    case "pullRequest.sizeWarningLines": {
      const lines = typeof value === "number" ? value : typeof value === "string" && /^\d{1,7}$/.test(value.trim()) ? Number(value.trim()) : NaN;
      if (!Number.isSafeInteger(lines) || lines < 0 || lines > 1_000_000) return "Enter a whole number of lines, or 0 to turn the warning off.";
      await save(key, lines);
      return null;
    }
    default:
      return "That setting can't be changed here.";
  }
}

export async function signInToGitHub(): Promise<void> {
  if (currentAirGap().enabled) return;
  try {
    await vscode.authentication.getSession("github", ["repo"], { createIfNone: true });
  } catch {
    return;
  }
}

/** The Git & Pull Requests settings page. The co-author checkbox keeps its id so the panel's existing wiring applies. */
export function getGitSettingsPane(docsLink: string): string {
  return `
    <div class="tab-pane" id="pane-git">
      <div class="section-header">
        <div>
          <h2 class="section-title">Git & Pull Requests</h2>
          <p class="section-desc">How Andromity signs commits and what Create pull request in Changes Review fills in for you. Branch, commit and push always go through VS Code's own Git, with your credentials and hooks. <a href="#" class="docs-link" data-docs-url="${docsLink}">Preferences explained</a></p>
        </div>
      </div>

      <h3 class="setting-group-title">Commits</h3>
      <div class="settings-card">
        <label class="checkbox-row">
          <input type="checkbox" id="setting-coauthor">
          <div>
            <div class="setting-label">Git Co-Author Attribution</div>
            <div class="setting-desc">Append <code>Co-authored-by: Andromity &lt;333054755+andromity-bot@users.noreply.github.com&gt;</code> trailer to AI-generated commit messages, commits made from Create pull request, and commits the agent creates.</div>
          </div>
        </label>
      </div>
      <div class="settings-card">
        <label class="checkbox-row">
          <input type="checkbox" id="git-assisted-by" data-git-setting="includeAssistedBy">
          <div>
            <div class="setting-label">Name the model in agent commits</div>
            <div class="setting-desc">Add an <code>Assisted-by: Andromity/&lt;version&gt; (&lt;provider&gt;/&lt;model&gt;)</code> trailer to commits the agent creates.</div>
          </div>
        </label>
      </div>

      <h3 class="setting-group-title">Pull requests</h3>
      <div class="settings-card">
        <label class="setting-label" for="git-branch-prefix">Branch name prefix</label>
        <input type="text" id="git-branch-prefix" class="custom-model-input" maxlength="40" spellcheck="false" placeholder="andromity/">
        <div class="setting-desc">New branches are suggested as <code id="git-prefix-example">andromity/round-totals</code>. Leave empty for no prefix.</div>
        <div class="setting-desc git-setting-error" id="git-prefix-error" role="alert" hidden></div>
      </div>
      <div class="settings-card">
        <label class="checkbox-row">
          <input type="checkbox" id="git-attach-receipt" data-git-setting="pullRequest.attachReceipt">
          <div>
            <div class="setting-label">Attach the turn receipt</div>
            <div class="setting-desc">Add the receipt below the description, with a line naming the commit. You can still untick it in the form. In a public repository the receipt is public: file paths, commands, the model, the cost and approver names from git settings (never emails).</div>
          </div>
        </label>
      </div>
      <div class="settings-card">
        <label class="checkbox-row">
          <input type="checkbox" id="git-draft-ai" data-git-setting="pullRequest.draftWithAI">
          <div>
            <div class="setting-label">Draft the description with AI</div>
            <div class="setting-desc">Your selected model drafts what changed from the diff, never from your prompt. Turn off for projects that don't accept AI-written pull request text. The commit message is still drafted, and a repository's pull request template always comes first.</div>
          </div>
        </label>
      </div>
      <div class="settings-card">
        <label class="setting-label" for="git-size-lines">Warn above this many changed lines</label>
        <input type="number" id="git-size-lines" class="custom-model-input" min="0" max="1000000" step="1">
        <div class="setting-desc">Lockfiles aren't counted. 0 turns the warning off. It never blocks.</div>
        <div class="setting-desc git-setting-error" id="git-size-error" role="alert" hidden></div>
      </div>

      <h3 class="setting-group-title">GitHub</h3>
      <div class="settings-card">
        <div class="setting-label">Account</div>
        <div class="setting-desc" id="git-github-status">Checking…</div>
        <button type="button" class="btn btn-secondary" id="git-sign-in" hidden>Sign in to GitHub</button>
        <div class="setting-desc">Uses VS Code's own GitHub sign-in. Andromity never sees your password and doesn't store the sign-in; manage or sign out from VS Code's Accounts menu.</div>
      </div>
    </div>`;
}

/* Injected with toString(), and production builds rename identifiers, so this function
   may only use its parameters and browser built-ins. */
export function gitSettingsClient(vscode: { postMessage(message: unknown): void }): void {
  const pane = document.getElementById("pane-git");
  if (!pane) return;
  const prefix = document.getElementById("git-branch-prefix") as HTMLInputElement | null;
  const size = document.getElementById("git-size-lines") as HTMLInputElement | null;
  const example = document.getElementById("git-prefix-example");
  const prefixError = document.getElementById("git-prefix-error");
  const sizeError = document.getElementById("git-size-error");
  const status = document.getElementById("git-github-status");
  const signIn = document.getElementById("git-sign-in") as HTMLButtonElement | null;

  const showExample = () => {
    if (example && prefix) example.textContent = prefix.value.trim() + "round-totals";
  };
  const showError = (el: HTMLElement | null, text: string | null) => {
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  };

  pane.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    const key = target.getAttribute("data-git-setting");
    if (key && target.type === "checkbox") {
      vscode.postMessage({ type: "git_settings_set", key: key, value: target.checked });
    } else if (target === prefix) {
      vscode.postMessage({ type: "git_settings_set", key: "pullRequest.branchPrefix", value: prefix.value });
    } else if (target === size) {
      vscode.postMessage({ type: "git_settings_set", key: "pullRequest.sizeWarningLines", value: size.value });
    }
  });
  prefix?.addEventListener("input", showExample);
  signIn?.addEventListener("click", () => vscode.postMessage({ type: "git_sign_in" }));
  document.getElementById("tab-btn-git")?.addEventListener("click", () => vscode.postMessage({ type: "git_settings_get" }));

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "git_settings_error") {
      showError(msg.key === "pullRequest.sizeWarningLines" ? sizeError : prefixError, typeof msg.error === "string" ? msg.error : null);
      return;
    }
    if (msg.type !== "git_settings" || !msg.state) return;
    const state = msg.state;
    const boxes: [string, unknown][] = [["git-assisted-by", state.includeAssistedBy], ["git-attach-receipt", state.attachReceipt], ["git-draft-ai", state.draftWithAI]];
    for (const [id, value] of boxes) {
      const box = document.getElementById(id) as HTMLInputElement | null;
      if (box) box.checked = value === true;
    }
    if (prefix && document.activeElement !== prefix) prefix.value = typeof state.branchPrefix === "string" ? state.branchPrefix : "";
    if (size && document.activeElement !== size) size.value = String(state.sizeWarningLines);
    showExample();
    showError(prefixError, null);
    showError(sizeError, null);
    const github = state.github || {};
    if (status) {
      status.textContent = github.status === "signed_in" ? "Signed in as " + String(github.account || "") + "."
        : github.status === "air_gap" ? "Air-gap mode is on, so pushing and opening pull requests are turned off."
          : "Not signed in. Create pull request asks you to sign in the first time.";
    }
    if (signIn) signIn.hidden = github.status !== "signed_out";
  });

  vscode.postMessage({ type: "git_settings_get" });
}
