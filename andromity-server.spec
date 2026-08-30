# andromity-server.spec
# PyInstaller spec to build a standalone andromity-server binary.
# Usage: pyinstaller andromity-server.spec
# Output: dist/andromity-server.exe (Windows) or dist/andromity-server (Unix)

import sys
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# Collect all andromity submodules and data files
andromity_datas, andromity_binaries, andromity_hiddenimports = collect_all('andromity')

# Also collect textual's data files (CSS, fonts, etc.)
textual_datas, textual_binaries, textual_hiddenimports = collect_all('textual')

# Collect litellm's data files (model pricing json, token tables, etc.)
litellm_datas, litellm_binaries, litellm_hiddenimports = collect_all('litellm')

a = Analysis(
    ['src/andromity/server/__main__.py'],  # entry point
    pathex=['src'],
    binaries=andromity_binaries + textual_binaries + litellm_binaries,
    datas=andromity_datas + textual_datas + litellm_datas,
    hiddenimports=(
        andromity_hiddenimports +
        textual_hiddenimports +
        litellm_hiddenimports +
        collect_submodules('andromity') +
        collect_submodules('litellm') +
        ['litellm.llms', 'litellm.utils', 'httpx', 'pydantic', 'rich', 'asyncio']
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'unittest', 'test', 'lib2to3'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='andromity-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # Disable UPX to prevent antivirus false positives
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,       # console app (no GUI)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
