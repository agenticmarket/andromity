import asyncio
import pytest
from unittest.mock import patch, MagicMock
from andromity.tui.app import AndromityApp

def get_resolved_future():
    f = asyncio.Future()
    f.set_result(True)
    return f

@pytest.mark.asyncio
async def test_permission_mode_yolo():
    app = AndromityApp()
    with patch("andromity.tui.app.config.get", return_value="yolo"):
        assert await app._on_tool_approval("shell_exec", {"command": "rm -rf /"}) is True
        assert await app._on_tool_approval("edit_file", {"path": ".env"}) is True

@pytest.mark.asyncio
async def test_permission_mode_safe():
    app = AndromityApp()
    with patch("andromity.tui.app.config.get", return_value="safe"):
        with patch.object(app, "query_one", return_value=MagicMock()):
            with patch("asyncio.Future", return_value=get_resolved_future()) as mock_future:
                await app._on_tool_approval("edit_file", {"path": "safe.py"})
                mock_future.assert_called_once()
                mock_future.reset_mock()
                
                await app._on_tool_approval("shell_exec", {"command": "ls"})
                mock_future.assert_called_once()
                mock_future.reset_mock()
                
                await app._on_tool_approval("read_file", {"path": ".env"})
                mock_future.assert_called_once()
                mock_future.reset_mock()

@pytest.mark.asyncio
async def test_permission_mode_trust():
    app = AndromityApp()
    def mock_config_get(section, key, default=None):
        if key == "permission_mode": return "trust"
        if key == "allowed_commands": return ["npm test", "git status"]
        return default
        
    with patch("andromity.tui.app.config.get", side_effect=mock_config_get):
        with patch.object(app, "query_one", return_value=MagicMock()):
            with patch("asyncio.Future", return_value=get_resolved_future()) as mock_future:
                await app._on_tool_approval("edit_file", {"path": "safe.py"})
                mock_future.assert_not_called()
                
                await app._on_tool_approval("edit_file", {"path": ".env"})
                mock_future.assert_called_once()
                mock_future.reset_mock()
                
                await app._on_tool_approval("shell_exec", {"command": "npm test"})
                mock_future.assert_not_called()
                
                await app._on_tool_approval("shell_exec", {"command": "rm -rf /"})
                mock_future.assert_called_once()
