"""Validate all release packages before providing registry credentials."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

PLATFORMS = {"win32-x64", "linux-x64", "darwin-arm64"}
LOCK = Path(__file__).resolve().parent.parent / "uv.lock"
DIST_INFO = re.compile(r"extension/bin/[^/]+/_internal/([^/]+)-([^/-]+)\.dist-info/METADATA")


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def locked_versions(lock: Path = LOCK) -> dict[str, set[str]]:
    versions: dict[str, set[str]] = {}
    for package in tomllib.loads(lock.read_text(encoding="utf-8"))["package"]:
        versions.setdefault(normalize(package["name"]), set()).add(package.get("version", ""))
    return versions


def unlocked_dependencies(names: list[str], locked: dict[str, set[str]]) -> list[str]:
    """Bundled packages whose version is not the one recorded in uv.lock."""
    found = []
    for name in names:
        match = DIST_INFO.fullmatch(name)
        if match and normalize(match.group(1)) in locked and match.group(2) not in locked[normalize(match.group(1))]:
            found.append(f"{match.group(1)} {match.group(2)}")
    return found


def validate(directory: Path, version: str, lock: Path = LOCK) -> None:
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Expected a stable extension version.")
    files = list(directory.glob("*.vsix"))
    if len(files) != 3:
        raise ValueError("Expected exactly three platform VSIX files.")
    locked = locked_versions(lock)
    seen = set()
    for file in files:
        with ZipFile(file) as archive:
            for name in ("extension/package.json", "extension.vsixmanifest"):
                if archive.getinfo(name).file_size > 1_000_000:
                    raise ValueError(f"Oversized manifest in {file.name}.")
            package = json.loads(archive.read("extension/package.json"))
            root = ElementTree.fromstring(archive.read("extension.vsixmanifest"))
            identity = root.find("{*}Metadata/{*}Identity")
            if identity is None:
                raise ValueError(f"Missing VSIX identity in {file.name}.")
            platform = identity.get("TargetPlatform")
            if platform not in PLATFORMS or platform in seen:
                raise ValueError(f"Missing, duplicate or unexpected platform in {file.name}.")
            if package.get("publisher") != "agenticmarket" or package.get("name") != "andromity-agent" or package.get("version") != version:
                raise ValueError(f"Wrong package identity/version in {file.name}.")
            if identity.get("Publisher") != "agenticmarket" or identity.get("Id") != "andromity-agent" or identity.get("Version") != version:
                raise ValueError(f"Wrong VSIX manifest identity/version in {file.name}.")
            binary = f"extension/bin/{platform}/andromity-server" + (".exe" if platform == "win32-x64" else "")
            if archive.getinfo(binary).file_size < 1_000_000:
                raise ValueError(f"Missing or unexpectedly small server binary in {file.name}.")
            drifted = unlocked_dependencies(archive.namelist(), locked)
            if drifted:
                raise ValueError(f"Bundled dependencies differ from uv.lock in {file.name}: {', '.join(sorted(drifted))}.")
            seen.add(platform)
            print(f"Validated {file.name}: {version}, {platform}")
    if seen != PLATFORMS:
        raise ValueError("Incomplete platform coverage.")


if __name__ == "__main__":
    validate(Path(sys.argv[1]), sys.argv[2])
