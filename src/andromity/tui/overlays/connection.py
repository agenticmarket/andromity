"""Compact custom-provider editor shared with the core connection contract."""
import asyncio

from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Collapsible, Input, Label, Static

from andromity.config import config


class ProviderConnectionScreen(ModalScreen):
    DEFAULT_CSS = """
ProviderConnectionScreen { align: center middle; }
#connection-dialog { width: 64; max-width: 95%; height: auto; max-height: 90%; padding: 1 2; border: solid $accent; background: $surface; }
#connection-dialog Input { margin-bottom: 1; }
#connection-actions { height: 3; align-horizontal: right; }
#connection-status { height: auto; margin-top: 1; }
"""

    def __init__(self, provider: str = ""):
        super().__init__()
        self.provider = provider
        self.saved = config.get_provider_config(provider) or {}

    def compose(self) -> ComposeResult:
        with VerticalScroll(id="connection-dialog"):
            yield Label("Edit connection" if self.provider else "Add custom provider")
            yield Label("Connection ID")
            yield Input(value=self.provider, placeholder="local-models", id="connection-id", disabled=bool(self.provider))
            yield Label("Display name")
            yield Input(value=self.saved.get("display_name", ""), placeholder="Local models", id="connection-name")
            yield Label("Base URL")
            yield Input(value=self.saved.get("base_url", ""), placeholder="http://localhost:1234/v1", id="connection-url")
            yield Static("Use the API root, for example https://your-provider/v1. Pasted /chat/completions endpoints are converted automatically.")
            yield Label("API key (optional; blank keeps the saved key)")
            yield Input(password=True, id="connection-key")
            yield Label("Model ID")
            yield Input(value=self.saved.get("model", ""), placeholder="provider/model-name", id="connection-model")
            with Collapsible(title="Advanced", collapsed=True):
                yield Label("LiteLLM provider type")
                yield Input(value=self.saved.get("type", "openai"), id="connection-type")
                yield Label("API version (optional)")
                yield Input(value=self.saved.get("api_version", ""), id="connection-version")
                yield Static("OpenAI-compatible is the default. Other adapters can use the runtime's standard environment credentials.")
            yield Static("", id="connection-status")
            with Horizontal(id="connection-actions"):
                yield Button("Cancel", id="connection-cancel")
                yield Button("Save & test", id="connection-test")
                yield Button("Save", id="connection-save", variant="primary")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "connection-cancel":
            self.dismiss(False)
            return
        if event.button.id not in ("connection-save", "connection-test"):
            return
        values = {key: self.query_one(selector, Input).value.strip() for key, selector in {
            "id": "#connection-id", "display_name": "#connection-name", "base_url": "#connection-url",
            "model": "#connection-model", "type": "#connection-type", "api_version": "#connection-version",
        }.items()}
        key = self.query_one("#connection-key", Input).value.strip()
        if key:
            values["api_key"] = key
        try:
            self.provider = config.save_provider(values)
        except ValueError as exc:
            self.query_one("#connection-status", Static).update(str(exc))
            return
        self.query_one("#connection-key", Input).value = ""
        if event.button.id == "connection-save":
            self.dismiss(True)
        else:
            self.run_worker(self._test(), exclusive=True, group="connection-test")

    async def _test(self) -> None:
        from andromity.core.connections import test_connection
        self.query_one("#connection-status", Static).update("Testing connection…")
        try:
            result = await asyncio.wait_for(test_connection(self.provider), 30)
            self.query_one("#connection-status", Static).update(result["message"])
        except asyncio.TimeoutError:
            self.query_one("#connection-status", Static).update("Connection timed out. Check the endpoint.")
        except Exception:
            self.query_one("#connection-status", Static).update("Connection failed. Check the model, endpoint, and provider type.")
