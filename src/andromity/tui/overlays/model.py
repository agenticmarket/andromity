from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll, Vertical
from textual.widget import Widget
from textual.widgets import Static, Input, Button, RadioButton, RadioSet, Label
from textual.reactive import reactive
from andromity.config import config
from andromity.core.models import MODEL_CATALOG, get_models_for_provider


class ModelPickerOverlay(Widget):
    """Two-step model picker: Provider → Model selection."""
    DEFAULT_CSS = """\
ModelPickerOverlay {
    width: 70; height: 30;
    border: solid $accent-darken-2; background: $surface;
    layer: overlay;
    align: center middle;
}
#mp-title { padding: 0 1; height: 1; background: $accent-darken-3; color: $text; }
#mp-step1 { height: 1fr; }
#mp-step2 { height: 1fr; display: none; }
#mp-step2.visible { display: block; }
#mp-providers { height: 1fr; overflow-y: auto; padding: 0 1; }
#mp-models { height: 1fr; overflow-y: auto; padding: 0 1; }
#mp-models RadioSet { height: auto; }
#mp-footer { dock: bottom; height: 3; padding: 0 1; }
#mp-footer Button { margin: 0 1; }
.mp-model-info { color: $accent; padding: 0 0 0 2; height: 1; }
"""

    _step: reactive(int) = reactive(1)
    _selected_provider: reactive(str) = reactive("")

    def compose(self) -> ComposeResult:
        yield Static(" Step 1: Select Provider ", id="mp-title")
        with Vertical(id="mp-step1"):
            yield Static("[bold]Choose a provider:[/]", id="mp-providers-header")
            with VerticalScroll(id="mp-providers"):
                for key, info in MODEL_CATALOG.items():
                    env = info.get("requires_env", "")
                    label = f" {info['name']}"
                    if env:
                        label += f"  [dim]({env})[/]"
                    else:
                        label += "  [dim](no key needed)[/]"
                    yield RadioButton(label, id=f"provider-{key}")
        with Vertical(id="mp-step2"):
            yield Static("", id="mp-models-header")
            with VerticalScroll(id="mp-models"):
                pass
        with Horizontal(id="mp-footer"):
            yield Button("Back", variant="default", id="mp-back")
            yield Button("Cancel", variant="default", id="mp-cancel")
            yield Button("Apply", variant="primary", id="mp-apply")

    def on_mount(self):
        self._show_step1()

    def _show_step1(self):
        self._step = 1
        self._selected_provider = ""
        self.query_one("#mp-title").update(" Step 1: Select Provider ")
        self.query_one("#mp-step1").display = True
        self.query_one("#mp-step2").display = False
        self.query_one("#mp-back").display = False

    def _show_step2(self, provider_key: str):
        self._step = 2
        self._selected_provider = provider_key
        provider = MODEL_CATALOG.get(provider_key, {})
        models = provider.get("models", [])

        self.query_one("#mp-title").update(f" Step 2: Select Model - {provider['name']} ")
        self.query_one("#mp-step1").display = False
        self.query_one("#mp-step2").display = True
        self.query_one("#mp-step2").add_class("visible")
        self.query_one("#mp-back").display = True

        models_container = self.query_one("#mp-models")
        models_container.remove_children()

        self.query_one("#mp-models-header").update(f"[bold]{provider['name']} - Select a model:[/]")

        for m in models:
            models_container.mount(RadioButton(
                f" {m['name']}  [dim]{m['id']}[/]",
                id=f"model-{m['id']}"
            ))
            models_container.mount(Static(
                f"   {m['desc']}  |  Context: {m.get('context', 'N/A')}  |  {m.get('pricing', '')}",
                classes="mp-model-info"
            ))

        if provider_key == "ollama":
            self.query_one("#mp-models-header").update(
                f"[bold]{provider['name']} - Select a model:[/]  [dim](must be pulled first: ollama pull <model>)[/]"
            )

    def on_radio_set_changed(self, event: RadioSet.Changed):
        if self._step == 1:
            try:
                radio = self.query(RadioButton)[event.radio_set.pressed_index]
                provider_key = radio.id.replace("provider-", "")
                self._show_step2(provider_key)
            except (IndexError, AttributeError):
                pass

    def _apply_selection(self):
        if self._selected_provider:
            config.set("default", "provider", self._selected_provider)
        # Find selected model if on step 2
        if self._step == 2:
            for radio in self.query("#mp-models RadioButton"):
                if radio.value:
                    model_id = radio.id.replace("model-", "")
                    config.set("default", "model", model_id)
                    break
        # Refresh agent
        app = self.app
        if hasattr(app, '_refresh_agent'):
            app._refresh_agent()
        # Close
        self._show_step1()
        self.remove_class("visible")
        try:
            self.app.query_one("#input-field").focus()
        except Exception:
            pass

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "mp-cancel":
            self._show_step1()
            self.remove_class("visible")
        elif event.button.id == "mp-back":
            self._show_step1()
        elif event.button.id == "mp-apply":
            self._apply_selection()
