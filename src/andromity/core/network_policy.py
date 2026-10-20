"""Air-gap mode for the engine.

`activate()` runs first at every entry point: it turns air-gap mode on from
config.toml ([default] airgap = true) or the environment (ANDROMITY_AIRGAP=1),
merges allowed hosts from both, and installs the process-wide network guard.
Features ask `enabled()` / `url_allowed()` here so they can turn themselves off
with a clear message instead of failing on a blocked socket.
"""
import os
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

from andromity.core import airgap_guard
from andromity.core.airgap_guard import ENV_ALLOW, ENV_FLAG, AirgapBlockedError

__all__ = [
    "AirgapBlockedError", "AirgapFeatureOff", "activate", "enabled", "host_allowed",
    "url_allowed", "require_url", "feature_off_message", "status",
]

_sources: List[str] = []


class AirgapFeatureOff(RuntimeError):
    """A feature that needs the internet was asked to run while air-gap mode is on."""


def _config_values() -> Tuple[bool, List[str]]:
    try:
        from andromity.config import config
    except Exception:
        return False, []
    enabled_flag = config.get("default", "airgap", False) is True
    hosts = config.get("default", "airgap_allowed_hosts", [])
    if isinstance(hosts, str):
        hosts = [hosts]
    if not isinstance(hosts, list):
        hosts = []
    return enabled_flag, [str(h) for h in hosts if isinstance(h, str) and h.strip()]


def activate() -> bool:
    """Turn air-gap mode on when configured and guard this process. Safe to call more than once."""
    from_env = os.environ.get(ENV_FLAG) == "1"
    from_config, config_hosts = _config_values()
    _sources.clear()
    if from_env:
        _sources.append("environment")
    if from_config:
        _sources.append("config")
        os.environ[ENV_FLAG] = "1"
    if not airgap_guard.is_enabled():
        return False
    allow = [h for h in (os.environ.get(ENV_ALLOW, ""), *config_hosts) if h]
    if allow:
        os.environ[ENV_ALLOW] = ",".join(allow)
    # LiteLLM downloads a model price map at import unless told to use its bundled copy.
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    os.environ["ANDROMITY_NO_TELEMETRY"] = "1"
    os.environ.setdefault("DO_NOT_TRACK", "1")
    airgap_guard.install()
    return True


def enabled() -> bool:
    return airgap_guard.is_enabled()


def host_allowed(host: Optional[str]) -> bool:
    if not enabled():
        return True
    return bool(host) and airgap_guard.host_allowed(str(host))


def url_allowed(url: Optional[str]) -> bool:
    """Whether a URL's host may be contacted. A missing URL means a cloud default, which is not."""
    if not enabled():
        return True
    if not url:
        return False
    try:
        host = urlsplit(str(url)).hostname
    except ValueError:
        return False
    return host_allowed(host)


def feature_off_message(feature: str, remedy: str = "") -> str:
    message = f"Air-gap mode is on, so {feature} is turned off because it needs the internet."
    return f"{message} {remedy}".strip()


def require_url(url: Optional[str], feature: str, remedy: str = "") -> None:
    """Raise AirgapFeatureOff when air-gap mode forbids contacting `url`."""
    if not url_allowed(url):
        raise AirgapFeatureOff(feature_off_message(feature, remedy))


def status() -> Dict[str, Any]:
    info = airgap_guard.status()
    info["sources"] = list(_sources)
    return info
