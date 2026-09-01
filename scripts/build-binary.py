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
temp_dist = os.path.join(ROOT, "dist-server", platform_key)
build_dir = os.path.join(ROOT, ".pyinstaller-build")
os.makedirs(temp_dist, exist_ok=True)
os.makedirs(out_dir, exist_ok=True)

print(f"Building andromity-server for {platform_key} -> {temp_dist}")

# Install package + pyinstaller deps
subprocess.check_call([sys.executable, "-m", "pip", "install", "-e", ".", "--quiet", "--no-warn-script-location"], cwd=ROOT)
subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller", "--quiet", "--no-warn-script-location"], cwd=ROOT)

# Build into temp_dist
subprocess.check_call([
    sys.executable, "-m", "PyInstaller",
    SPEC,
    "--distpath", temp_dist,
    "--workpath", build_dir,
    "--noconfirm",
], cwd=ROOT)

# Copy to target out_dir with graceful process termination
def robust_copy(src_root, out_dir):
    for attempt in range(5):
        if sys.platform == "win32":
            try:
                subprocess.run(["taskkill", "/F", "/IM", "andromity-server.exe"], capture_output=True)
            except Exception:
                pass
            import time
            time.sleep(0.5)
        try:
            for item in os.listdir(src_root):
                src_fp = os.path.join(src_root, item)
                dst_fp = os.path.join(out_dir, item)
                if os.path.isdir(dst_fp):
                    shutil.rmtree(dst_fp, ignore_errors=True)
                elif os.path.exists(dst_fp):
                    try:
                        os.remove(dst_fp)
                    except Exception:
                        pass
                if os.path.isdir(src_fp):
                    shutil.copytree(src_fp, dst_fp, dirs_exist_ok=True)
                else:
                    shutil.copy2(src_fp, dst_fp)
            return
        except Exception as e:
            if attempt == 4:
                raise
            import time
            time.sleep(1.0)

# If PyInstaller created a subdirectory named 'andromity-server', copy its contents
src_root = os.path.join(temp_dist, "andromity-server")
if not os.path.exists(src_root):
    src_root = temp_dist

robust_copy(src_root, out_dir)

print(f"\n[OK] Onedir binary bundle built and deployed at: {out_dir}")
for f in os.listdir(out_dir):
    fp = os.path.join(out_dir, f)
    if os.path.isdir(fp):
        print(f"  {f}/ (dir)")
    else:
        print(f"  {f}  ({os.path.getsize(fp) // 1024} KB)")
