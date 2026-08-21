"""Tests for the Settings → MCP pane.

Covers the live server controls:
  - seamless toggle on/off (config persisted, session started/stopped)
  - badge/tool-count live updates WITHOUT removing/re-mounting the card
  - rapid re-clicks after a toggle never crash Textual (regression for
    `AttributeError: 'NoneType' object has no attribute 'region'`)
  - restart-all and the crash-detection poll update cards in place
"""
import asyncio
import json
from pathlib import Path

import pytest
from textual.app import App, ComposeResult
from textual.widgets import (
    Button, Collapsible, ContentSwitcher, Label, Static, Switch,
)

from andromity.core.mcp import MCPToolInfo
from andromity.tui.overlays.settings import SettingsScreen


class StubSession:
    def __init__(self, name, tools=None):
        self.name = name
        self.tools = tools or []
        self.running = True

    async def stop(self):
        self.running = False


class StubManager:
    """Minimal stand-in for MCPClientManager with file-backed load_config."""

    def __init__(self, project_path: Path, servers: dict):
        self.project_path = Path(project_path)
        self.servers = dict(servers)
        self.tool_pool: dict = {}  # tools a server exposes when started
        self.sessions: dict = {}
        self.server_status: dict = {}
        self.refresh_from_servers()

    def refresh_from_servers(self):
        self.sessions.clear()
        self.server_status.clear()
        for name, conf in self.servers.items():
            if conf.get("disabled"):
                self.server_status[name] = {
                    "status": "disabled", "tools": 0, "error": None, "command": ""}
            else:
                self.sessions[name] = StubSession(name, self.tool_pool.get(name))
                self.server_status[name] = {
                    "status": "running", "tools": 0, "error": None, "command": ""}

    def load_config(self) -> dict:
        """Mirror MCPClientManager.load_config: read from disk."""
        p = self.project_path / ".andromity" / "mcp.json"
        if p.is_file():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                servers = data.get("mcpServers") or data.get("servers") or {}
                self.servers = dict(servers)
            except Exception:
                pass
        return {"mcpServers": dict(self.servers)}

    async def start_server(self, name):
        # Simulates the stdio handshake discovering the server's tools
        self.sessions[name] = StubSession(name, self.tool_pool.get(name))
        self.server_status[name] = {
            "status": "running", "tools": 0, "error": None, "command": ""}

    async def stop_server(self, name: str):
        session = self.sessions.pop(name, None)
        if session:
            await session.stop()
        self.server_status.pop(name, None)

    async def stop_all(self):
        for s in self.sessions.values():
            await s.stop()
        self.sessions.clear()
        self.server_status.clear()

    async def start_all(self):
        self.load_config()
        for name, conf in self.servers.items():
            if not conf.get("disabled"):
                await self.start_server(name)

    def check_liveness(self):
        changed = []
        for name, s in list(self.sessions.items()):
            if not s.running:
                self.server_status[name] = {
                    "status": "error", "tools": 0, "error": "Process exited unexpectedly",
                    "command": self.server_status.get(name, {}).get("command", "")}
                del self.sessions[name]
                changed.append(name)
        return changed


class Host(App):
    def compose(self) -> ComposeResult:
        yield Static("host")


def _write_config(tmp_path: Path, servers: dict):
    (tmp_path / ".andromity").mkdir(exist_ok=True)
    (tmp_path / ".andromity" / "mcp.json").write_text(
        json.dumps({"mcpServers": servers}), encoding="utf-8")


def _tools(n=2):
    return [
        MCPToolInfo(server_name="srv", name=f"tool_{i}",
                    description=f"desc {i}", input_schema={})
        for i in range(n)
    ]


def _switch(app: App, name: str) -> Switch:
    return app.screen.query_one(f"#mcp-toggle-{name}", Switch)


def _badge(app: App, name: str) -> Label:
    return app.screen.query_one(f"#mcp-badge-{name}", Label)


def _badge_text(app: App, name: str) -> str:
    return str(_badge(app, name).render()).strip()


def _setup(tmp_path, monkeypatch, servers, tools=None):
    """Temp project + isolated config + stub manager wired to the file."""
    _write_config(tmp_path, servers)
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    from andromity.config import config
    monkeypatch.setattr(config, "config_dir", tmp_path)
    monkeypatch.setattr(config, "config_path", tmp_path / "config.toml")
    mgr = StubManager(tmp_path, servers)
    if tools is not None:
        mgr.tool_pool = {name: list(tools) for name in mgr.sessions}
        for name in mgr.sessions:
            mgr.sessions[name].tools = list(tools)
    return mgr


@pytest.mark.asyncio
async def test_mcp_toggle_off_stops_server_and_updates_badge(tmp_path, monkeypatch):
    mgr = _setup(tmp_path, monkeypatch, {
        "mockserver": {"command": "python", "args": ["-m", "mock"]},
    })
    app = Host()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        app.push_screen(SettingsScreen(mgr, str(tmp_path)))
        for _ in range(10):
            await pilot.pause()
        app.screen.query_one("#settings-content", ContentSwitcher).current = "pane-mcp"
        for _ in range(6):
            await pilot.pause()

        assert "mockserver" in mgr.sessions
        assert "running" in _badge_text(app, "mockserver")

        # Toggle OFF via a real click on the switch
        switch = _switch(app, "mockserver")
        await pilot.click(switch)
        for _ in range(4):
            await pilot.pause()

        assert "mockserver" not in mgr.sessions, "server must be stopped"
        # config file now has disabled: true
        data = json.loads((tmp_path / ".andromity" / "mcp.json").read_text(encoding="utf-8"))
        assert data["mcpServers"]["mockserver"]["disabled"] is True
        # badge reflects the persisted state, card was NOT rebuilt (same switch)
        assert _switch(app, "mockserver").value is False
        # tools collapsible hidden
        coll = app.screen.query_one("#mcp-tools-mockserver", Collapsible)
        assert coll.display is False or "mcp-hidden" in coll.classes


@pytest.mark.asyncio
async def test_mcp_toggle_on_starts_server_and_shows_tools(tmp_path, monkeypatch):
    mgr = _setup(tmp_path, monkeypatch, {
        "mockserver": {"command": "python", "args": ["-m", "mock"]},
    }, tools=_tools(2))
    app = Host()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        app.push_screen(SettingsScreen(mgr, str(tmp_path)))
        for _ in range(10):
            await pilot.pause()
        app.screen.query_one("#settings-content", ContentSwitcher).current = "pane-mcp"
        for _ in range(6):
            await pilot.pause()

        switch = _switch(app, "mockserver")
        # tool count visible while running
        tc = app.screen.query_one("#mcp-toolcount-mockserver", Label)
        assert "2 tools" in str(tc.render())
        tools_coll = app.screen.query_one("#mcp-tools-mockserver", Collapsible)
        assert tools_coll.display is True

        # Toggle OFF then ON
        await pilot.click(switch)
        for _ in range(4):
            await pilot.pause()
        assert "mockserver" not in mgr.sessions

        await pilot.click(_switch(app, "mockserver"))
        for _ in range(6):
            await pilot.pause()

        assert "mockserver" in mgr.sessions, "server must restart on toggle-on"
        assert "running" in _badge_text(app, "mockserver")
        assert "2 tools" in str(app.screen.query_one("#mcp-toolcount-mockserver", Label).render())


@pytest.mark.asyncio
async def test_mcp_toggle_off_no_crash_on_rapid_reclick(tmp_path, monkeypatch):
    """Regression: removing the card mid-click left the compositor with a
    detached widget and the next MouseDown crashed Textual with
    `'NoneType' object has no attribute 'region'`."""
    from textual import events

    mgr = _setup(tmp_path, monkeypatch, {
        "mockserver": {"command": "python", "args": ["-m", "mock"]},
    })
    app = Host()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        app.push_screen(SettingsScreen(mgr, str(tmp_path)))
        for _ in range(10):
            await pilot.pause()
        app.screen.query_one("#settings-content", ContentSwitcher).current = "pane-mcp"
        for _ in range(6):
            await pilot.pause()

        switch = _switch(app, "mockserver")
        region = app.screen.find_widget(switch).region
        x, y = region.x + region.width // 2, region.y + region.height // 2

        # Toggle OFF
        await app.on_event(events.MouseDown(None, x, y, 0, 0, 1, False, False, False, x, y))
        await app.on_event(events.MouseUp(None, x, y, 0, 0, 1, False, False, False, x, y))
        for _ in range(4):
            await pilot.pause()
        assert "mockserver" not in mgr.sessions

        # Hammer the same spot — used to raise AttributeError in Screen._forward_event
        for _ in range(6):
            await app.on_event(
                events.MouseDown(None, x, y, 0, 0, 1, False, False, False, x, y))
            await pilot.pause()
        # still healthy
        assert _badge_text(app, "mockserver")
        assert "mockserver" not in mgr.sessions


@pytest.mark.asyncio
async def test_mcp_restart_all_updates_badges_in_place(tmp_path, monkeypatch):
    mgr = _setup(tmp_path, monkeypatch, {
        "one": {"command": "python", "args": ["-m", "a"]},
        "two": {"command": "python", "args": ["-m", "b"]},
    })
    app = Host()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        app.push_screen(SettingsScreen(mgr, str(tmp_path)))
        for _ in range(10):
            await pilot.pause()
        app.screen.query_one("#settings-content", ContentSwitcher).current = "pane-mcp"
        for _ in range(6):
            await pilot.pause()

        btn = app.screen.query_one("#mcp-restart-all", Button)
        await pilot.click(btn)
        for _ in range(8):
            await pilot.pause()

        assert set(mgr.sessions) == {"one", "two"}
        for name in ("one", "two"):
            assert "running" in _badge_text(app, name)


@pytest.mark.asyncio
async def test_mcp_poll_flags_crashed_server_and_updates_card(tmp_path, monkeypatch):
    mgr = _setup(tmp_path, monkeypatch, {
        "mockserver": {"command": "python", "args": ["-m", "mock"]},
    })
    app = Host()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        app.push_screen(SettingsScreen(mgr, str(tmp_path)))
        for _ in range(10):
            await pilot.pause()
        app.screen.query_one("#settings-content", ContentSwitcher).current = "pane-mcp"
        for _ in range(6):
            await pilot.pause()

        # Server dies behind the manager's back
        mgr.sessions["mockserver"].running = False

        # The 2s poll timer would call this — call it directly
        app.screen._poll_mcp_status()
        for _ in range(4):
            await pilot.pause()

        assert "mockserver" not in mgr.sessions
        assert "error" in _badge_text(app, "mockserver")
        err_coll = app.screen.query_one("#mcp-error-mockserver", Collapsible)
        assert err_coll.display is True


@pytest.mark.asyncio
async def test_mcp_card_hidden_sections_initially(tmp_path, monkeypatch):
    """Stopped/disabled servers render with tools + error sections hidden —
    the card is never structurally rebuilt on status changes."""
    mgr = _setup(tmp_path, monkeypatch, {
        "off": {"command": "python", "args": ["-m", "x"], "disabled": True},
    })
    app = Host()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        app.push_screen(SettingsScreen(mgr, str(tmp_path)))
        for _ in range(10):
            await pilot.pause()
        app.screen.query_one("#settings-content", ContentSwitcher).current = "pane-mcp"
        for _ in range(6):
            await pilot.pause()

        assert "disabled" in _badge_text(app, "off")
        assert _switch(app, "off").value is False
        tools_coll = app.screen.query_one("#mcp-tools-off", Collapsible)
        assert tools_coll.display is False
        err_coll = app.screen.query_one("#mcp-error-off", Collapsible)
        assert err_coll.display is False


@pytest.mark.asyncio
async def test_mcp_toggle_off_global_config_persists(tmp_path, monkeypatch):
    """Ensure servers located in ~/.gemini/config/mcp_config.json persist disabled: true."""
    gemini_dir = tmp_path / ".gemini" / "config"
    gemini_dir.mkdir(parents=True, exist_ok=True)
    mcp_file = gemini_dir / "mcp_config.json"
    mcp_file.write_text(json.dumps({
        "mcpServers": {
            "global_posthog": {"command": "npx", "args": ["posthog"]}
        }
    }), encoding="utf-8")

    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    from andromity.config import config
    monkeypatch.setattr(config, "config_dir", tmp_path)
    monkeypatch.setattr(config, "config_path", tmp_path / "config.toml")

    mgr = StubManager(tmp_path, {"global_posthog": {"command": "npx", "args": ["posthog"]}})
    app = Host()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause()
        app.push_screen(SettingsScreen(mgr, str(tmp_path)))
        for _ in range(10):
            await pilot.pause()
        app.screen.query_one("#settings-content", ContentSwitcher).current = "pane-mcp"
        for _ in range(6):
            await pilot.pause()

        switch = _switch(app, "global_posthog")
        await pilot.click(switch)
        for _ in range(4):
            await pilot.pause()

        # Check that disabled: true was written to mcp_config.json
        saved = json.loads(mcp_file.read_text(encoding="utf-8"))
        assert saved["mcpServers"]["global_posthog"]["disabled"] is True

