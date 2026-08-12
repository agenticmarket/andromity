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
    ContentSwitcher, Input, RadioSet, RadioButton, Switch, Collapsible
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
/* Per-card minimal restart button */
.mcp-btn-restart {
    border: none !important;
    background: transparent !important;
    color: $text-muted !important;
    min-width: 0 !important; height: 1 !important;
    padding: 0 1 !important;
}
.mcp-btn-restart:hover { color: $accent !important; }
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
.mcp-pat-input      { display: none; height: 3; margin-top: 1; margin-bottom: 1; }
.mcp-link-btn       { border: none !important; background: transparent !important; color: $accent !important; min-width: 0 !important; height: 1 !important; padding: 0 1 !important; }
.mcp-link-btn:hover { background: transparent !important; color: $accent-lighten-1 !important; text-style: none !important; }
.mcp-link-error       { color: $error !important; }
.mcp-link-error:hover { color: $error-lighten-1 !important; }
.mcp-auth-methods   { height: 1; margin-bottom: 1; margin-top: 1; }
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
                                    yield Button("[u]Revoke[/u]",
                                                 id=f"revoke-{t_key}",
                                                 classes="mcp-link-btn mcp-link-error")
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
                        with Horizontal(classes="adv-row"):
                            yield Label(
                                "Anonymous Telemetry  [dim](one ping on first launch to count users)[/]",
                                classes="adv-label")
                            yield Switch(id="setting-telemetry")
                        with Horizontal(classes="adv-row"):
                            yield Label(
                                "Sound Alerts (Attention)  [dim](play sound when AI needs approval)[/]",
                                classes="adv-label")
                            yield Switch(id="setting-sound-attention")
                        with Horizontal(classes="adv-row"):
                            yield Label(
                                "Sound Alerts (Done)  [dim](play sound when AI finishes a response)[/]",
                                classes="adv-label")
                            yield Switch(id="setting-sound-done")

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
                yield Label(badge_txt, classes=f"mcp-badge {badge_cls}",
                            id=f"mcp-badge-{s_name}")
                yield Label(
                    f"{len(tools)} tool{'s' if len(tools) != 1 else ''}",
                    classes="mcp-tool-count",
                    id=f"mcp-toolcount-{s_name}")
                # Minimal restart button — only for startable servers
                if transport in ("stdio", "sse") or already_converted:
                    yield Button(
                        "↺",
                        id=f"mcp-restart-{s_name}",
                        classes="mcp-btn-restart",
                        tooltip="Restart this server",
                    )
                # Toggle only for startable servers
                if transport in ("stdio", "sse") or already_converted:
                    yield Switch(value=not disabled, id=f"mcp-toggle-{s_name}")
                else:
                    yield Label("[dim]—[/]")
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

            # Tools Collapsible
            if tools:
                with Collapsible(title=f"View {len(tools)} tools exposed by {s_name}", classes="mcp-tools-collapsible"):
                    for t in tools:
                        name = getattr(t, 'name', 'unknown_tool')
                        d = getattr(t, 'description', '')
                        yield Label(f"• {name}: [dim]{d}[/]", classes="mcp-tool-label")

            # ── Auth sections ────────────────────────────────────────────
            # Remote HTTP or SSE server
            if transport in ("remote", "sse"):
                from andromity.core.oauth import load_token, clear_token
                has_token = bool(load_token(s_name))
                        
                with Vertical(classes="mcp-auth-section"):
                    if has_token:
                        yield Label("✅ Token active", classes="mcp-success")
                        with Horizontal(classes="mcp-auth-methods"):
                            yield Button("[u]Re-Authenticate[/u]", id=f"mcp-oauth-{s_name}", classes="mcp-link-btn")
                            yield Button("[u]Revoke[/u]", id=f"mcp-revoke-{s_name}", classes="mcp-link-btn mcp-link-error")
                    else:
                        yield Label("⚠ Authentication required", classes="mcp-warning")
                        with Horizontal(classes="mcp-auth-methods"):
                            yield Button("[u]🌐 Authenticate[/u]", id=f"mcp-oauth-{s_name}", classes="mcp-link-btn")
                            yield Button("[u]🔑 Use PAT[/u]", id=f"mcp-pat-toggle-{s_name}", classes="mcp-link-btn")

                        with Horizontal(classes="mcp-pat-input", id=f"mcp-pat-container-{s_name}"):
                            yield Input(placeholder="Paste Personal Access Token (PAT)", id=f"mcp-pat-{s_name}")
                            yield Button("Save", id=f"mcp-pat-save-{s_name}", variant="success")

                        yield Label("", id=f"mcp-oauth-status-{s_name}", classes="mcp-oauth-status")

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
            # ── Card footer ──────────────────────────────────────────────
            with Horizontal(classes="mcp-card-footer"):
                installed = s_conf.get("installedAt", "")
                yield Label(
                    f"[dim]{installed}[/]" if installed else "",
                    classes="mcp-install-date")
                yield Button("[u]Uninstall[/u]",
                             id=f"mcp-remove-{s_name}",
                             classes="mcp-link-btn mcp-link-error")


    # ── MCP card live-refresh ───────────────────────────────────────────────

    async def _refresh_mcp_card(self, server_name: str):
        """
        Surgically remove and re-mount a single MCP card so its status,
        badge, tool count and auth section all reflect the current live state.
        This avoids rebuilding the entire MCP pane.
        """
        if not self.mcp_manager:
            return
        try:
            # Fresh config from disk (might have changed — e.g. token saved)
            mcp_conf = self.mcp_manager.load_config().get("mcpServers", {})
            s_conf = mcp_conf.get(server_name)
            if s_conf is None:
                return  # server was removed

            old_card = self.query_one(f"#card-{server_name}")
            parent   = old_card.parent  # the VerticalScroll MCP pane

            # Compose fresh widgets
            new_widgets = list(self._compose_mcp_card(server_name, s_conf))

            # Atomic swap: remove old, mount new in same position
            if new_widgets:
                await parent.mount(new_widgets[0], before=old_card)
            await old_card.remove()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).debug(
                "_refresh_mcp_card(%s) failed: %s", server_name, exc)

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
            self.query_one("#setting-telemetry", Switch).value = config.get("default", "telemetry", True)
            self.query_one("#setting-sound-attention", Switch).value = config.get("default", "sound_attention", True)
            self.query_one("#setting-sound-done", Switch).value = config.get("default", "sound_done", True)
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
            
            async def _start():
                await self.mcp_manager.start_server(server_name)
                await self._refresh_mcp_card(server_name)
            
            self.run_worker(_start(), exclusive=False)
            return
        else:
            if server_name in self.mcp_manager.sessions:
                await self.mcp_manager.sessions[server_name].stop()
                del self.mcp_manager.sessions[server_name]
            self.mcp_manager.server_status.pop(server_name, None)

        # Refresh the card so badge/tools/auth sections reflect new state
        await self._refresh_mcp_card(server_name)


    # ── Button handlers ───────────────────────────────────────────────────────

    @on(Button.Pressed)
    async def _on_button_pressed(self, event: Button.Pressed):
        event.stop()
        btn_id = event.button.id or ""

        if btn_id == "settings-cancel":
            try:
                self.dismiss(False)
            except Exception:
                pass

        elif btn_id == "settings-save":
            self._save_settings()
            try:
                self.dismiss(True)
            except Exception:
                pass

        elif btn_id == "mcp-restart-all":
            if self.mcp_manager:
                self.app.notify("Restarting all MCP servers…",
                                severity="information")
                async def _restart():
                    await self.mcp_manager.stop_all()
                    try:
                        mcp_conf = self.mcp_manager.load_config().get("mcpServers", {})
                        for k in mcp_conf.keys():
                            self.mcp_manager.server_status[k] = {"status": "initializing", "tools": 0, "error": None, "command": ""}
                        self.app._update_status()
                    except Exception:
                        pass
                    await self.mcp_manager.start_all()
                    try:
                        self.app._update_status()
                    except Exception:
                        pass
                    n = len(self.mcp_manager.sessions)
                    self.app.notify(
                        f"MCP restart done: {n} server(s) active.",
                        severity="information")
                    # Refresh every card to reflect new live state
                    mcp_conf = self.mcp_manager.load_config().get("mcpServers", {})
                    for srv_name in list(mcp_conf.keys()):
                        await self._refresh_mcp_card(srv_name)
                    try:
                        from andromity.tui.panels.chat import ChatPanel
                        self.app.query_one(ChatPanel).add_system_message(
                            f"[green]✓ MCP restarted — {n} server(s) running.[/]")
                    except Exception:
                        pass
                self.run_worker(_restart(), exclusive=True)

        elif btn_id.startswith("mcp-restart-"):
            # Per-server restart — preserve all settings state
            s_name = btn_id[len("mcp-restart-"):]
            if not self.mcp_manager:
                return

            # 1. Immediately show "restarting…" in the badge (no full rebuild)
            try:
                badge = self.query_one(f"#mcp-badge-{s_name}", Label)
                badge.update("⟳ restarting…")
                badge.set_classes("mcp-badge mcp-badge-stopped")
            except Exception:
                pass
            # Disable the restart button while in progress
            try:
                event.button.disabled = True
            except Exception:
                pass

            async def _restart_one(name: str = s_name):
                try:
                    # Stop existing session
                    if name in self.mcp_manager.sessions:
                        await self.mcp_manager.sessions[name].stop()
                        del self.mcp_manager.sessions[name]
                    self.mcp_manager.server_status.pop(name, None)
                    
                    self.mcp_manager.server_status[name] = {"status": "initializing", "tools": 0, "error": None, "command": ""}
                    try:
                        self.app._update_status()
                    except Exception:
                        pass

                    # Start fresh (reads config from disk — no re-save needed)
                    await self.mcp_manager.start_server(name)

                    # Refresh just this card
                    await self._refresh_mcp_card(name)

                    # Update main app status bar
                    try:
                        self.app._update_status()
                    except Exception:
                        pass

                    status_info = self.mcp_manager.server_status.get(name, {})
                    status = status_info.get("status", "unknown")
                    if status == "running":
                        n_tools = status_info.get("tools", 0)
                        self.app.notify(
                            f"\u21ba {name}: running ({n_tools} tool{'s' if n_tools != 1 else ''})",
                            severity="information")
                    else:
                        err = status_info.get("error", "unknown error")
                        self.app.notify(f"\u21ba {name}: failed \u2014 {err}", severity="error")
                except Exception as exc:
                    self.app.notify(f"↺ {name}: error — {exc}", severity="error")
                    # Re-enable button even on failure
                    try:
                        self.query_one(f"#mcp-restart-{name}", Button).disabled = False
                    except Exception:
                        pass

            self.run_worker(_restart_one(), exclusive=False)


        elif btn_id.startswith("mcp-pat-save-"):
            # Remote HTTP: user pasted a PAT token
            s_name = btn_id.replace("mcp-pat-save-", "")
            try:
                token = self.query_one(f"#mcp-pat-{s_name}", Input).value.strip()
                if not token:
                    self.app.notify("Please paste a token first.", severity="warning")
                    return
                
                # Save the PAT token
                ok = config.convert_remote_to_mcp_remote(
                    self.project_path, s_name, token)
                if ok:
                    self._mcp_servers = (
                        self.mcp_manager.load_config().get("mcpServers", {})
                        if self.mcp_manager else {})
                    self.app.notify(
                        f"{s_name}: PAT saved! Toggle to connect.",
                        severity="information")
                    
                    if self.mcp_manager:
                        if s_name in self.mcp_manager.sessions:
                            await self.mcp_manager.sessions[s_name].stop()
                            del self.mcp_manager.sessions[s_name]
                        self.mcp_manager.server_status.pop(s_name, None)
                        
                    # Refresh the card so auth section disappears and toggle appears
                    await self._refresh_mcp_card(s_name)
                else:
                    self.app.notify("Failed to save token.", severity="error")
            except Exception as e:
                self.app.notify(f"Error: {e}", severity="error")

        elif btn_id.startswith("mcp-openurl-"):
            # Open a server URL or dashboard URL in the default browser
            import webbrowser
            rest = btn_id.replace("mcp-openurl-", "")
            # Special case: dashboard link for PAT generation
            if rest.startswith("dashboard-"):
                s_name = rest.replace("dashboard-", "")
                mcp_conf = self.mcp_manager.load_config() if self.mcp_manager else {}
                srv_url = (mcp_conf.get("mcpServers", {})
                           .get(s_name, {})
                           .get("serverUrl", ""))
                if "supabase.com" in srv_url.lower():
                    webbrowser.open("https://supabase.com/dashboard/account/tokens")
                else:
                    webbrowser.open(srv_url or "https://supabase.com/dashboard/account/tokens")
            else:
                # Regular server URL open
                s_name = rest
                mcp_conf = self.mcp_manager.load_config() if self.mcp_manager else {}
                srv_conf = mcp_conf.get("mcpServers", {}).get(s_name, {})
                url = srv_conf.get("serverUrl") or srv_conf.get("url") or ""
                if url:
                    webbrowser.open(url)
                else:
                    self.app.notify("No URL found for this server.", severity="warning")

        elif btn_id.startswith("mcp-pat-toggle-"):
            # Toggle visibility of the PAT input row
            s_name = btn_id.replace("mcp-pat-toggle-", "")
            try:
                container = self.query_one(f"#mcp-pat-container-{s_name}")
                container.styles.display = "flex" if container.styles.display == "none" else "none"
            except Exception:
                pass

        elif btn_id.startswith("mcp-revoke-"):
            # Clear stored OAuth token for this server
            from andromity.core.oauth import clear_token
            s_name = btn_id.replace("mcp-revoke-", "")
            clear_token(s_name)
            
            if self.mcp_manager:
                if s_name in self.mcp_manager.sessions:
                    await self.mcp_manager.sessions[s_name].stop()
                    del self.mcp_manager.sessions[s_name]
                self.mcp_manager.server_status.pop(s_name, None)
                
            self.app.notify(f"{s_name}: OAuth token revoked.", severity="information")
            await self._refresh_mcp_card(s_name)

        elif btn_id.startswith("mcp-oauth-"):
            # Full native Python OAuth flow
            s_name = btn_id.replace("mcp-oauth-", "")
            mcp_conf = self.mcp_manager.load_config() if self.mcp_manager else {}
            srv_conf = mcp_conf.get("mcpServers", {}).get(s_name, {})
            server_url = srv_conf.get("serverUrl") or srv_conf.get("url")
            
            # If server_url missing but args has it (legacy config)
            if not server_url:
                for a in srv_conf.get("args", []):
                    if isinstance(a, str) and (a.startswith("http://") or a.startswith("https://")):
                        server_url = a
                        break

            if not server_url:
                self.app.notify(f"{s_name}: no serverUrl configured.", severity="warning")
                return

            def _set_status(msg: str):
                try:
                    lbl = self.query_one(f"#mcp-oauth-status-{s_name}", Label)
                    lbl.update(f"[dim]{msg}[/]")
                except Exception:
                    pass

            async def _do_oauth():
                from andromity.core.oauth import full_oauth_flow
                _set_status("🔍 Discovering endpoints…")
                token = await full_oauth_flow(s_name, server_url, _set_status)

                if not token:
                    # If OAuth fails (e.g., no metadata for Supabase), show PAT field automatically
                    try:
                        container = self.query_one(f"#mcp-pat-container-{s_name}")
                        if container.styles.display == "none":
                            container.styles.display = "flex"
                    except Exception:
                        pass
                    return

                # Successfully authenticated, restart the MCP sessions to pick up the token natively!
                _set_status("✅ Connected! Initializing…")
                self.app.notify(f"{s_name} authenticated successfully!", severity="information")
                
                if self.mcp_manager:
                    try:
                        self.mcp_manager.server_status[s_name] = {"status": "initializing", "tools": 0, "error": None, "command": ""}
                        self.app._update_status()
                    except Exception:
                        pass
                    await self.mcp_manager.start_all()
                    try:
                        self.app._update_status()
                    except Exception:
                        pass
                    
                await self._refresh_mcp_card(s_name)
                try:
                    self.app._update_status()
                except Exception:
                    pass

            self.run_worker(_do_oauth(), exclusive=False)






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

        # 5. Debug / dry-run / telemetry
        try:
            app = self.app
            app._debug_mode  = self.query_one("#setting-debug",  Switch).value
            app.agent.dry_run = self.query_one("#setting-dryrun", Switch).value
            telemetry_enabled = self.query_one("#setting-telemetry", Switch).value
            config.set("default", "telemetry", telemetry_enabled)
            
            sound_attn = self.query_one("#setting-sound-attention", Switch).value
            config.set("default", "sound_attention", sound_attn)
            sound_done = self.query_one("#setting-sound-done", Switch).value
            config.set("default", "sound_done", sound_done)
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
