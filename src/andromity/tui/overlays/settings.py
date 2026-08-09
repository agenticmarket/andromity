from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, ListView, ListItem, Label, ContentSwitcher, Input, RadioSet, RadioButton, Switch

from andromity.config import config, get_shell


PROVIDERS = ["anthropic", "openai", "google", "deepseek", "groq", "openrouter", "nvidia"]

PROVIDER_LABELS = {
    "anthropic": "Anthropic (Claude)",
    "openai": "OpenAI (GPT)",
    "google": "Google (Gemini)",
    "deepseek": "DeepSeek",
    "groq": "Groq",
    "openrouter": "OpenRouter",
    "nvidia": "NVIDIA NIM",
}


class SettingsScreen(ModalScreen):
    """Unified settings screen for the Andromity TUI."""

    DEFAULT_CSS = """\
SettingsScreen {
    align: center middle;
    background: $background 20%;
}
#settings-dialog {
    width: 90%; height: 90%;
    border: solid $accent-darken-2; background: $surface;
    padding: 0;
}
#settings-title { padding: 0 1; height: 1; background: $accent-darken-3; color: $text; text-style: bold; }
#settings-body { height: 1fr; }
#settings-sidebar {
    width: 26;
    height: 1fr;
    border-right: solid $primary-darken-2;
}
#settings-content {
    height: 1fr;
    padding: 1 2;
}
#settings-footer { dock: bottom; height: 3; padding: 0 1; }
#settings-footer Button { margin: 0 1; }

.settings-pane { height: 1fr; overflow-y: auto; }
.settings-label { text-style: bold; color: $accent; margin-bottom: 1; }
.settings-row { height: auto; margin-bottom: 1; }
.key-row { height: 3; margin-bottom: 1; }
.settings-input { width: 1fr; }
.field-label { color: $text-muted; height: 1; margin-top: 1; }
.trust-entry { color: $text; padding: 0 0 1 0; }
.section-hint { color: $text-muted; margin-bottom: 1; }
.adv-row { height: 3; margin-bottom: 1; }
.adv-label { width: 1fr; content-align: left middle; }
"""

    def compose(self) -> ComposeResult:
        with Vertical(id="settings-dialog"):
            yield Static(" ⚙  Andromity Settings ", id="settings-title")

            with Horizontal(id="settings-body"):
                with ListView(id="settings-sidebar"):
                    yield ListItem(Label("General"), id="nav-general")
                    yield ListItem(Label("API Keys"), id="nav-apikeys")
                    yield ListItem(Label("Model"), id="nav-model")
                    yield ListItem(Label("MCP"), id="nav-mcp")
                    yield ListItem(Label("Profiles"), id="nav-profiles")
                    yield ListItem(Label("Trust & Security"), id="nav-trust")
                    yield ListItem(Label("Advanced"), id="nav-advanced")

                with ContentSwitcher(initial="pane-general", id="settings-content"):

                    # ── General ──────────────────────────────────────────────
                    with VerticalScroll(id="pane-general", classes="settings-pane"):
                        yield Label("General Settings", classes="settings-label")
                        yield Label("Default Permission Mode:", classes="field-label")
                        with RadioSet(id="setting-permission-mode"):
                            yield RadioButton("Safe  (ask before writes & shell)", id="perm-safe")
                            yield RadioButton("Trust (auto-approve writes, ask shell)", id="perm-trust")
                            yield RadioButton("Full  (auto-approve everything)", id="perm-full")
                        yield Label("Shell (system, read-only):", classes="field-label")
                        yield Input(value=get_shell(), id="setting-shell", disabled=True)

                    # ── API Keys ─────────────────────────────────────────────
                    with VerticalScroll(id="pane-apikeys", classes="settings-pane"):
                        yield Label("API Keys", classes="settings-label")
                        yield Label(
                            "Keys are stored in config.toml and applied immediately on save.",
                            classes="section-hint"
                        )
                        for provider in PROVIDERS:
                            current_key = config.get_api_key(provider) or ""
                            status = " ✓" if current_key else " (not set)"
                            status_color = "green" if current_key else "dim"
                            yield Label(
                                f"{PROVIDER_LABELS[provider]}  [{status_color}]{status}[/]",
                                classes="field-label"
                            )
                            yield Input(
                                value=current_key,
                                password=True,
                                placeholder=f"Paste {provider} API key here...",
                                id=f"key-{provider}",
                                classes="settings-input"
                            )

                    # ── Model ────────────────────────────────────────────────
                    with VerticalScroll(id="pane-model", classes="settings-pane"):
                        yield Label("Model Configuration", classes="settings-label")
                        curr_provider = config.get("default", "provider", "—")
                        curr_model = config.get("default", "model", "—")
                        yield Label(
                            f"Active: [bold]{curr_provider}[/] / [bold]{curr_model}[/]\n"
                            "Use [bold cyan]Ctrl+L[/] to open the live model picker.",
                            classes="section-hint"
                        )
                        yield Label("Ollama Base URL:", classes="field-label")
                        ollama_cfg = config.get_provider_config("ollama")
                        ollama_url = (ollama_cfg or {}).get("base_url", "http://localhost:11434")
                        yield Input(
                            value=ollama_url,
                            placeholder="http://localhost:11434",
                            id="setting-ollama-url"
                        )
                        yield Label(
                            "[dim]Change takes effect next time you select the Ollama provider.[/]",
                            classes="section-hint"
                        )

                    # ── MCP ──────────────────────────────────────────────────
                    with VerticalScroll(id="pane-mcp", classes="settings-pane"):
                        yield Label("Model Context Protocol (MCP)", classes="settings-label")
                        yield Label(
                            "Use [bold cyan]/mcp[/] in chat to check status.\n"
                            "Configure MCP servers directly in [dim]config.toml[/] (MCP UI editor coming soon).",
                            classes="section-hint"
                        )

                    # ── Profiles ─────────────────────────────────────────────
                    with VerticalScroll(id="pane-profiles", classes="settings-pane"):
                        yield Label("Profiles", classes="settings-label")
                        curr_profile = config.get("default", "profile", "builder")
                        yield Label(
                            f"Active profile: [bold]{curr_profile}[/]\n"
                            "Use [bold cyan]Ctrl+J[/] to open the quick profile picker.",
                            classes="section-hint"
                        )
                        yield Label("\nAvailable profiles:", classes="field-label")
                        from andromity.tui.overlays.profile import PROFILES
                        for key, info in PROFILES.items():
                            marker = "[bold green]▶[/] " if key == curr_profile else "   "
                            yield Label(f"{marker}[bold]{info['name']}[/] ({key})")
                            yield Label(f"   [dim]{info['desc']}[/]")

                    # ── Trust & Security ─────────────────────────────────────
                    with VerticalScroll(id="pane-trust", classes="settings-pane"):
                        yield Label("Trust & Security", classes="settings-label")
                        yield Label("Trusted project folders:", classes="field-label")
                        trusted = config._config_cache.get("trusted_projects", {})
                        if trusted:
                            for _key, info in trusted.items():
                                path = info.get("path", "Unknown")
                                trusted_at = info.get("trusted_at", "")[:10]
                                yield Label(f"  [green]✓[/] {path}  [dim](since {trusted_at})[/]", classes="trust-entry")
                        else:
                            yield Label("  [dim]No trusted projects yet.[/]", classes="trust-entry")
                        yield Label(
                            "\nUse [bold cyan]/trust[/] and [bold cyan]/untrust[/] commands to manage trust.",
                            classes="section-hint"
                        )

                    # ── Advanced ─────────────────────────────────────────────
                    with VerticalScroll(id="pane-advanced", classes="settings-pane"):
                        yield Label("Advanced Settings", classes="settings-label")
                        yield Label("These are live session toggles — they don't persist across restarts.", classes="section-hint")
                        with Horizontal(classes="adv-row"):
                            yield Label("Debug Mode  [dim](shows tool calls inline)[/]", classes="adv-label")
                            yield Switch(id="setting-debug")
                        with Horizontal(classes="adv-row"):
                            yield Label("Dry Run Mode  [dim](simulates tools, no real writes)[/]", classes="adv-label")
                            yield Switch(id="setting-dryrun")

            with Horizontal(id="settings-footer"):
                yield Button("Cancel", variant="default", id="settings-cancel")
                yield Button("Save", variant="primary", id="settings-save")

    def on_mount(self):
        """Load live values into form fields."""
        # Permission mode
        perm = config.get("default", "permission_mode", "safe")
        mapping = {"safe": "#perm-safe", "trust": "#perm-trust", "full": "#perm-full"}
        target_id = mapping.get(perm, "#perm-safe")
        try:
            self.query_one(target_id, RadioButton).value = True
        except Exception:
            pass

        # Debug / dry-run — read from live app if possible
        try:
            app = self.app
            self.query_one("#setting-debug", Switch).value = getattr(app, "_debug_mode", False)
            self.query_one("#setting-dryrun", Switch).value = getattr(app.agent, "dry_run", False)
        except Exception:
            pass

    def on_list_view_selected(self, event: ListView.Selected):
        nav_id = event.item.id
        if nav_id and nav_id.startswith("nav-"):
            pane_id = nav_id.replace("nav-", "pane-")
            try:
                self.query_one("#settings-content", ContentSwitcher).current = pane_id
            except Exception:
                pass

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "settings-cancel":
            self.dismiss(False)
        elif event.button.id == "settings-save":
            self._save_settings()
            self.dismiss(True)

    def _save_settings(self):
        # 1. Permission mode
        perm_map = {"perm-safe": "safe", "perm-trust": "trust", "perm-full": "full"}
        try:
            rs = self.query_one("#setting-permission-mode", RadioSet)
            if rs.pressed_button:
                config.set("default", "permission_mode", perm_map.get(rs.pressed_button.id, "safe"))
        except Exception:
            pass

        # 2. API keys — only save non-empty values
        for provider in PROVIDERS:
            try:
                val = self.query_one(f"#key-{provider}", Input).value.strip()
                if val:
                    config.set_api_key(provider, val)
            except Exception:
                pass

        # 3. Ollama base URL
        try:
            url = self.query_one("#setting-ollama-url", Input).value.strip()
            if url:
                providers = config._config_cache.get("providers", [])
                updated = False
                for p in providers:
                    if p.get("name") == "ollama":
                        p["base_url"] = url
                        updated = True
                        break
                if not updated:
                    providers.append({"name": "ollama", "type": "ollama", "base_url": url})
                    config._config_cache["providers"] = providers
                config.save()
        except Exception:
            pass

        # 4. Debug / dry-run — apply to live app
        try:
            app = self.app
            app._debug_mode = self.query_one("#setting-debug", Switch).value
            app.agent.dry_run = self.query_one("#setting-dryrun", Switch).value
        except Exception:
            pass

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(False)
