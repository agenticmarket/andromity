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
                "permission_mode": "safe",
                "reasoning_effort": "medium",
                "expand_tools_while_working": True,
                "allowed_commands": ["npm run", "npm test", "npm list", "npm run dev", "git status", "git diff", "git log", "ls", "dir", "cat", "echo"]
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

    def get(self, section: str, key: str, default: Any = None, fallback: Any = None) -> Any:
        eff_default = default if fallback is None else fallback
        sec = self._config_cache.get(section, {})
        if not isinstance(sec, dict):
            return eff_default
        return sec.get(key, eff_default)

    def set(self, section: str, key: str, value: Any):
        if section not in self._config_cache:
            self._config_cache[section] = {}
        self._config_cache[section][key] = value
        self.save()
        
    def get_root(self, key: str, default: Any = None) -> Any:
        return self._config_cache.get(key, default)
        
    def set_root(self, key: str, value: Any):
        self._config_cache[key] = value
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

        # Also set in os.environ for immediate so it can be used by litellm
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

    # ─── User Management ─────────────────────────────────────────────────
    def get_user(self) -> Dict[str, str]:
        return self._config_cache.get("user", {})

    def set_user(self, name: str, email: str):
        if "user" not in self._config_cache:
            self._config_cache["user"] = {}
        if name is not None:
            self._config_cache["user"]["name"] = name
        if email is not None:
            self._config_cache["user"]["email"] = email
        self.save()

    # ─── MCP Config ──────────────────────────────────────────────────────
    def get_mcp_config_path(self, project_path: str = "") -> Path:
        """Find the most specific mcp.json file available."""
        candidates = []
        if project_path:
            candidates.extend([
                Path(project_path) / ".andromity" / "mcp.json",
                Path(project_path) / ".vscode" / "mcp.json",
            ])
        candidates.append(Path.home() / ".andromity" / "mcp.json")
        for p in candidates:
            if p.is_file():
                return p
        # Default to home if none exist
        default_path = Path.home() / ".andromity" / "mcp.json"
        default_path.parent.mkdir(parents=True, exist_ok=True)
        if not default_path.exists():
            import json
            default_path.write_text(json.dumps({"mcpServers": {}}, indent=2), encoding="utf-8")
        return default_path

    def set_mcp_server_disabled(self, project_path: str, server_name: str, disabled: bool) -> bool:
        """Toggle the 'disabled' flag for a specific MCP server in the config."""
        path, data, srv_key = self._find_mcp_file_for_server(project_path, server_name)
        if path is None:
            path = self.get_mcp_config_path(project_path)
            if not path.exists():
                return False
            try:
                import json
                data = json.loads(path.read_text(encoding="utf-8"))
                srv_key = "mcpServers" if "mcpServers" in data else ("servers" if "servers" in data else "mcpServers") #compatible with both version Antigravity and VSCode
            except Exception:
                return False

        try:
            import json
            servers = data.setdefault(srv_key, {})
            if server_name in servers and isinstance(servers[server_name], dict):
                servers[server_name]["disabled"] = disabled
                path.write_text(json.dumps(data, indent=2), encoding="utf-8")
                return True
        except Exception:
            pass
        return False

    def _find_mcp_file_for_server(self, project_path: str, server_name: str):
        """
        Return (path, data, key) for the mcp.json file that contains server_name,
        searching project then global Gemini config.
        Returns (None, None, None) if not found.
        """
        import json

        # Candidate files in priority order
        candidates = []
        if project_path:
            candidates.extend([
                Path(project_path) / ".andromity" / "mcp.json",
                Path(project_path) / ".vscode" / "mcp.json",
            ])
        candidates.extend([
            Path.home() / ".andromity" / "mcp.json",
            Path.home() / ".gemini" / "config" / "mcp_config.json",
        ])

        for p in candidates:
            if not p.is_file():
                continue
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            for key in ("mcpServers", "servers"):
                if server_name in data.get(key, {}):
                    return p, data, key
        return None, None, None

    def set_mcp_server_env(self, project_path: str, server_name: str, key: str, value: str):
        """Set a single env-var key for an MCP server in the config file."""
        path, data, srv_key = self._find_mcp_file_for_server(project_path, server_name)
        if path is None:
            return
        try:
            import json
            servers = data.get(srv_key, {})
            if "env" not in servers[server_name]:
                servers[server_name]["env"] = {}
            servers[server_name]["env"][key] = value
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception:
            pass

    def remove_mcp_server(self, project_path: str, server_name: str) -> bool:
        """Remove an MCP server entry from the config file. Returns True on success."""
        path, data, srv_key = self._find_mcp_file_for_server(project_path, server_name)
        if path is None:
            return False
        try:
            import json
            del data[srv_key][server_name]
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            return True
        except Exception:
            return False

    def add_mcp_server(self, project_path: str, server_name: str, conf: dict) -> bool:
        """Add or replace an MCP server entry in <project>/.andromity/mcp.json.

        Merges into any existing mcpServers so other servers are preserved.
        Returns True on success."""
        try:
            import json
            path = Path(project_path) / ".andromity" / "mcp.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            data = {}
            if path.exists():
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    data = {}
            servers = data.setdefault("mcpServers", {})
            servers[server_name] = conf
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            return True
        except Exception:
            return False

    def convert_remote_to_mcp_remote(
        self, project_path: str, server_name: str, token: str
    ) -> bool:
        """
        Convert a remote HTTP server (serverUrl only) to use npx mcp-remote
        with an Authorization: Bearer header, so it can be launched as stdio.
        Searches project and global config. Returns True on success.
        """
        path, data, srv_key = self._find_mcp_file_for_server(project_path, server_name)
        if path is None:
            return False
        try:
            import json
            conf = data[srv_key][server_name]
            remote_url = conf.get("serverUrl") or conf.get("url") or ""
            if not remote_url:
                return False
            # Preserve safe metadata fields only
            meta = {k: v for k, v in conf.items()
                    if k not in ("command", "args", "env", "serverUrl", "url",
                                 "type", "$typeName")}
            data[srv_key][server_name] = {
                "command": "npx",
                "args": [
                    "-y", "mcp-remote", remote_url,
                    "--header", f"Authorization:Bearer {token}",
                ],
                "env": {},
                **meta,
            }
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            return True
        except Exception:
            return False

    # ─── Trust Management ────────────────────────────────────────────────
    def _trust_key(self, path: str) -> str:
        resolved = str(Path(path).resolve())
        return "p" + hashlib.sha256(resolved.encode()).hexdigest()[:15]

    def is_trusted(self, path: str) -> bool:
        mode = self._config_cache.get("default", {}).get("permission_mode", "safe")
        if mode in ("full", "yolo"):
            return True
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

    # ─── Subagent Management ─────────────────────────────────────────────
    def get_subagents_config(self) -> Dict[str, Any]:
        return self._config_cache.get("subagents", {})

    def get_subagent_role(self, role_name: str) -> Optional[Dict[str, Any]]:

        roles = self._config_cache.get("subagents", {}).get("roles", [])
        for r in roles:
            if isinstance(r, dict) and r.get("name", "").lower() == role_name.lower():
                return r
        return None

    def set_subagent_role(
        self,
        role_name: str,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        tools: Optional[list] = None,
        description: Optional[str] = None,
    ):
        if "subagents" not in self._config_cache:
            self._config_cache["subagents"] = {}
        roles = self._config_cache["subagents"].setdefault("roles", [])
        found = False
        for r in roles:
            if isinstance(r, dict) and r.get("name", "").lower() == role_name.lower():
                if model is not None:
                    r["model"] = model
                if provider is not None:
                    r["provider"] = provider
                if tools is not None:
                    r["tools"] = tools
                if description is not None:
                    r["description"] = description
                found = True
                break
        if not found:
            entry = {"name": role_name}
            if model is not None:
                entry["model"] = model
            if provider is not None:
                entry["provider"] = provider
            if tools is not None:
                entry["tools"] = tools
            if description is not None:
                entry["description"] = description
            roles.append(entry)
        self.save()

    def list_subagent_roles(self) -> list:
        return self._config_cache.get("subagents", {}).get("roles", [])


config = ConfigManager()

