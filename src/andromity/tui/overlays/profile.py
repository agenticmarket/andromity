from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, RadioButton, RadioSet
from textual.reactive import reactive


PROFILES = {
    "builder": {
        "name": "Builder",
        "desc": "Full access — read, write, edit files. Default for coding tasks.",
        "tools": "read_file, write_file, edit_file, edit_file_multi, list_dir, shell_exec",
    },
    "coder": {
        "name": "Fast Coder",
        "desc": "Quick code edits — read, write, edit files. No planning.",
        "tools": "read_file, write_file, edit_file, edit_file_multi, list_dir, shell_exec",
    },
    "reviewer": {
        "name": "Reviewer",
        "desc": "Read-only — reviews codebase professionally, suggests changes, no file modifications.",
        "tools": "read_file, list_dir",
    },
    "planner": {
        "name": "Planner",
        "desc": "Planning only — analyzes codebase like a human planner, creates task plans, no edits.",
        "tools": "read_file, list_dir",
    },
}


class ProfilePickerOverlay(ModalScreen):
    """Profile picker overlay."""
    DEFAULT_CSS = """\
ProfilePickerOverlay {
    align: center middle;
    background: $background 30%;
}
#pp-dialog {
    width: 90%; max-width: 62;
    height: auto; max-height: 28;
    border: solid $accent-darken-2;
    background: $surface;
    padding: 0;
}
#pp-title {
    padding: 0 1;
    height: 1;
    background: $accent-darken-3;
    color: $text;
    text-style: bold;
}
#pp-body {
    height: auto;
    padding: 1 2;
}
#pp-radioset {
    height: auto;
    border: none;
    background: transparent;
    padding: 0;
}
#pp-desc {
    height: auto;
    padding: 1 0;
    margin-top: 1;
    border-top: solid $surface-lighten-1;
    color: $text-muted;
}
#pp-hint {
    height: 1;
    padding: 0;
    margin-top: 1;
    margin-bottom: 1;
    color: $text-muted;
}
#pp-footer {
    height: 3;
    padding: 0 1;
    background: $surface-darken-2;
    border-top: solid $surface-lighten-1;
    align: right middle;
}
#pp-footer Button {
    height: 1;
    min-width: 14;
    margin: 0 1;
    padding: 0 2;
    border: none;
}
#pp-cancel {
    background: $surface-lighten-1;
    color: $text-muted;
}
#pp-cancel:hover, #pp-cancel:focus {
    background: $surface-lighten-2;
    color: $text;
}
#pp-apply {
    background: $accent;
    color: $background;
    text-style: bold;
}
#pp-apply:hover, #pp-apply:focus {
    background: $accent-lighten-1;
    color: $background;
}
"""

    _selected: reactive[str] = reactive("")

    def compose(self) -> ComposeResult:
        with Vertical(id="pp-dialog"):
            yield Static(" Select Profile ", id="pp-title")
            with Vertical(id="pp-body"):
                with RadioSet(id="pp-radioset"):
                    for key, info in PROFILES.items():
                        yield RadioButton(f" {info['name']}  [dim]({key})[/]", id=f"profile-{key}")
                yield Static("", id="pp-desc")
                yield Static("[dim]Profile controls which tools the agent can use.[/]", id="pp-hint")
            with Horizontal(id="pp-footer"):
                yield Button("Cancel", id="pp-cancel")
                yield Button("Apply", id="pp-apply")

    def on_mount(self):
        try:
            self._selected = self.app.agent.profile
            self.query_one(f"#profile-{self._selected}", RadioButton).value = True
            self._update_desc(self._selected)
        except Exception:
            self._selected = ""

    def _update_desc(self, key: str):
        info = PROFILES.get(key, {})
        if info:
            try:
                self.query_one("#pp-desc").update(
                    f"  [bold]{info['name']}:[/] {info['desc']}\n\n"
                    f"  Tools: [dim]{info['tools']}[/]"
                )
            except Exception:
                pass

    def on_radio_set_changed(self, event: RadioSet.Changed):
        try:
            self._selected = event.pressed.id.replace("profile-", "")
            self._update_desc(self._selected)
        except AttributeError:
            pass

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "pp-cancel":
            self.dismiss()
        elif event.button.id == "pp-apply":
            if self._selected:
                app = self.app
                if hasattr(app, '_apply_profile'):
                    app._apply_profile(self._selected)
            self.dismiss()
            try:
                self.app.query_one("#input-field").focus()
            except Exception:
                pass

    def on_key(self, event):
        if event.key == "escape":
            # Never let a modal's Esc bubble to the app (it cancels streaming).
            event.stop()
            self.dismiss()

