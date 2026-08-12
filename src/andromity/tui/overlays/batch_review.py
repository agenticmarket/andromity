"""Batch review modal overlay for safe mode."""
import asyncio
from pathlib import Path
from typing import List, Optional

from rich.markup import escape
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, OptionList
from textual.widgets.option_list import Option

from andromity.core.git_ops import get_repo, restore_file_snapshot, restore_snapshot
from andromity.tui.panels.diff import _get_git_diff, _format_diff


class BatchReviewOverlay(ModalScreen[bool]):
    """Shown at the end of a turn to review all files modified in safe mode."""
    DEFAULT_CSS = """\
BatchReviewOverlay {
    align: center middle;
    background: $background 30%;
}
#batch-dialog {
    width: 90%; height: 90%;
    border: solid $accent; background: $surface;
    padding: 0;
}
#batch-header {
    height: 3; padding: 1 2;
    background: $accent-darken-2; color: $text; text-style: bold;
    dock: top;
}
#batch-body {
    height: 1fr;
}
#batch-file-list {
    width: 30;
    height: 1fr;
    border-right: solid $surface-lighten-2;
}
#batch-diff-view {
    height: 1fr;
    padding: 1 2;
    overflow-y: auto;
}
#batch-footer {
    dock: bottom; height: 3; padding: 0 1;
    background: $surface-darken-1;
}
#batch-footer Button { margin: 0 1; }
"""

    def __init__(self, project_path: str, snapshot_hash: Optional[str], files: List[Path], **kwargs):
        super().__init__(**kwargs)
        self.project_path = Path(project_path)
        self.snapshot_hash = snapshot_hash  # None when git unavailable — Reject still shows but can't revert
        self.files = [p for p in files if p.is_absolute() and p.is_relative_to(self.project_path)]
        self.repo = get_repo(self.project_path)
        self._selected_index = 0

    def compose(self) -> ComposeResult:
        with Vertical(id="batch-dialog"):
            yield Static("🔍 Batch Review: Modified Files", id="batch-header")
            with Horizontal(id="batch-body"):
                yield OptionList(id="batch-file-list")
                with VerticalScroll(id="batch-diff-view"):
                    yield Static("", id="batch-diff-content")
            with Horizontal(id="batch-footer"):
                yield Button("Reject Selected", variant="error", id="btn-reject-sel")
                yield Button("Reject All", variant="error", id="btn-reject-all")
                yield Button("Accept All", variant="success", id="btn-accept-all")

    def on_mount(self):
        self._update_file_list()

    def _update_file_list(self):
        option_list = self.query_one("#batch-file-list", OptionList)
        option_list.clear_options()
        
        if not self.files:
            self.dismiss(True)
            return

        for f in self.files:
            try:
                rel = f.relative_to(self.project_path)
                option_list.add_option(Option(str(rel), id=str(rel)))
            except ValueError:
                pass
                
        if self.files:
            option_list.highlighted = 0
            self._show_diff_for_index(0)

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted):
        self._selected_index = event.option_index
        self._show_diff_for_index(event.option_index)

    def _show_diff_for_index(self, index: int):
        if not (0 <= index < len(self.files)):
            return
            
        path = self.files[index]
        content_area = self.query_one("#batch-diff-content", Static)
        
        try:
            diff_text = _get_git_diff(path)
            if not diff_text.strip():
                content_area.update("[dim]No unstaged changes.[/dim]")
            else:
                content_area.update(_format_diff(diff_text))
        except Exception as e:
            content_area.update(f"[red]Error loading diff: {e}[/red]")

    def on_button_pressed(self, event: Button.Pressed):
        bid = event.button.id
        
        if bid == "btn-accept-all":
            self.dismiss(True)
            
        elif bid == "btn-reject-all":
            if self.repo and self.snapshot_hash:
                restore_snapshot(self.repo, self.snapshot_hash)
            self.dismiss(False)
            
        elif bid == "btn-reject-sel":
            if not (0 <= self._selected_index < len(self.files)):
                return
            
            path_to_revert = self.files[self._selected_index]
            if self.repo and self.snapshot_hash:
                try:
                    rel_path = path_to_revert.relative_to(self.project_path)
                    restore_file_snapshot(self.repo, self.snapshot_hash, str(rel_path))
                except ValueError:
                    pass
            
            # Remove from list
            self.files.pop(self._selected_index)
            self._update_file_list()
