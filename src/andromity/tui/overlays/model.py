from textual import work
from textual.app import ComposeResult
from textual.containers import Horizontal, VerticalScroll, Vertical, Container
from textual.screen import ModalScreen
from textual.widgets import Static, Button, RadioButton, RadioSet, Input
from textual.reactive import reactive
from andromity.config import config
from andromity.core.models import MODEL_CATALOG, fetch_live_models_sync


class ModelPickerScreen(ModalScreen):
    """Two-step model picker: Provider -> Model selection with live model fetching."""
    DEFAULT_CSS = """\
ModelPickerScreen {
    align: center middle;
    background: $background 30%;
}
#mp-dialog {
    width: 90%; max-width: 72;
    height: 85%; max-height: 32; min-height: 20;
    border: solid $accent-darken-2;
    background: $surface;
    padding: 0;
}
#mp-title {
    padding: 0 1;
    height: 1;
    background: $accent-darken-3;
    color: $text;
    text-style: bold;
}
#mp-step1 { height: 1fr; padding: 1 2 0 2; }
#mp-step2 { height: 1fr; padding: 1 2 0 2; display: none; }
#mp-step2.visible { display: block; }
#mp-providers { height: 1fr; overflow-y: auto; padding: 0 1; }
#mp-models { height: 1fr; overflow-y: auto; padding: 0 1; }
#mp-key-row {
    height: 3;
    padding: 0;
    margin-bottom: 1;
    display: none;
    align: left middle;
}
#mp-key-row.visible { display: block; }
#mp-key-input { width: 1fr; height: 3; }
#mp-connect {
    height: 3;
    min-width: 12;
    margin-left: 1;
    padding: 0 2;
    border: none;
    background: $accent;
    color: $background;
    text-style: bold;
}
#mp-connect:hover, #mp-connect:focus {
    background: $accent-lighten-1;
    color: $background;
}
#mp-key-hint { height: 1; padding: 0 1; color: $warning; display: none; }
#mp-key-hint.visible { display: block; }
#mp-custom-row { height: 3; padding: 0; }
#mp-model-desc { height: 2; padding: 0 1; color: $text-muted; }
#mp-footer {
    dock: bottom;
    height: 3;
    padding: 0 1;
    background: $surface-darken-2;
    border-top: solid $surface-lighten-1;
    align: right middle;
}
#mp-footer Button {
    height: 1;
    min-width: 14;
    margin: 0 1;
    padding: 0 2;
    border: none;
}
#mp-back, #mp-cancel {
    background: $surface-lighten-1;
    color: $text-muted;
}
#mp-back:hover, #mp-back:focus,
#mp-cancel:hover, #mp-cancel:focus {
    background: $surface-lighten-2;
    color: $text;
}
#mp-apply {
    background: $accent;
    color: $background;
    text-style: bold;
}
#mp-apply:hover, #mp-apply:focus {
    background: $accent-lighten-1;
    color: $background;
}
"""

    _step: reactive[int] = reactive(1)
    _selected_provider: reactive[str] = reactive("")

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._current_models: list[dict] = []
        self._selected_model_idx: int = -1   # -1 = nothing chosen yet
        self._gen: int = 0                    # generation counter for unique IDs
        self._ready: bool = False             # guards auto-jump on mount
        self._key_just_connected: bool = False  # key saved this session — enables rejection hint

    def compose(self) -> ComposeResult:
        with Container(id="mp-dialog"):
            yield Static(" Step 1: Select Provider ", id="mp-title")
            with Vertical(id="mp-step1"):
                yield Static("[bold]Choose a provider:[/]", id="mp-providers-header")
                with VerticalScroll(id="mp-providers"):
                    with RadioSet(id="mp-providers-radioset"):
                        for key, info in MODEL_CATALOG.items():
                            env = info.get("requires_env", "")
                            label = f" {info['name']}"
                            if env:
                                label += f"  [dim]({env})[/]"
                            else:
                                label += "  [dim](local / free)[/]"
                            yield RadioButton(label, id=f"provider-{key}")
            with Vertical(id="mp-step2"):
                yield Static("", id="mp-models-header")
                with Horizontal(id="mp-key-row"):
                    yield Input(placeholder="Paste API key…", password=True, id="mp-key-input")
                    yield Button("Connect", id="mp-connect")
                yield Static("", id="mp-key-hint")
                with VerticalScroll(id="mp-models"):
                    yield RadioSet(id="mp-models-radioset")
                with Horizontal(id="mp-custom-row"):
                    yield Input(placeholder="Or type custom model name (e.g. meta/llama3-70b-instruct)", id="mp-custom-model")
                yield Static("", id="mp-model-desc", classes="mp-desc-panel")
            with Horizontal(id="mp-footer"):
                yield Button("Back", id="mp-back")
                yield Button("Cancel", id="mp-cancel")
                yield Button("Apply", id="mp-apply")

    def on_mount(self):
        self._show_step1()
        current_provider = ""
        # Highlight current provider button BUT don't trigger Changed event yet.
        # We set _ready=True only after call_after_refresh so the RadioSet.Changed
        # fired by setting .value=True below doesn't jump to Step 2.
        try:
            current_provider = config.get("default", "provider", "")
            if current_provider:
                btn = self.query_one(f"#provider-{current_provider}", RadioButton)
                btn.value = True  # This WILL fire RadioSet.Changed ...
        except Exception:
            pass
        # ... but _ready is still False here, so on_radio_set_changed ignores it.
        self.call_after_refresh(self._set_ready)
        if current_provider:
            self.call_after_refresh(lambda: self._show_step2(current_provider))

    def _set_ready(self):
        """Allow RadioSet.Changed to respond AFTER initial mount is complete."""
        self._ready = True

    def _show_step1(self):
        self._step = 1
        self._selected_model_idx = -1
        self.query_one("#mp-title").update(" Step 1: Select Provider ")
        self.query_one("#mp-step1").display = True
        self.query_one("#mp-step2").display = False
        try:
            self.query_one("#mp-back").display = False
        except Exception:
            pass

    def _show_step2(self, provider_key: str):
        self._step = 2
        self._selected_provider = provider_key
        self._selected_model_idx = -1
        provider = MODEL_CATALOG.get(provider_key, {})

        self.query_one("#mp-title").update(
            f" Step 2: Select Model — {provider.get('name', provider_key)} "
        )
        self.query_one("#mp-step1").display = False
        self.query_one("#mp-step2").display = True
        self.query_one("#mp-step2").add_class("visible")
        self.query_one("#mp-back").display = True

        # For Ollama: don't show fake catalog — wait for live fetch
        if provider_key == "ollama":
            self._populate_models([], provider_key)  # empty = show placeholder
            self.query_one("#mp-models-header").update(
                f"[bold]{provider.get('name', provider_key)} — Select a model:[/] "
                "[dim](checking Ollama...)[/]"
            )
            self._fetch_live_models_worker(provider_key)
            return

        # Cloud providers: show curated catalog immediately, fetch live in background
        models = provider.get("models", [])
        self._populate_models(models, provider_key)

        header_text = f"[bold]{provider.get('name', provider_key)} — Select a model:[/]"
        has_key = bool(config.get_api_key(provider_key))
        req_env = provider.get("requires_env")
        key_row = self.query_one("#mp-key-row", Horizontal)
        if req_env and not has_key:
            key_row.add_class("visible")
            header_text += " [yellow](API key required)[/]"
        else:
            key_row.remove_class("visible")
        self.query_one("#mp-key-hint", Static).remove_class("visible")
        if req_env and has_key:
            header_text += " [dim](fetching live models...)[/]"
        elif req_env and not has_key:
            header_text = f"[bold]{provider.get('name', provider_key)} — Select a model:[/] [yellow](API key required)[/]"
            self.query_one("#mp-models-header").update(header_text)
            self.call_after_refresh(self._focus_key_input)
            return
        self.query_one("#mp-models-header").update(header_text)

        if req_env and has_key:
            self._fetch_live_models_worker(provider_key)

    def _focus_key_input(self):
        try:
            self.query_one("#mp-key-input", Input).focus()
        except Exception:
            pass

    def _connect_key(self):
        """Save the pasted API key and kick off live model fetching."""
        try:
            key = self.query_one("#mp-key-input", Input).value.strip()
            if not key:
                self._show_key_hint("[yellow]Paste a key first — then press Connect.[/]")
                return
            provider_key = self._selected_provider
            config.set_api_key(provider_key, key)
            self._key_just_connected = True
            self.query_one("#mp-key-row", Horizontal).remove_class("visible")
            self.query_one("#mp-key-hint", Static).remove_class("visible")
            provider = MODEL_CATALOG.get(provider_key, {})
            self.query_one("#mp-models-header").update(
                f"[bold]{provider.get('name', provider_key)} — Select a model:[/] [dim](fetching live models...)[/]"
            )
            self._populate_models(provider.get("models", []), provider_key)
            self._fetch_live_models_worker(provider_key)
        except Exception:
            self._show_key_hint("[red]Could not save key — check permissions and retry.[/]")

    def _show_key_hint(self, text: str):
        hint = self.query_one("#mp-key-hint", Static)
        hint.update(text)
        hint.add_class("visible")

    # ─── Model list population ────────────────────────────────────────────────

    def _populate_models(self, models: list[dict], provider_key: str):
        """Render model RadioButtons. Uses generation counter to avoid DuplicateId."""
        self._current_models = list(models)
        self._gen += 1
        gen = self._gen

        rset = self.query_one("#mp-models-radioset", RadioSet)
        rset.remove_children()
        try:
            self.query_one("#mp-model-desc").update("")
        except Exception:
            pass

        if not models:
            # Placeholder — will be replaced when live fetch completes
            rset.mount(Static(
                "[dim]  Searching for available models…[/]",
                id=f"m-{gen}-placeholder"
            ))
            return

        current_model = config.get("default", "model", "")

        for idx, m in enumerate(models):
            label = f" {m['name']}  [dim]{m['id']}[/]"
            if m["id"] == current_model:
                label = f"[green]✓[/] {m['name']}  [dim]{m['id']}[/] [green](current)[/]"
            # NO set_timer auto-select — user must click
            rset.mount(RadioButton(label, id=f"m-{gen}-{idx}"))

    @work(thread=True)
    def _fetch_live_models_worker(self, provider_key: str):
        api_key = config.get_api_key(provider_key)
        provider = MODEL_CATALOG.get(provider_key, {})
        base_url = provider.get("base_url")
        live_models = fetch_live_models_sync(provider_key, api_key=api_key, base_url=base_url)
        # Always call back — even with empty list (so Ollama offline is shown)
        self.app.call_from_thread(self._on_live_models_received, provider_key, live_models)

    def _on_live_models_received(self, provider_key: str, live_models: list[dict]):
        if self._step != 2 or self._selected_provider != provider_key:
            return

        provider = MODEL_CATALOG.get(provider_key, {})

        if not live_models:
            # Ollama offline OR API failed — show clear error
            if provider_key == "ollama":
                rset = self.query_one("#mp-models-radioset", RadioSet)
                rset.remove_children()
                self.query_one("#mp-models-header").update(
                    "[bold]Ollama (Local)[/] [red] ⚠  Ollama is not running[/]"
                )
                self.query_one("#mp-model-desc").update(
                    "  Start Ollama with: [bold]ollama serve[/]  then reopen this picker."
                )
            else:
                just_added = self._key_just_connected
                self._key_just_connected = False
                header = f"[bold]{provider.get('name', provider_key)}[/] "
                if just_added:
                    header += "[red]— key rejected or network error. Verify the key:[/]"
                    self.query_one("#mp-key-row", Horizontal).add_class("visible")
                    inp = self.query_one("#mp-key-input", Input)
                    inp.value = ""
                    self.call_after_refresh(self._focus_key_input)
                else:
                    header += "[yellow]— live fetch failed, showing catalog[/]"
                self.query_one("#mp-models-header").update(header)
            return

        self.query_one("#mp-models-header").update(
            f"[bold]{provider.get('name', provider_key)} — Select a model:[/] "
            f"[green](Live: {len(live_models)} available)[/]"
        )
        self._populate_models(live_models, provider_key)

    # ─── Event handlers ───────────────────────────────────────────────────────

    def on_radio_set_changed(self, event: RadioSet.Changed):
        if not self._ready:
            return  # ignore events fired during mount

        if event.radio_set.id == "mp-providers-radioset":
            try:
                provider_key = event.pressed.id.replace("provider-", "")
                self._show_step2(provider_key)
            except AttributeError:
                pass

        elif event.radio_set.id == "mp-models-radioset":
            try:
                btn_id = event.pressed.id  # "m-{gen}-{idx}"
                parts = btn_id.split("-")
                idx = int(parts[-1])
                self._selected_model_idx = idx
                if idx < len(self._current_models):
                    m = self._current_models[idx]
                    desc_parts = [m.get("desc", "")]
                    if m.get("context"):
                        desc_parts.append(f"Context: {m['context']}")
                    if m.get("pricing"):
                        desc_parts.append(m["pricing"])
                    self.query_one("#mp-model-desc").update(
                        "  " + " | ".join(filter(None, desc_parts))
                    )
            except Exception:
                pass

    def _apply_selection(self):
        # Save provider
        if self._selected_provider:
            config.set("default", "provider", self._selected_provider)

        # Save model (prioritize custom text box, then radio selection)
        if self._step == 2:
            custom_input = self.query_one("#mp-custom-model", Input).value.strip()
            if custom_input:
                config.set("default", "model", custom_input)
            elif self._selected_model_idx >= 0:
                idx = self._selected_model_idx
                if idx < len(self._current_models):
                    model_id = self._current_models[idx]["id"]
                    config.set("default", "model", model_id)
            else:
                pass  # User didn't type or choose — keep whatever was already set

        # Warn if API key missing
        if self._selected_provider:
            provider_info = MODEL_CATALOG.get(self._selected_provider, {})
            api_key = config.get_api_key(self._selected_provider)
            req_env = provider_info.get("requires_env")
            if req_env and not api_key:
                try:
                    chat = self.app.query_one("ChatPanel")
                    chat.add_system_message(
                        f"\u26a0 Missing API Key: Provider [bold]{provider_info['name']}[/] has no key configured.\n"
                        f"Set it via [bold cyan]/keys set {self._selected_provider} <your_key>[/] "
                        f"or define [dim]{req_env}[/]."
                    )
                except Exception:
                    pass

        # Refresh agent with new model/provider
        app = self.app
        if hasattr(app, "_refresh_agent"):
            app._refresh_agent()

        self.dismiss()

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "mp-connect":
            event.stop()
            self._connect_key()
            return
        if event.button.id == "mp-cancel":
            self._show_step1()
            self.dismiss()
        elif event.button.id == "mp-back":
            self._show_step1()
        elif event.button.id == "mp-apply":
            self._apply_selection()

    def on_input_submitted(self, event: Input.Submitted):
        # Enter inside the key field connects without leaving the keyboard.
        if event.input.id == "mp-key-input":
            event.stop()
            self._connect_key()

    def on_key(self, event):
        if event.key == "escape":
            # Never let a modal's Esc bubble to the app (it cancels streaming).
            event.stop()
            self._show_step1()
            self.dismiss()


# Keep backward-compatible alias
ModelPickerOverlay = ModelPickerScreen
