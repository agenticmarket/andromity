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
    background: $background 50%;
}
#batch-dialog {
    width: 92%; height: 88%;
    border: solid $primary-darken-2;
    background: $surface;
    padding: 0;
}
#batch-header {
    height: 2; padding: 0 2;
    background: $primary-darken-3;
    color: $text;
    dock: top;
    content-align: left middle;
}
#batch-body {
    height: 1fr;
}
#batch-file-list {
    width: 32;
    height: 1fr;
    border-right: solid $surface-lighten-1;
    padding: 0;
}
#batch-diff-view {
    height: 1fr;
    padding: 1 2;
    overflow-y: auto;
}

/* ── Footer ──────────────────────────────────────────────────── */
#batch-footer {
    dock: bottom;
    height: 3;
    padding: 0 2;
    background: $surface-darken-1;
    border-top: solid $surface-lighten-1;
    align: left middle;
}
#batch-footer-divider {
    width: 1;
    height: 1;
    color: $surface-lighten-2;
    margin: 0 1;
    content-align: center middle;
}

/* Flat minimal button base */
#batch-footer Button {
    border: none !important;
    background: transparent !important;
    height: 1 !important;
    min-width: 0 !important;
    padding: 0 2 !important;
    margin: 0 !important;
    text-style: none;
}

/* Per-file actions — muted until hovered */
#btn-reject-sel  { color: $error-darken-1 !important; }
#btn-accept-sel  { color: $success-darken-1 !important; }
#btn-reject-sel:hover { color: $error !important; text-style: bold; }
#btn-accept-sel:hover { color: $success !important; text-style: bold; }

/* Bulk actions — slightly more prominent */
#btn-reject-all {
    color: $error !important;
    text-style: bold;
    margin-left: 1 !important;
}
#btn-accept-all {
    color: $success !important;
    text-style: bold;
}
#btn-reject-all:hover { color: $error-lighten-1 !important; }
#btn-accept-all:hover { color: $success-lighten-1 !important; }
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
            yield Static(self._header_text(), id="batch-header")
            with Horizontal(id="batch-body"):
                yield OptionList(id="batch-file-list")
                with VerticalScroll(id="batch-diff-view"):
                    yield Static("", id="batch-diff-content")
            with Horizontal(id="batch-footer"):
                # Per-file actions
                yield Button("✕ Reject", id="btn-reject-sel")
                yield Button("✓ Accept", id="btn-accept-sel")
                # Divider
                yield Static("│", id="batch-footer-divider")
                # Bulk actions
                yield Button("✕ Reject All", id="btn-reject-all")
                yield Button("✓ Accept All", id="btn-accept-all")

    def _header_text(self) -> str:
        n = len(self.files)
        return f"[bold]🔍 Batch Review[/bold]  [dim]{n} file{'s' if n != 1 else ''} modified — review before accepting[/dim]"

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

        # Keep header count in sync
        try:
            self.query_one("#batch-header", Static).update(self._header_text())
        except Exception:
            pass

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
            if diff_text.strip():
                content_area.update(_format_diff(diff_text))
                return

            # No git diff — figure out why and show something useful
            if not path.exists():
                content_area.update("[red]File was deleted.[/red]")
                return

            try:
                file_content = path.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                content_area.update(f"[red]Cannot read file: {escape(str(e))}[/red]")
                return

            if not file_content.strip():
                # Newly created empty file — common when agent scaffolds files
                content_area.update(
                    f"[dim]New empty file[/dim] [bold]{escape(path.name)}[/bold]\n\n"
                    "[dim]The agent created this file with no content yet.\n"
                    "Accept to keep it, Reject to delete it.[/dim]"
                )
            else:
                # File exists with content but git can't diff it (non-git folder,
                # or untracked with content that wasn't captured in snapshot).
                # Show the file content directly as a synthetic "+ new file" diff.
                lines = file_content.splitlines()
                synthetic = (
                    f"[bold cyan]--- /dev/null[/bold cyan]\n"
                    f"[bold cyan]+++ b/{escape(path.name)}[/bold cyan]\n"
                    f"[bold magenta]@@ -0,0 +1,{len(lines)} @@[/bold magenta]\n"
                )
                synthetic += "\n".join(f"[green]+{escape(l)}[/green]" for l in lines)
                content_area.update(synthetic)

        except Exception as e:
            content_area.update(f"[red]Error loading diff: {escape(str(e))}[/red]")

    def on_button_pressed(self, event: Button.Pressed):
        bid = event.button.id

        if bid == "btn-accept-all":
            self.dismiss(True)

        elif bid == "btn-reject-all":
            if self.repo and self.snapshot_hash:
                restore_snapshot(self.repo, self.snapshot_hash)
            else:
                # No git snapshot available. Fallback: delete the files since the AI just touched them.
                # (This is better than leaving them silently on disk when the user clicked Reject)
                for f in self.files:
                    if f.exists():
                        try: f.unlink()
                        except OSError: pass
            self.dismiss(False)

        elif bid == "btn-accept-sel":
            # Accept this file as-is — remove from review list, move to next
            if not (0 <= self._selected_index < len(self.files)):
                return
            self.files.pop(self._selected_index)
            self._update_file_list()

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
            else:
                # No git available. Just delete it.
                if path_to_revert.exists():
                    try: path_to_revert.unlink()
                    except OSError: pass

            # Remove from list and refresh
            self.files.pop(self._selected_index)
            self._update_file_list()
