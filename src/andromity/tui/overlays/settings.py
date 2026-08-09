import asyncio
import importlib.metadata
from typing import Any
from textual import on
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, ListView, ListItem, Label, ContentSwitcher, Input, RadioSet, RadioButton, Switch

from andromity.config import config, get_shell
from andromity.core.mcp import MCPClientManager
from andromity.tui.panels.chat import ChatPanel


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

/* MCP Items */
.mcp-item { height: 4; border-left: tall $primary; margin-bottom: 1; padding: 0 1; background: $surface-darken-1; }
.mcp-title { text-style: bold; color: $accent; width: 1fr; }
.mcp-status { width: auto; color: $text-muted; margin-right: 2; }
.mcp-tools { width: auto; color: $text-muted; margin-right: 2; }
"""

    def __init__(self, mcp_manager: MCPClientManager = None, project_path: str = "", **kwargs):
        super().__init__(**kwargs)
        self.mcp_manager = mcp_manager
        self.project_path = project_path

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
                    yield ListItem(Label("About"), id="nav-about")

                with ContentSwitcher(initial="pane-general", id="settings-content"):

                    # ── General ──────────────────────────────────────────────
                    with VerticalScroll(id="pane-general", classes="settings-pane"):
                        yield Label("General Settings", classes="settings-label")
                        
                        user = config.get_user()
                        yield Label("Name:", classes="field-label")
                        yield Input(value=user.get("name", ""), placeholder="Your Name", id="setting-user-name")
                        yield Label("Email:", classes="field-label")
                        yield Input(value=user.get("email", ""), placeholder="your@email.com", id="setting-user-email")
                        
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
                        
                        if self.mcp_manager:
                            mcp_conf = self.mcp_manager.load_config()
                            servers = mcp_conf.get("mcpServers", {})
                            if servers:
                                yield Button("Restart All Servers", id="mcp-restart-all", variant="default")
                                yield Label("") # spacing
                                for s_name, s_conf in servers.items():
                                    with Vertical(classes="mcp-item"):
                                        with Horizontal():
                                            yield Label(f" {s_name}", classes="mcp-title")
                                            disabled = s_conf.get("disabled", False)
                                            is_running = not disabled and s_name in self.mcp_manager.sessions
                                            status = "running" if is_running else ("disabled" if disabled else "stopped")
                                            tools_count = 0
                                            if is_running:
                                                session = self.mcp_manager.sessions[s_name]
                                                tools_count = len(session.tools)
                                            yield Label(f"{status}", classes="mcp-status")
                                            yield Label(f"{tools_count} tools", classes="mcp-tools")
                                            yield Switch(value=not disabled, id=f"mcp-toggle-{s_name}")
                                        yield Label(f"  [dim]{s_conf.get('command', '')} {' '.join(s_conf.get('args', []))}[/dim]")
                            else:
                                yield Label("[dim]No MCP servers configured yet.[/]")
                        yield Label(
                            "\nConfigure MCP servers directly in [dim]config.toml[/] or [dim].andromity/mcp.json[/]",
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
                        with RadioSet(id="setting-profiles"):
                            for key, info in PROFILES.items():
                                rb = RadioButton(f"{info['name']} ({key})", id=f"prof-{key}")
                                if key == curr_profile:
                                    rb.value = True
                                yield rb
                                yield Label(f"   [dim]{info['desc']}[/]\n")

                    # ── Trust & Security ─────────────────────────────────────
                    with VerticalScroll(id="pane-trust", classes="settings-pane"):
                        yield Label("Trust & Security", classes="settings-label")
                        yield Label("Trusted project folders:", classes="field-label")
                        trusted = config._config_cache.get("trusted_projects", {})
                        if trusted:
                            for t_key, info in trusted.items():
                                path = info.get("path", "Unknown")
                                trusted_at = info.get("trusted_at", "")[:10]
                                with Horizontal():
                                    yield Label(f"  [green]✓[/] {path}  [dim](since {trusted_at})[/]", classes="trust-entry")
                                    yield Button("Revoke", variant="error", id=f"revoke-{t_key}")
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

                    # ── About ────────────────────────────────────────────────
                    with VerticalScroll(id="pane-about", classes="settings-pane"):
                        yield Label("About Andromity", classes="settings-label")
                        
                        version = "Unknown"
                        try:
                            version = importlib.metadata.version("andromity")
                        except Exception:
                            pass
                            
                        yield Label(f"Version: [bold]{version}[/]")
                        yield Label("GitHub:  [bold cyan]https://github.com/agenticmarket/andromity[/]")
                        
                        cfg_path = config.config_path
                        yield Label(f"\nConfig file: [dim]{cfg_path}[/]")
                        mcp_path = config.get_mcp_config_path(self.project_path)
                        yield Label(f"MCP config:  [dim]{mcp_path}[/]")
                        
                        yield Label("\n© 2026 Agentic Market")

            with Horizontal(id="settings-footer"):
                yield Button("Cancel", variant="default", id="settings-cancel")
                yield Button("Save All", variant="primary", id="settings-save")

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

    @on(Switch.Changed)
    async def _on_switch_changed(self, event: Switch.Changed):
        # Handle MCP toggles immediately
        if event.switch.id and event.switch.id.startswith("mcp-toggle-"):
            server_name = event.switch.id.replace("mcp-toggle-", "")
            enable = event.value
            config.set_mcp_server_disabled(self.project_path, server_name, not enable)
            
            if self.mcp_manager:
                if enable:
                    if server_name not in self.mcp_manager.sessions:
                        # Re-load config to get command/args
                        mcp_conf = self.mcp_manager.load_config()
                        srv_conf = mcp_conf.get("mcpServers", {}).get(server_name)
                        if srv_conf:
                            from andromity.core.mcp import MCPStdioSession
                            command = srv_conf.get("command")
                            args = srv_conf.get("args", [])
                            env = srv_conf.get("env", {})
                            if command:
                                session = MCPStdioSession(name=server_name, command=command, args=args, env=env, cwd=self.mcp_manager.project_path)
                                success = await session.start()
                                if success:
                                    self.mcp_manager.sessions[server_name] = session
                else:
                    if server_name in self.mcp_manager.sessions:
                        await self.mcp_manager.sessions[server_name].stop()
                        del self.mcp_manager.sessions[server_name]

    @on(Button.Pressed)
    async def _on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id
        if not btn_id:
            return
            
        if btn_id == "settings-cancel":
            self.dismiss(False)
        elif btn_id == "settings-save":
            self._save_settings()
            self.dismiss(True)
        elif btn_id == "mcp-restart-all":
            if self.mcp_manager:
                await self.mcp_manager.stop_all()
                await self.mcp_manager.start_all()
                self.app.query_one(ChatPanel).add_system_message("[green]✓ All active MCP servers restarted.[/]")
        elif btn_id.startswith("revoke-"):
            t_key = btn_id.replace("revoke-", "")
            trusted = config._config_cache.get("trusted_projects", {})
            if t_key in trusted:
                path = trusted[t_key].get("path", "")
                config.revoke_trust(path)
                # Hide row by hiding parent Horizontal
                event.button.parent.display = False

    def _save_settings(self):
        # 1. User
        try:
            name = self.query_one("#setting-user-name", Input).value.strip()
            email = self.query_one("#setting-user-email", Input).value.strip()
            config.set_user(name, email)
        except Exception:
            pass

        # 2. Permission mode
        perm_map = {"perm-safe": "safe", "perm-trust": "trust", "perm-full": "full"}
        try:
            rs = self.query_one("#setting-permission-mode", RadioSet)
            if rs.pressed_button:
                config.set("default", "permission_mode", perm_map.get(rs.pressed_button.id, "safe"))
        except Exception:
            pass

        # 3. API keys — only save non-empty values
        for provider in PROVIDERS:
            try:
                val = self.query_one(f"#key-{provider}", Input).value.strip()
                if val:
                    config.set_api_key(provider, val)
            except Exception:
                pass

        # 4. Ollama base URL
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

        # 5. Debug / dry-run — apply to live app
        try:
            app = self.app
            app._debug_mode = self.query_one("#setting-debug", Switch).value
            app.agent.dry_run = self.query_one("#setting-dryrun", Switch).value
        except Exception:
            pass

        # 6. Profile
        try:
            prof_rs = self.query_one("#setting-profiles", RadioSet)
            if prof_rs.pressed_button and prof_rs.pressed_button.id:
                prof_id = prof_rs.pressed_button.id.replace("prof-", "")
                if hasattr(self.app, '_apply_profile'):
                    self.app._apply_profile(prof_id)
        except Exception:
            pass

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(False)
