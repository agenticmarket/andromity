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
try:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-e", ".", "--quiet", "--no-warn-script-location"], cwd=ROOT)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller", "--quiet", "--no-warn-script-location"], cwd=ROOT)
except Exception:
    import shutil
    uv_path = shutil.which("uv")
    if uv_path:
        subprocess.check_call([uv_path, "pip", "install", "-e", ".", "--quiet"], cwd=ROOT)
        subprocess.check_call([uv_path, "pip", "install", "pyinstaller", "--quiet"], cwd=ROOT)
    else:
        raise

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
            time.sleep(0.8)
        try:
            for root, dirs, files in os.walk(src_root):
                rel_path = os.path.relpath(root, src_root)
                target_dir = os.path.join(out_dir, rel_path) if rel_path != "." else out_dir
                os.makedirs(target_dir, exist_ok=True)
                for f in files:
                    s = os.path.join(root, f)
                    d = os.path.join(target_dir, f)
                    try:
                        shutil.copy2(s, d)
                    except PermissionError:
                        pass  # Unmodified DLL currently loaded in memory
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

# Remove botocore documentation-only data files that are never loaded at runtime
# but trigger false-positive secret scanner alerts on Open VSX (rule: square-access-token etc.)
_BOTOCORE_DATA = os.path.join(out_dir, "_internal", "botocore", "data")
if os.path.isdir(_BOTOCORE_DATA):
    _removed = 0
    for root, dirs, files in os.walk(_BOTOCORE_DATA):
        for fname in files:
            if fname in ("examples-1.json", "completions-1.json"):
                try:
                    os.remove(os.path.join(root, fname))
                    _removed += 1
                except Exception:
                    pass
    if _removed:
        print(f"[Cleanup] Removed {_removed} botocore documentation files (examples/completions) - runtime unaffected.")

print(f"\n[OK] Onedir binary bundle built and deployed at: {out_dir}")
for f in os.listdir(out_dir):
    fp = os.path.join(out_dir, f)
    if os.path.isdir(fp):
        print(f"  {f}/ (dir)")
    else:
        print(f"  {f}  ({os.path.getsize(fp) // 1024} KB)")

