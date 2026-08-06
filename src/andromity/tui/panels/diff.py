import difflib
from pathlib import Path
from typing import Dict, Any, Optional
from rich.markup import escape
from rich.syntax import Syntax
from textual.app import ComposeResult
from textual.containers import VerticalScroll, Horizontal
from textual.widget import Widget
from textual.widgets import Static, Button
from andromity.core.git_ops import get_repo, get_file_diff
from andromity.tui.markup_utils import safe_update


class DiffPanel(VerticalScroll):
    """Right-side panel for syntax-highlighted file viewing and git / tool diffs."""
    DEFAULT_CSS = """\
DiffPanel { height: 1fr; }
#diff-header { padding: 0 1; height: 3; background: $surface-darken-1; }
#diff-content { height: 1fr; overflow-y: auto; padding: 0 1; }
#diff-buttons { dock: bottom; height: 3; padding: 0 1; background: $surface-darken-1; }
#diff-buttons Button { margin: 0 1; }
"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._current_tool: Optional[str] = None
        self._current_args: Optional[Dict[str, Any]] = None
        self._current_file: Optional[Path] = None
        self._view_mode: str = "file"  # "file", "git_diff", "tool_diff"

    def compose(self) -> ComposeResult:
        yield Static("[bold]Code & Diff Viewer[/]", id="diff-header")
        yield VerticalScroll(id="diff-content")
        with Horizontal(id="diff-buttons"):
            yield Button("Close", variant="default", id="btn-close")
            yield Button("View Diff", variant="primary", id="btn-toggle-diff")
            yield Button("[Y] Apply", variant="success", id="btn-apply")
            yield Button("[N] Reject", variant="error", id="btn-reject")

    def on_mount(self):
        self._update_button_visibility()

    def _update_button_visibility(self):
        try:
            btn_close = self.query_one("#btn-close", Button)
            btn_diff = self.query_one("#btn-toggle-diff", Button)
            btn_apply = self.query_one("#btn-apply", Button)
            btn_reject = self.query_one("#btn-reject", Button)

            if self._view_mode == "tool_diff":
                btn_close.display = True
                btn_diff.display = False
                btn_apply.display = True
                btn_reject.display = True
            elif self._view_mode == "file":
                btn_close.display = True
                btn_diff.display = bool(self._current_file and self._has_git_diff(self._current_file))
                btn_diff.label = "View Git Diff"
                btn_apply.display = False
                btn_reject.display = False
            elif self._view_mode == "git_diff":
                btn_close.display = True
                btn_diff.display = True
                btn_diff.label = "View Code"
                btn_apply.display = False
                btn_reject.display = False
        except Exception:
            pass

    def _has_git_diff(self, path: Path) -> bool:
        try:
            repo = get_repo(path.parent)
            if repo:
                rel = str(path.relative_to(Path(repo.working_tree_dir)))
                diff = get_file_diff(repo, rel)
                return bool(diff.strip())
        except Exception:
            pass
        return False

    def show_file(self, path: Path):
        """Display a file with Rich syntax highlighting like an IDE."""
        self._current_file = path
        self._current_tool = None
        self._current_args = None
        self._view_mode = "file"

        header = self.query_one("#diff-header", Static)
        content_area = self.query_one("#diff-content", VerticalScroll)
        content_area.remove_children()

        try:
            rel = str(path.relative_to(Path.cwd()))
        except ValueError:
            rel = str(path)

        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                code = f.read()
            line_count = len(code.splitlines())
            size_kb = path.stat().st_size / 1024
            safe_update(header, f"[bold cyan]\U0001f4c4 {escape(rel)}[/bold cyan]  [dim]({line_count} lines, {size_kb:.1f} KB)[/dim]")

            # Render syntax highlighted code
            lexer = Syntax.guess_lexer(str(path), code=code)
            syntax = Syntax(code, lexer, theme="monokai", line_numbers=True, word_wrap=True)
            content_area.mount(Static(syntax))
        except Exception as e:
            safe_update(header, f"[bold red]Error reading {escape(rel)}[/bold red]")
            content_area.mount(Static(f"[red]{escape(str(e))}[/red]"))

        self._update_button_visibility()

    def show_git_diff(self, path: Path):
        """Display git diff for a specific file vs HEAD."""
        self._current_file = path
        self._view_mode = "git_diff"

        header = self.query_one("#diff-header", Static)
        content_area = self.query_one("#diff-content", VerticalScroll)
        content_area.remove_children()

        try:
            rel = str(path.relative_to(Path.cwd()))
        except ValueError:
            rel = str(path)

        repo = get_repo(path.parent)
        diff_text = ""
        if repo:
            try:
                repo_rel = str(path.relative_to(Path(repo.working_tree_dir)))
                diff_text = get_file_diff(repo, repo_rel)
            except Exception:
                pass

        safe_update(header, f"[bold yellow]Diff: {escape(rel)}[/bold yellow] [dim](vs HEAD)[/dim]")
        if not diff_text.strip():
            content_area.mount(Static("[dim]  No uncommitted changes in this file.[/dim]"))
        else:
            self._render_diff_text(content_area, diff_text)

        self._update_button_visibility()

    def show_tool(self, tool_name: str, args: Dict[str, Any]):
        """Display incoming tool proposal diff for agent approval."""
        self._current_tool = tool_name
        self._current_args = args
        self._view_mode = "tool_diff"

        header = self.query_one("#diff-header", Static)
        safe_update(header, f"[bold yellow]Proposed Change:[/bold yellow] [bold]{escape(tool_name)}[/bold]")

        content_area = self.query_one("#diff-content", VerticalScroll)
        content_area.remove_children()

        if tool_name == "write_file":
            self._show_write_diff(content_area, args)
        elif tool_name == "edit_file":
            self._show_edit_diff(content_area, args)
        elif tool_name == "shell_exec":
            self._show_command_approval(content_area, args)
        elif tool_name == "read_file":
            self._show_sensitive_warning(content_area, args)

        self._update_button_visibility()

    def _render_diff_text(self, container: VerticalScroll, diff_text: str):
        style_map = {
            "add": "[green]",
            "remove": "[red]",
            "header": "[bold cyan]",
            "hunk": "[bold magenta]",
            "context": ""
        }
        
        formatted_lines = []
        for line in diff_text.splitlines():
            if line.startswith("+++") or line.startswith("---"):
                line_type = "header"
            elif line.startswith("@@"):
                line_type = "hunk"
            elif line.startswith("+"):
                line_type = "add"
            elif line.startswith("-"):
                line_type = "remove"
            else:
                line_type = "context"
                
            style = style_map.get(line_type, "")
            close = f"[/{style.strip('[]')}]" if style else ""
            
            # Unified diff lines already have + - leading chars, use as-is
            formatted_lines.append(f"{style}{escape(line)}{close}")
            
        container.mount(Static("\n".join(formatted_lines)))

    def _show_write_diff(self, container: VerticalScroll, args: Dict[str, Any]):
        path = args.get("path", "?")
        new_content = args.get("content", "")
        try:
            with open(path, "r", encoding="utf-8") as f:
                old_content = f.read()
        except (FileNotFoundError, PermissionError):
            old_content = ""
        diff = list(difflib.unified_diff(
            old_content.splitlines(keepends=True), new_content.splitlines(keepends=True),
            fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="",
        ))
        if not diff:
            container.mount(Static("[dim]No changes[/dim]"))
            return
        self._render_diff_text(container, "\n".join(line.rstrip("\r\n") for line in diff))

    def _show_edit_diff(self, container: VerticalScroll, args: Dict[str, Any]):
        path = args.get("path", "?")
        old_str = args.get("old_str", "")
        new_str = args.get("new_str", "")
        
        diff = list(difflib.unified_diff(
            old_str.splitlines(keepends=True), new_str.splitlines(keepends=True),
            fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="",
        ))
        if not diff:
            container.mount(Static("[dim]No changes[/dim]"))
            return
            
        self._render_diff_text(container, "\n".join(line.rstrip("\r\n") for line in diff))

    def _show_command_approval(self, container: VerticalScroll, args: Dict[str, Any]):
        command = args.get("CommandLine", "") or args.get("command", "")
        container.mount(Static("[bold red]⚠ SECURITY WARNING: The AI wants to run a shell command.[/bold red]\n\n"
                               "Shell commands can modify your system, access the internet, or delete files. "
                               "Only approve this if you understand exactly what the command does.\n"))
        container.mount(Static(f"[bold]Command:[/]\n\n  [cyan]{escape(command)}[/cyan]\n\n", classes="shell-command-view"))

    def _show_sensitive_warning(self, container: VerticalScroll, args: Dict[str, Any]):
        path = args.get("path", "")
        container.mount(Static("[bold red]⚠ SECURITY WARNING: Sensitive File Access[/bold red]\n\n"
                               "The AI is attempting to read a sensitive file (like a password, API key, or configuration file).\n"
                               "If you approve this, the contents of the file will be sent to the LLM provider.\n"))
        container.mount(Static(f"[bold]Target File:[/]\n\n  [magenta]{escape(path)}[/magenta]\n\n"))

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id
        parent_panel = self.app.query_one("#right-panel")
        
        if btn_id == "btn-close":
            parent_panel.remove_class("visible")
        elif btn_id == "btn-apply":
            if hasattr(self.app, "_tool_approval_future") and self.app._tool_approval_future:
                if not self.app._tool_approval_future.done():
                    self.app._tool_approval_future.set_result(True)
            parent_panel.remove_class("visible")
        elif btn_id == "btn-reject":
            if hasattr(self.app, "_tool_approval_future") and self.app._tool_approval_future:
                if not self.app._tool_approval_future.done():
                    self.app._tool_approval_future.set_result(False)
            parent_panel.remove_class("visible")
        elif btn_id == "btn-toggle-diff":
            if self._view_mode == "file" and self._current_file:
                self.show_git_diff(self._current_file)
            elif self._view_mode == "git_diff" and self._current_file:
                self.show_file(self._current_file)
