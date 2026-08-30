#!/usr/bin/env python3
"""
Build script: produces andromity-server binaries for all platforms.
Run from the repo root: python scripts/build-binary.py

On Windows:   produces vscode-extension/bin/win32-x64/andromity-server.exe
On macOS:     produces vscode-extension/bin/darwin-x64/andromity-server (or darwin-arm64)
On Linux:     produces vscode-extension/bin/linux-x64/andromity-server

CI usage (GitHub Actions):
  - Run this script on ubuntu-latest, macos-latest, windows-latest
  - Commit / upload the resulting bin/ artifacts into the extension
"""
import os
import sys
import platform
import subprocess
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "andromity-server.spec")

os_name = sys.platform          # win32 | darwin | linux
arch = platform.machine().lower()  # amd64 / x86_64 → x64, arm64
arch = "arm64" if "arm" in arch else "x64"
platform_key = f"{os_name.replace('win32','win32')}-{arch}"

out_dir = os.path.join(ROOT, "vscode-extension", "bin", platform_key)
build_dir = os.path.join(ROOT, ".pyinstaller-build")

print(f"Building andromity-server for {platform_key} → {out_dir}")

# Install package + pyinstaller deps
subprocess.check_call([sys.executable, "-m", "pip", "install", ".", "--quiet", "--no-warn-script-location"], cwd=ROOT)
subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller", "--quiet", "--no-warn-script-location"], cwd=ROOT)

# Build
subprocess.check_call([
    sys.executable, "-m", "PyInstaller",
    SPEC,
    "--distpath", out_dir,
    "--workpath", build_dir,
    "--noconfirm",
], cwd=ROOT)

print(f"\n✓ Binary built at: {out_dir}")
for f in os.listdir(out_dir):
    fp = os.path.join(out_dir, f)
    print(f"  {f}  ({os.path.getsize(fp) // (1024*1024)} MB)")
