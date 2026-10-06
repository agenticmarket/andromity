"""Model-specific effort discovery from provider metadata and official docs.

Unknown contracts use provider defaults. No model-name capability heuristics.
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import asdict, dataclass, field, replace
from enum import Enum
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.request import Request, urlopen
from urllib.parse import quote
import json


class ReasoningMode(str, Enum):
    NONE = "none"
    UNKNOWN = "unknown"
    MANDATORY = "mandatory"
    TOGGLEABLE = "toggleable"
    CONFIGURABLE = "configurable"
    ROUTER = "router"


@dataclass
class ReasoningCapability:
    mode: ReasoningMode
    supported_efforts: List[str] = field(default_factory=list)
    default_effort: str = "auto"
    is_mandatory: bool = False
    supports_max_tokens: bool = False
    description: str = ""
    source: str = ""
    request_format: str = ""
    budget_min: Optional[int] = None
    budget_max: Optional[int] = None
    off_effort: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result = asdict(self)
        result["mode"] = self.mode.value
        return result


def _efforts(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    result: List[str] = []
    for value in values:
        if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]*", value):
            continue
        value = "off" if value.lower() == "none" else value.lower()
        if value not in result:
            result.append(value)
    return result


def _cap(efforts: List[str], source: str, request_format: str,
         default: str = "auto", mandatory: bool = False, **kwargs: Any) -> ReasoningCapability:
    if mandatory:
        efforts = [value for value in efforts if value != "off"]
    default = "off" if default == "none" else default
    return ReasoningCapability(
        mode=(ReasoningMode.MANDATORY if mandatory else
              ReasoningMode.TOGGLEABLE if "off" in efforts else ReasoningMode.CONFIGURABLE),
        supported_efforts=efforts,
        default_effort=default if default in efforts else "auto",
        is_mandatory=mandatory, source=source, request_format=request_format,
        description="Controls verified from " + source, **kwargs,
    )


def _supported(value: Any) -> bool:
    return isinstance(value, dict) and value.get("supported") is True


def _from_metadata(provider: str, metadata: Dict[str, Any]) -> Optional[ReasoningCapability]:
    reasoning = metadata.get("reasoning")
    if isinstance(reasoning, dict):
        values = reasoning.get("supported_efforts")
        request_format = provider
        if provider == "openrouter" and not values:
            # OpenRouter exposes toggle-only models without an effort allowlist.
            # Do not mistake its API-wide effort enum for model-level support.
            values = ["on"]
            if reasoning.get("mandatory") is not True:
                values.append("off")
            request_format = "openrouter_toggle"
        return _cap(_efforts(values), "provider metadata", request_format,
                    str(reasoning.get("default_effort", "auto")).lower(),
                    reasoning.get("mandatory") is True,
                    supports_max_tokens=reasoning.get("supports_max_tokens") is True)
    capabilities = metadata.get("capabilities")
    if provider == "anthropic" and isinstance(capabilities, dict):
        effort = capabilities.get("effort", {})
        thinking = capabilities.get("thinking", {})
        types = (thinking.get("types") or {}) if isinstance(thinking, dict) else {}
        values = [key for key, value in effort.items() if key != "supported" and _supported(value)] if _supported(effort) else []
        adaptive = _supported(types.get("adaptive"))
        if not values and _supported(types.get("enabled")):
            values = ["on"]  # Manual thinking is a token budget, not an effort enum.
        if _supported(types.get("disabled")):
            values.append("off")
        if "effort" not in capabilities and "thinking" not in capabilities:
            return None
        if not values and not _supported(thinking):
            return ReasoningCapability(ReasoningMode.NONE, source="provider metadata")
        return _cap(values, "provider metadata", "anthropic_adaptive" if adaptive else "anthropic_budget",
                    supports_max_tokens=_supported(types.get("enabled")) and not adaptive,
                    budget_min=1024, budget_max=(metadata.get("max_tokens") or 0) - 1 if metadata.get("max_tokens") else None)
    params = metadata.get("supported_parameters")
    if isinstance(params, list) and not any(p in params for p in ("reasoning", "reasoning_effort", "thinking")):
        return ReasoningCapability(ReasoningMode.NONE, source="provider metadata")
    return None


_DISCOVERED: Dict[tuple[str, str], tuple[float, ReasoningCapability]] = {}
_DOCS: Dict[str, tuple[float, str]] = {}
_LOCK = threading.RLock()
_TTL = 3600


def invalidate_reasoning_capabilities(provider: str) -> None:
    with _LOCK:
        for key in list(_DISCOVERED):
            if key[0] == provider:
                del _DISCOVERED[key]


def get_model_reasoning_capability(provider_key: str, model_id: str,
                                   live_metadata: Optional[Dict[str, Any]] = None) -> ReasoningCapability:
    """Resolve without network I/O; shared by catalogs, TUI and requests."""
    provider = (provider_key or "").strip().lower()
    model = (model_id or "").strip()
    if live_metadata is None:
        with _LOCK:
            cached = _DISCOVERED.get((provider, model))
            if cached and time.monotonic() - cached[0] < _TTL:
                return cached[1]
        from andromity.core.models import get_cached_live_models
        live_metadata = next((m for m in get_cached_live_models(provider) if m.get("id") == model), None)
    if live_metadata is not None:
        cap = _from_metadata(provider, live_metadata)
        if cap is not None:
            return cap
    with _LOCK:
        cached = _DISCOVERED.get((provider, model))
        if cached and time.monotonic() - cached[0] < _TTL:
            return cached[1]
    return ReasoningCapability(ReasoningMode.UNKNOWN,
                               description="Effort controls unavailable; using the provider default.")


class _Document(HTMLParser):
    """Read visible text and table cells, excluding script/style data."""
    def __init__(self, html: str):
        super().__init__()
        self.text: List[str] = []
        self.tables: List[List[List[str]]] = []
        self._table: Optional[List[List[str]]] = None
        self._row: Optional[List[str]] = None
        self._cell: Optional[List[str]] = None
        self._ignored = 0
        self.feed(html)

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in ("script", "style"):
            self._ignored += 1
        elif tag == "table":
            self._table = []
        elif tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []
        elif tag in ("p", "li", "h1", "h2", "h3"):
            self.text.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            self._ignored = max(0, self._ignored - 1)
        elif tag in ("td", "th") and self._cell is not None:
            if self._row is not None:
                self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._table is not None:
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None
        elif tag in ("p", "li"):
            self.text.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._ignored:
            self.text.append(data)
            if self._cell is not None:
                self._cell.append(data)


def parse_openai_efforts(html: str) -> ReasoningCapability:
    text = "".join(_Document(html).text)
    match = re.search(r"reasoning[._ ]effort\s+supports?\s*:\s*([^\n.]+)", text, re.I)
    if not match:
        return ReasoningCapability(ReasoningMode.UNKNOWN, description="No effort enum in official model documentation.")
    clause = match.group(1)
    values = _efforts([v.strip() for v in re.sub(r"\([^)]*\)", "", clause).replace(" and ", ",").split(",") if v.strip()])
    default = re.search(r"([a-z]+)\s*\(default\)", clause, re.I)
    return _cap(values, "official OpenAI model documentation", "openai",
                default.group(1).lower() if default else "auto", mandatory="off" not in values)


def _google_names(label: str) -> List[str]:
    label = label.lower().replace("gemini", "").strip()
    parts = [part.strip() for part in label.split("&")]
    suffix = re.sub(r"^[\d.]+\s*", "", parts[-1])
    return ["gemini-" + re.sub(r"\s+", "-", part if re.search(r"[a-z]", part) else part + " " + suffix) for part in parts]


def parse_google_efforts(html: str, model_id: str) -> ReasoningCapability:
    model = model_id.removeprefix("models/")
    document = _Document(html)
    for table in document.tables:
        if not table:
            continue
        header = table[0]
        if header and header[0].lower() == "thinking level":
            for col, label in enumerate(header[1:], 1):
                names = _google_names(label)
                if model not in names and model.removesuffix("-preview") not in names:
                    continue
                values, default = [], "auto"
                for row in table[1:]:
                    if len(row) > col and row[col].lower().startswith("supported"):
                        values.append(row[0].strip("` ").lower())
                        if "default" in row[col].lower():
                            default = values[-1]
                if values:
                    return _cap(values, "official Gemini thinking documentation", "google_level", default, mandatory=True)
        if header and "disable thinking" in [h.lower() for h in header]:
            off_col = [h.lower() for h in header].index("disable thinking")
            for row in table[1:]:
                if not row or model not in _google_names(row[0]):
                    continue
                values = ["dynamic"]
                if len(row) > off_col and re.search(r"thinkingBudget\s*=\s*0\b", row[off_col]):
                    values.append("off")
                limits = re.findall(r"\d+", row[2]) if len(row) > 2 else []
                return _cap(values, "official Gemini budget documentation", "google_budget",
                            supports_max_tokens=True, mandatory="off" not in values,
                            budget_min=int(limits[0]) if len(limits) == 2 else None,
                            budget_max=int(limits[1]) if len(limits) == 2 else None)
    return ReasoningCapability(ReasoningMode.UNKNOWN, description="Model absent from official thinking tables.")


def enrich_anthropic_capability(html: str, model: str, cap: ReasoningCapability) -> ReasoningCapability:
    """Read disabling rules absent from the Models API's effort flags."""
    def normalize(value: str) -> str:
        value = re.sub(r"-\d{8}$", "", value)
        return re.sub(r"[^a-z0-9]", "", value.lower())
    for table in _Document(html).tables:
        if not table or '"disabled"' not in table[0]:
            continue
        column = table[0].index('"disabled"')
        for row in table[1:]:
            if len(row) <= column or normalize(row[0]) != normalize(model):
                continue
            values = [value for value in cap.supported_efforts if value != "off"]
            rule = row[column].lower()
            condition = re.search(r"at ([a-z]+) effort or below", rule)
            off_effort = condition.group(1) if condition else None
            allowed = rule.startswith("thinking off") and (off_effort is None or off_effort in values)
            if allowed:
                values.append("off")
            mandatory = rule.startswith("400")
            return replace(cap, supported_efforts=values, off_effort=off_effort,
                           is_mandatory=mandatory,
                           mode=ReasoningMode.TOGGLEABLE if allowed else ReasoningMode.MANDATORY if mandatory else cap.mode,
                           source="provider metadata and official Anthropic thinking documentation")
    return cap


def _fetch_document(url: str) -> str:
    with _LOCK:
        cached = _DOCS.get(url)
        if cached and time.monotonic() - cached[0] < _TTL:
            return cached[1]
    with urlopen(Request(url, headers={"User-Agent": "Andromity/1.0"}), timeout=4) as response:
        html = response.read(2_000_000).decode("utf-8")
    with _LOCK:
        _DOCS[url] = (time.monotonic(), html)
    return html


def discover_model_reasoning_capability(provider: str, model: str) -> ReasoningCapability:
    """Blocking discovery, called in a worker thread before a stream starts."""
    provider = (provider or "").strip().lower()
    model = (model or "").strip()
    if provider in ("openai", "anthropic", "google"):
        model = model.removeprefix(provider + "/")
    cap = get_model_reasoning_capability(provider, model)
    if cap.mode != ReasoningMode.UNKNOWN and provider != "anthropic":
        return cap
    with _LOCK:
        cached = _DISCOVERED.get((provider, model))
        if cached and time.monotonic() - cached[0] < (60 if cached[1].mode == ReasoningMode.UNKNOWN else _TTL):
            return cached[1]
    try:
        if provider == "openai" and re.fullmatch(r"[a-zA-Z0-9_.-]+", model):
            cap = parse_openai_efforts(_fetch_document("https://developers.openai.com/api/docs/models/" + model))
        elif provider == "google":
            cap = parse_google_efforts(_fetch_document("https://ai.google.dev/gemini-api/docs/generate-content/thinking"), model)
        elif provider == "anthropic":
            if cap.mode == ReasoningMode.UNKNOWN:
                from andromity.config import config
                api_key = config.get_api_key(provider)
                if api_key:
                    request = Request("https://api.anthropic.com/v1/models/" + quote(model, safe=""),
                                      headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"})
                    with urlopen(request, timeout=4) as response:
                        metadata = json.loads(response.read(1_000_000))
                    cap = get_model_reasoning_capability(provider, model, metadata)
            if cap.mode != ReasoningMode.UNKNOWN:
                cap = enrich_anthropic_capability(_fetch_document("https://platform.claude.com/docs/en/build-with-claude/thinking"), model, cap)
        elif provider == "openrouter":
            from andromity.config import config
            from andromity.core.models import fetch_live_models_sync
            rows = fetch_live_models_sync(provider, api_key=config.get_api_key(provider))
            metadata = next((row for row in rows if row.get("id") == model), None)
            if metadata is not None:
                cap = get_model_reasoning_capability(provider, model, metadata)
    except Exception:
        pass  # Offline or changed schemas leave provider defaults intact.
    with _LOCK:
        _DISCOVERED[(provider, model)] = (time.monotonic(), cap)
    return cap


def is_valid_effort(cap: ReasoningCapability, value: str) -> bool:
    value = "off" if value == "none" else value
    if value == "auto" or value in cap.supported_efforts:
        return True
    if not cap.supports_max_tokens or not re.fullmatch(r"budget:[0-9]+", value):
        return False
    budget = int(value.split(":", 1)[1])
    return (cap.budget_min is not None and cap.budget_max is not None
            and cap.budget_min <= budget <= cap.budget_max
            and (budget != 0 or "off" in cap.supported_efforts))


def apply_reasoning_to_request(provider_name: str, model_id: str, effort: Optional[str],
                               kwargs: Dict[str, Any], capability: Optional[ReasoningCapability] = None) -> Dict[str, Any]:
    cap = capability or get_model_reasoning_capability(provider_name, model_id)
    for key in ("reasoning_effort", "thinking", "reasoning", "thinking_level"):
        kwargs.pop(key, None)
    if isinstance(kwargs.get("extra_body"), dict):
        for key in ("reasoning", "thinking"):
            kwargs["extra_body"].pop(key, None)
    generation = kwargs.get("extra_body", {}).get("generationConfig", {})
    if isinstance(generation, dict):
        generation.pop("thinkingConfig", None)
    if isinstance(kwargs.get("output_config"), dict):
        kwargs["output_config"].pop("effort", None)
    value = (effort or "auto").strip().lower()
    value = "off" if value == "none" else value
    if cap.mode in (ReasoningMode.NONE, ReasoningMode.UNKNOWN) or value == "auto":
        return kwargs
    budget = None
    if value.startswith("budget:") and cap.supports_max_tokens:
        try:
            budget = int(value.split(":", 1)[1])
        except ValueError:
            return kwargs
        if cap.budget_min is None or cap.budget_max is None or not cap.budget_min <= budget <= cap.budget_max:
            return kwargs
        if budget == 0 and "off" not in cap.supported_efforts:
            return kwargs
    if budget is not None:
        if cap.request_format == "google_budget":
            kwargs.setdefault("extra_body", {}).setdefault("generationConfig", {})["thinkingConfig"] = {"thinkingBudget": budget}
        elif cap.request_format == "anthropic_budget":
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
            kwargs["max_tokens"] = max(kwargs.get("max_tokens", 0), budget + 1)
        return kwargs
    if value not in cap.supported_efforts:
        value = cap.default_effort
    if value == "auto":
        return kwargs
    if provider_name == "openrouter" and cap.request_format == "openrouter_toggle":
        kwargs.setdefault("extra_body", {})["reasoning"] = {"enabled": value != "off"}
    elif provider_name == "openrouter":
        kwargs.setdefault("extra_body", {})["reasoning"] = {"effort": "none" if value == "off" else value}
    elif cap.request_format == "anthropic_adaptive":
        if value == "off":
            kwargs["thinking"] = {"type": "disabled"}
            if cap.off_effort:
                kwargs.setdefault("output_config", {})["effort"] = cap.off_effort
        else:
            kwargs["thinking"] = {"type": "adaptive"}
            kwargs.setdefault("output_config", {})["effort"] = value
    elif cap.request_format == "anthropic_budget":
        if value == "off":
            kwargs["thinking"] = {"type": "disabled"}
        elif value == "on":
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": 1024}
            kwargs["max_tokens"] = max(kwargs.get("max_tokens", 0), 5120)
        else:
            kwargs.setdefault("output_config", {})["effort"] = value
    elif cap.request_format == "google_level":
        kwargs.setdefault("extra_body", {}).setdefault("generationConfig", {})["thinkingConfig"] = {"thinkingLevel": value}
    elif cap.request_format == "google_budget":
        kwargs.setdefault("extra_body", {}).setdefault("generationConfig", {})["thinkingConfig"] = {"thinkingBudget": 0 if value == "off" else -1}
    elif cap.request_format == "openai":
        kwargs["reasoning_effort"] = "none" if value == "off" else value
    return kwargs
