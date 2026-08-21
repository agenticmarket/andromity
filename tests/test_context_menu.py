import os
import platform
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from andromity.config import config
from andromity.core.context_menu import (
    MENU_LABEL,
    REGISTRY_TARGETS,
    _get_command_string,
    _get_icon_path,
    _refresh_shell_icons,
    install_context_menu,
    is_context_menu_installed,
    maybe_auto_install_context_menu,
    remove_context_menu,
)


@pytest.fixture(autouse=True)
def _isolate_env(tmp_path, monkeypatch):
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("andromity.core.context_menu.get_config_dir", lambda: cfg_dir)
    monkeypatch.setattr("andromity.config.get_config_dir", lambda: cfg_dir)
    config._config_cache = {}


def test_get_icon_path_extracts_to_config_dir(tmp_path):
    icon_path = _get_icon_path()
    assert icon_path is not None
    assert Path(icon_path).exists()
    assert Path(icon_path).name == "andromity.ico"
    assert Path(icon_path).stat().st_size > 0


def test_get_icon_path_with_custom_icon(tmp_path):
    custom_ico = tmp_path / "custom.ico"
    custom_ico.write_bytes(b"\x00\x00\x01\x00" + b"\x00" * 100)
    icon_path = _get_icon_path(custom_icon=str(custom_ico))
    assert icon_path is not None
    assert Path(icon_path).exists()


def test_refresh_shell_icons_does_not_crash():
    # Should run cleanly on all platforms without raising
    _refresh_shell_icons()


def test_get_command_string():
    cmd = _get_command_string()
    assert isinstance(cmd, str)
    assert len(cmd) > 0
    assert "andromity" in cmd


@pytest.mark.skipif(platform.system() != "Windows", reason="Windows registry required")
def test_install_and_remove_context_menu_windows():
    ok, msg = install_context_menu()
    assert ok is True
    assert is_context_menu_installed() is True

    # Re-running auto install should not fail
    assert maybe_auto_install_context_menu() is False

    ok_rem, msg_rem = remove_context_menu()
    assert ok_rem is True
    assert is_context_menu_installed() is False

    # Re-install after remove
    ok_re, _ = install_context_menu()
    assert ok_re is True

    # Verify registry Icon property points to an existing file
    import winreg
    for target in REGISTRY_TARGETS:
        key_path = rf"Software\Classes\{target}"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ) as key:
            icon_val, _ = winreg.QueryValueEx(key, "Icon")
            assert icon_val is not None
            assert Path(icon_val).exists()
            assert Path(icon_val).stat().st_size > 0
