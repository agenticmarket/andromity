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
