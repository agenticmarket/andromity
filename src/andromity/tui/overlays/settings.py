from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, ListView, ListItem, Label, ContentSwitcher, Input, RadioSet, RadioButton, Switch
from textual.reactive import reactive

from andromity.config import config
from andromity.core.models import MODEL_CATALOG


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
    width: 25;
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
.settings-section { margin-bottom: 1; }
.settings-label { text-style: bold; color: $accent; margin-bottom: 1; }
.settings-row { height: 3; margin-bottom: 1; }
.settings-input { width: 1fr; }
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
                    with VerticalScroll(id="pane-general", classes="settings-pane"):
                        yield Label("General Settings", classes="settings-label")
                        yield Label("Default Permission Mode:")
                        with RadioSet(id="setting-permission-mode"):
                            yield RadioButton("Safe (Requires approval for writes)", id="perm-safe")
                            yield RadioButton("Full (Auto-approve everything)", id="perm-full")
                        yield Label("\nShell:")
                        yield Input(value=config.get("default", "shell", ""), id="setting-shell", disabled=True)
                    
                    with VerticalScroll(id="pane-apikeys", classes="settings-pane"):
                        yield Label("API Keys", classes="settings-label")
                        for provider in ["anthropic", "openai", "google", "deepseek", "groq", "openrouter", "nvidia"]:
                            yield Label(provider.capitalize() + " Key:")
                            with Horizontal(classes="settings-row"):
                                current_key = config.get_api_key(provider) or ""
                                yield Input(value=current_key, password=True, placeholder=f"Enter {provider} key", id=f"key-{provider}", classes="settings-input")
                    
                    with VerticalScroll(id="pane-model", classes="settings-pane"):
                        yield Label("Model Configuration", classes="settings-label")
                        yield Label("To change the active model, use the Model Picker (Ctrl+L).")
                        yield Label("\nOllama Base URL:")
                        yield Input(placeholder="http://localhost:11434", id="setting-ollama-url")
                    
                    with VerticalScroll(id="pane-mcp", classes="settings-pane"):
                        yield Label("Model Context Protocol (MCP)", classes="settings-label")
                        yield Label("MCP integration is configured in config.toml. Settings UI coming soon.")
                    
                    with VerticalScroll(id="pane-profiles", classes="settings-pane"):
                        yield Label("Profiles", classes="settings-label")
                        yield Label("To change the active profile, use the Profile Picker (Ctrl+J).")
                    
                    with VerticalScroll(id="pane-trust", classes="settings-pane"):
                        yield Label("Trust & Security", classes="settings-label")
                        yield Label("Currently trusted projects:")
                        trusted = config.get("trusted_projects", {})
                        if trusted:
                            for key, info in trusted.items():
                                yield Label(f"• {info.get('path', 'Unknown')}")
                        else:
                            yield Label("No trusted projects found.")
                    
                    with VerticalScroll(id="pane-advanced", classes="settings-pane"):
                        yield Label("Advanced Settings", classes="settings-label")
                        with Horizontal(classes="settings-row"):
                            yield Label("Debug Mode")
                            yield Switch(id="setting-debug")
                        with Horizontal(classes="settings-row"):
                            yield Label("Dry Run Mode")
                            yield Switch(id="setting-dryrun")
            
            with Horizontal(id="settings-footer"):
                yield Button("Cancel", variant="default", id="settings-cancel")
                yield Button("Save All", variant="primary", id="settings-save")

    def on_mount(self):
        # Initialize form values from config
        perm = config.get("default", "permission_mode", "safe")
        if perm == "full":
            self.query_one("#perm-full", RadioButton).value = True
        else:
            self.query_one("#perm-safe", RadioButton).value = True

    def on_list_view_selected(self, event: ListView.Selected):
        nav_id = event.item.id
        if nav_id and nav_id.startswith("nav-"):
            pane_id = nav_id.replace("nav-", "pane-")
            self.query_one("#settings-content", ContentSwitcher).current = pane_id

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "settings-cancel":
            self.dismiss(False)
        elif event.button.id == "settings-save":
            self._save_settings()
            self.dismiss(True)

    def _save_settings(self):
        # Save permission mode
        if self.query_one("#perm-full", RadioButton).value:
            config.set("default", "permission_mode", "full")
        else:
            config.set("default", "permission_mode", "safe")
            
        # Save API keys
        for provider in ["anthropic", "openai", "google", "deepseek", "groq", "openrouter", "nvidia"]:
            val = self.query_one(f"#key-{provider}", Input).value.strip()
            if val:
                config.set_api_key(provider, val)

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(False)
