# Andromity Improvement Plan

> **Goal**: Transform Andromity from a solid coding agent into a world-class one by
> improving UX flow, safety, extensibility, and cost awareness — all within the TUI.

---

## Phase 1 — Safety & Flow (Quick Wins)

### 1.1 Keyboard-First Tool Approval (Y / N / A)
- **Problem**: Tool approval requires mouse clicks on DiffPanel buttons — breaks terminal flow.
- **Solution**: Add keyboard bindings to the DiffPanel: `Y` to accept, `N` to reject, `A` to accept-all-remaining.
- **Files**: `tui/panels/diff.py`, `tui/app.py`
- **Status**: [ ] TODO

### 1.2 Undo / Rollback System (`/undo`)
- **Problem**: No way to revert the last agent action. Users fear irreversible changes.
- **Solution**: Track every `write_file`/`edit_file`/`shell_exec` action. `/undo` restores
  the pre-action git snapshot for the last tool call. Show what will be undone, confirm, done.
- **Files**: `core/agent.py` (action stack), `tui/app.py` (`/undo` command), `core/git_ops.py`
- **Status**: [ ] TODO

### 1.3 File Tree Live-Update After Tool Calls
- **Problem**: File tree is static — built once on mount. No feedback when agent writes/edits files.
- **Solution**: Auto-refresh the file tree after tool calls complete. Highlight recently-changed
  files with a visual marker (e.g., `[修改]` badge) that fades after a few seconds.
- **Files**: `tui/panels/filetree.py` (rebuild method), `tui/app.py` (call after tool result)
- **Status**: [ ] TODO

---

## Phase 2 — Cost & Context Awareness

### 2.1 Real Per-Model Pricing in Cost Calculation
- **Problem**: Cost is computed with a fixed formula (`prompt * 3.0 + completion * 15.0` per MTok)
  regardless of provider/model. Inaccurate for every non-Anthropic-Sonnet model.
- **Solution**: Store input/output pricing per model in `MODEL_CATALOG`. Use it in
  `session.update_usage()`. Pass the active model's pricing to the Session so it calculates correctly.
- **Files**: `core/models.py` (add pricing fields), `core/session.py` (use pricing), `core/provider.py` (pass pricing info), `tui/app.py` (wire up)
- **Status**: [ ] TODO

### 2.2 Context Window Management (`/compact`)
- **Problem**: Long sessions silently hit context limits and fail. No visual warning or recovery.
- **Solution**:
  - Visible warning in status bar at 80% context (yellow) and 90% (red — already partially done).
  - `/compact` command: ask the model to summarize the conversation, replace messages with the
    summary + system prompt, continue. Preserve user/assistant pairs in a "compacted" flag.
  - Auto-suggest `/compact` when crossing 85%.
- **Files**: `core/session.py` (compact method), `tui/app.py` (`/compact` command), `core/agent.py` (compact support)
- **Status**: [ ] TODO

---

## Phase 3 — Power Features

### 3.1 Multi-File Plan & Batch Approval
- **Problem**: Agent proposes changes one tool call at a time. Multi-file refactors require
  approving each file separately — tedious and loses context.
- **Solution**: When the agent returns multiple consecutive `write_file`/`edit_file` tool calls,
  batch them into a single diff panel review. Show all proposed changes side by side. User hits
  **Apply All** or **Reject All**, or selectively approves individual files.
- **Files**: `tui/panels/diff.py` (multi-file view), `tui/app.py` (`_on_tool_approval` batching), `core/agent.py` (batch support)
- **Status**: [ ] TODO

### 3.2 Conversation Branching / Session Forking
- **Problem**: `Session` has `parent_session` and `branch_point` fields but they're unused.
  Users can't explore "what if I asked X instead of Y" without losing the current conversation.
- **Solution**: `/fork` command — creates a child session that copies the current conversation
  up to a specified message index (or the latest by default). The parent session is preserved.
  Session browser shows the tree relationship. Switching between branches is instant.
- **Files**: `core/session.py` (fork method), `tui/overlays/session.py` (tree view), `tui/app.py` (`/fork` command)
- **Status**: [ ] TODO

### 3.3 Plugin Tool System
- **Problem**: Tools are hardcoded in `tools.py`. Adding new tools requires touching core code.
- **Solution**: Create a `plugins/` directory. Each plugin is a Python file that defines:
  - `TOOL_DEF` — the OpenAI-format tool definition
  - `execute(args) -> str` — the execution function
  - `PROFILE_ACCESS` — optional set of profiles that can use this tool (default: all)
  On startup, Andromity auto-discovers `.py` files in `~/.andromity/plugins/` and the project's
  `.andromity/plugins/` directory, loads them, and adds their tools to `CORE_TOOLS`.
- **Files**: `core/plugins.py` (new — auto-discovery + loading), `core/tools.py` (integrate), `core/agent.py` (use merged tools)
- **Status**: [ ] TODO

---

## Phase 4 — Polish

### 4.1 Streaming Cost Counter Using Real Pricing
- Depends on: 2.1
- Show live cost estimate during streaming using the actual model's pricing.
- **Files**: `tui/app.py` (`_update_status` with live cost), `tui/footer.py` (display)
- **Status**: [ ] TODO

### 4.2 Smart Auto-Compact Suggestion
- Depends on: 2.2
- When context usage crosses 85%, insert a system message suggesting `/compact`.
- **Files**: `tui/app.py`, `core/session.py`
- **Status**: [ ] TODO

---

## Implementation Order
1. ✅ 1.1 — Keyboard tool approval
2. ✅ 1.2 — Undo/rollback system
3. ✅ 1.3 — File tree live-update
4. ✅ 2.1 — Real per-model pricing
5. ✅ 2.2 — Context window management (`/compact`)
6. ✅ 3.1 — Multi-file batch approval
7. ✅ 3.2 — Conversation branching/forking
8. ✅ 3.3 — Plugin tool system
9. ✅ 4.1 — Streaming cost counter
10. ✅ 4.2 — Auto-compact suggestion

---

## Testing
- Run existing test suite after each phase to ensure no regressions.
- Add targeted tests for new features.
