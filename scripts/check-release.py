"""Check release metadata without importing the agent or installing dependencies."""
import ast
import json
import os
from pathlib import Path
import tomllib


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    version = project["project"]["version"]
    versions = {}
    for filename in ("package.json", "vscode-extension/package.json", "vscode-extension/package-lock.json"):
        data = json.loads((root / filename).read_text(encoding="utf-8"))
        versions[filename] = data["version"]
        if "packages" in data:
            versions[filename + " root package"] = data["packages"][""]["version"]
    module = ast.parse((root / "src/andromity/__init__.py").read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets):
            versions["Python package"] = ast.literal_eval(node.value)
    if "Python package" not in versions:
        raise SystemExit("Python package version is missing")
    lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    versions["uv.lock"] = next(package["version"] for package in lock["package"] if package["name"] == "andromity")
    for filename, found in versions.items():
        if found != version:
            raise SystemExit(f"Version mismatch: {filename} is {found}, expected {version}")
    for filename in ("CHANGELOG.md", "vscode-extension/CHANGELOG.md"):
        if not any(line.startswith(f"## [{version}]") for line in (root / filename).read_text(encoding="utf-8").splitlines()):
            raise SystemExit(f"Missing {version} release notes in {filename}")
    tag = os.environ.get("RELEASE_TAG", "")
    if tag and tag != "v" + version:
        raise SystemExit(f"Release tag {tag} does not match v{version}")
    print(f"Release metadata is consistent: {version}")


if __name__ == "__main__":
    main()
