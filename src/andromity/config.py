import hashlib
import os
import platform
import sys
from datetime import datetime, timezone
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
                "model": "claude-sonnet-4-6",
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
        if provider_cfg:
            key = provider_cfg.get("api_key")
            if key:
                if key.startswith("$"):
                    return os.environ.get(key[1:])
                return key
        
        # Fallback to standard env vars
        env_map = {
            "anthropic": "ANTHROPIC_API_KEY",
            "openai": "OPENAI_API_KEY",
            "google": "GEMINI_API_KEY",
            "deepseek": "DEEPSEEK_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "nvidia": "NVIDIA_API_KEY",
        }
        if provider_name == "google":
            return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if provider_name == "nvidia":
            return os.environ.get("NVIDIA_API_KEY") or os.environ.get("NVIDIA_NIM_API_KEY")
        env_var = env_map.get(provider_name)
        if env_var:
            return os.environ.get(env_var)
        return None

    def set_api_key(self, provider_name: str, api_key: str):
        """Set or update the API key for a given provider in config.toml and environment."""
        providers = self._config_cache.get("providers", [])
        found = False
        for p in providers:
            if p.get("name") == provider_name:
                p["api_key"] = api_key
                found = True
                break
        if not found:
            providers.append({"name": provider_name, "type": provider_name, "api_key": api_key})
            self._config_cache["providers"] = providers
        self.save()

        # Also set in os.environ for immediate use by litellm
        env_map = {
            "anthropic": "ANTHROPIC_API_KEY",
            "openai": "OPENAI_API_KEY",
            "google": "GEMINI_API_KEY",
            "deepseek": "DEEPSEEK_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
        }
        env_var = env_map.get(provider_name)
        if env_var:
            os.environ[env_var] = api_key

    def list_providers(self) -> list:
        return self._config_cache.get("providers", [])

    # ─── Trust Management ────────────────────────────────────────────────
    def _trust_key(self, path: str) -> str:
        resolved = str(Path(path).resolve())
        return "p" + hashlib.sha256(resolved.encode()).hexdigest()[:15]

    def is_trusted(self, path: str) -> bool:
        key = self._trust_key(path)
        return key in self._config_cache.get("trusted_projects", {})

    def set_trusted(self, path: str):
        resolved = str(Path(path).resolve())
        key = self._trust_key(path)
        if "trusted_projects" not in self._config_cache:
            self._config_cache["trusted_projects"] = {}
        self._config_cache["trusted_projects"][key] = {
            "path": resolved,
            "trusted_at": datetime.now(timezone.utc).isoformat(),
        }
        self.save()

    def revoke_trust(self, path: str):
        key = self._trust_key(path)
        trusted = self._config_cache.get("trusted_projects", {})
        if key in trusted:
            del trusted[key]
            self.save()


config = ConfigManager()
