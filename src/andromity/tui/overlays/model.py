from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll, Vertical
from textual.widget import Widget
from textual.widgets import Static, Input, Button, RadioButton, RadioSet, Label
from andromity.config import config


class ModelPickerOverlay(Widget):
    DEFAULT_CSS = """\
ModelPickerOverlay {
    width: 50; height: 25;
    border: solid $accent-darken-2; background: $surface;
}
#model-title { padding: 0 1; height: 3; }
#model-list { height: 1fr; overflow-y: auto; padding: 0 1; }
#ollama-config { padding: 0 1; height: 3; }
#ollama-config Input { width: 1fr; }
#model-buttons { dock: bottom; height: 3; padding: 0 1; }
#model-buttons Button { margin: 0 1; }
"""

    def compose(self) -> ComposeResult:
        yield Static("[bold]Select Provider & Model[/]", id="model-title")
        with VerticalScroll(id="model-list"):
            providers = config.list_providers()
            for p in providers:
                name = p.get("name", "?")
                url = p.get("base_url", "")
                label = f" {name}"
                if url:
                    label += f"  ({url})"
                yield RadioButton(label, id=f"provider-{name}")
        with Horizontal(id="ollama-config"):
            yield Label(" Ollama URL: ")
            yield Input(
                value=config.get_provider_config("ollama").get("base_url", "http://localhost:11434")
                if config.get_provider_config("ollama") else "http://localhost:11434",
                placeholder="http://localhost:11434",
                id="ollama-url-input",
            )
            yield Button("Save URL", variant="default", id="save-url-btn")
        with Horizontal(id="model-buttons"):
            yield Input(placeholder="Model name (e.g. llama3, claude-sonnet-4-20240514)", id="model-name-input")
            yield Button("Apply", variant="primary", id="model-apply")
            yield Button("Cancel", variant="default", id="model-cancel")

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "model-cancel":
            self.remove_class("visible")
        elif event.button.id == "model-apply":
            model = self.query_one("#model-name-input").value.strip()
            if model:
                config.set("default", "model", model)
            # Refresh agent in app
            app = self.app
            if hasattr(app, '_refresh_agent'):
                app._refresh_agent()
            self.remove_class("visible")
            # Focus back to input field in app
            try:
                self.app.query_one("#input-field").focus()
            except Exception:
                pass
        elif event.button.id == "save-url-btn":
            url = self.query_one("#ollama-url-input").value.strip()
            if url:
                providers = config._config_cache.get("providers", [])
                for p in providers:
                    if p.get("name") == "ollama":
                        p["base_url"] = url
                        break
                config.save()
                self.remove_class("visible")

    def on_radio_set_changed(self, event: RadioSet.Changed):
        try:
            radio = self.query(RadioButton)[event.radio_set.pressed_index]
            provider_name = radio.id.replace("provider-", "")
            config.set("default", "provider", provider_name)
        except (IndexError, AttributeError):
            pass
