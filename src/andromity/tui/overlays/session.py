from datetime import datetime, timezone
from pathlib import Path
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, DataTable
from andromity.core.session import Session


def _time_ago(iso_str: str) -> str:
    """Convert ISO timestamp to human-readable relative time."""
    try:
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        secs = int(delta.total_seconds())
        if secs < 60:
            return "just now"
        if secs < 3600:
            return f"{secs // 60}m ago"
        if secs < 86400:
            return f"{secs // 3600}h ago"
        days = secs // 86400
        if days == 1:
            return "yesterday"
        if days < 7:
            return f"{days}d ago"
        return f"{days // 7}w ago"
    except Exception:
        return ""


class SessionBrowserOverlay(ModalScreen):
    """Browse, switch, and manage sessions for the current project."""
    DEFAULT_CSS = """\
SessionBrowserOverlay {
    align: center middle;
    background: $background 20%;
}
#sb-dialog {
    width: 76; height: 28;
    border: solid $accent-darken-2; background: $surface;
}
#sb-title { padding: 0 1; height: 1; background: $accent-darken-3; color: $text; text-style: bold; }
#sb-table { height: 1fr; overflow-y: auto; }
#sb-hint { height: 1; padding: 0 1; color: $text-muted; }
#sb-footer { dock: bottom; height: 3; padding: 0 1; }
#sb-footer Button { margin: 0 1; }
"""

    def __init__(self, current_session_id: str, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._current_id = current_session_id
        self._project_path = project_path
        self._sessions: list[Session] = []
        self._selected_idx: int = 0
        self._session_limit: int = 20

    def compose(self) -> ComposeResult:
        with Vertical(id="sb-dialog"):
            yield Static("", id="sb-title")
            with Vertical():
                with VerticalScroll(id="sb-table"):
                    yield DataTable(id="sb-data", cursor_type="row", zebra_stripes=True)
                yield Static("[dim]↑↓ Navigate   Enter / Open to load session   Delete to remove[/]", id="sb-hint")
            with Horizontal(id="sb-footer"):
                yield Button("New Session", variant="default", id="sb-new")
                yield Button("Delete", variant="error", id="sb-delete")
                yield Button("Cancel", variant="default", id="sb-cancel")
                yield Button("Load More", variant="default", id="sb-load-more")
                yield Button("Open", variant="primary", id="sb-open")

    def on_mount(self):
        cwd = str(Path(self._project_path).resolve())
        short_path = cwd if len(cwd) <= 50 else "..." + cwd[-47:]
        self.query_one("#sb-title").update(f" Sessions — {short_path} ")
        self._load_sessions()

    def _load_sessions(self, keep_cursor: bool = False):
        self._sessions = Session.list_sessions(self._project_path, limit=self._session_limit)
        table = self.query_one("#sb-data", DataTable)
        
        # Save cursor position if loading more
        old_row = table.cursor_row if keep_cursor and table.row_count > 0 else 0
        
        table.clear(columns=True)
        table.add_columns("Name", "Status", "Age", "Tokens", "Messages")
        for s in self._sessions:
            badge = "[bold green]active[/]" if s.id == self._current_id else ""
            age = _time_ago(getattr(s, "updated_at", s.created_at))
            tokens = f"{s.token_total:,}" if s.token_total else "—"
            msg_count = str(len([m for m in s.messages if m.get("role") in ("user", "assistant")]))
            name = s.name if s.name != "new-session" and s.name != "tui-session" else "[dim]Unnamed[/]"
            table.add_row(name, badge, age, tokens, msg_count)
            
        if self._sessions:
            table.move_cursor(row=old_row)
            
        # Hide load more if we probably loaded everything
        load_more_btn = self.query_one("#sb-load-more", Button)
        if len(self._sessions) < self._session_limit:
            load_more_btn.display = False
        else:
            load_more_btn.display = True

    def on_data_table_row_selected(self, event: DataTable.RowSelected):
        self._selected_idx = event.cursor_row

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted):
        self._selected_idx = event.cursor_row

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "sb-cancel":
            self.dismiss()
            try:
                self.app.query_one("#input-field").focus()
            except Exception:
                pass
        elif event.button.id == "sb-open":
            self._open_selected()
        elif event.button.id == "sb-new":
            self.dismiss()
            try:
                self.app._new_session()
            except Exception:
                pass
        elif event.button.id == "sb-delete":
            self._delete_selected()
        elif event.button.id == "sb-load-more":
            self._session_limit += 20
            self._load_sessions(keep_cursor=True)

    def _open_selected(self):
        if not self._sessions:
            return
        idx = min(self._selected_idx, len(self._sessions) - 1)
        session = self._sessions[idx]
        self.dismiss()
        try:
            self.app._load_session(session)
        except Exception:
            pass

    def _delete_selected(self):
        if not self._sessions:
            return
        idx = min(self._selected_idx, len(self._sessions) - 1)
        session = self._sessions[idx]
        if session.id == self._current_id:
            return  # don't delete active session
        try:
            session.file_path.unlink(missing_ok=True)
        except Exception:
            pass
        self._load_sessions()

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss()
