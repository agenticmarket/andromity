"""
Settings Screen — unified control panel for Andromity TUI.

MCP transport type detection:
  - stdio   : has 'command', no 'serverUrl'
  - sse     : command contains 'mcp-remote' or 'supergateway'
  - remote  : has 'serverUrl', no 'command'  (OAuth / token required)
  - env-auth: has 'env' dict with API key fields
"""
import asyncio
import platform
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

try:
    from textual_plotext import PlotextPlot
except ImportError:
    PlotextPlot = None

def _format_cost(v: float) -> str:
    if v == 0:
        return "$0"
    a = abs(v)
    if a >= 1_000_000:
        return f"${v/1_000_000:.1f}m"
    if a >= 1_000:
        return f"${v/1_000:.1f}k"
    if a >= 10:
        return f"${v:.0f}"
    if a >= 1:
        return f"${v:.2f}"
    return "$" + f"{v:.4f}".rstrip("0").rstrip(".")


def _format_tokens(v: int) -> str:
    if v >= 1_000_000:
        return f"{v/1_000_000:.1f}M"
    if v >= 10_000:
        return f"{v/1_000:.0f}k"
    if v >= 1_000:
        return f"{v/1_000:.1f}k"
    return f"{v:g}" if isinstance(v, float) else str(v)


if PlotextPlot:
    class UsageChart(PlotextPlot):
        DEFAULT_CSS = "UsageChart { width: 1fr; height: 12; margin-bottom: 1; border: tall $surface-lighten-2; background: $surface-darken-1; padding: 1 1; }"
        def __init__(self, chart_data: dict, metric="cost", **kwargs):
            super().__init__(**kwargs)
            self.chart_data = chart_data
            self.metric = metric

        def on_mount(self):
            plt = self.plt
            plt.clear_figure()
            plt.theme("clear")
            fmt = _format_cost if self.metric == "cost" else _format_tokens
            ranked = sorted(
                self.chart_data.items(),
                key=lambda kv: kv[1].get(self.metric, 0.0),
                reverse=True,
            )[:3]
            labels = []
            values = []
            for m, stats in ranked:
                short_m = m.split("/")[-1] if "/" in m else m
                if len(short_m) > 16:
                    short_m = short_m[:14] + "…"
                labels.append(short_m)
                values.append(stats.get(self.metric, 0.0))

            max_val = max(values) if values else 0.0
            plt.bar(labels, values, color="cyan", marker="fhd")
            if self.metric == "cost" and max_val == 0.0:
                plt.ylim(0.0, 1.0)
                plt.yticks([0.0], ["$0.00"])
                title = "Total Cost ($) by Model — All Free ($0.00)"
            else:
                top = max_val * 1.15 if max_val > 0 else 1.0
                plt.ylim(0.0, top)
                ticks = [top * frac for frac in (0.0, 0.25, 0.5, 0.75, 1.0)]
                tick_labels = [fmt(t) for t in ticks]
                title = "Total Cost ($) by Model" if self.metric == "cost" else "Total Tokens by Model"
                plt.yticks(ticks, tick_labels)
            plt.title(title)
            self.refresh()
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
    border: solid $panel-lighten-2; background: $surface;
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
#settings-footer {
    dock: bottom;
    height: 3;
    padding: 1 1 0 1;
    background: $surface-darken-2;
    border-top: solid $panel-lighten-2;
    align: right middle;
}
#settings-footer Button {
    height: 1;
    min-width: 14;
    margin: 0 1;
    padding: 0 2;
    border: none;
}
#settings-footer #settings-save {
    background: $success;
    color: $background;
    text-style: bold;
}
#settings-footer #settings-save:hover, #settings-footer #settings-save:focus {
    background: $success-lighten-1;
    color: $background;
}
#settings-footer #settings-cancel {
    background: $surface;
    color: $text-muted;
}
#settings-footer #settings-cancel:hover, #settings-footer #settings-cancel:focus {
    background: $error;
    color: $text;
}

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
.mcp-error-detail { color: $error-lighten-1; height: auto; padding: 0 1 1 1; }
.mcp-error-collapsible { height: auto; }
.mcp-hidden { display: none; }
.mcp-success { color: $success; height: 1; }
.mcp-warning { color: $warning; height: 1; }
/* ── Add Server form ── */
.mcp-add-collapsible { height: auto; margin-bottom: 1; }
.mcp-add-note { color: $text-muted; margin-bottom: 1; }
.mcp-add-fld-remote { display: none; }
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
.mcp-url-btn       { border: none !important; background: transparent !important; color: $accent !important; min-width: 0 !important; height: 1 !important; padding: 0 1 !important; margin-left: 1; }
.mcp-url-btn:hover { background: transparent !important; color: $accent-lighten-1 !important; text-style: underline !important; }
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

/* ── Usage Pane ── */
.usage-controls-row { height: 3; margin-bottom: 1; layout: horizontal; }
.usage-time-tabs    { height: 3; layout: horizontal; width: auto; }
.usage-metric-tabs  { height: 3; layout: horizontal; width: auto; margin-left: 2; }
.usage-tab-btn, .usage-metric-btn {
    height: 3;
    min-width: 11;
    margin-right: 1;
    background: $surface-darken-1;
    color: $text-muted;
    border: tall $surface-lighten-2;
    padding: 0 1;
}
.usage-tab-btn:hover, .usage-metric-btn:hover,
.usage-tab-btn:focus, .usage-metric-btn:focus {
    background: $surface !important;
    color: $text !important;
    border: tall $panel-lighten-2 !important;
}
.usage-tab-btn.active, .usage-metric-btn.active {
    background: $accent;
    color: $background;
    text-style: bold;
    border: tall $accent-lighten-1;
}
.usage-tab-btn.active:hover, .usage-metric-btn.active:hover,
.usage-tab-btn.active:focus, .usage-metric-btn.active:focus {
    background: $accent-lighten-1 !important;
    color: $background !important;
    border: tall $accent-lighten-2 !important;
}
.usage-stat-row   { height: 5; margin-bottom: 1; }
.usage-stat-card  {
    width: 1fr; height: 5;
    border: tall $surface-lighten-2;
    background: $surface-darken-1;
    padding: 0 1;
    content-align: center middle;
}
.usage-stat-label { height: 1; color: $text-muted; text-align: center; }
.usage-stat-value { height: 2; color: $accent; text-style: bold; text-align: center; }
.usage-stat-sub   { height: 1; color: $text-muted; text-align: center; }
.usage-section-title { color: $accent; text-style: bold; margin-top: 1; margin-bottom: 1; height: 1; }
.usage-tbl-header {
    height: 1;
    margin-top: 1;
    margin-bottom: 0;
    padding: 0 1;
    color: $text-muted;
}
.usage-tbl-hdr-name  { width: 1fr; text-style: bold; color: $text-muted; }
.usage-tbl-hdr-count { width: 10; text-align: right; text-style: bold; color: $text-muted; }
.usage-tbl-hdr-tok   { width: 12; text-align: right; text-style: bold; color: $text-muted; }
.usage-tbl-hdr-cost  { width: 18; text-align: right; text-style: bold; color: $text-muted; }

.usage-model-row  {
    height: 3;
    margin-bottom: 1;
    border: tall $surface-lighten-1;
    background: $surface-darken-1;
    padding: 0 1;
}
.usage-model-row:hover {
    background: $surface-lighten-1;
    border: tall $accent;
}
.usage-model-name  { width: 1fr; color: $text; content-align: left middle; }
.usage-model-count { width: 10; color: $text-muted; content-align: right middle; }
.usage-model-tok   { width: 12; color: $accent; content-align: right middle; }
.usage-model-cost  { width: 18; color: $success; content-align: right middle; }
.usage-empty      { color: $text-muted; margin-top: 2; }
"""

    def __init__(self, mcp_manager: MCPClientManager = None,
                 project_path: str = "", **kwargs):
        super().__init__(**kwargs)
        self.mcp_manager = mcp_manager
        self.project_path = project_path
        self._usage_metric = "cost"
        self._usage_time_range = "all"
        # Serializes structural card/pane rebuilds so two rebuilds can never
        # race (duplicate ids / half-removed cards). In-place status updates
        # (_update_mcp_card_state) do NOT take this lock — they never touch
        # the DOM structure.
        self._card_refresh_lock = asyncio.Lock()
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
                    yield ListItem(Label("Skills"),          id="nav-skills")
                    yield ListItem(Label("Profiles"),        id="nav-profiles")
                    yield ListItem(Label("Trust & Security"),id="nav-trust")
                    yield ListItem(Label("Usage"),           id="nav-usage")
                    yield ListItem(Label("Advanced"),        id="nav-advanced")
                    yield ListItem(Label("About"),           id="nav-about")

                with ContentSwitcher(initial="pane-general", id="settings-content"):

                    # ── 1. General ────────────────────────────────────────────
                    with VerticalScroll(id="pane-general", classes="settings-pane"):
                        yield Label("General Settings", classes="settings-label")
                        user = config.get_user()
                        yield Label("Your Name:", classes="field-label")
                        yield Input(value=user.get("name", ""),
                                    placeholder="e.g. Alex",
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
                            "Saved to config.toml on Save All. "
                            "Leave blank to keep existing key.",
                            classes="section-hint")
                        for provider in PROVIDERS:
                            current_key = config.get_api_key(provider) or ""
                            status_txt = " [green]✓ Set[/]" if current_key else " [dim]Not set[/]"
                            yield Label(
                                f"{PROVIDER_LABELS[provider]}{status_txt}",
                                classes="field-label")
                            yield Input(
                                value="",
                                password=True,
                                placeholder=f"Paste new {provider} key…" if current_key else f"Paste {provider} key…",
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
                        yield from self._compose_mcp_pane()

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
                        trusted = config.get_root("trusted_projects", {})
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

                    # ── 6.5 Usage ─────────────────────────────────────────────
                    with VerticalScroll(id="pane-usage", classes="settings-pane"):
                        yield Label("Usage Analytics", classes="settings-label")
                        yield Label("Track tokens, costs, and model usage across sessions.", classes="section-hint")
                        with Horizontal(classes="usage-controls-row"):
                            with Horizontal(id="usage-time-tabs", classes="usage-time-tabs"):
                                yield Button("Today", id="usage-tab-today", classes="usage-tab-btn")
                                yield Button("7 Days", id="usage-tab-week", classes="usage-tab-btn")
                                yield Button("30 Days", id="usage-tab-month", classes="usage-tab-btn")
                                yield Button("All Time", id="usage-tab-all", classes="usage-tab-btn active")
                            with Horizontal(id="usage-metric-tabs", classes="usage-metric-tabs"):
                                yield Button("By Cost ($)", id="usage-metric-cost", classes="usage-metric-btn active")
                                yield Button("By Tokens", id="usage-metric-tokens", classes="usage-metric-btn")
                        yield Vertical(id="usage-content-area")

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
                                "Auto-expand Tools  [dim](expand while running, collapse when done)[/]",
                                classes="adv-label")
                            yield Switch(value=config.get("default", "expand_tools_while_working", True), id="setting-auto-expand-tools")
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
                        if platform.system() == "Windows":
                            with Horizontal(classes="adv-row"):
                                yield Label(
                                    "Windows Context Menu  [dim]('Open in Andromity' on right-click)[/]",
                                    classes="adv-label")
                                yield Switch(id="setting-context-menu")

                    # ── 8. About ──────────────────────────────────────────────
                    with VerticalScroll(id="pane-about", classes="settings-pane"):
                        yield Label("About Andromity", classes="settings-label")
                        from andromity import __version__
                        version = f"v{__version__}"
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
                yield Button("Cancel (Esc)", id="settings-cancel")
                yield Button("Save All", id="settings-save")

    # ── MCP pane composer ────────────────────────────────────────────────────

    def _compose_mcp_pane(self):
        """All widgets for the MCP pane. Used both by compose() and rebuilds
        after add/remove so the whole pane stays consistent."""
        yield Label("Model Context Protocol (MCP)", classes="settings-label")
        yield from self._compose_add_server_section()
        servers = self._mcp_servers
        if not servers:
            yield Label(
                "[dim]No MCP servers yet. Add one above, or hand-edit "
                "[bold].andromity/mcp.json[/].[/]",
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

    def _compose_add_server_section(self):
        """Inline 'Add Server' form — name, transport, and fields per type."""
        with Collapsible(title="+ Add Server", id="mcp-add-server",
                         classes="mcp-add-collapsible"):
            with Vertical():
                yield Label(
                    "Saved to .andromity/mcp.json and connected immediately.",
                    classes="mcp-add-note")
                yield Label("Name:", classes="field-label")
                yield Input(placeholder="e.g. my-server", id="mcp-add-name")
                yield Label("Type:", classes="field-label")
                with RadioSet(id="mcp-add-type"):
                    yield RadioButton("Local process (stdio)",
                                      id="add-type-stdio", value=True)
                    yield RadioButton("Remote HTTP/SSE",
                                      id="add-type-remote")
                yield Label("Command:", classes="field-label",
                            id="mcp-add-cmd-label")
                yield Input(placeholder="npx / uvx / python",
                            id="mcp-add-command")
                yield Label("Args (JSON array, optional):", classes="field-label",
                            id="mcp-add-args-label")
                yield Input(placeholder='["-y", "mcp-server-sqlite"]',
                            id="mcp-add-args")
                yield Label("Env (JSON object, optional):", classes="field-label",
                            id="mcp-add-env-label")
                yield Input(placeholder='{"API_KEY": "sk-..."}',
                            id="mcp-add-env")
                yield Label("Server URL:", classes="field-label mcp-add-fld-remote",
                            id="mcp-add-url-label")
                yield Input(placeholder="https://mcp.example.com/sse",
                            id="mcp-add-url", classes="mcp-add-fld-remote")
                yield Label("PAT token (optional):",
                            classes="field-label mcp-add-fld-remote",
                            id="mcp-add-pat-label")
                yield Input(placeholder="Paste a token if the server needs auth",
                            id="mcp-add-pat", password=True,
                            classes="mcp-add-fld-remote")
                yield Label("", id="mcp-add-error", classes="mcp-error-line")
                yield Button("Save & Connect", id="mcp-add-save",
                             variant="primary")

    # ── MCP card composer ─────────────────────────────────────────────────────

    def _mcp_card_badge(self, s_name: str, s_conf: dict) -> tuple[str, str]:
        """Compute (badge_text, badge_class) for one card from live state."""
        disabled    = s_conf.get("disabled", False)
        transport   = _mcp_transport(s_conf)
        is_running  = (not disabled and s_name in (self.mcp_manager.sessions if self.mcp_manager else {}))
        status_info = (self.mcp_manager.server_status.get(s_name, {}) if self.mcp_manager else {})
        status      = status_info.get("status")
        error_msg   = status_info.get("error") if not is_running and not disabled else None
        # Check if already converted to mcp-remote (has command after previous save)
        already_converted = bool(s_conf.get("command")) and transport in ("stdio", "sse")

        # For remote/SSE servers that were never converted to mcp-remote,
        # 'needs token' only applies when there is genuinely no token — a
        # stopped-but-authenticated server shows 'stopped' with a ✓.
        has_token = False
        if transport in ("remote", "sse") and not already_converted:
            try:
                from andromity.core.oauth import load_token
                has_token = bool(load_token(s_name))
            except Exception:
                pass

        if disabled:
            return "◌ disabled",     "mcp-badge-disabled"
        if status == "initializing":
            return "⟳ initializing…", "mcp-badge-stopped"
        if is_running:
            return "● running",      "mcp-badge-running"
        if error_msg:
            return "✕ error",        "mcp-badge-error"
        if transport in ("remote", "sse") and not already_converted and not has_token:
            return "⚠ needs token",  "mcp-badge-auth"
        return "○ stopped",           "mcp-badge-stopped"

    def _mcp_card_tools(self, s_name: str, s_conf: dict) -> list:
        """Live tool list for a card — empty unless the server is running."""
        disabled = s_conf.get("disabled", False)
        is_running = (not disabled and s_name in (self.mcp_manager.sessions if self.mcp_manager else {}))
        if is_running and self.mcp_manager:
            sess = self.mcp_manager.sessions.get(s_name)
            if sess:
                return list(sess.tools)
        return []

    def _compose_mcp_card(self, s_name: str, s_conf: dict):
        """Yield all widgets for a single MCP server card.

        Status-dependent sections (tools, error, auth) are ALWAYS composed and
        simply hidden/shown — the card is never removed and re-mounted for a
        status change (removing widgets mid-click crashed Textual's mouse
        handling with `'NoneType' object has no attribute 'region'`).
        """
        disabled    = s_conf.get("disabled", False)
        transport   = _mcp_transport(s_conf)
        status_info = (self.mcp_manager.server_status.get(s_name, {}) if self.mcp_manager else {})
        error_msg   = status_info.get("error") if not disabled else None
        auth_keys   = _mcp_auth_env_keys(s_conf)
        server_url  = s_conf.get("serverUrl") or s_conf.get("url") or ""
        # Check if already converted to mcp-remote (has command after previous save)
        already_converted = bool(s_conf.get("command")) and transport in ("stdio", "sse")

        badge_txt, badge_cls = self._mcp_card_badge(s_name, s_conf)
        tools = self._mcp_card_tools(s_name, s_conf)

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
                # Minimal restart/retry button — only for startable servers
                if transport in ("stdio", "sse") or already_converted:
                    if status_info.get("status") == "error":
                        btn_label, btn_tip = "↺ Retry", "Retry this server"
                    else:
                        btn_label, btn_tip = "↺", "Restart this server"
                    yield Button(
                        btn_label,
                        id=f"mcp-restart-{s_name}",
                        classes="mcp-btn-restart",
                        tooltip=btn_tip,
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
                                 classes="mcp-url-btn",
                                 tooltip=f"Open full URL in browser: {server_url}")

            # Description (1 line max)
            desc = s_conf.get("description", "").strip()
            if desc:
                yield Label(f"[dim]{desc[:90].replace(chr(10), ' ')}[/]",
                            classes="mcp-cmd-line")
            # Tools Collapsible — always composed, hidden until the server
            # exposes tools (status changes only toggle display in place).
            with Collapsible(
                title=f"View {len(tools)} tools exposed by {s_name}" if tools
                      else f"Tools exposed by {s_name}",
                id=f"mcp-tools-{s_name}",
                classes="mcp-tools-collapsible" + ("" if tools else " mcp-hidden"),
            ):
                yield Label(
                    "\n".join(
                        f"• {getattr(t, 'name', 'unknown_tool')}: "
                        f"[dim]{getattr(t, 'description', '')}[/]"
                        for t in tools
                    ),
                    id=f"mcp-tools-body-{s_name}",
                    classes="mcp-tool-label",
                )

            # ── Auth sections ────────────────────────────────────────────
            # Remote HTTP or SSE server — BOTH token states are composed up
            # front and toggled in place, so authenticating/revoking never
            # re-mounts the card (re-mounting mid-click crashed Textual).
            if transport in ("remote", "sse"):
                from andromity.core.oauth import load_token
                has_token = bool(load_token(s_name))

                with Vertical(classes="mcp-auth-section", id=f"mcp-auth-{s_name}"):
                    yield Label("✅ Token active", id=f"mcp-auth-ok-{s_name}",
                                classes="mcp-success" + ("" if has_token else " mcp-hidden"))
                    yield Label("⚠ Authentication required", id=f"mcp-auth-warn-{s_name}",
                                classes="mcp-warning" + ("" if not has_token else " mcp-hidden"))
                    with Horizontal(classes="mcp-auth-methods"):
                        yield Button(
                            "[u]Re-Authenticate[/u]" if has_token else "[u]🌐 Authenticate[/u]",
                            id=f"mcp-oauth-{s_name}", classes="mcp-link-btn")
                        yield Button("[u]Revoke[/u]", id=f"mcp-revoke-{s_name}",
                                     classes="mcp-link-btn mcp-link-error"
                                     + ("" if has_token else " mcp-hidden"))
                        yield Button("[u]🔑 Use PAT[/u]", id=f"mcp-pat-toggle-{s_name}",
                                     classes="mcp-link-btn"
                                     + ("" if not has_token else " mcp-hidden"))

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

            # ── Error (full detail behind a collapsible) — always composed,
            #    shown only when the server is in an error state.
            short = error_msg if error_msg and len(error_msg) <= 70 \
                else (error_msg[:67] + "…" if error_msg else "")
            with Collapsible(
                title=f"✕  Error: {short}" if error_msg else "Error",
                id=f"mcp-error-{s_name}",
                classes="mcp-error-collapsible" + ("" if error_msg else " mcp-hidden"),
            ):
                yield Label("", id=f"mcp-error-body-{s_name}",
                            classes="mcp-error-detail")
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

    def _update_mcp_card_state(self, server_name: str, s_conf: dict | None = None):
        """Live, in-place status update for a single MCP card.

        Only updates labels/classes/display flags — it NEVER removes or mounts
        widgets, so the compositor's widget map stays valid and a click can
        never land on a detached widget (which crashed Textual's mouse
        handling with `'NoneType' object has no attribute 'region'`).
        """
        if not self.mcp_manager or not self.is_attached:
            return
        if s_conf is None:
            try:
                s_conf = self.mcp_manager.load_config() \
                    .get("mcpServers", {}).get(server_name, {})
            except Exception:
                s_conf = {}

        disabled  = s_conf.get("disabled", False)
        transport = _mcp_transport(s_conf)
        badge_txt, badge_cls = self._mcp_card_badge(server_name, s_conf)
        tools = self._mcp_card_tools(server_name, s_conf)

        # ── Header: badge + tool count ──────────────────────────────────
        try:
            badge = self.query_one(f"#mcp-badge-{server_name}", Label)
            badge.update(badge_txt)
            badge.set_classes(f"mcp-badge {badge_cls}")
        except Exception:
            pass
        try:
            tc = self.query_one(f"#mcp-toolcount-{server_name}", Label)
            tc.update(f"{len(tools)} tool{'s' if len(tools) != 1 else ''}")
        except Exception:
            pass

        # Restart button label (Retry when the server is in an error state)
        try:
            status = (self.mcp_manager.server_status.get(server_name, {}) or {}).get("status")
            btn = self.query_one(f"#mcp-restart-{server_name}", Button)
            if status == "error":
                btn.label = "↺ Retry"
                btn.tooltip = "Retry this server"
            else:
                btn.label = "↺"
                btn.tooltip = "Restart this server"
        except Exception:
            pass

        # ── Tools collapsible ───────────────────────────────────────────
        try:
            coll = self.query_one(f"#mcp-tools-{server_name}", Collapsible)
            body = self.query_one(f"#mcp-tools-body-{server_name}", Label)
            coll.display = bool(tools)
            if tools:
                coll.title = f"View {len(tools)} tools exposed by {server_name}"
                body.update("\n".join(
                    f"• {getattr(t, 'name', 'unknown_tool')}: "
                    f"[dim]{getattr(t, 'description', '')}[/]"
                    for t in tools))
        except Exception:
            pass

        # ── Error collapsible ───────────────────────────────────────────
        error_msg = None
        status_info: dict = {}
        try:
            status_info = self.mcp_manager.server_status.get(server_name, {}) or {}
            is_running = (not disabled and server_name in self.mcp_manager.sessions)
            if not is_running and not disabled:
                error_msg = status_info.get("error")
        except Exception:
            pass
        try:
            coll = self.query_one(f"#mcp-error-{server_name}", Collapsible)
            body = self.query_one(f"#mcp-error-body-{server_name}", Label)
            coll.display = bool(error_msg)
            if error_msg:
                short = error_msg if len(error_msg) <= 70 else error_msg[:67] + "…"
                coll.title = f"✕  Error: {short}"
                detail_lines = [f"✕ {error_msg}"]
                err_detail = status_info.get("error_detail") or ""
                if err_detail:
                    detail_lines.append("")
                    detail_lines.append("[dim]detail / stderr tail:[/]")
                    detail_lines.append(err_detail)
                cmd_str = status_info.get("command") or ""
                if cmd_str:
                    detail_lines.append("")
                    detail_lines.append(f"[dim]command:[/] {cmd_str}")
                body.update("\n".join(detail_lines))
        except Exception:
            pass

        # ── Auth section (remote/SSE only) — toggle token states ───────
        try:
            from andromity.core.oauth import load_token
            has_token = bool(load_token(server_name))
        except Exception:
            has_token = False
        try:
            self.query_one(f"#mcp-auth-{server_name}")
        except Exception:
            pass
        else:
            def _show(wid: str, show: bool):
                try:
                    self.query_one(wid).display = show
                except Exception:
                    pass
            _show(f"#mcp-auth-ok-{server_name}", has_token)
            _show(f"#mcp-auth-warn-{server_name}", not has_token)
            _show(f"#mcp-revoke-{server_name}", has_token)
            _show(f"#mcp-pat-toggle-{server_name}", not has_token)
            try:
                oauth_btn = self.query_one(f"#mcp-oauth-{server_name}", Button)
                oauth_btn.label = (
                    "[u]Re-Authenticate[/u]" if has_token else "[u]🌐 Authenticate[/u]")
            except Exception:
                pass

    def _schedule_card_rebuild(self, server_name: str):
        """Defer a STRUCTURAL card rebuild until after the current event has
        fully settled. Used only when the card's shape changes (e.g. a remote
        server was converted to mcp-remote) — status-only changes go through
        _update_mcp_card_state which never mutates the DOM."""
        if not self.is_attached:
            return
        self.call_after_refresh(
            lambda: self.run_worker(
                self._rebuild_mcp_card(server_name), group="settings"))

    def _schedule_pane_rebuild(self):
        """Defer a full MCP-pane rebuild out of the current event handler so
        the compositor is consistent when the DOM is mutated."""
        if not self.is_attached:
            return
        self.call_after_refresh(
            lambda: self.run_worker(self._rebuild_mcp_pane(), group="settings"))

    async def _rebuild_mcp_card(self, server_name: str):
        """Full structural rebuild of ONE card. Only for shape changes;
        serialized by _card_refresh_lock and deferred out of event handlers."""
        if not self.mcp_manager or not self.is_attached:
            return
        async with self._card_refresh_lock:
            try:
                mcp_conf = self.mcp_manager.load_config().get("mcpServers", {})
                s_conf = mcp_conf.get(server_name)
                if s_conf is None:
                    return  # server was removed

                old_card = self.query_one(f"#card-{server_name}")
                parent   = old_card.parent  # the VerticalScroll MCP pane
                index    = parent.children.index(old_card)

                from textual.compose import compose
                new_widgets = compose(self, self._compose_mcp_card(server_name, s_conf))

                await old_card.remove()
                if new_widgets:
                    target = parent.children[index] if index < len(parent.children) else None
                    if target is not None:
                        await parent.mount(new_widgets[0], before=target)
                    else:
                        await parent.mount(new_widgets[0])
            except Exception as exc:
                import logging
                logging.getLogger(__name__).debug(
                    "_rebuild_mcp_card(%s) failed: %s", server_name, exc)

    # ── Live MCP status poll ─────────────────────────────────────────────────

    def _poll_mcp_status(self):
        """Timer callback: detect crashed servers and repaint their cards.
        Only does work when the MCP pane is the active pane and something
        actually changed."""
        if not self.mcp_manager:
            return
        try:
            switcher = self.query_one("#settings-content", ContentSwitcher)
            if switcher.current != "pane-mcp":
                return
        except Exception:
            return
        try:
            changed = self.mcp_manager.check_liveness()
            if changed:
                for name in changed:
                    self.app.notify(
                        f"⚠ MCP '{name}' stopped unexpectedly — see Settings → MCP",
                        severity="warning",
                    )
                self.run_worker(self._refresh_changed_cards(changed),
                                group="settings")
        except Exception:
            pass

    async def _refresh_changed_cards(self, names: list):
        for name in names:
            self._update_mcp_card_state(name)

    async def _rebuild_mcp_pane(self):
        """Re-mount the whole MCP pane (used after add/remove so the new
        server's card appears / a removed one disappears). Uses Textual's
        compose() helper so the `with`-block hierarchy in the pane generator
        is assembled correctly."""
        from textual.compose import compose
        try:
            pane = self.query_one("#pane-mcp", VerticalScroll)
            await pane.query("*").remove()
            nodes = compose(self, self._compose_mcp_pane())
            await pane.mount(*nodes)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).debug("_rebuild_mcp_pane failed: %s", exc)

    # ── Add Server form ────────────────────────────────────────────────────────

    @on(RadioSet.Changed, "#mcp-add-type")
    def _on_mcp_add_type_changed(self, event: RadioSet.Changed):
        is_remote = bool(event.pressed.id == "add-type-remote")
        stdio_ids = ["#mcp-add-command", "#mcp-add-args", "#mcp-add-env",
                     "#mcp-add-cmd-label", "#mcp-add-args-label", "#mcp-add-env-label"]
        remote_ids = ["#mcp-add-url", "#mcp-add-pat",
                      "#mcp-add-url-label", "#mcp-add-pat-label"]
        for wid in stdio_ids:
            try:
                w = self.query_one(wid)
                if is_remote:
                    w.add_class("mcp-add-fld-remote")
                else:
                    w.remove_class("mcp-add-fld-remote")
            except Exception:
                pass
        for wid in remote_ids:
            try:
                w = self.query_one(wid)
                if is_remote:
                    w.remove_class("mcp-add-fld-remote")
                else:
                    w.add_class("mcp-add-fld-remote")
            except Exception:
                pass

    async def _add_mcp_server(self):
        """Validate the Add Server form, write mcp.json, rebuild the pane,
        and connect the new server immediately."""
        import json as _json
        err = self.query_one("#mcp-add-error", Label)
        name = self.query_one("#mcp-add-name", Input).value.strip()
        if not name:
            err.update("⚠ Name is required.")
            return
        if name in self._mcp_servers:
            err.update(
                f"⚠ '{name}' already exists — remove it first or pick another name.")
            return
        is_remote = False
        try:
            rs = self.query_one("#mcp-add-type", RadioSet)
            is_remote = bool(rs.pressed_button
                             and rs.pressed_button.id == "add-type-remote")
        except Exception:
            pass
        try:
            if is_remote:
                url = self.query_one("#mcp-add-url", Input).value.strip()
                if not url:
                    err.update("⚠ Server URL is required for remote servers.")
                    return
                conf: dict = {"serverUrl": url}
                pat = self.query_one("#mcp-add-pat", Input).value.strip()
                if pat:
                    conf["headers"] = {"Authorization": f"Bearer {pat}"}
            else:
                command = self.query_one("#mcp-add-command", Input).value.strip()
                if not command:
                    err.update("⚠ Command is required for stdio servers.")
                    return
                args_raw = self.query_one("#mcp-add-args", Input).value.strip()
                args = _json.loads(args_raw) if args_raw else []
                if not isinstance(args, list):
                    err.update('⚠ Args must be a JSON array, e.g. ["-y", "pkg"].')
                    return
                env_raw = self.query_one("#mcp-add-env", Input).value.strip()
                env = _json.loads(env_raw) if env_raw else {}
                if not isinstance(env, dict):
                    err.update('⚠ Env must be a JSON object, e.g. {"KEY": "value"}.')
                    return
                conf = {"command": command, "args": args}
                if env:
                    conf["env"] = env
        except ValueError as e:
            err.update(f"⚠ Invalid JSON: {e}")
            return

        ok = config.add_mcp_server(self.project_path, name, conf)
        if not ok:
            err.update("⚠ Failed to write mcp.json.")
            return
        err.update("")
        # Reload config so the new card renders, then rebuild the pane
        if self.mcp_manager:
            self._mcp_servers = self.mcp_manager.load_config().get("mcpServers", {})
        else:
            self._mcp_servers = {**self._mcp_servers, name: conf}
        self.app.notify(f"✓ '{name}' added — connecting…", severity="information")
        self._schedule_pane_rebuild()
        if self.mcp_manager:
            async def _connect():
                await self.mcp_manager.start_server(name)
                self._update_mcp_card_state(name)
            # Defer the connect so it runs after the (deferred) pane rebuild
            self.call_after_refresh(
                lambda: self.run_worker(_connect(), group="settings"))

    def on_mount(self):
        self.run_worker(self._refresh_usage("all"), group="settings")
        # Live MCP status: cheap liveness poll while the screen is open so a
        # crashed server flips to 'error' (and shows its stderr) without a
        # full reload. Only repaints when something actually changed.
        try:
            self._status_timer = self.set_interval(2.0, self._poll_mcp_status)
        except Exception:
            self._status_timer = None
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
            if platform.system() == "Windows":
                from andromity.core.context_menu import is_context_menu_installed
                self.query_one("#setting-context-menu", Switch).value = is_context_menu_installed()
        except Exception:
            pass

    def on_unmount(self) -> None:
        """Cancel in-flight workers and the live-status timer so nothing
        touches widgets after the screen is dismissed (same guard as Skills)."""
        try:
            timer = getattr(self, "_status_timer", None)
            if timer is not None:
                timer.stop()
        except Exception:
            pass
        try:
            self._workers.cancel_group(self, group="settings")
        except Exception:
            pass

    # ── Navigation ────────────────────────────────────────────────────────────

    def on_list_view_selected(self, event: ListView.Selected):
        nav_id = event.item.id
        if nav_id == "nav-skills":
            # Skills get their own screen so settings.py stays small.
            from andromity.tui.overlays.skills import SkillsScreen
            self.app.push_screen(SkillsScreen(self.project_path))
            return
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
        # Re-read config so badge/toggle reflect the persisted disabled flag
        if self.mcp_manager:
            try:
                self._mcp_servers = self.mcp_manager.load_config().get("mcpServers", {})
            except Exception:
                pass

        if not self.mcp_manager:
            return

        if enable:
            # Don't re-start if already running
            if server_name in self.mcp_manager.sessions:
                return

            async def _start():
                # Show "⟳ initializing…" while the server boots
                self.mcp_manager.server_status[server_name] = {
                    "status": "initializing", "tools": 0, "error": None, "command": ""}
                self._update_mcp_card_state(server_name)
                await self.mcp_manager.start_server(server_name)
                self._update_mcp_card_state(server_name)
                try:
                    self.app._update_status()
                except Exception:
                    pass
                # Re-read the tool list into the agent's registry
                try:
                    self.app._refresh_agent()
                except Exception:
                    pass

            self.run_worker(_start(), exclusive=False, group="settings")
            return
        else:
            async def _stop():
                await self.mcp_manager.stop_server(server_name)
                self._update_mcp_card_state(server_name)
                try:
                    self.app._update_status()
                except Exception:
                    pass
                # Re-read the tool list into the agent's registry so it no longer
                # sees the disabled server's tools.
                try:
                    self.app._refresh_agent()
                except Exception:
                    pass

            self.run_worker(_stop(), exclusive=False, group="settings")
            return

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

        elif btn_id == "mcp-add-save":
            await self._add_mcp_server()

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
                            self._update_mcp_card_state(k)
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
                    # Refresh every card in place (never re-mounts the card)
                    mcp_conf = self.mcp_manager.load_config().get("mcpServers", {})
                    for srv_name in list(mcp_conf.keys()):
                        self._update_mcp_card_state(srv_name)
                    try:
                        from andromity.tui.panels.chat import ChatPanel
                        self.app.query_one(ChatPanel).add_system_message(
                            f"[green]✓ MCP restarted — {n} server(s) running.[/]")
                    except Exception:
                        pass
                self.run_worker(_restart(), exclusive=True, group="settings")

        elif btn_id.startswith("mcp-restart-"):
            # Per-server restart — preserve all settings state
            s_name = btn_id[len("mcp-restart-"):]
            if not self.mcp_manager:
                return

            # 1. Immediately show "⟳ initializing…" in the badge (in-place)
            self.mcp_manager.server_status[s_name] = {
                "status": "initializing", "tools": 0, "error": None, "command": ""}
            self._update_mcp_card_state(s_name)
            # Disable the restart button while in progress
            try:
                event.button.disabled = True
            except Exception:
                pass

            async def _restart_one(name: str = s_name):
                try:
                    # Stop existing session safely
                    await self.mcp_manager.stop_server(name)
                    
                    self.mcp_manager.server_status[name] = {"status": "initializing", "tools": 0, "error": None, "command": ""}
                    try:
                        self.app._update_status()
                    except Exception:
                        pass

                    # Start fresh (reads config from disk — no re-save needed)
                    await self.mcp_manager.start_server(name)

                    # Refresh just this card (in-place)
                    self._update_mcp_card_state(name)

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
                finally:
                    # Re-enable the restart button (success or failure)
                    try:
                        self.query_one(f"#mcp-restart-{name}", Button).disabled = False
                    except Exception:
                        pass

            self.run_worker(_restart_one(), exclusive=False, group="settings")


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

                    if self.mcp_manager:
                        await self.mcp_manager.stop_server(s_name)
                        # Live-state auth: connect immediately, don't make the
                        # user hunt for a toggle.
                        self.app.notify(
                            f"{s_name}: PAT saved — connecting…",
                            severity="information")
                        async def _connect_after_pat():
                            await self.mcp_manager.start_server(s_name)
                            self._update_mcp_card_state(s_name)
                        self.run_worker(_connect_after_pat(), group="settings")
                        # Card shape changed (remote → mcp-remote): rebuild once
                        # the event settles
                        self._schedule_card_rebuild(s_name)
                        return

                    # Card shape changed (remote → mcp-remote): rebuild once
                    # the event settles
                    self._schedule_card_rebuild(s_name)
                else:
                    self.app.notify("Failed to save token.", severity="error")
            except Exception as e:
                self.app.notify(f"Error: {e}", severity="error")

        elif btn_id.startswith("mcp-openurl-"):
            # Open server URL in the default browser (always opens the full, un-truncated URL)
            import webbrowser
            s_name = btn_id.replace("mcp-openurl-", "")
            mcp_conf = self.mcp_manager.load_config() if self.mcp_manager else {}
            srv_conf = mcp_conf.get("mcpServers", {}).get(s_name, {})
            if not srv_conf and s_name in self._mcp_servers:
                srv_conf = self._mcp_servers[s_name]
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
                await self.mcp_manager.stop_server(s_name)
                
            self.app.notify(f"{s_name}: OAuth token revoked.", severity="information")
            self._update_mcp_card_state(s_name)

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
                    
                self._update_mcp_card_state(s_name)
                try:
                    self.app._update_status()
                except Exception:
                    pass

            self.run_worker(_do_oauth(), exclusive=False, group="settings")






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
                        # Credentials section rows changed — rebuild the card
                        self._schedule_card_rebuild(s_name)
                    else:
                        self.app.notify("Value is empty.", severity="warning")
                except Exception as e:
                    self.app.notify(f"Error: {e}", severity="error")

        elif btn_id.startswith("mcp-remove-"):
            # Remove / uninstall a server from mcp.json
            s_name = btn_id.replace("mcp-remove-", "")
            # Stop if running
            if self.mcp_manager:
                await self.mcp_manager.stop_server(s_name)
            ok = config.remove_mcp_server(self.project_path, s_name)
            if ok:
                self._mcp_servers.pop(s_name, None)
                self.app.notify(f"{s_name} removed from MCP config.",
                                severity="information")
                # Rebuild the pane so the card disappears (keeps add/remove
                # consistent with the live config). Deferred so the removal
                # never happens while a click is mid-flight.
                self._schedule_pane_rebuild()
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
                providers = config.get_root("providers", [])
                updated = False
                for p in providers:
                    if p.get("name") == "ollama":
                        p["base_url"] = url
                        updated = True
                        break
                if not updated:
                    providers.append({"name": "ollama", "type": "ollama", "base_url": url})
                config.set_root("providers", providers)
        except Exception:
            pass

        # 5. Debug / dry-run / telemetry
        try:
            app = self.app
            app._debug_mode  = self.query_one("#setting-debug",  Switch).value
            app.agent.dry_run = self.query_one("#setting-dryrun", Switch).value
            telemetry_enabled = self.query_one("#setting-telemetry", Switch).value
            config.set("default", "telemetry", telemetry_enabled)
            
            expand_tools = self.query_one("#setting-auto-expand-tools", Switch).value
            config.set("default", "expand_tools_while_working", expand_tools)
            
            sound_attn = self.query_one("#setting-sound-attention", Switch).value
            config.set("default", "sound_attention", sound_attn)
            sound_done = self.query_one("#setting-sound-done", Switch).value
            config.set("default", "sound_done", sound_done)

            if platform.system() == "Windows":
                ctx_enabled = self.query_one("#setting-context-menu", Switch).value
                from andromity.core.context_menu import install_context_menu, remove_context_menu, is_context_menu_installed
                if ctx_enabled != is_context_menu_installed():
                    if ctx_enabled:
                        install_context_menu()
                    else:
                        remove_context_menu()
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
            # Never let a modal's Esc bubble to the app (it cancels streaming).
            event.stop()
            self.dismiss(False)

    @on(Button.Pressed, ".usage-tab-btn")
    def on_usage_tab_pressed(self, event: Button.Pressed):
        btn_id = event.button.id
        for b in self.query(".usage-tab-btn"):
            b.remove_class("active")
        event.button.add_class("active")
        if btn_id == "usage-tab-today": rng = "today"
        elif btn_id == "usage-tab-week": rng = "week"
        elif btn_id == "usage-tab-month": rng = "month"
        else: rng = "all"
        self._usage_time_range = rng
        self.run_worker(self._refresh_usage(), group="settings")

    @on(Button.Pressed, ".usage-metric-btn")
    def on_usage_metric_pressed(self, event: Button.Pressed):
        btn_id = event.button.id
        for b in self.query(".usage-metric-btn"):
            b.remove_class("active")
        event.button.add_class("active")
        self._usage_metric = "tokens" if btn_id == "usage-metric-tokens" else "cost"
        self.run_worker(self._refresh_usage(), group="settings")

    async def _refresh_usage(self, time_range: str = None, metric: str = None):
        if time_range:
            self._usage_time_range = time_range
        if metric:
            self._usage_metric = metric
        from andromity.core.usage_tracker import UsageTracker
        tracker = UsageTracker()
        summary = tracker.get_summary(self._usage_time_range, self.project_path)
        if not self.is_attached:
            return  # screen dismissed while loading usage
        try:
            area = self.query_one("#usage-content-area", Vertical)
            await area.query("*").remove()
            
            if summary.total_sessions == 0:
                await area.mount(Label("No usage data found for this period.", classes="usage-empty"))
                return
                
            # Top Stats
            total_cost = summary.total_cost_usd
            if total_cost == 0.0:
                cost_text = "$0.00"
            elif total_cost < 0.01:
                cost_text = f"${total_cost:.4f}"
            else:
                cost_text = f"${total_cost:.2f}"

            stats_row = Horizontal(
                Vertical(
                    Label("Total Cost", classes="usage-stat-label"),
                    Label(cost_text, classes="usage-stat-value"),
                    classes="usage-stat-card"
                ),
                Vertical(
                    Label("Tokens", classes="usage-stat-label"),
                    Label(self._fmt_tokens(summary.total_tokens), classes="usage-stat-value"),
                    classes="usage-stat-card"
                ),
                Vertical(
                    Label("Sessions", classes="usage-stat-label"),
                    Label(str(summary.total_sessions), classes="usage-stat-value"),
                    classes="usage-stat-card"
                ),
                classes="usage-stat-row"
            )
            await area.mount(stats_row)
                    
            # Chart
            if PlotextPlot and summary.by_model:
                await area.mount(UsageChart(summary.by_model, metric=self._usage_metric))

            # By Model Table
            sort_label = "Tokens" if self._usage_metric == "tokens" else "Cost"
            await area.mount(Label(f"Usage by Model (Sorted by {sort_label})", classes="usage-section-title"))
            hdr = Horizontal(
                Label("Model / Provider", classes="usage-tbl-hdr-name"),
                Label("Sessions", classes="usage-tbl-hdr-count"),
                Label("Tokens", classes="usage-tbl-hdr-tok"),
                Label("Cost", classes="usage-tbl-hdr-cost"),
                classes="usage-tbl-header"
            )
            await area.mount(hdr)

            if self._usage_metric == "tokens":
                sorted_models = sorted(
                    summary.by_model.items(),
                    key=lambda x: (x[1].get("tokens", 0), x[1].get("cost", 0.0)),
                    reverse=True
                )
            else:
                sorted_models = sorted(
                    summary.by_model.items(),
                    key=lambda x: (x[1].get("cost", 0.0), x[1].get("tokens", 0)),
                    reverse=True
                )

            # Build all rows first, then mount in a single batch for instant rendering
            rows = []
            for m, stats in sorted_models:
                provider = stats.get("provider", "")
                disp = f"{provider} / {m}" if provider and provider != "unknown" else m
                full_name = disp
                cost = stats.get("cost", 0.0)
                is_free = (":free" in m.lower() or str(provider).lower() in ("ollama", "local"))
                if cost > 0:
                    cost_str = f"${cost:.4f}" if cost < 0.01 else f"${cost:.2f}"
                elif is_free:
                    cost_str = "$0.00 (Free)"
                else:
                    cost_str = "$0.00 (Free / Unpriced)" if stats.get("tokens", 0) > 0 else "$0.00"
                name_label = Label(self._truncate_name(disp), classes="usage-model-name")
                name_label.tooltip = full_name
                rows.append(Horizontal(
                    name_label,
                    Label(str(stats.get("sessions", 0)), classes="usage-model-count"),
                    Label(self._fmt_tokens(stats.get("tokens", 0)), classes="usage-model-tok"),
                    Label(cost_str, classes="usage-model-cost"),
                    classes="usage-model-row"
                ))
            if rows:
                await area.mount_all(rows)
            else:
                await area.mount(Label("No model data available.", classes="usage-empty"))
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"Usage render error: {e}")

    def _fmt_tokens(self, val: int) -> str:
        if val >= 1_000_000:
            return f"{val/1_000_000:.1f}M"
        if val >= 1_000:
            return f"{val/1_000:.1f}k"
        return str(val)

    @staticmethod
    def _truncate_name(name: str, limit: int = 46) -> str:
        return name if len(name) <= limit else name[:limit - 1] + "…"
