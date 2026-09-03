"""Trust prompt - shown on startup when a project folder has not been trusted yet."""
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Static, Button


class TrustPromptOverlay(ModalScreen):
    """Shown on startup when a project folder has not been trusted yet."""
    DEFAULT_CSS = """\
TrustPromptOverlay {
    align: center middle;
    background: $background 30%;
}
#tp-dialog {
    width: 90%; max-width: 62;
    height: auto;
    border: solid $warning;
    background: $surface;
    padding: 0;
}
#tp-title {
    padding: 0 1;
    height: 1;
    background: $warning-darken-2;
    color: $text;
    text-style: bold;
}
#tp-body {
    height: auto;
    padding: 1 2;
}
#tp-path {
    color: $accent;
    padding: 0 0 1 0;
    text-style: bold;
}
#tp-info {
    color: $text;
    height: auto;
}
#tp-footer {
    height: 3;
    padding: 0 1;
    background: $surface-darken-2;
    border-top: solid $surface-lighten-1;
    align: right middle;
}
#tp-footer Button {
    height: 1;
    min-width: 16;
    margin: 0 1;
    padding: 0 2;
    border: none;
}
#tp-footer #tp-readonly {
    background: $surface-lighten-1;
    color: $text-muted;
}
#tp-footer #tp-readonly:hover, #tp-footer #tp-readonly:focus {
    background: $surface-lighten-2;
    color: $text;
}
#tp-footer #tp-trust {
    background: $success;
    color: $background;
    text-style: bold;
}
#tp-footer #tp-trust:hover, #tp-footer #tp-trust:focus {
    background: $success-lighten-1;
    color: $background;
}
"""

    def __init__(self, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._project_path = project_path

    def compose(self) -> ComposeResult:
        from rich.markup import escape
        with Vertical(id="tp-dialog"):
            yield Static(" ⚠  Untrusted Folder ", id="tp-title")
            with Vertical(id="tp-body"):
                yield Static(escape(self._project_path), id="tp-path")
                yield Static(
                    "Do you trust the files in this folder?\n\n"
                    "  [green]✓[/]  Read files [dim]— always allowed[/]\n"
                    "  [yellow]⚠[/]  Write and edit files [dim]— requires trust[/]\n"
                    "  [yellow]⚠[/]  Run shell commands [dim]— requires trust[/]\n\n"
                    "[dim]Trust is saved permanently. Use /untrust to revoke.[/]",
                    id="tp-info"
                )
            with Horizontal(id="tp-footer"):
                yield Button("Read-only (Esc)", id="tp-readonly")
                yield Button("Trust Folder", id="tp-trust")

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "tp-trust":
            from andromity.config import config
            config.set_trusted(self._project_path)
            self.dismiss(True)
        elif event.button.id == "tp-readonly":
            self.dismiss(False)

    def on_key(self, event):
        # ESC = read-only mode (don't block startup)
        if event.key == "escape":
            # Never let a modal's Esc bubble to the app (it cancels streaming).
            event.stop()
            self.dismiss(False)
