"""
Settings Screen — unified control panel for Andromity TUI.

MCP transport type detection:
  - stdio   : has 'command', no 'serverUrl'
  - sse     : command contains 'mcp-remote' or 'supergateway'
  - remote  : has 'serverUrl', no 'command'  (OAuth / token required)
  - env-auth: has 'env' dict with API key fields
"""
import asyncio
import importlib.metadata
from textual import on
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import (
    Static, Button, ListView, ListItem, Label,
    ContentSwitcher, Input, RadioSet, RadioButton, Switch,
)

from andromity.config import config, get_shell
from andromity.core.mcp import MCPClientManager, MCPStdioSession
from andromity.tui.panels.chat import ChatPanel


PROVIDERS = ["anthropic", "openai", "google", "deepseek", "groq", "openrouter", "nvidia"]

PROVIDER_LABELS = {
    "anthropic": "Anthropic (Claude)",
    "openai":    "OpenAI (GPT)",
    "google":    "Google (Gemini)",
    "deepseek":  "DeepSeek",
    "groq":      "Groq",
    "openrouter":"OpenRouter",
    "nvidia":    "NVIDIA NIM",
}

# ── MCP transport detection ──────────────────────────────────────────────────

def _mcp_transport(s_conf: dict) -> str:
    """Return one of: stdio | sse | remote | unknown"""
    cmd = s_conf.get("command", "")
    url = s_conf.get("serverUrl") or s_conf.get("url") or ""
    if url and not cmd:
        return "remote"
    if "mcp-remote" in cmd or "supergateway" in cmd or any(
        "mcp-remote" in str(a) for a in s_conf.get("args", [])
    ):
        return "sse"
    if cmd:
        return "stdio"
    return "unknown"


def _mcp_auth_env_keys(s_conf: dict) -> list[str]:
    """Return env var names that look like auth credentials."""
    auth_keywords = ("KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH", "CREDENTIALS", "PASS", "API")
    return [k for k in s_conf.get("env", {}) if any(kw in k.upper() for kw in auth_keywords)]


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
#settings-title {
    padding: 0 1; height: 1;
    background: $accent-darken-3; color: $text; text-style: bold;
}
#settings-body { height: 1fr; }
#settings-sidebar {
    width: 25; height: 1fr;
    border-right: solid $primary-darken-2;
    background: $surface-darken-1;
}
#settings-content { height: 1fr; padding: 1 2; }
#settings-footer { dock: bottom; height: 3; padding: 0 1; }
#settings-footer Button { margin: 0 1; }

/* ── Pane ── */
.settings-pane  { height: 1fr; overflow-y: auto; }
.settings-label { text-style: bold; color: $accent; margin-bottom: 1; }
.field-label    { color: $text-muted; height: 1; margin-top: 1; }
.section-hint   { color: $text-muted; margin-bottom: 1; }
.settings-input { width: 1fr; }

/* ── Advanced ── */
.adv-row   { height: 3; margin-bottom: 1; }
.adv-label { width: 1fr; content-align: left middle; }

/* ── Profile ── */
.prof-desc { color: $text-muted; padding: 0 2 1 4; }

/* ── Trust ── */
.trust-row  { height: 3; margin-bottom: 0; }
.trust-path { width: 1fr; content-align: left middle; color: $text; }
.trust-date { width: 12; content-align: right middle; color: $text-muted; }
.trust-btn  { width: 10; margin-left: 1; }

/* ── MCP Card ── */
.mcp-card {
    border: tall $surface-lighten-1;
    background: $surface-darken-1;
    margin-bottom: 1;
    padding: 0;
    height: auto;
}
.mcp-card-header {
    height: 3; padding: 0 1; background: $surface;
}
.mcp-name  { width: 1fr; text-style: bold; color: $accent; content-align: left middle; }
.mcp-badge-running  { width: auto; color: $success; content-align: right middle; margin-right: 1; }
.mcp-badge-stopped  { width: auto; color: $warning; content-align: right middle; margin-right: 1; }
.mcp-badge-error    { width: auto; color: $error; content-align: right middle; margin-right: 1; }
.mcp-badge-disabled { width: auto; color: $text-muted; content-align: right middle; margin-right: 1; }
.mcp-badge-auth     { width: auto; color: $warning-darken-1; content-align: right middle; margin-right: 1; }
.mcp-tool-count { width: auto; color: $text-muted; content-align: right middle; margin-right: 1; }
.mcp-card-body  { padding: 0 2 1 2; height: auto; }
.mcp-transport  { color: $text-muted; height: 1; }
.mcp-cmd-line   { color: $text-muted; height: 1; }
.mcp-error-line { color: $error; height: auto; }
.mcp-auth-warn  { color: $warning-darken-1; height: auto; }
.mcp-tools-head { color: $text-muted; height: 1; margin-top: 1; }
.mcp-tool-row   { height: 1; padding: 0 1; }
.mcp-tool-name  { color: $accent; width: 24; }
.mcp-tool-desc  { color: $text-muted; width: 1fr; }
.mcp-actions    { height: 3; padding: 0 1; }
.mcp-restart-btn { margin-right: 1; }
"""

    def __init__(self, mcp_manager: MCPClientManager = None,
                 project_path: str = "", **kwargs):
        super().__init__(**kwargs)
        self.mcp_manager = mcp_manager
        self.project_path = project_path
        # Pre-load MCP config synchronously at compose time
        self._mcp_servers: dict = {}
        if mcp_manager:
            try:
                self._mcp_servers = mcp_manager.load_config().get("mcpServers", {})
            except Exception:
                pass

    # ── Compose ──────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        with Vertical(id="settings-dialog"):
            yield Static(" ⚙  Andromity Settings ", id="settings-title")

            with Horizontal(id="settings-body"):
                # ── Sidebar ──────────────────────────────────────────
                with ListView(id="settings-sidebar"):
                    yield ListItem(Label("General"),         id="nav-general")
                    yield ListItem(Label("API Keys"),        id="nav-apikeys")
                    yield ListItem(Label("Model"),           id="nav-model")
                    mcp_count = len(self._mcp_servers)
                    mcp_label = f"MCP  ({mcp_count})" if mcp_count else "MCP"
                    yield ListItem(Label(mcp_label),         id="nav-mcp")
                    yield ListItem(Label("Profiles"),        id="nav-profiles")
                    yield ListItem(Label("Trust & Security"),id="nav-trust")
                    yield ListItem(Label("Advanced"),        id="nav-advanced")
                    yield ListItem(Label("About"),           id="nav-about")

                with ContentSwitcher(initial="pane-general", id="settings-content"):

                    # ── 1. General ────────────────────────────────────────────
                    with VerticalScroll(id="pane-general", classes="settings-pane"):
                        yield Label("General Settings", classes="settings-label")
                        user = config.get_user()
                        yield Label("Your Name:", classes="field-label")
                        yield Input(value=user.get("name", ""),
                                    placeholder="e.g. Chand",
                                    id="setting-user-name")
                        yield Label("Email (for login):", classes="field-label")
                        yield Input(value=user.get("email", ""),
                                    placeholder="you@example.com",
                                    id="setting-user-email")
                        yield Label("Default Permission Mode:", classes="field-label")
                        with RadioSet(id="setting-permission-mode"):
                            yield RadioButton(
                                "Safe   — ask before every write & shell", id="perm-safe")
                            yield RadioButton(
                                "Trust  — auto writes, ask shell cmds",    id="perm-trust")
                            yield RadioButton(
                                "Full   — auto-approve writes & shell",    id="perm-full")
                            yield RadioButton(
                                "Yolo   — no confirmations at all  ⚠",    id="perm-yolo")
                        yield Label("Shell (read-only):", classes="field-label")
                        yield Input(value=get_shell(), id="setting-shell", disabled=True)

                    # ── 2. API Keys ───────────────────────────────────────────
                    with VerticalScroll(id="pane-apikeys", classes="settings-pane"):
                        yield Label("API Keys", classes="settings-label")
                        yield Label(
                            "Saved to config.toml — applied immediately. "
                            "Leave blank to keep existing key.",
                            classes="section-hint")
                        for provider in PROVIDERS:
                            current_key = config.get_api_key(provider) or ""
                            status_txt = " [green]✓ Set[/]" if current_key else " [dim]Not set[/]"
                            yield Label(
                                f"{PROVIDER_LABELS[provider]}{status_txt}",
                                classes="field-label")
                            yield Input(
                                value=current_key,
                                password=True,
                                placeholder=f"Paste {provider} key…",
                                id=f"key-{provider}",
                                classes="settings-input")

                    # ── 3. Model ──────────────────────────────────────────────
                    with VerticalScroll(id="pane-model", classes="settings-pane"):
                        yield Label("Model Configuration", classes="settings-label")
                        curr_provider = config.get("default", "provider", "—")
                        curr_model    = config.get("default", "model",    "—")
                        yield Label(
                            f"Active: [bold]{curr_provider}[/] / [bold cyan]{curr_model}[/]\n"
                            "Press [bold]Ctrl+L[/] anywhere to open the live model picker.",
                            classes="section-hint")
                        yield Label("Ollama Base URL:", classes="field-label")
                        ollama_cfg = config.get_provider_config("ollama")
                        ollama_url = (ollama_cfg or {}).get(
                            "base_url", "http://localhost:11434")
                        yield Input(value=ollama_url,
                                    placeholder="http://localhost:11434",
                                    id="setting-ollama-url")
                        yield Label(
                            "[dim]Takes effect next time Ollama is selected.[/]",
                            classes="section-hint")

                    # ── 4. MCP ────────────────────────────────────────────────
                    with VerticalScroll(id="pane-mcp", classes="settings-pane"):
                        yield Label("Model Context Protocol (MCP)",
                                    classes="settings-label")
                        servers = self._mcp_servers
                        if not servers:
                            yield Label(
                                "[dim]No MCP servers configured.\n"
                                "Add servers to [bold].andromity/mcp.json[/] "
                                "in your project.[/]",
                                classes="section-hint")
                        else:
                            with Horizontal(classes="mcp-actions"):
                                yield Button("↺ Restart All", id="mcp-restart-all",
                                             variant="default",
                                             classes="mcp-restart-btn")
                            for s_name, s_conf in servers.items():
                                yield from self._compose_mcp_card(s_name, s_conf)
                        mcp_path = config.get_mcp_config_path(self.project_path)
                        yield Label(
                            f"\nConfig: [dim]{mcp_path}[/]",
                            classes="section-hint")

                    # ── 5. Profiles ───────────────────────────────────────────
                    with VerticalScroll(id="pane-profiles", classes="settings-pane"):
                        yield Label("Agent Profiles", classes="settings-label")
                        curr_profile = config.get("default", "profile", "builder")
                        yield Label(
                            f"Active: [bold green]{curr_profile}[/]  "
                            "·  [dim]Ctrl+J for quick picker[/]",
                            classes="section-hint")
                        from andromity.tui.overlays.profile import PROFILES
                        with RadioSet(id="setting-profiles"):
                            for key, info in PROFILES.items():
                                yield RadioButton(
                                    f"{info['name']}  [dim]({key})[/]",
                                    id=f"prof-{key}")
                        for key, info in PROFILES.items():
                            yield Label(f"   [dim]{info['desc']}[/]",
                                        classes="prof-desc")

                    # ── 6. Trust & Security ───────────────────────────────────
                    with VerticalScroll(id="pane-trust", classes="settings-pane"):
                        yield Label("Trust & Security", classes="settings-label")
                        trusted = config._config_cache.get("trusted_projects", {})
                        if trusted:
                            yield Label(
                                f"[dim]{len(trusted)} trusted folder(s).[/]  "
                                "Click Revoke to remove trust.",
                                classes="section-hint")
                            for t_key, info in trusted.items():
                                path       = info.get("path", "Unknown")
                                trusted_at = info.get("trusted_at", "")[:10]
                                with Horizontal(classes="trust-row"):
                                    yield Label(
                                        f"[green]✓[/]  {path}",
                                        classes="trust-path")
                                    yield Label(trusted_at,
                                                classes="trust-date")
                                    yield Button("Revoke", variant="error",
                                                 id=f"revoke-{t_key}",
                                                 classes="trust-btn")
                        else:
                            yield Label("[dim]No trusted projects yet.[/]",
                                        classes="section-hint")
                        yield Label(
                            "\n[dim]Use [bold]/trust[/] and [bold]/untrust[/] "
                            "commands to manage trust from chat.[/]",
                            classes="section-hint")

                    # ── 7. Advanced ───────────────────────────────────────────
                    with VerticalScroll(id="pane-advanced", classes="settings-pane"):
                        yield Label("Advanced", classes="settings-label")
                        yield Label(
                            "Session toggles — not persisted across restarts.",
                            classes="section-hint")
                        with Horizontal(classes="adv-row"):
                            yield Label(
                                "Debug Mode  [dim](logs tool calls inline)[/]",
                                classes="adv-label")
                            yield Switch(id="setting-debug")
                        with Horizontal(classes="adv-row"):
                            yield Label(
                                "Dry Run Mode  [dim](simulate tools, no real writes)[/]",
                                classes="adv-label")
                            yield Switch(id="setting-dryrun")

                    # ── 8. About ──────────────────────────────────────────────
                    with VerticalScroll(id="pane-about", classes="settings-pane"):
                        yield Label("About Andromity", classes="settings-label")
                        version = "Unknown"
                        try:
                            version = importlib.metadata.version("andromity")
                        except Exception:
                            pass
                        yield Label(f"Version:     [bold]{version}[/]")
                        yield Label(
                            "GitHub:      [bold cyan]"
                            "https://github.com/agenticmarket/andromity[/]")
                        yield Label(
                            "Website:     [cyan]https://agenticmarket.dev[/]")
                        yield Label(
                            f"\nConfig file: [dim]{config.config_path}[/]")
                        mcp_path = config.get_mcp_config_path(self.project_path)
                        yield Label(f"MCP config:  [dim]{mcp_path}[/]")
                        yield Label("\n[dim]© 2026 Agentic Market[/]")

            with Horizontal(id="settings-footer"):
                yield Button("Cancel",   variant="default", id="settings-cancel")
                yield Button("Save All", variant="primary",  id="settings-save")

    # ── MCP card composer ─────────────────────────────────────────────────────

    def _compose_mcp_card(self, s_name: str, s_conf: dict):
        """Yield all widgets for a single MCP server card."""
        disabled    = s_conf.get("disabled", False)
        transport   = _mcp_transport(s_conf)
        is_running  = (not disabled and s_name in (self.mcp_manager.sessions if self.mcp_manager else {}))
        status_info = (self.mcp_manager.server_status.get(s_name, {}) if self.mcp_manager else {})
        error_msg   = status_info.get("error") if not is_running and not disabled else None
        auth_keys   = _mcp_auth_env_keys(s_conf)
        server_url  = s_conf.get("serverUrl") or s_conf.get("url") or ""

        # Status badge
        if disabled:
            badge_txt = "◌ disabled"
            badge_cls = "mcp-badge-disabled"
        elif is_running:
            badge_txt = "● running"
            badge_cls = "mcp-badge-running"
        elif error_msg:
            badge_txt = "✕ error"
            badge_cls = "mcp-badge-error"
        elif transport == "remote" and not is_running:
            badge_txt = "⚠ auth required"
            badge_cls = "mcp-badge-auth"
        else:
            badge_txt = "○ stopped"
            badge_cls = "mcp-badge-stopped"

        # Tool count
        tools: list = []
        if is_running and self.mcp_manager:
            sess = self.mcp_manager.sessions.get(s_name)
            if sess:
                tools = sess.tools

        with Vertical(classes="mcp-card"):
            # Header row
            with Horizontal(classes="mcp-card-header"):
                yield Label(f" {s_name}", classes="mcp-name")
                yield Label(badge_txt, classes=badge_cls)
                yield Label(
                    f"{len(tools)} tool{'s' if len(tools) != 1 else ''}",
                    classes="mcp-tool-count")
                # Only show toggle for stdio/sse — remote needs browser OAuth
                if transport in ("stdio", "sse"):
                    yield Switch(value=not disabled, id=f"mcp-toggle-{s_name}")
                else:
                    # Remote — show info icon instead of toggle
                    yield Label("[dim]OAuth[/]")

            # Body
            with Vertical(classes="mcp-card-body"):
                # Transport + command line
                transport_label = {
                    "stdio":   "stdio",
                    "sse":     "SSE proxy",
                    "remote":  "remote HTTP",
                    "unknown": "unknown",
                }[transport]
                yield Label(f"[dim]Transport:[/] {transport_label}",
                            classes="mcp-transport")

                if server_url:
                    short_url = server_url[:70] + "…" if len(server_url) > 70 else server_url
                    yield Label(f"[dim]URL:[/] {short_url}",
                                classes="mcp-cmd-line")
                elif s_conf.get("command"):
                    cmd_str = (f"{s_conf['command']} "
                               f"{' '.join(str(a) for a in s_conf.get('args', []))}").strip()
                    cmd_str = cmd_str[:70] + "…" if len(cmd_str) > 70 else cmd_str
                    yield Label(f"[dim]Command:[/] {cmd_str}",
                                classes="mcp-cmd-line")

                # Description from config
                desc = s_conf.get("description", "").strip()
                if desc:
                    short_desc = desc[:100].replace("\n", " ")
                    yield Label(f"[dim]{short_desc}[/]", classes="mcp-cmd-line")

                # Auth guidance
                if transport == "remote":
                    yield Label(
                        "⚠  This server uses OAuth. Run [bold cyan]mcp-remote[/] "
                        "or connect via browser to authenticate.",
                        classes="mcp-auth-warn")
                elif auth_keys:
                    missing = [k for k in auth_keys
                               if not s_conf.get("env", {}).get(k)]
                    if missing:
                        yield Label(
                            f"⚠  Requires env vars: [bold]{', '.join(missing)}[/]",
                            classes="mcp-auth-warn")
                    else:
                        yield Label(
                            f"[green]✓[/] Credentials set: {', '.join(auth_keys)}",
                            classes="mcp-transport")

                # Error message
                if error_msg:
                    short_err = error_msg[:120]
                    yield Label(f"✕  {short_err}", classes="mcp-error-line")

                # Tool list when running
                if tools:
                    yield Label(
                        f"  Tools ({len(tools)}):", classes="mcp-tools-head")
                    for tool in tools:
                        with Horizontal(classes="mcp-tool-row"):
                            yield Label(
                                f"  {tool.name}", classes="mcp-tool-name")
                            desc_short = (tool.description or "")[:60].replace("\n", " ")
                            yield Label(
                                f"[dim]{desc_short}[/]",
                                classes="mcp-tool-desc")

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def on_mount(self):
        # Permission mode
        perm = config.get("default", "permission_mode", "safe")
        perm_ids = {"safe": "#perm-safe", "trust": "#perm-trust",
                    "full": "#perm-full",  "yolo":  "#perm-yolo"}
        try:
            self.query_one(perm_ids.get(perm, "#perm-safe"), RadioButton).value = True
        except Exception:
            pass

        # Profile
        curr_profile = config.get("default", "profile", "builder")
        try:
            self.query_one(f"#prof-{curr_profile}", RadioButton).value = True
        except Exception:
            pass

        # Debug / dry-run from live app state
        try:
            app = self.app
            self.query_one("#setting-debug",  Switch).value = getattr(app, "_debug_mode", False)
            self.query_one("#setting-dryrun", Switch).value = getattr(app.agent, "dry_run", False)
        except Exception:
            pass

    # ── Navigation ────────────────────────────────────────────────────────────

    def on_list_view_selected(self, event: ListView.Selected):
        nav_id = event.item.id
        if nav_id and nav_id.startswith("nav-"):
            pane_id = nav_id.replace("nav-", "pane-")
            try:
                self.query_one("#settings-content", ContentSwitcher).current = pane_id
            except Exception:
                pass

    # ── MCP toggle (live start/stop) ──────────────────────────────────────────

    @on(Switch.Changed)
    async def _on_switch_changed(self, event: Switch.Changed):
        sw_id = event.switch.id or ""
        if not sw_id.startswith("mcp-toggle-"):
            return
        server_name = sw_id.replace("mcp-toggle-", "")
        enable = event.value

        # Persist to mcp.json
        config.set_mcp_server_disabled(self.project_path, server_name, not enable)

        if not self.mcp_manager:
            return

        if enable:
            # Don't re-start if already running
            if server_name in self.mcp_manager.sessions:
                return
            mcp_conf = self.mcp_manager.load_config()
            srv_conf = mcp_conf.get("mcpServers", {}).get(server_name, {})
            command  = srv_conf.get("command")
            args     = srv_conf.get("args", [])
            env      = srv_conf.get("env", {})
            if command:
                session = MCPStdioSession(
                    name=server_name, command=command, args=args, env=env,
                    cwd=self.mcp_manager.project_path)
                success = await session.start()
                if success:
                    self.mcp_manager.sessions[server_name] = session
                    self.mcp_manager.server_status[server_name] = {
                        "status": "running",
                        "tools":  len(session.tools),
                        "error":  None,
                        "command": f"{command} {' '.join(str(a) for a in args)}".strip(),
                    }
                else:
                    self.mcp_manager.server_status[server_name] = {
                        "status": "error",
                        "tools":  0,
                        "error":  session.error or "Failed to connect",
                        "command": f"{command} {' '.join(str(a) for a in args)}".strip(),
                    }
        else:
            if server_name in self.mcp_manager.sessions:
                await self.mcp_manager.sessions[server_name].stop()
                del self.mcp_manager.sessions[server_name]
            self.mcp_manager.server_status.pop(server_name, None)

    # ── Button handlers ───────────────────────────────────────────────────────

    @on(Button.Pressed)
    async def _on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id or ""

        if btn_id == "settings-cancel":
            self.dismiss(False)

        elif btn_id == "settings-save":
            self._save_settings()
            self.dismiss(True)

        elif btn_id == "mcp-restart-all":
            if self.mcp_manager:
                await self.mcp_manager.stop_all()
                await self.mcp_manager.start_all()
                try:
                    self.app.query_one(ChatPanel).add_system_message(
                        "[green]✓ All MCP servers restarted.[/]")
                except Exception:
                    pass

        elif btn_id.startswith("revoke-"):
            t_key = btn_id.replace("revoke-", "")
            trusted = config._config_cache.get("trusted_projects", {})
            if t_key in trusted:
                path = trusted[t_key].get("path", "")
                config.revoke_trust(path)
                # Hide the parent row immediately without refresh
                try:
                    event.button.parent.display = False
                except Exception:
                    pass

    # ── Save ──────────────────────────────────────────────────────────────────

    def _save_settings(self):
        # 1. User name/email
        try:
            name  = self.query_one("#setting-user-name",  Input).value.strip()
            email = self.query_one("#setting-user-email", Input).value.strip()
            config.set_user(name, email)
        except Exception:
            pass

        # 2. Permission mode
        perm_map = {"perm-safe": "safe", "perm-trust": "trust",
                    "perm-full": "full", "perm-yolo":  "yolo"}
        try:
            rs = self.query_one("#setting-permission-mode", RadioSet)
            if rs.pressed_button:
                new_mode = perm_map.get(rs.pressed_button.id, "safe")
                if new_mode == "yolo":
                    # Yolo is session-only — set live flag, don't persist
                    self.app._yolo_session = True
                else:
                    self.app._yolo_session = False
                    config.set("default", "permission_mode", new_mode)
        except Exception:
            pass

        # 3. API keys — only save non-empty
        for provider in PROVIDERS:
            try:
                val = self.query_one(f"#key-{provider}", Input).value.strip()
                if val:
                    config.set_api_key(provider, val)
            except Exception:
                pass

        # 4. Ollama URL
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

        # 5. Debug / dry-run
        try:
            app = self.app
            app._debug_mode  = self.query_one("#setting-debug",  Switch).value
            app.agent.dry_run = self.query_one("#setting-dryrun", Switch).value
        except Exception:
            pass

        # 6. Profile
        try:
            prof_rs = self.query_one("#setting-profiles", RadioSet)
            if prof_rs.pressed_button and prof_rs.pressed_button.id:
                prof_id = prof_rs.pressed_button.id.replace("prof-", "")
                config.set("default", "profile", prof_id)
                if hasattr(self.app, "_apply_profile"):
                    self.app._apply_profile(prof_id)
        except Exception:
            pass

    def on_key(self, event):
        if event.key == "escape":
            self.dismiss(False)
