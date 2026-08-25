"""
DiffPanel — minimal syntax viewer + git diff + tool proposal panel.

Bugs fixed vs original:
- safe_update called on Horizontal (#diff-header) instead of Static (#diff-header-title)
- _update_button_visibility never hid buttons when leaving tool_diff mode
- show_git_diff double-rendered (show_file rendered code, then diff rendered again)
- Toggle state tracked via label string sniffing — replaced with _tab_showing_diff dict
- VerticalScroll-in-VerticalScroll double scrollbar in tool viewer
- self.remove_class("visible") — "visible" was never added; replaced with self.display
- show_file / show_tool never called self.display = True after panel was closed
- Repeated get_repo/get_file_diff calls for same file in same operation
"""

from __future__ import annotations

import difflib
import json
from pathlib import Path
import re
from typing import Dict, Any, Optional

from rich.syntax import Syntax
from textual import on
from textual.app import ComposeResult
from textual.containers import VerticalScroll, Horizontal, Container
from textual.widgets import Static, Button, TabbedContent, TabPane, ContentSwitcher, Label, Input

from andromity.core.git_ops import get_repo, get_file_diff
from andromity.tui.markup_utils import safe_update, escape_textual as escape


class DiffPanel(VerticalScroll):
    """Right-side panel: file viewer, git diffs, tool proposal approvals."""

    DEFAULT_CSS = """\
DiffPanel { height: 1fr; }

/* Header */
#diff-header {
    padding: 0 1; height: 3;
    background: $surface-darken-1;
    align: right middle;
}
#diff-header-title { width: 1fr; content-align: left middle; }
#btn-close-panel {
    border: none !important; background: transparent !important;
    color: $text-muted !important;
    min-width: 3 !important; height: 1 !important; padding: 0 !important;
}
#btn-close-panel:hover { color: $error !important; }

/* Content area */
#diff-switcher  { height: 1fr; }
#viewer-tabs    { height: 1fr; }
#viewer-tabs > TabBar { overflow-x: auto; overflow-y: hidden; }
#viewer-tabs > TabBar Tab { min-width: 10; max-width: 26; }
.tab-content    { height: 1fr; overflow-x: auto; overflow-y: auto; padding: 0 1; }
.diff-content   { width: auto; min-width: 100%; text-wrap: nowrap; }

/* Per-tab toolbar */
.tab-toolbar {
    height: 3;
    border-bottom: solid $surface-lighten-2;
    margin-bottom: 1;
}
.tab-filename {
    width: 1fr;
    padding: 0 1;
    content-align: left middle;
}
.tab-btn {
    border: none !important; background: transparent !important;
    color: $accent !important;
    min-width: 0 !important; height: 1 !important; padding: 0 1 !important;
}
.tab-btn:hover { color: $accent-lighten-1 !important; }

.tab-btn-diff {
    border: none !important; background: ansi_yellow !important;
    color: black !important;
    min-width: 0 !important; height: 1 !important; padding: 0 1 !important;
    text-style: bold;
}
.tab-btn-diff:hover { background: ansi_bright_yellow !important; }

.tab-btn-close  { color: $text-muted !important; }
.tab-btn-close:hover { color: $error !important; }

/* Tool viewer */
#tool-viewer { height: 1fr; }
#tool-content { height: 1fr; overflow-x: auto; overflow-y: auto; padding: 0 1; }
#tool-buttons {
    dock: bottom; height: 2; padding: 0 1;
    background: $surface-darken-1;
}
#btn-apply {
    border: none !important; background: transparent !important;
    color: $success !important;
    min-width: 0 !important; height: 1 !important; padding: 0 1 !important;
    text-style: bold;
}
#btn-apply:hover { color: $success-lighten-1 !important; }
#btn-allow-domain {
    border: none !important; background: transparent !important;
    color: $warning !important;
    min-width: 0 !important; height: 1 !important; padding: 0 1 !important;
}
#btn-allow-domain:hover { color: $warning-lighten-1 !important; }
#btn-reject {
    border: none !important; background: transparent !important;
    color: $error !important;
    min-width: 0 !important; height: 1 !important; padding: 0 1 !important;
    text-style: bold;
}
#btn-reject:hover { color: $error-lighten-1 !important; }

/* Plan viewer */
#plan-viewer { height: 1fr; }
#plan-content { height: 1fr; padding: 1 2; overflow-y: auto; }
#plan-action-bar {
    dock: bottom; height: 3; padding: 0 1;
    background: $surface-darken-1;
    display: none;
}
#plan-action-bar.visible { display: block; }
#plan-action-bar Input {
    width: 1fr; height: 1; border: none !important;
    background: $surface !important; padding: 0 1;
}
#btn-plan-approve {
    border: none !important; background: $success-darken-1 !important;
    min-width: 10 !important; height: 1 !important; padding: 0 1 !important;
}
#btn-plan-reject {
    border: none !important; background: $error-darken-1 !important;
    min-width: 9 !important; height: 1 !important; padding: 0 1 !important;
}
#btn-plan-approve:hover { background: $success !important; }
#btn-plan-reject:hover { background: $error !important; }
"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._view_mode: str = "file"             # "file" | "tool_diff" | "plan"
        self._current_tool: Optional[str] = None
        self._current_args: Optional[Dict[str, Any]] = None
        self._current_file: Optional[Path] = None
        self._current_plan = None                 # Plan object when in plan mode

        self._open_tabs: Dict[Path, str] = {}     # path → tab_id
        self._tab_paths: Dict[str, Path] = {}     # tab_id → path
        self._tab_showing_diff: Dict[str, bool] = {}  # tab_id → is_diff_mode
        self._tab_is_binary: Dict[str, bool] = {}     # tab_id → is_binary
        self._tab_counter = 0
        self._plan_comment_mode: str = ""         # "approve" | "reject" | ""

    # ── Compose ───────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        with Horizontal(id="diff-header"):
            yield Static("[bold]Viewer[/]", id="diff-header-title")
            yield Button("✕", id="btn-close-panel")

        with ContentSwitcher(initial="viewer-tabs", id="diff-switcher"):
            yield TabbedContent(id="viewer-tabs")

            # Tool viewer: Container (not VerticalScroll) so dock: bottom works
            with Container(id="tool-viewer"):
                yield VerticalScroll(id="tool-content")
                with Horizontal(id="tool-buttons"):
                    yield Button("✓ Apply", variant="success", id="btn-apply")
                    yield Button("⊕ Allow Domain", variant="warning", id="btn-allow-domain")
                    yield Button("✕ Reject", variant="error", id="btn-reject")

            # Plan viewer: shows plan title / description / questions + approve/reject
            # Uses a single Static (#plan-body) updated in-place via .update() so
            # we never call async mount/remove from a synchronous context.
            with Container(id="plan-viewer"):
                with VerticalScroll(id="plan-content"):
                    yield Static("", id="plan-body")
                with Horizontal(id="plan-action-bar"):
                    yield Button("✓ Approve", id="btn-plan-approve")
                    yield Input(placeholder="Optional comment...", id="plan-comment-input")
                    yield Button("✗ Reject", id="btn-plan-reject")

    def on_mount(self) -> None:
        self._set_tool_buttons(visible=False)

    # ── Public API ────────────────────────────────────────────────────────────

    def show_file(self, path: Path) -> None:
        self._current_file = path
        self._current_tool = None
        self._view_mode = "file"
        self.display = True
        self._set_tool_buttons(visible=False)
        self._set_header("[bold]File Viewer[/bold]")
        self.query_one("#diff-switcher", ContentSwitcher).current = "viewer-tabs"

        tabs = self.query_one("#viewer-tabs", TabbedContent)

        if path in self._open_tabs:
            # Tab already exists — just switch to it, don't re-render
            tabs.active = self._open_tabs[path]
            return

        # New tab
        self._tab_counter += 1
        tab_id = f"tab-{self._tab_counter}"
        self._open_tabs[path] = tab_id
        self._tab_paths[tab_id] = path
        self._tab_showing_diff[tab_id] = False

        # Check binary before creating the tab — binary files get no diff button
        is_bin = _is_binary_path(path)
        self._tab_is_binary[tab_id] = is_bin

        has_diff = (not is_bin) and self._has_git_diff(path)
        btn_toggle = Button("⎇ Diff", classes="tab-btn-diff", id=f"btn-toggle-{tab_id}")
        btn_toggle.display = has_diff
        btn_close = Button("✕", classes="tab-btn tab-btn-close", id=f"btn-close-{tab_id}")
        
        lbl_filename = Label(f"[bold]{escape(path.name)}[/bold]", classes="tab-filename")

        tabs.add_pane(TabPane(
            path.name,
            Horizontal(lbl_filename, btn_toggle, btn_close, classes="tab-toolbar"),
            VerticalScroll(classes="tab-content", id=f"content-{tab_id}"),
            id=tab_id,
        ))
        tabs.active = tab_id
        self._render_tab(tab_id)

    def show_git_diff(self, path: Path) -> None:
        """Open file (or switch to existing tab) and force diff view."""
        self.show_file(path)  # creates tab if needed, switches if exists; no double-render
        tab_id = self._open_tabs[path]
        if not self._tab_showing_diff.get(tab_id) and not self._tab_is_binary.get(tab_id, False):
            self._set_tab_mode(tab_id, diff=True)

    def show_tool(self, tool_name: str, args: Dict[str, Any]) -> None:
        self._current_tool = tool_name
        self._current_args = args
        self._view_mode = "tool_diff"
        self.display = True
        self._set_header(f"[bold yellow]Action:[/bold yellow] [bold]{escape(tool_name)}[/bold]")
        self.query_one("#diff-switcher", ContentSwitcher).current = "tool-viewer"

        # Play attention sound if enabled
        from andromity.config import config as _cfg
        try:
            if _cfg.get("default", "sound_attention", True):
                from andromity.core.audio import play_sound
                play_sound("done.wav")
        except Exception:
            pass

        content = self.query_one("#tool-content", VerticalScroll)
        content.remove_children()

        _TOOL_RENDERERS = {
            "write_file":      self._render_write_diff,
            "edit_file":       self._render_edit_diff,
            "edit_file_multi": self._render_edit_multi_diff,
            "shell_exec":      self._render_command,
            "read_file":       self._render_sensitive,
            "web_search":      self._render_web_search,
            "fetch_url":       self._render_fetch_url,
        }
        if tool_name.startswith("mcp__"):
            self._render_mcp(content, args)
        elif tool_name in _TOOL_RENDERERS:
            _TOOL_RENDERERS[tool_name](content, args)
        else:
            content.mount(Static(f"[dim]{escape(json.dumps(args, indent=2))}[/dim]"))

        self._set_tool_buttons(visible=True, allow_domain=(tool_name == "fetch_url"))

    def dismiss_tool(self) -> None:
        """Hide the tool viewer and reset button state. Call after user approves or rejects."""
        self._set_tool_buttons(visible=False)
        # Switch back to the tab viewer so next show_file() lands on the right pane
        try:
            self.query_one("#diff-switcher", ContentSwitcher).current = "viewer-tabs"
        except Exception:
            pass
        self._view_mode = "file"
        self._current_tool = None
        self._current_args = None
        # Auto-close the whole panel if no file tabs are open
        if not self._open_tabs:
            self.display = False

    def show_plan(self, plan) -> None:
        """Display plan content in the viewer. Fully synchronous — uses Static.update() only."""
        self._current_plan = plan
        self._view_mode = "plan"
        self.display = True
        title_short = escape(plan.title[:40] + ("..." if len(plan.title) > 40 else ""))
        self._set_header(f"[bold cyan]\U0001f4cb Plan:[/] {title_short}")
        self.query_one("#diff-switcher", ContentSwitcher).current = "plan-viewer"

        # Build the entire plan body as one Rich markup string
        # and update the single pre-mounted Static in-place — zero async DOM ops.
        lines: list[str] = []

        if plan.description:
            lines.append(f"[dim]{escape(plan.description)}[/dim]")
            lines.append("")

        # Full markdown document written by the agent (architecture, file-by-file
        # changes, verification plan, …) — escaped so it renders as safe plain
        # text in the single in-place Static.
        body = getattr(plan, "body", "") or ""
        if body:
            lines.append(escape(body))
            lines.append("")

        questions = getattr(plan, "questions", [])
        if isinstance(questions, str):
            questions = [q.strip() for q in questions.split("\n") if q.strip()]
            
        if questions:
            lines.append("[bold cyan]Questions for you:[/bold cyan]")
            for q in questions:
                lines.append(f"  [cyan]?[/] {escape(q)}")
            lines.append("")

        status = getattr(plan, "status", "pending")
        badge = {
            "pending":  "[yellow]\u23f3 Awaiting your approval[/]",
            "approved": "[green]\u2713 Approved — work in progress[/]",
            "rejected": "[red]\u2717 Rejected[/]",
        }.get(status, status)
        lines.append(badge)

        self.query_one("#plan-body", Static).update("\n".join(lines))

        # Approve/reject bar — only visible when pending
        action_bar = self.query_one("#plan-action-bar")
        comment_input = self.query_one("#plan-comment-input", Input)
        comment_input.value = ""
        self._plan_comment_mode = ""
        if status == "pending":
            action_bar.add_class("visible")
        else:
            action_bar.remove_class("visible")

    # ── Button handler ────────────────────────────────────────────────────────

    @on(Button.Pressed)
    def _on_button(self, event: Button.Pressed) -> None:
        bid = event.button.id or ""

        if bid == "btn-close-panel":
            try:
                self.app._resolve_tool_approval(False)
            except Exception:
                pass
            self.display = False

        elif bid.startswith("btn-close-"):
            self._close_tab(bid[len("btn-close-"):])

        elif bid.startswith("btn-toggle-"):
            tab_id = bid[len("btn-toggle-"):]
            self._set_tab_mode(tab_id, diff=not self._tab_showing_diff.get(tab_id, False))

        # btn-apply / btn-allow-domain / btn-reject are handled by the parent app
        # via bubbling — don't consume them here.

        elif bid == "btn-plan-approve":
            # Immediately hide the action bar so there's no double-click confusion
            self.query_one("#plan-action-bar").remove_class("visible")
            comment = self.query_one("#plan-comment-input", Input).value.strip()
            if self._current_plan:
                try:
                    self.app._on_plan_approved(self._current_plan, comment=comment)
                except Exception:
                    pass
            event.stop()

        elif bid == "btn-plan-reject":
            # Immediately hide action bar and tell app
            self.query_one("#plan-action-bar").remove_class("visible")
            comment = self.query_one("#plan-comment-input", Input).value.strip()
            if self._current_plan:
                try:
                    self.app._on_plan_rejected(self._current_plan, comment)
                except Exception:
                    pass
            event.stop()

    # ── Internal: tab management ──────────────────────────────────────────────

    def _set_tab_mode(self, tab_id: str, *, diff: bool) -> None:
        self._tab_showing_diff[tab_id] = diff
        try:
            btn = self.query_one(f"#btn-toggle-{tab_id}", Button)
            btn.label = "⎇ Code" if diff else "⎇ Diff"
        except Exception:
            pass
        self._render_tab(tab_id)

    def _close_tab(self, tab_id: str) -> None:
        path = self._tab_paths.pop(tab_id, None)
        if path:
            self._open_tabs.pop(path, None)
        self._tab_showing_diff.pop(tab_id, None)
        self._tab_is_binary.pop(tab_id, None)

        self.query_one("#viewer-tabs", TabbedContent).remove_pane(tab_id)

        if not self._open_tabs:
            self._current_file = None
            self._set_header("[bold]Viewer[/]")
            self.display = False

    def _render_tab(self, tab_id: str) -> None:
        path = self._tab_paths.get(tab_id)
        if not path:
            return
        try:
            area = self.query_one(f"#content-{tab_id}", VerticalScroll)
            area.remove_children()
        except Exception:
            # The pane attaches asynchronously (add_pane returns AwaitComplete);
            # retry after refresh instead of leaving the new tab blank.
            self.call_after_refresh(self._render_tab, tab_id)
            return

        if self._tab_showing_diff.get(tab_id):
            diff_text = _get_git_diff(path)
            if not diff_text.strip():
                area.mount(Static("[dim]  No uncommitted changes.[/dim]"))
            else:
                area.mount(Static(_format_diff(diff_text), classes="diff-content"))
        else:
            try:
                # Detect binary files before attempting text render
                try:
                    raw = path.read_bytes()
                    if _is_binary(raw):
                        size_kb = len(raw) / 1024
                        area.mount(Static(
                            f"[yellow]⚠ Binary file[/yellow] — cannot display as text.\n\n"
                            f"[dim]Path: {escape(str(path))}[/dim]\n"
                            f"[dim]Size: {size_kb:.1f} KB  |  Type: {escape(path.suffix or 'unknown')}[/dim]"
                        ))
                        return
                    code = raw.decode("utf-8", errors="replace")
                except PermissionError:
                    area.mount(Static(f"[red]Permission denied: {escape(str(path))}[/red]"))
                    return
                except OSError as e:
                    area.mount(Static(f"[red]Cannot read file: {escape(str(e))}[/red]"))
                    return
                area.mount(Static(Syntax(
                    code, _lexer(path), theme="monokai",
                    line_numbers=True, word_wrap=False,
                ), classes="diff-content"))
            except Exception as e:
                area.mount(Static(f"[red]{escape(str(e))}[/red]"))

    # ── Internal: helpers ─────────────────────────────────────────────────────

    def _has_git_diff(self, path: Path) -> bool:
        return bool(_get_git_diff(path).strip())

    def _set_header(self, markup: str) -> None:
        try:
            safe_update(self.query_one("#diff-header-title", Static), markup)
        except Exception:
            pass

    def _set_tool_buttons(self, *, visible: bool, allow_domain: bool = False) -> None:
        try:
            self.query_one("#btn-apply", Button).display = visible
            self.query_one("#btn-allow-domain", Button).display = visible and allow_domain
            self.query_one("#btn-reject", Button).display = visible
        except Exception:
            pass

    # ── Tool content renderers ────────────────────────────────────────────────

    def _render_write_diff(self, c: VerticalScroll, args: Dict[str, Any]) -> None:
        path_str = args.get("path", "?")
        new = args.get("content", "")
        try:
            old = Path(path_str).read_text(encoding="utf-8")
        except (FileNotFoundError, PermissionError):
            old = ""
        diff = list(difflib.unified_diff(
            old.splitlines(keepends=True), new.splitlines(keepends=True),
            fromfile=f"a/{path_str}", tofile=f"b/{path_str}", lineterm="",
        ))
        if not diff:
            c.mount(Static("[dim]No changes.[/dim]"))
        else:
            c.mount(Static(_format_diff("\n".join(l.rstrip("\r\n") for l in diff)), classes="diff-content"))

    def _render_edit_diff(self, c: VerticalScroll, args: Dict[str, Any]) -> None:
        path_str = args.get("path", "?")
        diff = list(difflib.unified_diff(
            args.get("old_str", "").splitlines(keepends=True),
            args.get("new_str", "").splitlines(keepends=True),
            fromfile=f"a/{path_str}", tofile=f"b/{path_str}", lineterm="",
        ))
        if not diff:
            c.mount(Static("[dim]No changes.[/dim]"))
        else:
            c.mount(Static(_format_diff("\n".join(l.rstrip("\r\n") for l in diff)), classes="diff-content"))

    def _render_edit_multi_diff(self, c: VerticalScroll, args: Dict[str, Any]) -> None:
        path_str = args.get("path", "?")
        replacements = args.get("replacements", [])
        if not replacements:
            c.mount(Static("[dim]No changes.[/dim]"))
            return
            
        diffs = []
        for i, rep in enumerate(replacements):
            old_str = rep.get("old_str", "")
            new_str = rep.get("new_str", "")
            chunk_diff = list(difflib.unified_diff(
                old_str.splitlines(keepends=True),
                new_str.splitlines(keepends=True),
                fromfile=f"a/{path_str} (chunk {i+1})", 
                tofile=f"b/{path_str} (chunk {i+1})", lineterm="",
            ))
            if chunk_diff:
                diffs.extend(chunk_diff)
                diffs.append("\n")
                
        if not diffs:
            c.mount(Static("[dim]No changes.[/dim]"))
        else:
            c.mount(Static(_format_diff("\n".join(l.rstrip("\r\n") for l in diffs)), classes="diff-content"))

    def _render_command(self, c: VerticalScroll, args: Dict[str, Any]) -> None:
        c.mount(Static(
            f"[dim]Shell command:[/dim]\n\n[bold white]{escape(args.get('command', ''))}[/bold white]",
            classes="diff-content",
        ))

    def _render_sensitive(self, c: VerticalScroll, args: Dict[str, Any]) -> None:
        c.mount(Static(
            f"[yellow]Agent wants to read:[/yellow]\n\n"
            f"[bold white]{escape(args.get('path', '?'))}[/bold white]\n\n"
            f"[dim]Verify this is safe before approving.[/dim]",
            classes="diff-content",
        ))

    def _render_web_search(self, c: VerticalScroll, args: Dict[str, Any]) -> None:
        c.mount(Static(
            f"[dim]Web search:[/dim]\n\n[bold cyan]{escape(args.get('query', ''))}[/bold cyan]",
            classes="diff-content",
        ))

    def _render_fetch_url(self, c: VerticalScroll, args: Dict[str, Any]) -> None:
        c.mount(Static(
            f"[dim]Fetch URL:[/dim]\n\n[bold cyan]{escape(args.get('url', ''))}[/bold cyan]\n\n"
            f"[dim]'Allow Domain' skips future prompts for this site.[/dim]",
            classes="diff-content",
        ))

    def _render_mcp(self, c: VerticalScroll, args: Dict[str, Any]) -> None:
        c.mount(Static(
            f"[dim]MCP call:[/dim]\n\n[bold cyan]{escape(json.dumps(args, indent=2))}[/bold cyan]",
            classes="diff-content",
        ))


# ── Module-level helpers (no self needed) ──────────────────────────────────────

def _get_git_diff(path: Path) -> str:
    try:
        repo = get_repo(path.parent)
        if repo:
            rel = str(path.relative_to(Path(repo.working_tree_dir)))
            return get_file_diff(repo, rel)
    except Exception:
        pass
    return ""


def _format_diff(diff_text: str) -> str:
    """Colour a unified diff string with clean single-column line numbers and Rich markup."""
    lines = []
    old_lineno: Optional[int] = None
    new_lineno: Optional[int] = None

    # First pass: find maximum line number to calculate gutter column width
    max_line = 0
    for line in diff_text.splitlines():
        if line.startswith("@@"):
            m_new = re.search(r"\+(\d+)(?:,(\d+))?", line)
            if m_new:
                start = int(m_new.group(1))
                count = int(m_new.group(2)) if m_new.group(2) else 1
                max_line = max(max_line, start + count)
            m_old = re.search(r"-(\d+)(?:,(\d+))?", line)
            if m_old:
                start = int(m_old.group(1))
                count = int(m_old.group(2)) if m_old.group(2) else 1
                max_line = max(max_line, start + count)

    width = max(3, len(str(max_line))) if max_line > 0 else 3
    empty_gutter = " " * width

    for raw_line in diff_text.splitlines():
        line_clean = raw_line.rstrip("\r\n")

        if line_clean.startswith(("diff --git", "index ", "new file", "deleted file", "similarity")):
            lines.append(f"[dim]{escape(line_clean)}[/dim]")
        elif line_clean.startswith(("---", "+++")):
            lines.append(f"[dim]{empty_gutter} │[/dim] [bold cyan]{escape(line_clean)}[/bold cyan]")
        elif line_clean.startswith("@@"):
            m = re.match(r"^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)", line_clean)
            if m:
                old_lineno = int(m.group(1))
                new_lineno = int(m.group(2))
                heading = m.group(3).strip()
                heading_str = f" [dim]{escape(heading)}[/dim]" if heading else ""
                hunk_header = line_clean if not heading else line_clean[:line_clean.find(heading)].rstrip()
                lines.append(f"[dim]{empty_gutter} │[/dim] [bold magenta]{escape(hunk_header)}[/bold magenta]{heading_str}")
            else:
                lines.append(f"[dim]{empty_gutter} │[/dim] [bold magenta]{escape(line_clean)}[/bold magenta]")
        elif line_clean.startswith("-"):
            num_str = f"{old_lineno:>{width}}" if old_lineno is not None else empty_gutter
            lines.append(f"[dim]{num_str} │[/dim] [red]{escape(line_clean)}[/red]")
            if old_lineno is not None:
                old_lineno += 1
        elif line_clean.startswith("+"):
            num_str = f"{new_lineno:>{width}}" if new_lineno is not None else empty_gutter
            lines.append(f"[dim]{num_str} │[/dim] [green]{escape(line_clean)}[/green]")
            if new_lineno is not None:
                new_lineno += 1
        else:
            # Context line (unchanged)
            current_no = new_lineno if new_lineno is not None else old_lineno
            num_str = f"{current_no:>{width}}" if current_no is not None else empty_gutter
            lines.append(f"[dim]{num_str} │[/dim] {escape(line_clean)}")
            if old_lineno is not None:
                old_lineno += 1
            if new_lineno is not None:
                new_lineno += 1

    return "\n".join(lines)


def _lexer(path: Path) -> str:
    return {
        ".py": "python",   ".js": "javascript", ".jsx": "javascript",
        ".ts": "typescript", ".tsx": "typescript",
        ".html": "html",   ".htm": "html",
        ".css": "css",     ".json": "json",     ".jsonc": "json",
        ".md": "markdown", ".markdown": "markdown",
        ".toml": "toml",   ".yaml": "yaml",     ".yml": "yaml",
        ".sh": "bash",     ".bash": "bash",
    }.get(path.suffix.lower(), "text")


def _is_binary(data: bytes, sample: int = 8192) -> bool:
    """Heuristic binary check: look for null bytes in first `sample` bytes."""
    chunk = data[:sample]
    return b"\x00" in chunk


def _is_binary_path(path: Path, sample: int = 8192) -> bool:
    """Read the first few bytes from a path and return True if it looks binary."""
    try:
        with path.open("rb") as f:
            chunk = f.read(sample)
        return b"\x00" in chunk
    except OSError:
        return False