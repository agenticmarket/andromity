# andromity-server.spec
# PyInstaller spec to build a standalone andromity-server binary.
# Usage: pyinstaller andromity-server.spec
# Output: dist/andromity-server.exe (Windows) or dist/andromity-server (Unix)

import sys
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules, collect_data_files

block_cipher = None

# Collect all andromity submodules and data files
andromity_datas, andromity_binaries, andromity_hiddenimports = collect_all('andromity')

# Also collect textual's data files (CSS, fonts, etc.)
textual_datas, textual_binaries, textual_hiddenimports = collect_all('textual')

# Collect litellm's data files (model pricing json, token tables, etc.)
litellm_datas, litellm_binaries, litellm_hiddenimports = collect_all('litellm')

# Collect tiktoken dynamically loaded extensions
tiktoken_datas, tiktoken_binaries, tiktoken_hiddenimports = collect_all('tiktoken')
tiktoken_ext_datas, tiktoken_ext_binaries, tiktoken_ext_hiddenimports = collect_all('tiktoken_ext')

# Collect fastuuid, jsonschema_specifications, mcp, referencing, rpds, pydantic_core
fastuuid_datas, fastuuid_binaries, fastuuid_hiddenimports = collect_all('fastuuid')
jsonschema_specs_datas, jsonschema_specs_binaries, jsonschema_specs_hidden = collect_all('jsonschema_specifications')
referencing_datas, referencing_binaries, referencing_hiddenimports = collect_all('referencing')
rpds_datas, rpds_binaries, rpds_hiddenimports = collect_all('rpds')
pydantic_core_datas, pydantic_core_binaries, pydantic_core_hidden = collect_all('pydantic_core')

import importlib.util
def collect_native_binaries(pkg_name):
    try:
        spec = importlib.util.find_spec(pkg_name)
        if spec and spec.submodule_search_locations:
            pkg_path = list(spec.submodule_search_locations)[0]
            collected = []
            for root, _, files in os.walk(pkg_path):
                rel_dir = os.path.relpath(root, os.path.dirname(pkg_path))
                for f in files:
                    if f.endswith(('.pyd', '.so', '.dylib', '.dll')):
                        collected.append((os.path.join(root, f), rel_dir))
            return collected
    except Exception:
        pass
    return []

extra_native_binaries = (
    collect_native_binaries('rpds') +
    collect_native_binaries('fastuuid') +
    collect_native_binaries('tiktoken') +
    collect_native_binaries('tiktoken_ext') +
    collect_native_binaries('pydantic_core')
)

mcp_datas = collect_data_files('mcp')
mcp_hiddenimports = (
    collect_submodules('mcp.server') +
    collect_submodules('mcp.client') +
    collect_submodules('mcp.types') +
    collect_submodules('mcp.shared')
)

a = Analysis(
    ['src/andromity/server/__main__.py'],  # entry point
    pathex=['src'],
    binaries=andromity_binaries + textual_binaries + litellm_binaries + tiktoken_binaries + tiktoken_ext_binaries + fastuuid_binaries + jsonschema_specs_binaries + referencing_binaries + rpds_binaries + pydantic_core_binaries + extra_native_binaries,
    datas=andromity_datas + textual_datas + litellm_datas + tiktoken_datas + tiktoken_ext_datas + fastuuid_datas + jsonschema_specs_datas + mcp_datas + referencing_datas + rpds_datas + pydantic_core_datas + [('src/andromity/core/schema.sql', 'andromity/core')],
    hiddenimports=(
        andromity_hiddenimports +
        textual_hiddenimports +
        litellm_hiddenimports +
        tiktoken_hiddenimports +
        tiktoken_ext_hiddenimports +
        fastuuid_hiddenimports +
        jsonschema_specs_hidden +
        mcp_hiddenimports +
        referencing_hiddenimports +
        rpds_hiddenimports +
        pydantic_core_hidden +
        collect_submodules('andromity') +
        collect_submodules('litellm') +
        collect_submodules('fastuuid') +
        collect_submodules('rpds') +
        # _overlapped is Windows-only (part of asyncio's Windows proactor event loop);
        # including it on Linux/macOS causes a PyInstaller hook error.
        (['_overlapped'] if sys.platform == 'win32' else []) +
        ['_asyncio', '_sqlite3', 'sqlite3', 'litellm.llms', 'litellm.utils', 'litellm.litellm_core_utils.tokenizers', 'httpx', 'pydantic', 'rich', 'asyncio',
         'tiktoken._tiktoken', 'fastuuid.fastuuid', 'rpds.rpds']
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
    [],
    exclude_binaries=True,
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

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='andromity-server',
)
