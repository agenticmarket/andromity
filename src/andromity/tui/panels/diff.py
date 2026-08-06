import difflib
from typing import Dict, Any
from textual.app import ComposeResult
from textual.containers import VerticalScroll, Horizontal
from textual.widget import Widget
from textual.widgets import Static, Button


class DiffLine(Widget):
    DEFAULT_CSS = """\
DiffLine { width: 1fr; min-height: 1; }
"""
    def __init__(self, line: str, line_type: str = "context", **kwargs):
        super().__init__(**kwargs)
        self.line = line
        self.line_type = line_type

    def compose(self) -> ComposeResult:
        style_map = {"add": "[green]", "remove": "[red]", "header": "[bold cyan]", "hunk": "[bold magenta]"}
        prefix = {"add": "+ ", "remove": "- ", "context": "  ", "header": "@ ", "hunk": "@@"}
        style = style_map.get(self.line_type, "")
        pfx = prefix.get(self.line_type, "  ")
        yield Static(f"{style}{pfx}{self.line}[/]")


class DiffPanel(VerticalScroll):
    DEFAULT_CSS = """\
DiffPanel { height: 1fr; }
#diff-header { padding: 0 1; height: 3; }
#diff-content { height: 1fr; overflow-y: auto; }
#diff-buttons { dock: bottom; height: 3; padding: 0 1; }
#diff-buttons Button { margin: 0 1; }
"""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._current_tool = None
        self._current_args = None

    def compose(self) -> ComposeResult:
        yield Static("[bold]Diff View[/]", id="diff-header")
        yield VerticalScroll(id="diff-content")
        with Horizontal(id="diff-buttons"):
            yield Button("[Y] Apply", variant="success", id="btn-apply")
            yield Button("[N] Reject", variant="error", id="btn-reject")
            yield Button("[E] Close", variant="default", id="btn-close")

    def show_tool(self, tool_name: str, args: Dict[str, Any]):
        self._current_tool = tool_name
        self._current_args = args
        content_area = self.query_one("#diff-content")
        content_area.remove_children()
        if tool_name == "write_file":
            self._show_write_diff(content_area, args)
        elif tool_name == "edit_file":
            self._show_edit_diff(content_area, args)

    def _show_write_diff(self, container, args: Dict[str, Any]):
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
            container.mount(Static("[dim]No changes[/]"))
            return
        for line in diff:
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
            container.mount(DiffLine(line, line_type))

    def _show_edit_diff(self, container, args: Dict[str, Any]):
        path = args.get("path", "?")
        container.mount(DiffLine(f"--- a/{path}", "header"))
        container.mount(DiffLine(f"+++ b/{path}", "header"))
        for line in args.get("old_str", "").splitlines():
            container.mount(DiffLine(line, "remove"))
        for line in args.get("new_str", "").splitlines():
            container.mount(DiffLine(line, "add"))
