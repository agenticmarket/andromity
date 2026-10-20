import tomllib
from importlib.metadata import version
from pathlib import Path

from packaging.requirements import Requirement
from packaging.version import Version

PYPROJECT = Path(__file__).parents[1] / "pyproject.toml"

# litellm 1.106.0 imports mcp.types.CacheableResult, which only exists from mcp 2.2.
# With an older mcp every model call fails with an APIConnectionError.
LITELLM_NEEDS_NEW_MCP = Version("1.106.0")
MCP_WITH_CACHEABLE_RESULT = Version("2.2.0")


def _requirements() -> dict[str, Requirement]:
    deps = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]["dependencies"]
    return {req.name: req for req in map(Requirement, deps)}


def test_litellm_pin_excludes_releases_that_need_newer_mcp():
    reqs = _requirements()
    if not reqs["mcp"].specifier.contains("1.30.0"):
        return
    assert not reqs["litellm"].specifier.contains("1.106.0")
    assert not reqs["litellm"].specifier.contains("1.107.0")
    assert reqs["litellm"].specifier.contains("1.105.1")


def test_installed_litellm_works_with_installed_mcp():
    if Version(version("litellm")) >= LITELLM_NEEDS_NEW_MCP:
        assert Version(version("mcp")) >= MCP_WITH_CACHEABLE_RESULT
