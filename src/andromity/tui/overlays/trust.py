from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import Static, Button


class TrustPromptOverlay(Widget):
    """Shown on startup when a project folder has not been trusted yet."""
    DEFAULT_CSS = """\
TrustPromptOverlay {
    width: 62; height: 20;
    border: solid $warning; background: $surface;
    layer: overlay;
    align: center middle;
}
#tp-title { padding: 0 1; height: 1; background: $warning-darken-2; color: $text; text-style: bold; }
#tp-body { height: 1fr; padding: 1 2; }
#tp-path { color: $accent; padding: 0 0 1 0; text-style: bold; }
#tp-info { color: $text-muted; height: auto; }
#tp-footer { dock: bottom; height: 3; padding: 0 1; }
#tp-footer Button { margin: 0 1; }
"""

    def __init__(self, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._project_path = project_path

    def compose(self) -> ComposeResult:
        yield Static(" \u26a0  Untrusted Folder ", id="tp-title")
        with Vertical(id="tp-body"):
            yield Static(self._project_path, id="tp-path")
            yield Static(
                "Do you trust the files in this folder?\n\n"
                "  [green]\u2713[/] Read files — always allowed\n"
                "  [yellow]\u26a0[/] Write and edit files [dim](requires trust)[/]\n"
                "  [yellow]\u26a0[/] Run shell commands [dim](requires trust)[/]\n\n"
                "[dim]Trust is saved permanently. Use /untrust to revoke.[/]",
                id="tp-info"
            )
        with Horizontal(id="tp-footer"):
            yield Button("Read-only Mode", variant="default", id="tp-readonly")
            yield Button("Trust Folder", variant="primary", id="tp-trust")

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "tp-trust":
            from andromity.config import config
            config.set_trusted(self._project_path)
            self._dismiss(trusted=True)
        elif event.button.id == "tp-readonly":
            self._dismiss(trusted=False)

    def _dismiss(self, trusted: bool):
        self.remove_class("visible")
        try:
            self.app._on_trust_resolved(trusted)
        except Exception:
            pass
