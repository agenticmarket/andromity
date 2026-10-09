import importlib.util
import json
from pathlib import Path
from zipfile import ZipFile

import pytest

spec = importlib.util.spec_from_file_location("validate_vsix", Path(__file__).parents[1] / "scripts/validate-vsix-release.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def packages(path, wrong_version=False, duplicate=False, tiny_binary=False, litellm=None):
    for index, platform in enumerate(sorted(module.PLATFORMS)):
        with ZipFile(path / f"{index}.vsix", "w") as archive:
            target = "win32-x64" if duplicate else platform
            version = "0.2.14" if wrong_version else "0.2.15"
            archive.writestr("extension/package.json", json.dumps({"name": "andromity-agent", "publisher": "agenticmarket", "version": version}))
            archive.writestr("extension.vsixmanifest", f'<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="andromity-agent" Publisher="agenticmarket" Version="{version}" TargetPlatform="{target}"/></Metadata></PackageManifest>')
            binary = f"extension/bin/{target}/andromity-server" + (".exe" if target == "win32-x64" else "")
            archive.writestr(binary, b"0" * (10 if tiny_binary else 1_000_000))
            if litellm:
                archive.writestr(f"extension/bin/{target}/_internal/litellm-{litellm}.dist-info/METADATA", "Name: litellm")


def lock_file(path):
    lock = path / "uv.lock"
    lock.write_text('[[package]]\nname = "litellm"\nversion = "1.99.0"\n', encoding="utf-8")
    return lock


def test_complete_matching_packages_pass(tmp_path):
    packages(tmp_path)
    module.validate(tmp_path, "0.2.15")


@pytest.mark.parametrize("option", ["wrong_version", "duplicate", "tiny_binary"])
def test_invalid_package_prevents_publication(tmp_path, option):
    packages(tmp_path, **{option: True})
    with pytest.raises(ValueError):
        module.validate(tmp_path, "0.2.15")


def test_missing_platform_prevents_publication(tmp_path):
    packages(tmp_path)
    (tmp_path / "0.vsix").unlink()
    with pytest.raises(ValueError):
        module.validate(tmp_path, "0.2.15")


def test_bundled_dependency_matching_lock_passes(tmp_path):
    packages(tmp_path, litellm="1.99.0")
    module.validate(tmp_path, "0.2.15", lock_file(tmp_path))


def test_bundled_dependency_drifting_from_lock_prevents_publication(tmp_path):
    packages(tmp_path, litellm="1.104.2")
    with pytest.raises(ValueError, match="litellm 1.104.2"):
        module.validate(tmp_path, "0.2.15", lock_file(tmp_path))
