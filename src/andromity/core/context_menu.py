"""Windows Context Menu integration for Andromity.

Enables 'Open in Andromity' when right-clicking folders, drives, or empty directory background in File Explorer.
Operates exclusively under HKEY_CURRENT_USER (safe, no Administrator permissions required).
"""
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Optional, Tuple

from andromity.config import config, get_config_dir
from andromity.core.debug_log import get_logger

log = get_logger("context_menu")

MENU_LABEL = "Open with Andromity"
REGISTRY_TARGETS = [
    r"Directory\shell\Andromity",
    r"Directory\Background\shell\Andromity",
    r"Drive\shell\Andromity",
]


def _refresh_shell_icons() -> None:
    """Notify Windows Explorer that shell associations/icons have changed to refresh cache."""
    if platform.system() != "Windows":
        return
    try:
        import ctypes
        # SHCNE_ASSOCCHANGED = 0x08000000, SHCNF_IDLIST = 0x0000
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0x0000, None, None)
    except Exception as e:
        log.debug("SHChangeNotify failed: %s", e)


def _get_icon_path(custom_icon: Optional[str] = None) -> Optional[str]:
    """Find or extract the best available icon file and guarantee it's on disk for Windows Explorer.
    
    Uses ~/.andromity/andromity.ico to avoid MSIX / Windows Store Python VFS AppData redirection,
    ensuring explorer.exe can always read the icon file directly from disk.
    """
    home_dir = Path.home() / ".andromity"
    home_icon = home_dir / "andromity.ico"
    config_dir_icon = get_config_dir() / "andromity.ico"

    if custom_icon and os.path.exists(custom_icon):
        try:
            home_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(custom_icon, str(home_icon))
            return str(home_icon)
        except Exception:
            return os.path.abspath(custom_icon)

    candidate_sources = [
        # Package assets (src/andromity/assets/andromity.ico)
        Path(__file__).resolve().parent.parent / "assets" / "andromity.ico",
        # Repo root when running in development / editable mode
        Path(__file__).resolve().parents[2] / "andromity.ico" if len(Path(__file__).resolve().parents) > 2 else None,
        Path(__file__).resolve().parents[3] / "andromity.ico" if len(Path(__file__).resolve().parents) > 3 else None,
        # AppData icon if it exists
        config_dir_icon if config_dir_icon.exists() else None,
        # Current working directory
        Path.cwd() / "andromity.ico",
        # Next to executable or sys.prefix
        Path(sys.executable).parent / "andromity.ico",
        Path(sys.prefix) / "share" / "andromity" / "andromity.ico",
    ]

    # Try importlib.resources as well
    try:
        import importlib.resources as pkg_resources
        res = pkg_resources.files("andromity").joinpath("assets", "andromity.ico")
        if res and hasattr(res, "is_file") and res.is_file():
            candidate_sources.insert(0, Path(str(res)))
    except Exception:
        pass

    for candidate in candidate_sources:
        if candidate and candidate.exists() and candidate.is_file() and candidate.stat().st_size > 0:
            try:
                home_dir.mkdir(parents=True, exist_ok=True)
                if not home_icon.exists() or home_icon.stat().st_size != candidate.stat().st_size:
                    shutil.copy2(str(candidate), str(home_icon))
                # Also try to copy to config_dir if different
                try:
                    get_config_dir().mkdir(parents=True, exist_ok=True)
                    if not config_dir_icon.exists() or config_dir_icon.stat().st_size != candidate.stat().st_size:
                        shutil.copy2(str(candidate), str(config_dir_icon))
                except Exception:
                    pass
                return str(home_icon)
            except Exception:
                return str(candidate)

    if home_icon.exists() and home_icon.stat().st_size > 0:
        return str(home_icon)

    if config_dir_icon.exists() and config_dir_icon.stat().st_size > 0:
        return str(config_dir_icon)

    # Fallback: if running standalone without asset files, attempt to fetch icon from GitHub
    try:
        import urllib.request
        home_dir.mkdir(parents=True, exist_ok=True)
        url = "https://raw.githubusercontent.com/agenticmarket/andromity/main/andromity.ico"
        urllib.request.urlretrieve(url, str(home_icon))
        if home_icon.exists() and home_icon.stat().st_size > 0:
            return str(home_icon)
    except Exception:
        pass

    return str(home_icon) if home_icon.exists() else None


def _get_command_string() -> str:
    """Build the launch command string for Windows Explorer."""
    andromity_bin = shutil.which("andromity")
    wt_bin = shutil.which("wt.exe") or shutil.which("wt")

    if wt_bin:
        # Prefer Windows Terminal if available
        if andromity_bin:
            return f'wt.exe -d "%V" andromity'
        else:
            return f'wt.exe -d "%V" "{sys.executable}" -m andromity.cli'
    else:
        # Fallback to standard command prompt / PowerShell
        if andromity_bin:
            return f'cmd.exe /k "cd /d \"%V\" && andromity"'
        else:
            return f'cmd.exe /k "cd /d \"%V\" && \"{sys.executable}\" -m andromity.cli"'


def is_context_menu_installed() -> bool:
    """Check if 'Open with Andromity' is registered in HKCU."""
    if platform.system() != "Windows":
        return False

    try:
        import winreg
        key_path = rf"Software\Classes\{REGISTRY_TARGETS[0]}"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ):
            return True
    except (FileNotFoundError, OSError, Exception):
        return False


def install_context_menu(icon_path: Optional[str] = None) -> Tuple[bool, str]:
    r"""Register 'Open with Andromity' in the current user's Windows registry.
    
    Safe: writes only to HKEY_CURRENT_USER\Software\Classes (no admin rights needed).
    """
    if platform.system() != "Windows":
        return False, "Context menu integration is only supported on Windows."

    try:
        import winreg

        icon = _get_icon_path(icon_path)
        cmd_str = _get_command_string()

        for target in REGISTRY_TARGETS:
            # 1. Create/open the main shell key (e.g. Directory\shell\Andromity)
            key_path = rf"Software\Classes\{target}"
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, MENU_LABEL)
                if icon:
                    winreg.SetValueEx(key, "Icon", 0, winreg.REG_SZ, icon)
                winreg.SetValueEx(key, "Position", 0, winreg.REG_SZ, "Top")

            # 2. Create the command subkey
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{key_path}\command") as cmd_key:
                winreg.SetValueEx(cmd_key, "", 0, winreg.REG_SZ, cmd_str)

        config.set("default", "context_menu_installed", True)
        _refresh_shell_icons()
        log.info("Context menu installed successfully")
        return True, "Successfully added 'Open with Andromity' to Windows context menu."
    except Exception as e:
        log.error("Failed to install context menu: %s", e)
        return False, f"Failed to install context menu: {e}"


def remove_context_menu() -> Tuple[bool, str]:
    """Remove 'Open with Andromity' from the current user's Windows registry."""
    if platform.system() != "Windows":
        return False, "Context menu integration is only supported on Windows."

    try:
        import winreg

        for target in REGISTRY_TARGETS:
            key_path = rf"Software\Classes\{target}"
            # Delete command subkey first
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"{key_path}\command")
            except (FileNotFoundError, OSError):
                pass
            # Delete main key
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            except (FileNotFoundError, OSError):
                pass

        config.set("default", "context_menu_installed", False)
        _refresh_shell_icons()
        log.info("Context menu removed successfully")
        return True, "Successfully removed 'Open with Andromity' from Windows context menu."
    except Exception as e:
        log.error("Failed to remove context menu: %s", e)
        return False, f"Failed to remove context menu: {e}"


def maybe_auto_install_context_menu() -> bool:
    """Auto-install or self-heal context menu on launch on Windows."""
    if platform.system() != "Windows":
        return False

    already_decided = config.get("default", "context_menu_installed", None)
    if already_decided is None:
        ok, _ = install_context_menu()
        return ok
    elif already_decided is True:
        # Self-healing: check if icon file or registry is missing
        home_icon = Path.home() / ".andromity" / "andromity.ico"
        if not home_icon.exists() or not is_context_menu_installed():
            ok, _ = install_context_menu()
            return ok
    return False
