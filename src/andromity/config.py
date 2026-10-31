import ast
import hashlib
import math
import os
import platform
import re
import sys
from datetime import date, datetime, time as dt_time, timezone
from pathlib import Path
from typing import Any, Dict, Optional

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

_INT64_MIN, _INT64_MAX = -(2 ** 63), 2 ** 63 - 1

try:
    import tomli_w
except ImportError:
    class _TomliWFallback:
        """Writes the TOML subset config.toml uses, at any depth, when tomli-w is not installed.
        Unsupported values raise TypeError, as tomli-w does, instead of being written as text."""

        _BARE_KEY = re.compile(r"[A-Za-z0-9_-]+")
        _ESCAPES = {"\\": "\\\\", '"': '\\"', "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r"}

        @classmethod
        def dump(cls, d: dict, f):
            f.write(cls.dumps(d).encode("utf-8"))

        @classmethod
        def dumps(cls, d: dict) -> str:
            lines: list = []
            cls._table(d, [], lines)
            return "\n".join(lines).strip("\n") + "\n"

        @classmethod
        def _table(cls, d: dict, path: list, lines: list) -> None:
            nested = []
            for k, v in d.items():
                if isinstance(v, dict) or (isinstance(v, list) and v and all(isinstance(i, dict) for i in v)):
                    nested.append((k, v))
                else:
                    lines.append(f"{cls._key(k)} = {cls._value(v)}")
            for k, v in nested:
                header = ".".join(cls._key(part) for part in [*path, k])
                for item in ([v] if isinstance(v, dict) else v):
                    lines.extend(["", f"[{header}]" if isinstance(v, dict) else f"[[{header}]]"])
                    cls._table(item, [*path, k], lines)

        @classmethod
        def _key(cls, k) -> str:
            if not isinstance(k, str):
                raise TypeError(f"TOML keys must be strings, not {type(k).__name__}")
            return k if cls._BARE_KEY.fullmatch(k) else cls._string(k)

        @classmethod
        def _string(cls, s: str) -> str:
            out = []
            for ch in s:
                if ch in cls._ESCAPES:
                    out.append(cls._ESCAPES[ch])
                elif ord(ch) < 0x20 or ord(ch) == 0x7F:
                    out.append(f"\\u{ord(ch):04X}")
                else:
                    out.append(ch)
            return '"' + "".join(out) + '"'

        @classmethod
        def _value(cls, v) -> str:
            if isinstance(v, bool):
                return "true" if v else "false"
            if isinstance(v, int):
                if not _INT64_MIN <= v <= _INT64_MAX:
                    raise TypeError("TOML integers must fit in 64 bits")
                return str(int(v))
            if isinstance(v, float):
                v = float(v)
                if math.isnan(v):
                    return "nan"
                if math.isinf(v):
                    return "inf" if v > 0 else "-inf"
                return repr(v)
            if isinstance(v, str):
                return cls._string(v)
            if isinstance(v, datetime):
                return v.isoformat()
            if isinstance(v, (date, dt_time)):
                if isinstance(v, dt_time) and v.tzinfo is not None:
                    raise TypeError("TOML times can't carry a time zone")
                return v.isoformat()
            if isinstance(v, (list, tuple)):
                return "[" + ", ".join(cls._value(i) for i in v) + "]"
            if isinstance(v, dict):
                return "{" + ", ".join(f"{cls._key(k)} = {cls._value(x)}" for k, x in v.items()) + "}"
            raise TypeError(f"Object of type {type(v).__name__} is not TOML serializable")

    tomli_w = _TomliWFallback


def get_config_dir() -> Path:
    if os.environ.get("ANDROMITY_CONFIG_DIR"):
        return Path(os.environ["ANDROMITY_CONFIG_DIR"]).expanduser()
    if platform.system() == "Windows":
        return Path(os.environ.get("APPDATA", "~")).expanduser() / "andromity"
    return Path.home() / ".andromity"


ALLOWED_SHELLS = {
    "/bin/bash", "/bin/sh", "/bin/zsh", "/bin/dash",
    "/usr/bin/bash", "/usr/bin/sh", "/usr/bin/zsh", "/usr/bin/dash",
    "/usr/local/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/fish",
    "/opt/homebrew/bin/bash", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/fish",
}


def get_shell() -> str:
    if platform.system() == "Windows":
        return "powershell"
    shell = os.environ.get("SHELL", "/bin/bash").strip()
    if shell in ALLOWED_SHELLS and os.path.isfile(shell) and os.access(shell, os.X_OK):
        return shell

    etc_shells = Path("/etc/shells")
    if etc_shells.is_file():
        try:
            valid_shells = {
                line.strip() for line in etc_shells.read_text(encoding="utf-8", errors="ignore").splitlines()
                if line.strip() and not line.startswith("#")
            }
            if shell in valid_shells and os.path.isfile(shell) and os.access(shell, os.X_OK):
                return shell
        except Exception:
            pass

    for fallback in ("/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"):
        if os.path.isfile(fallback) and os.access(fallback, os.X_OK):
            return fallback
    return "/bin/bash"


class ConfigManager:
    def __init__(self, config_dir: Optional[Path] = None):
        self.config_dir = config_dir or get_config_dir()
        self.config_path = self.config_dir / "config.toml"
        self.config_dir.mkdir(parents=True, exist_ok=True)
        if platform.system() != "Windows":
            try:
                os.chmod(self.config_dir, 0o700)
            except OSError:
                pass
        self._config_cache: Dict[str, Any] = {}
        self._load()

    def _load(self):
        self.load_error: Optional[str] = None
        self.unreadable_copy: Optional[Path] = None
        if not self.config_path.exists():
            self._create_default_config()
        raw = self.config_path.read_bytes()
        try:
            self._config_cache = tomllib.loads(raw.decode("utf-8"))
        except Exception as e:
            # The next save rewrites the file from defaults, so keep the user's keys and settings first.
            self.load_error = str(e)
            self.unreadable_copy = self._keep_unreadable_copy(raw)
            kept = f" A copy was saved to {self.unreadable_copy}." if self.unreadable_copy else ""
            print(f"Warning: Failed to parse {self.config_path}: {e}.{kept} Using default settings.", file=sys.stderr)
            self._config_cache = {}
            return
        if self._repair_stringified_tables():
            try:
                self.save()
            except Exception as e:
                print(f"Warning: Could not save the repaired {self.config_path}: {e}", file=sys.stderr)

    def _reload_saved(self) -> None:
        try:
            self._config_cache = tomllib.loads(self.config_path.read_bytes().decode("utf-8"))
        except (OSError, ValueError):
            pass

    @staticmethod
    def _toml_compatible(value: Any, depth: int = 0) -> bool:
        if depth > 16:
            return False
        if isinstance(value, dict):
            return all(isinstance(k, str) and ConfigManager._toml_compatible(v, depth + 1) for k, v in value.items())
        if isinstance(value, list):
            return all(ConfigManager._toml_compatible(v, depth + 1) for v in value)
        if isinstance(value, int) and not isinstance(value, bool):
            return _INT64_MIN <= value <= _INT64_MAX
        return isinstance(value, (str, float, bool))

    @staticmethod
    def _restore_table(value: Any) -> Any:
        """A table that an older fallback writer saved as Python text, parsed back; any other value unchanged."""
        if not (isinstance(value, str) and len(value) <= 16384 and (value == "{}" or value.startswith("{'"))
                and value.endswith("}")):
            return value
        try:
            parsed = ast.literal_eval(value)
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            return value
        return parsed if isinstance(parsed, dict) and ConfigManager._toml_compatible(parsed) else value

    def _repair_stringified_tables(self) -> bool:
        """Turn nested tables an older writer stored as Python text back into tables, in sections and their lists."""
        repaired = False
        for section in self._config_cache.values():
            for container in section if isinstance(section, list) else [section]:
                if not isinstance(container, dict):
                    continue
                for key, value in container.items():
                    if isinstance(value, list):
                        fixed = [self._restore_table(item) for item in value]
                        changed = any(new is not old for new, old in zip(fixed, value))
                    else:
                        fixed = self._restore_table(value)
                        changed = fixed is not value
                    if changed:
                        container[key] = fixed
                        repaired = True
        return repaired

    def _keep_unreadable_copy(self, raw: bytes) -> Optional[Path]:
        try:
            for existing in sorted(self.config_dir.glob("config.toml.unreadable-*")):
                if existing.read_bytes() == raw:
                    return existing
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            copy = self.config_dir / f"config.toml.unreadable-{stamp}"
            fd = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
            return copy
        except OSError:
            return None

    def _create_default_config(self):
        default_config = {
            "default": {
                "provider": "andromity",
                "model": "auto",
                "profile": "builder",
                "permission_mode": "safe",
                "reasoning_effort": "auto",
                "expand_tools_while_working": True,
                "allowed_commands": ["npm run", "npm test", "npm list", "npm run dev", "git status", "git diff", "git log", "ls", "dir", "cat", "echo"]
            },
            "providers": [
                {"name": "andromity", "type": "andromity", "base_url": "https://gateway.agenticmarket.dev/v1"},
                {"name": "openrouter", "type": "openrouter"},
                {"name": "ollama", "type": "ollama", "base_url": "http://localhost:11434"},
            ],
        }
        self.save(default_config)

    def save(self, config_data: Optional[Dict[str, Any]] = None):
        import os
        import time
        if os.environ.get("ANDROMITY_SKIP_CONFIG_SAVE") == "1":
            if config_data is not None:
                self._config_cache = config_data
            return

        data_to_save = config_data if config_data is not None else self._config_cache
        try:
            payload = tomli_w.dumps(data_to_save).encode("utf-8")
        except (TypeError, ValueError):
            # A value TOML can't hold must not stay in memory and fail every later save.
            if config_data is None:
                self._reload_saved()
            raise
        tmp_path = self.config_path.with_name(f"{self.config_path.stem}_{os.getpid()}_{time.time_ns()}.tmp")
        try:
            with open(tmp_path, "wb") as f:
                f.write(payload)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            if platform.system() != "Windows":
                try:
                    os.chmod(tmp_path, 0o600)
                except OSError:
                    pass

            for attempt in range(10):
                try:
                    os.replace(str(tmp_path), str(self.config_path))
                    break
                except (PermissionError, OSError):
                    if attempt == 9:
                        raise
                    time.sleep(0.05 * (attempt + 1))

            if platform.system() != "Windows":
                try:
                    os.chmod(self.config_path, 0o600)
                except OSError:
                    pass
        except Exception:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except Exception:
                    pass
            raise
        if config_data is not None:
            self._config_cache = config_data


    def get(self, section: str, key: str, default: Any = None, fallback: Any = None) -> Any:
        eff_default = default if fallback is None else fallback
        sec = self._config_cache.get(section, {})
        if not isinstance(sec, dict):
            return eff_default
        return sec.get(key, eff_default)

    def set(self, section: str, key: str, value: Any):
        if not isinstance(self._config_cache.get(section), dict):
            self._config_cache[section] = {}
        self._config_cache[section][key] = value
        self.save()

    def get_root(self, key: str, default: Any = None) -> Any:
        return self._config_cache.get(key, default)
        
    def set_root(self, key: str, value: Any):
        self._config_cache[key] = value
        self.save()

    def get_pinned_models(self) -> list:
        sec = self._config_cache.get("models", {})
        if isinstance(sec, dict) and "pinned" in sec and isinstance(sec["pinned"], list):
            return [item for item in sec["pinned"] if isinstance(item, dict)]
        return [
            {"id": "auto", "provider": "andromity", "name": "Andromity Auto"},
            {"id": "anthropic/claude-3.7-sonnet", "provider": "openrouter", "name": "Claude 3.7 Sonnet"},
        ]

    def set_pinned_models(self, pinned: list) -> list:
        if "models" not in self._config_cache or not isinstance(self._config_cache["models"], dict):
            self._config_cache["models"] = {}
        self._config_cache["models"]["pinned"] = pinned
        self.save()
        return pinned

    def toggle_pinned_model(self, model_id: str, provider: str = "", name: str = "") -> list:
        if not model_id:
            return self.get_pinned_models()
        pinned = list(self.get_pinned_models())
        match_idx = -1
        for idx, item in enumerate(pinned):
            if item.get("id") == model_id and (not provider or item.get("provider") == provider):
                match_idx = idx
                break
        if match_idx >= 0:
            pinned.pop(match_idx)
        else:
            pinned.append({
                "id": model_id,
                "provider": provider or "openrouter",
                "name": name or model_id,
            })
        return self.set_pinned_models(pinned)

    def get_provider_config(self, provider_name: str) -> Optional[Dict[str, Any]]:
        providers = self._config_cache.get("providers", [])
        for p in providers if isinstance(providers, list) else []:
            if isinstance(p, dict) and p.get("name") == provider_name:
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
            "andromity": "ANDROMITY_API_KEY",
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
            "nvidia": "NVIDIA_API_KEY",
            "andromity": "ANDROMITY_API_KEY",
        }
        env_var = env_map.get(provider_name)
        if env_var:
            os.environ[env_var] = api_key

    def list_providers(self) -> list:
        providers = self._config_cache.get("providers", [])
        return [p for p in providers if isinstance(p, dict)] if isinstance(providers, list) else []

    def save_provider(self, values: Dict[str, Any]) -> str:
        from andromity.core.connections import validate_connection
        saved = validate_connection(values)
        existing = self.get_provider_config(saved["name"]) or {}
        saved = {**existing, **saved}
        if "api_key" in values:
            saved["api_key"] = str(values["api_key"] or "").strip()
        providers = [p for p in self.list_providers() if p.get("name") != saved["name"]]
        self._config_cache["providers"] = [*providers, saved]
        self.save()
        from andromity.core.models import invalidate_model_catalog
        invalidate_model_catalog(saved["name"])
        return saved["name"]

    def set_ollama_base_url(self, url: str) -> str:
        from andromity.core.connections import validate_base_url
        base_url = validate_base_url(url, "ollama")
        providers = self.list_providers()
        entry = next((p for p in providers if p.get("name") == "ollama"), None)
        if entry is None:
            providers.append({"name": "ollama", "type": "ollama", "base_url": base_url})
        elif entry.get("base_url") == base_url:
            return base_url
        else:
            entry["base_url"] = base_url
        self._config_cache["providers"] = providers
        self.save()
        from andromity.core.models import invalidate_model_catalog
        invalidate_model_catalog("ollama")
        return base_url

    def delete_provider(self, provider: str) -> None:
        from andromity.core.connections import PRESETS
        if provider in PRESETS:
            raise ValueError("Built-in presets cannot be removed.")
        if self.get("default", "provider", "") == provider:
            raise ValueError("Select another provider before removing the active connection.")
        self._config_cache["providers"] = [p for p in self.list_providers() if p.get("name") != provider]
        self.save()

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
        return self._write_mcp_server(Path(project_path) / ".andromity" / "mcp.json", server_name, conf)

    def add_user_mcp_server(self, server_name: str, conf: dict) -> bool:
        """Add or replace an MCP server entry in the user-level ~/.andromity/mcp.json."""
        return self._write_mcp_server(Path.home() / ".andromity" / "mcp.json", server_name, conf)

    def _write_mcp_server(self, path: Path, server_name: str, conf: dict) -> bool:
        try:
            import json
            path.parent.mkdir(parents=True, exist_ok=True)
            data = {}
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
            servers = data.setdefault("mcpServers", {})
            servers[server_name] = conf
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            return True
        except Exception:
            return False


    # ─── Trust Management ────────────────────────────────────────────────
    def _trust_key(self, path: str) -> str:
        resolved = str(Path(path).resolve())
        return "p" + hashlib.sha256(resolved.encode()).hexdigest()[:15]

    def is_trusted(self, path: str) -> bool:
        if not path:
            return False
        trusted = self._config_cache.get("trusted_projects", {})
        return isinstance(trusted, dict) and isinstance(trusted.get(self._trust_key(path)), dict)

    def set_trusted(self, path: str):
        resolved = str(Path(path).resolve())
        key = self._trust_key(path)
        if not isinstance(self._config_cache.get("trusted_projects"), dict):
            self._config_cache["trusted_projects"] = {}
        if isinstance(self._config_cache["trusted_projects"].get(key), dict):
            return
        self._config_cache["trusted_projects"][key] = {
            "path": resolved,
            "trusted_at": datetime.now(timezone.utc).isoformat(),
        }
        self.save()


    def revoke_trust(self, path: str):
        key = self._trust_key(path)
        trusted = self._config_cache.get("trusted_projects", {})
        if isinstance(trusted, dict) and key in trusted:
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

