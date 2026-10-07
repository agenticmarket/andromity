import subprocess
import sys
from pathlib import Path


def test_release_provider_imports(tmp_path):
    entrypoint = Path(__file__).parents[1] / "src/andromity/server/__main__.py"
    result = subprocess.run(
        [sys.executable, str(entrypoint), "--check-runtime"],
        capture_output=True, text=True, timeout=60, cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert "provider runtime OK" in result.stdout


def test_vscodeignore_preserves_proxy_and_blocks_secrets():
    vscodeignore_path = Path(__file__).parents[1] / "vscode-extension" / ".vscodeignore"
    assert vscodeignore_path.is_file(), "vscode-extension/.vscodeignore must exist"
    content = vscodeignore_path.read_text(encoding="utf-8")
    lines = [line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")]

    # 1. litellm.proxy MUST NOT be blanket-excluded (would cause ModuleNotFoundError at runtime)
    assert "bin/**/_internal/litellm/proxy/**" not in lines, (
        "bin/**/_internal/litellm/proxy/** must NOT be in .vscodeignore as it strips litellm.proxy from VSIX"
    )

    # 2. Secret/certificate patterns must be recursively excluded (prevents Marketplace scanner errors)
    assert any("**/*.pem" in l for l in lines), "Recursive **/*.pem rule must be present in .vscodeignore"
    assert any("**/*.key" in l for l in lines), "Recursive **/*.key rule must be present in .vscodeignore"

    # 3. Duplicate serverb executables must be excluded
    assert any("serverb" in l for l in lines), "serverb pattern must be present in .vscodeignore"


def test_bundled_binary_bundle_cleanliness():
    bin_dir = Path(__file__).parents[1] / "vscode-extension" / "bin"
    if not bin_dir.is_dir():
        return

    for platform_dir in bin_dir.iterdir():
        if not platform_dir.is_dir():
            continue

        # 1. No duplicate serverb or backup binaries
        serverb_files = list(platform_dir.rglob("*serverb*"))
        assert len(serverb_files) == 0, f"Found duplicate serverb files in {platform_dir}: {serverb_files}"

        # 2. No non-cacert PEM files (prevents Marketplace security scanner rejection)
        pems = [p for p in platform_dir.rglob("*.pem") if p.name != "cacert.pem"]
        assert len(pems) == 0, f"Found non-cacert PEM certificate files in {platform_dir}: {pems}"

        # 3. No Next.js chunks in litellm proxy (prevents Marketplace validation errors)
        proxy_dir = platform_dir / "_internal" / "litellm" / "proxy"
        if proxy_dir.is_dir():
            js_files = list(proxy_dir.rglob("*.js"))
            assert len(js_files) == 0, f"Found JS files in litellm proxy {proxy_dir}: {js_files}"

            # 4. spend_tracking must be preserved (prevents ModuleNotFoundError at runtime)
            spend_tracking = proxy_dir / "spend_tracking"
            assert spend_tracking.is_dir(), f"spend_tracking missing from {proxy_dir}"
