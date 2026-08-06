from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widget import Widget
from textual.widgets import Static, Button, RadioButton, RadioSet
from textual.reactive import reactive


PROFILES = {
    "builder": {
        "name": "Builder",
        "desc": "Full access — read, write, edit files. Default for coding tasks.",
        "tools": "read_file, write_file, edit_file, list_dir, shell_exec",
    },
    "reviewer": {
        "name": "Reviewer",
        "desc": "Read-only — reviews code, suggests changes, no file modifications.",
        "tools": "read_file, list_dir",
    },
    "planner": {
        "name": "Planner",
        "desc": "Planning only — analyzes codebase, creates task plans, no edits.",
        "tools": "read_file, list_dir",
    },
}


class ProfilePickerOverlay(Widget):
    """Profile picker overlay."""
    DEFAULT_CSS = """\
ProfilePickerOverlay {
    width: 62; height: 22;
    border: solid $accent-darken-2; background: $surface;
    layer: overlay;
    align: center middle;
}
#pp-title { padding: 0 1; height: 1; background: $accent-darken-3; color: $text; text-style: bold; }
#pp-list { height: 1fr; overflow-y: auto; padding: 0 1; }
#pp-desc { height: 4; padding: 0 2; color: $text-muted; }
#pp-hint { height: 1; padding: 0 1; }
#pp-footer { dock: bottom; height: 3; padding: 0 1; }
#pp-footer Button { margin: 0 1; }
"""

    _selected: reactive[str] = reactive("")

    def compose(self) -> ComposeResult:
        yield Static(" Select Profile ", id="pp-title")
        with Vertical(id="pp-body"):
            with RadioSet(id="pp-radioset"):
                for key, info in PROFILES.items():
                    yield RadioButton(f" {info['name']}  [dim]({key})[/]", id=f"profile-{key}")
            yield Static("", id="pp-desc")
            yield Static("[dim]Profile controls which tools the agent can use.[/]", id="pp-hint")
        with Horizontal(id="pp-footer"):
            yield Button("Cancel", variant="default", id="pp-cancel")
            yield Button("Apply", variant="primary", id="pp-apply")

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
            self.remove_class("visible")
        elif event.button.id == "pp-apply":
            if self._selected:
                app = self.app
                if hasattr(app, '_apply_profile'):
                    app._apply_profile(self._selected)
            self.remove_class("visible")
            try:
                self.app.query_one("#input-field").focus()
            except Exception:
                pass

