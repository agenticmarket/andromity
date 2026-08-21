"""Batch review modal overlay for safe mode."""
import asyncio
from pathlib import Path
from typing import List, Optional

from andromity.tui.markup_utils import escape_textual as escape
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, OptionList
from textual.widgets.option_list import Option

from andromity.core.git_ops import get_repo, restore_file_snapshot
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


    def __init__(
        self,
        project_path: str,
        snapshot_hash: Optional[str],
        files: List[Path],
        pre_write_contents: Optional[dict] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.project_path = Path(project_path)
        self.snapshot_hash = snapshot_hash  # None when git unavailable
        self.files = [p for p in files if p.is_absolute() and p.is_relative_to(self.project_path)]
        self.repo = get_repo(self.project_path)
        # pre_write_contents: {Path -> bytes | None}
        # bytes  = old file content (agent modified it this turn)
        # None   = file didn't exist before this turn (agent created it)
        self.pre_write_contents: dict = pre_write_contents or {}
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
            # ── Priority 1: real git diff (tracked files with committed baseline) ──
            diff_text = _get_git_diff(path)
            if diff_text.strip():
                content_area.update(_format_diff(diff_text))
                return

            # ── No git diff. Could be: untracked file, non-git folder, or empty delta ──
            if not path.exists():
                content_area.update("[red]File was deleted.[/red]")
                return

            try:
                new_content = path.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                content_area.update(f"[red]Cannot read file: {escape(str(e))}[/red]")
                return

            # ── Priority 2: difflib diff using pre_write_contents ──────────────────
            # pre_write_contents[path] is None  → file was NEW this turn (agent created it)
            # pre_write_contents[path] is bytes → file EXISTED and was modified
            old_bytes = self.pre_write_contents.get(path)

            if old_bytes is not None:
                # File was modified — show only what actually changed using difflib
                import difflib
                old_text = old_bytes.decode("utf-8", errors="replace")
                old_lines = old_text.splitlines(keepends=True)
                new_lines = new_content.splitlines(keepends=True)
                diff = list(difflib.unified_diff(
                    old_lines, new_lines,
                    fromfile=f"a/{path.name}",
                    tofile=f"b/{path.name}",
                    lineterm="",
                ))
                if diff:
                    content_area.update(_format_diff("".join(diff)))
                else:
                    content_area.update("[dim]No visible changes (whitespace only or identical content).[/dim]")
                return

            # ── Priority 3: genuinely new file — show all content as + ─────────────
            if not new_content.strip():
                content_area.update(
                    f"[dim]New empty file[/dim] [bold]{escape(path.name)}[/bold]\n\n"
                    "[dim]The agent created this file with no content yet.\n"
                    "Accept to keep it, Reject to delete it.[/dim]"
                )
            else:
                lines = new_content.splitlines()
                synthetic = (
                    f"[bold cyan]--- /dev/null[/bold cyan]\n"
                    f"[bold cyan]+++ b/{escape(path.name)}[/bold cyan]\n"
                    f"[bold magenta]@@ -0,0 +1,{len(lines)} @@[/bold magenta]\n"
                )
                synthetic += "\n".join(f"[green]+{escape(l)}[/green]" for l in lines)
                content_area.update(synthetic)


        except Exception as e:
            content_area.update(f"[red]Error loading diff: {escape(str(e))}[/red]")

    # ── Revert helpers ───────────────────────────────────────────────────

    def _revert_one(self, path: Path) -> None:
        """
        Revert a SINGLE file to its state before this agent turn.

        With git snapshot:
          - Uses restore_file_snapshot() per file (not the whole tree!).
            This precisely handles:
              • Modified tracked file  → git checkout restores old content
              • Newly created file     → git checkout fails gracefully, then deletes the file
          - Does NOT run git clean or touch anything outside this file.

        Without git snapshot (pre_write_contents fallback):
          - old_content is None  → file was new this turn, delete it.
          - old_content is bytes → file was modified, write the old bytes back.
        """
        if self.repo and self.snapshot_hash:
            try:
                rel = str(path.relative_to(self.project_path))
                restore_file_snapshot(self.repo, self.snapshot_hash, rel)
            except (ValueError, Exception):
                pass
            return

        # No git — use the in-memory pre-write content we captured before the agent ran.
        old_content: bytes | None = self.pre_write_contents.get(path)
        if old_content is None:
            # File didn't exist before this turn — agent created it. Delete it.
            if path.exists():
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
        else:
            # File existed and was modified this turn. Restore the old bytes.
            try:
                path.write_bytes(old_content)
            except OSError:
                pass

    def _revert_files(self, paths: List[Path]) -> None:
        """Revert a list of files. Precise: only those files, nothing else in the workspace."""
        for f in paths:
            self._revert_one(f)

    # ── Button handler ───────────────────────────────────────────────────

    def on_button_pressed(self, event: Button.Pressed):
        bid = event.button.id

        if bid == "btn-accept-all":
            self.dismiss(True)

        elif bid == "btn-reject-all":
            # Revert every file in this batch precisely. No other files in the workspace are touched.
            self._revert_files(self.files)
            self.dismiss(False)

        elif bid == "btn-accept-sel":
            if not (0 <= self._selected_index < len(self.files)):
                return
            self.files.pop(self._selected_index)
            self._update_file_list()

        elif bid == "btn-reject-sel":
            if not (0 <= self._selected_index < len(self.files)):
                return
            path_to_revert = self.files[self._selected_index]
            self._revert_one(path_to_revert)
            self.files.pop(self._selected_index)
            self._update_file_list()

