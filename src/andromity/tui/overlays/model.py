from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.content import Content
from textual.containers import Horizontal, Vertical, Container
from textual.screen import ModalScreen
from textual.widgets import Static, Button, OptionList, Input
from textual.widgets.option_list import Option
from textual.reactive import reactive
from andromity.tui.overlays.dialog import dialog_styles
from andromity.config import config
from andromity.core.models import provider_catalog, fetch_live_models_sync, get_cached_live_models


class ModelList(OptionList):
    BINDINGS = [Binding("space", "select", "Select", show=False)]


class ModelPickerScreen(ModalScreen):
    """Two-step model picker: Provider -> Model selection with live model fetching."""
    DEFAULT_CSS = """\
ModelPickerScreen {
    align: center middle;
    background: $background 30%;
}
#mp-dialog {
    width: 90%; max-width: 80;
    height: auto; max-height: 90%; min-height: 14;
    border: solid $surface-lighten-2;
    background: $surface;
    padding: 0;
}
#mp-title {
    padding: 0 1;
    height: 1;
    background: $surface-lighten-1;
    color: $text;
    text-style: bold;
}
#mp-step1 { height: auto; padding: 1 2 0 2; }
#mp-step2 { height: auto; padding: 1 2 0 2; display: none; }
#mp-step2.visible { display: block; }
#mp-providers-header, #mp-models-header { height: auto; margin-bottom: 1; }
#mp-providers, #mp-models {
    height: auto; max-height: 14; min-height: 1;
    border: none;
    padding: 0;
    background: transparent;
    color: $text;
    overflow-x: hidden;
}
#mp-providers:focus, #mp-models:focus { border: none; background-tint: transparent; }
#mp-providers > .option-list--option, #mp-models > .option-list--option { padding: 0 1; }
#mp-providers > .option-list--option-highlighted,
#mp-models > .option-list--option-highlighted { background: $surface-lighten-1; color: $text; }
#mp-providers:focus > .option-list--option-highlighted,
#mp-models:focus > .option-list--option-highlighted {
    background: $primary 25%;
    color: $text;
    text-style: bold;
}
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
#mp-key-hint { height: auto; max-height: 2; padding: 0 1; color: $text-warning; display: none; }
#mp-key-hint.visible { display: block; }
#mp-custom-row { height: 3; padding: 0; margin-top: 1; }
#mp-custom-model { width: 1fr; height: 3; }
#mp-custom-model > .input--placeholder { color: $text-muted; }
#mp-model-desc { height: 2; padding: 0 1; color: $text-muted; }
#mp-footer {
    height: 4;
    padding: 1;
    background: $surface;
    border-top: solid $surface-lighten-1;
    align: right middle;
}
#mp-footer Button {
    height: 1;
    width: auto; min-width: 10;
    margin: 0 0 0 1;
    padding: 0 2;
    border: none;
}
#mp-back, #mp-cancel {
    background: $surface-lighten-1;
    color: $text;
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
ModelPickerScreen.compact #mp-step1, ModelPickerScreen.compact #mp-step2 { padding: 0 1; }
ModelPickerScreen.compact #mp-providers-header,
ModelPickerScreen.compact #mp-models-header { margin-bottom: 0; }
ModelPickerScreen.compact #mp-custom-row { margin-top: 0; }
ModelPickerScreen.compact #mp-model-desc { height: 1; }
ModelPickerScreen.compact #mp-footer { height: 3; padding: 0 1; }
""" + dialog_styles(
        "mp-dialog", "mp-title", "mp-footer",
        primary=("mp-apply",),
    )

    _step: reactive[int] = reactive(1)
    _selected_provider: reactive[str] = reactive("")

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._provider_keys: list[str] = []
        self._current_models: list[dict] = []
        self._selected_model_idx: int = -1   # -1 = nothing chosen yet
        self._ready: bool = False             # guards auto-jump on mount
        self._key_just_connected: bool = False  # key saved this session — enables rejection hint

    def compose(self) -> ComposeResult:
        with Container(id="mp-dialog"):
            yield Static(" Step 1: Select Provider ", id="mp-title")
            with Vertical(id="mp-step1"):
                yield Static("[bold]Choose a provider:[/]", id="mp-providers-header")
                providers = provider_catalog()
                self._provider_keys = list(providers)
                yield ModelList(*(
                    Option(Content.assemble(
                        (info["name"], "bold"), "  ",
                        (info.get("requires_env") or "local / free", "dim"),
                    ), id=f"provider-{key}")
                    for key, info in providers.items()
                ), id="mp-providers")
            with Vertical(id="mp-step2"):
                yield Static("", id="mp-models-header")
                with Horizontal(id="mp-key-row"):
                    yield Input(placeholder="Paste API key…", password=True, id="mp-key-input")
                    yield Button("Connect", id="mp-connect")
                yield Static("", id="mp-key-hint")
                yield ModelList(id="mp-models")
                with Horizontal(id="mp-custom-row"):
                    yield Input(placeholder="Or enter a custom model ID", id="mp-custom-model")
                yield Static("", id="mp-model-desc", classes="mp-desc-panel")
            with Horizontal(id="mp-footer"):
                yield Button("Back", id="mp-back")
                yield Button("Cancel", id="mp-cancel")
                yield Button("Apply", id="mp-apply")

    def on_mount(self):
        self._show_step1()
        current_provider = ""
        try:
            current_provider = config.get("default", "provider", "")
            if current_provider in self._provider_keys:
                self.query_one("#mp-providers", OptionList).highlighted = self._provider_keys.index(current_provider)
        except Exception:
            pass
        self.call_after_refresh(self._set_ready)
        if current_provider:
            self.call_after_refresh(lambda: self._show_step2(current_provider))

    def _set_ready(self) -> None:
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
        self._resize_lists()
        self.query_one("#mp-providers", OptionList).focus()

    def _show_step2(self, provider_key: str):
        self._step = 2
        self._selected_provider = provider_key
        self._selected_model_idx = -1
        provider = provider_catalog().get(provider_key, {})

        self.query_one("#mp-title").update(
            f" Step 2: Select Model — {provider.get('name', provider_key)} "
        )
        self.query_one("#mp-step1").display = False
        self.query_one("#mp-step2").display = True
        self.query_one("#mp-step2").add_class("visible")
        self.query_one("#mp-back").display = True
        self.query_one("#mp-key-row").remove_class("visible")
        self.query_one("#mp-key-hint").remove_class("visible")
        self._resize_lists()

        # For Ollama: don't show fake catalog — wait for live fetch
        if provider_key == "ollama":
            self._populate_models([], provider_key)  # empty = show placeholder
            self.query_one("#mp-models-header").update(
                "[bold]Choose a model[/] · Checking local connection…"
            )
            self.query_one("#mp-models", OptionList).focus()
            self._fetch_live_models_worker(provider_key)
            return

        # Cloud providers: show curated catalog immediately, fetch live in background
        models = get_cached_live_models(provider_key) or provider.get("models", [])
        self._populate_models(models, provider_key)

        header_text = "[bold]Choose a model[/]"
        has_key = bool(config.get_api_key(provider_key))
        req_env = provider.get("requires_env")
        key_row = self.query_one("#mp-key-row", Horizontal)
        if req_env and not has_key:
            key_row.add_class("visible")
        else:
            key_row.remove_class("visible")
        self._resize_lists()
        self.query_one("#mp-key-hint", Static).remove_class("visible")
        if req_env and has_key:
            header_text += " [dim](fetching live models...)[/]"
        elif req_env and not has_key:
            header_text = "[bold]Choose a model[/] [$text-warning]· API key required[/]"
            self.query_one("#mp-models-header").update(header_text)
            self.call_after_refresh(self._focus_key_input)
            return
        self.query_one("#mp-models-header").update(header_text)
        self._resize_lists()
        self.query_one("#mp-models", OptionList).focus()

        if has_key or provider.get("base_url"):
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
                self._show_key_hint("[$text-warning]Paste a key first — then press Connect.[/]")
                return
            provider_key = self._selected_provider
            config.set_api_key(provider_key, key)
            self._key_just_connected = True
            self.query_one("#mp-key-row", Horizontal).remove_class("visible")
            self.query_one("#mp-key-hint", Static).remove_class("visible")
            self._resize_lists()
            provider = provider_catalog().get(provider_key, {})
            self.query_one("#mp-models-header").update(
                "[bold]Choose a model[/] · Loading live models…"
            )
            self._populate_models(provider.get("models", []), provider_key)
            self.query_one("#mp-models", OptionList).focus()
            self._fetch_live_models_worker(provider_key)
        except Exception:
            self._show_key_hint("[$text-error]Could not save key — check permissions and retry.[/]")

    def _show_key_hint(self, text: str):
        hint = self.query_one("#mp-key-hint", Static)
        hint.update(text)
        hint.add_class("visible")
        self._resize_lists()

    # ─── Model list population ────────────────────────────────────────────────

    def _populate_models(self, models: list[dict], provider_key: str):
        """Replace the model list while keeping an explicit selection by ID."""
        selected_id = (
            self._current_models[self._selected_model_idx]["id"]
            if 0 <= self._selected_model_idx < len(self._current_models) else None
        )
        self._current_models = list(models)
        self._selected_model_idx = next((
            i for i, model in enumerate(models) if model["id"] == selected_id
        ), -1)
        model_list = self.query_one("#mp-models", OptionList)
        model_list.clear_options()
        try:
            self.query_one("#mp-model-desc").update("")
        except Exception:
            pass

        if not models:
            model_list.add_option(Option("Searching for available models…", disabled=True))
            self._resize_lists()
            return

        current_model = config.get("default", "model", "")
        model_list.add_options(Option("", id=f"model-{idx}") for idx in range(len(models)))
        self._format_model_rows()
        model_list.highlighted = (
            self._selected_model_idx if self._selected_model_idx >= 0 else
            next((i for i, model in enumerate(models) if model["id"] == current_model), 0)
        )
        self._resize_lists()
        self.call_after_refresh(self._format_model_rows)

    def _format_model_rows(self) -> None:
        model_list = self.query_one("#mp-models", OptionList)
        width = max(12, model_list.scrollable_content_region.width - 2)
        name_width = min(24, max(8, width // 2 - 2))
        current_model = config.get("default", "model", "")
        for idx, model in enumerate(self._current_models):
            marker = "✓ " if model["id"] == current_model else ("› " if idx == self._selected_model_idx else "  ")
            free_label = "  Free" if model.get("is_free") or model["id"].lower().endswith(":free") else ""
            name = Content(str(model["name"])).truncate(name_width, ellipsis=True, pad=True)
            model_id = Content(str(model["id"])).truncate(max(1, width - name_width - 4 - len(free_label)), ellipsis=True)
            model_list.replace_option_prompt_at_index(idx, Content.assemble(
                (marker, "bold"), name, "  ", (model_id.plain, "dim"),
                (free_label, "$text-success"),
            ))

    def _resize_lists(self) -> None:
        if not self.is_mounted:
            return
        compact = self.size.height < 26
        self.set_class(compact, "compact")
        height = int(self.size.height * 0.9)
        self.query_one("#mp-providers").styles.max_height = max(1, min(14, height - (7 if compact else 10)))
        key_rows = 4 if self.query_one("#mp-key-row").has_class("visible") else 0
        hint_rows = 2 if self.query_one("#mp-key-hint").has_class("visible") else 0
        width = max(1, min(80, int(self.size.width * 0.9)) - 6)
        header = self.query_one("#mp-models-header", Static)
        header_rows = max(1, header.get_content_height(self.size, self.size, width))
        overhead = 10 if compact else 15
        self.query_one("#mp-models").styles.max_height = max(1, min(14, height - overhead - header_rows - key_rows - hint_rows))

    def on_resize(self) -> None:
        self._resize_lists()
        if self._current_models:
            self.call_after_refresh(self._format_model_rows)

    @work(thread=True)
    def _fetch_live_models_worker(self, provider_key: str):
        api_key = config.get_api_key(provider_key)
        provider = provider_catalog().get(provider_key, {})
        base_url = provider.get("base_url")
        live_models = fetch_live_models_sync(provider_key, api_key=api_key, base_url=base_url)
        # Always call back — even with empty list (so Ollama offline is shown)
        self.app.call_from_thread(self._on_live_models_received, provider_key, live_models)

    def _on_live_models_received(self, provider_key: str, live_models: list[dict]):
        if self._step != 2 or self._selected_provider != provider_key:
            return

        provider = provider_catalog().get(provider_key, {})

        if not live_models:
            # Ollama offline OR API failed — show clear error
            if provider_key == "ollama":
                self.query_one("#mp-models", OptionList).clear_options()
                self.query_one("#mp-models-header").update(
                    "[bold]Ollama (Local)[/] [$text-error]Ollama is not running[/]"
                )
                self.query_one("#mp-model-desc").update(
                    "  Start Ollama with: [bold]ollama serve[/]  then reopen this picker."
                )
            else:
                just_added = self._key_just_connected
                self._key_just_connected = False
                header = f"[bold]{provider.get('name', provider_key)}[/] "
                if just_added:
                    header += "[$text-error]— key rejected or network error. Verify the key:[/]"
                    self.query_one("#mp-key-row", Horizontal).add_class("visible")
                    self._resize_lists()
                    inp = self.query_one("#mp-key-input", Input)
                    inp.value = ""
                    self.call_after_refresh(self._focus_key_input)
                else:
                    header += "[$text-warning]— live fetch failed, showing catalog[/]"
                self.query_one("#mp-models-header").update(header)
            return

        self.query_one("#mp-models-header").update(
            "[bold]Choose a model[/] "
            f"[$text-success]· {len(live_models)} live model{'' if len(live_models) == 1 else 's'}[/]"
        )
        self._populate_models(live_models, provider_key)

    # ─── Event handlers ───────────────────────────────────────────────────────

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if not self._ready:
            return
        event.stop()
        if event.option_list.id == "mp-providers":
            self._show_step2(self._provider_keys[event.option_index])
        elif event.option_list.id == "mp-models" and event.option_index < len(self._current_models):
            self._selected_model_idx = event.option_index
            self._format_model_rows()
            self._update_model_description(event.option_index)

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        if event.option_list.id == "mp-models" and event.option_index < len(self._current_models):
            self._update_model_description(event.option_index)

    def _update_model_description(self, idx: int) -> None:
        model = self._current_models[idx]
        parts = [str(model["id"])]
        if model.get("desc"):
            parts.append(str(model["desc"]))
        if model.get("context"):
            parts.append(f"Context: {model['context']}")
        if model.get("pricing"):
            parts.append(str(model["pricing"]))
        self.query_one("#mp-model-desc", Static).update(Content(" · ".join(parts)))

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
            provider_info = provider_catalog().get(self._selected_provider, {})
            api_key = config.get_api_key(self._selected_provider)
            req_env = provider_info.get("requires_env")
            if req_env and not api_key:
                try:
                    chat = self.app.query_one("ChatPanel")
                    chat.add_system_message(
                        f"\u26a0 Missing API Key: Provider [bold]{provider_info['name']}[/] has no key configured.\n"
                        f"Set it via [bold]/keys set {self._selected_provider} <your_key>[/] "
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
