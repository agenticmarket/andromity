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
    border: tall $surface-lighten-2;
    background: $surface-darken-1;
    margin-bottom: 1;
    padding: 0;
    height: auto;
}
.mcp-card-header { height: 3; padding: 0 1; background: $surface; }
.mcp-name  { width: 1fr; text-style: bold; color: $accent; content-align: left middle; }
.mcp-badge-running  { width: auto; color: $success;           content-align: right middle; margin-right: 1; }
.mcp-badge-stopped  { width: auto; color: $warning;           content-align: right middle; margin-right: 1; }
.mcp-badge-error    { width: auto; color: $error;             content-align: right middle; margin-right: 1; }
.mcp-badge-disabled { width: auto; color: $text-muted;        content-align: right middle; margin-right: 1; }
.mcp-badge-auth     { width: auto; color: $warning-darken-1;  content-align: right middle; margin-right: 1; }
.mcp-tool-count     { width: auto; color: $text-muted;        content-align: right middle; margin-right: 1; }
.mcp-card-body  { padding: 0 2 1 2; height: auto; }
.mcp-transport  { color: $text-muted; height: 1; }
.mcp-cmd-line   { color: $text-muted; height: 1; }
.mcp-error-line { color: $error;      height: auto; }
.mcp-tools-head { color: $text-muted; height: 1; margin-top: 1; text-style: bold; }
.mcp-tool-row   { height: 1; padding-left: 2; }
.mcp-tool-name  { color: $accent; width: 22; }
.mcp-tool-desc  { color: $text-muted; width: 1fr; }
.mcp-actions    { height: 3; padding: 0 1; }
.mcp-restart-btn { margin-right: 1; }
/* Auth section inside card */
.mcp-auth-section   { padding: 0 2 1 2; height: auto; }
.mcp-auth-label     { color: $warning; height: 1; text-style: bold; margin-bottom: 1; }
.mcp-token-row      { height: 3; }
.mcp-token-hint     { color: $text-muted; height: auto; margin-bottom: 1; }
.mcp-url-btn        { width: auto; min-width: 8; margin-left: 1; }
/* Card footer */
.mcp-card-footer    { height: 3; padding: 0 1; border-top: solid $surface-lighten-1; }
.mcp-install-date   { width: 1fr; color: $text-muted; content-align: left middle; }
.mcp-remove-btn     { width: 12; }
.mcp-connect-btn    { width: 10; margin-left: 1; }
.mcp-auth-btn       { width: auto; margin-right: 1; }
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
        # Check if already converted to mcp-remote (has command after previous save)
        already_converted = bool(s_conf.get("command")) and transport in ("stdio", "sse")

        # ─── Status badge ────────────────────────────────────────────────
        if disabled:
            badge_txt, badge_cls = "◌ disabled",     "mcp-badge-disabled"
        elif is_running:
            badge_txt, badge_cls = "● running",      "mcp-badge-running"
        elif error_msg:
            badge_txt, badge_cls = "✕ error",        "mcp-badge-error"
        elif transport == "remote" and not already_converted:
            badge_txt, badge_cls = "⚠ needs token",  "mcp-badge-auth"
        else:
            badge_txt, badge_cls = "○ stopped",      "mcp-badge-stopped"

        # ─── Tool list ───────────────────────────────────────────────────
        tools: list = []
        if is_running and self.mcp_manager:
            sess = self.mcp_manager.sessions.get(s_name)
            if sess:
                tools = sess.tools

        transport_label = {
            "stdio":   "stdio (local process)",
            "sse":     "SSE proxy (mcp-remote)",
            "remote":  "remote HTTP",
            "unknown": "unknown",
        }[transport]

        with Vertical(classes="mcp-card", id=f"card-{s_name}"):
            # ── Header ───────────────────────────────────────────────────
            with Horizontal(classes="mcp-card-header"):
                yield Label(f" {s_name}", classes="mcp-name")
                yield Label(badge_txt, classes=badge_cls)
                yield Label(
                    f"{len(tools)} tool{'s' if len(tools) != 1 else ''}",
                    classes="mcp-tool-count")
                # Toggle only for startable servers
                if transport in ("stdio", "sse") or already_converted:
                    yield Switch(value=not disabled, id=f"mcp-toggle-{s_name}")
                else:
                    yield Label("[dim]—[/]")

            # ── Body ─────────────────────────────────────────────────────
            with Vertical(classes="mcp-card-body"):
                yield Label(f"[dim]Transport:[/] {transport_label}",
                            classes="mcp-transport")

                # Command display
                if s_conf.get("command"):
                    cmd_str = (f"{s_conf['command']} "
                               f"{' '.join(str(a) for a in s_conf.get('args', []))}").strip()
                    cmd_str = cmd_str[:80] + "…" if len(cmd_str) > 80 else cmd_str
                    yield Label(f"[dim]Command:[/] {cmd_str}", classes="mcp-cmd-line")

                # URL display — as clickable button + truncated label
                if server_url and not already_converted:
                    short = server_url[:60] + "…" if len(server_url) > 60 else server_url
                    with Horizontal(classes="mcp-transport"):
                        yield Label(f"[dim]URL:[/] {short}", classes="mcp-cmd-line")
                        yield Button("🔗 Open",
                                     id=f"mcp-openurl-{s_name}",
                                     classes="mcp-url-btn")

                # Description (1 line max)
                desc = s_conf.get("description", "").strip()
                if desc:
                    yield Label(f"[dim]{desc[:90].replace(chr(10), ' ')}[/]",
                                classes="mcp-cmd-line")

                # ── Auth sections ────────────────────────────────────────────
                # CASE 1 — remote HTTP (serverUrl only, not yet converted to mcp-remote)
                if transport == "remote" and not already_converted:
                    with Vertical(classes="mcp-auth-section"):
                        yield Label("⚠  Auth Required — paste Personal Access Token:",
                                    classes="mcp-auth-label")
                        with Horizontal(classes="mcp-token-row"):
                            yield Input(
                                placeholder=f"{s_name} access token…",
                                password=True,
                                id=f"mcp-token-{s_name}")
                            yield Button("Connect", variant="primary",
                                         id=f"mcp-connect-{s_name}",
                                         classes="mcp-connect-btn")

                # CASE 2 — SSE proxy already running — show nothing extra
                # CASE 2b — SSE proxy stopped — offer browser auth
                elif transport == "sse" and not is_running:
                    with Horizontal(classes="mcp-auth-section"):
                        yield Label("⚠  Browser OAuth needed.",
                                    classes="mcp-auth-label")
                        yield Button("Open Auth in Browser", variant="warning",
                                     id=f"mcp-browser-auth-{s_name}",
                                     classes="mcp-auth-btn")

                # CASE 3 — stdio with missing env var credentials
                elif auth_keys:
                    env_block = s_conf.get("env", {})
                    missing = [k for k in auth_keys if not env_block.get(k)]
                    if missing:
                        with Vertical(classes="mcp-auth-section"):
                            yield Label("⚠  Missing credentials:",
                                        classes="mcp-auth-label")
                            for env_key in missing:
                                with Horizontal(classes="mcp-token-row"):
                                    yield Label(f"[dim]{env_key}[/]",
                                                classes="mcp-cmd-line")
                                    yield Input(
                                        placeholder=f"Value…",
                                        password=True,
                                        id=f"mcp-env-{s_name}--{env_key}")
                                    yield Button("Save", variant="primary",
                                                 id=f"mcp-saveenv-{s_name}--{env_key}")
                    else:
                        yield Label(
                            f"[green]✓[/] Credentials set: {', '.join(auth_keys)}",
                            classes="mcp-transport")

                # ── Error ─────────────────────────────────────────────────
                if error_msg:
                    yield Label(f"✕  {error_msg[:110]}", classes="mcp-error-line")

                # ── Tool list ──────────────────────────────────────────────
                if tools:
                    yield Label(f"Tools ({len(tools)}):", classes="mcp-tools-head")
                    for tool in tools:
                        with Horizontal(classes="mcp-tool-row"):
                            yield Label(tool.name, classes="mcp-tool-name")
                            desc_short = (tool.description or "")[:55].replace("\n", " ")
                            yield Label(f"[dim]{desc_short}[/]",
                                        classes="mcp-tool-desc")

            # ── Card footer ──────────────────────────────────────────────
            with Horizontal(classes="mcp-card-footer"):
                installed = s_conf.get("installedAt", "")
                yield Label(
                    f"[dim]{installed}[/]" if installed else "",
                    classes="mcp-install-date")
                yield Button("✕ Remove", variant="error",
                             id=f"mcp-remove-{s_name}",
                             classes="mcp-remove-btn")



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

    # ── MCP toggle (live start/stop) ─────────────────────────────────────

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
                self.app.notify("Restarting all MCP servers…",
                                severity="information")
                async def _restart():
                    await self.mcp_manager.stop_all()
                    await self.mcp_manager.start_all()
                    n = len(self.mcp_manager.sessions)
                    self.app.notify(
                        f"MCP restart done: {n} server(s) active.",
                        severity="information")
                    try:
                        from andromity.tui.panels.chat import ChatPanel
                        self.app.query_one(ChatPanel).add_system_message(
                            f"[green]✓ MCP restarted — {n} server(s) running.[/]")
                    except Exception:
                        pass
                self.run_worker(_restart(), exclusive=True)

        elif btn_id.startswith("mcp-connect-"):
            # Remote HTTP: user pasted a PAT token → convert to mcp-remote
            s_name = btn_id.replace("mcp-connect-", "")
            try:
                token = self.query_one(f"#mcp-token-{s_name}", Input).value.strip()
                if not token:
                    self.app.notify("Please paste a token first.", severity="warning")
                    return
                ok = config.convert_remote_to_mcp_remote(
                    self.project_path, s_name, token)
                if ok:
                    # Reload the MCP servers list and start immediately
                    self._mcp_servers = (self.mcp_manager.load_config().get("mcpServers", {})
                                         if self.mcp_manager else {})
                    mcp_conf = self.mcp_manager.load_config() if self.mcp_manager else {}
                    srv_conf = mcp_conf.get("mcpServers", {}).get(s_name, {})
                    command  = srv_conf.get("command")
                    args     = srv_conf.get("args", [])
                    env      = srv_conf.get("env", {})
                    if command and self.mcp_manager:
                        session = MCPStdioSession(
                            name=s_name, command=command, args=args, env=env,
                            cwd=self.mcp_manager.project_path)
                        success = await session.start()
                        if success:
                            self.mcp_manager.sessions[s_name] = session
                    self.app.notify(
                        f"{s_name} configured! Toggle to connect.",
                        severity="information")
                else:
                    self.app.notify("Failed to save token.", severity="error")
            except Exception as e:
                self.app.notify(f"Error: {e}", severity="error")

        elif btn_id.startswith("mcp-openurl-"):
            # Open a server URL in the default browser
            import webbrowser
            s_name = btn_id.replace("mcp-openurl-", "")
            mcp_conf = self.mcp_manager.load_config() if self.mcp_manager else {}
            srv_conf = mcp_conf.get("mcpServers", {}).get(s_name, {})
            url = srv_conf.get("serverUrl") or srv_conf.get("url") or ""
            if url:
                webbrowser.open(url)
            else:
                self.app.notify("No URL found for this server.", severity="warning")

        elif btn_id.startswith("mcp-browser-auth-"):

            # SSE proxy (like Neon): open browser OAuth via mcp-remote
            import subprocess, shutil
            s_name = btn_id.replace("mcp-browser-auth-", "")
            mcp_conf = self.mcp_manager.load_config() if self.mcp_manager else {}
            srv_conf = mcp_conf.get("mcpServers", {}).get(s_name, {})
            args = srv_conf.get("args", [])
            # Find the URL in args (after mcp-remote)
            remote_url = ""
            for i, a in enumerate(args):
                if a.startswith("http") and "mcp" in a.lower():
                    remote_url = a
                    break
            if remote_url:
                try:
                    # Run mcp-remote in a new window to trigger browser OAuth
                    npx = shutil.which("npx") or "npx"
                    subprocess.Popen(
                        [npx, "-y", "mcp-remote", remote_url, "--port", "3334"],
                        creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
                    )
                    self.app.notify(
                        f"Opening browser for {s_name} OAuth login…",
                        severity="information")
                except Exception as e:
                    self.app.notify(f"Failed to launch mcp-remote: {e}",
                                    severity="error")
            else:
                self.app.notify("Could not find remote URL in config.",
                                severity="warning")

        elif btn_id.startswith("mcp-saveenv-"):
            # Save a single env var for a stdio server
            rest = btn_id.replace("mcp-saveenv-", "")
            s_name, env_key = rest.split("--", 1) if "--" in rest else (rest, "")
            if env_key:
                try:
                    val = self.query_one(
                        f"#mcp-env-{s_name}--{env_key}", Input).value.strip()
                    if val:
                        config.set_mcp_server_env(
                            self.project_path, s_name, env_key, val)
                        self.app.notify(
                            f"{env_key} saved for {s_name}.",
                            severity="information")
                    else:
                        self.app.notify("Value is empty.", severity="warning")
                except Exception as e:
                    self.app.notify(f"Error: {e}", severity="error")

        elif btn_id.startswith("mcp-remove-"):
            # Remove / uninstall a server from mcp.json
            s_name = btn_id.replace("mcp-remove-", "")
            # Stop if running
            if self.mcp_manager and s_name in self.mcp_manager.sessions:
                await self.mcp_manager.sessions[s_name].stop()
                del self.mcp_manager.sessions[s_name]
                self.mcp_manager.server_status.pop(s_name, None)
            ok = config.remove_mcp_server(self.project_path, s_name)
            if ok:
                # Hide card immediately
                try:
                    self.query_one(f"#card-{s_name}").display = False
                except Exception:
                    pass
                self.app.notify(f"{s_name} removed from MCP config.",
                                severity="information")
            else:
                self.app.notify(f"Could not remove {s_name}.", severity="error")

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
