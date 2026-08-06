import os
import platform
import sys
from pathlib import Path
from typing import Any, Dict, Optional

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

import tomli_w


def get_config_dir() -> Path:
    if platform.system() == "Windows":
        return Path(os.environ.get("APPDATA", "~")).expanduser() / "andromity"
    return Path.home() / ".andromity"


def get_project_dir() -> Path:
    return Path.cwd() / ".andromity"


def get_shell() -> str:
    if platform.system() == "Windows":
        return "powershell"
    return os.environ.get("SHELL", "/bin/bash")


class ConfigManager:
    def __init__(self, config_dir: Optional[Path] = None):
        self.config_dir = config_dir or get_config_dir()
        self.config_path = self.config_dir / "config.toml"
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self._config_cache: Dict[str, Any] = {}
        self._load()

    def _load(self):
        if not self.config_path.exists():
            self._create_default_config()
        with open(self.config_path, "rb") as f:
            try:
                self._config_cache = tomllib.load(f)
            except Exception as e:
                print(f"Warning: Failed to parse {self.config_path}: {e}")
                self._config_cache = {}

    def _create_default_config(self):
        default_config = {
            "default": {
                "provider": "anthropic",
                "model": "claude-sonnet-4-20240514",
                "profile": "builder",
            },
            "providers": [
                {"name": "anthropic", "type": "anthropic"},
                {"name": "ollama", "type": "ollama", "base_url": "http://localhost:11434"},
            ],
        }
        self.save(default_config)

    def save(self, config_data: Optional[Dict[str, Any]] = None):
        data_to_save = config_data if config_data is not None else self._config_cache
        with open(self.config_path, "wb") as f:
            tomli_w.dump(data_to_save, f)
        if config_data is not None:
            self._config_cache = config_data

    def get(self, section: str, key: str, default: Any = None) -> Any:
        return self._config_cache.get(section, {}).get(key, default)

    def set(self, section: str, key: str, value: Any):
        if section not in self._config_cache:
            self._config_cache[section] = {}
        self._config_cache[section][key] = value
        self.save()

    def get_provider_config(self, provider_name: str) -> Optional[Dict[str, Any]]:
        providers = self._config_cache.get("providers", [])
        for p in providers:
            if p.get("name") == provider_name:
                return p
        return None

    def get_api_key(self, provider_name: str) -> Optional[str]:
        provider_cfg = self.get_provider_config(provider_name)
        if not provider_cfg:
            return None
        key = provider_cfg.get("api_key")
        if key and key.startswith("$"):
            env_var = key[1:]
            return os.environ.get(env_var)
        return key

    def list_providers(self) -> list:
        return self._config_cache.get("providers", [])


config = ConfigManager()
