"""Backward-compatible imports for the model effort engine."""
from andromity.core.effort import (
    ReasoningCapability, ReasoningMode, apply_reasoning_to_request,
    discover_model_reasoning_capability, get_model_reasoning_capability,
)
__all__ = [
    "ReasoningCapability", "ReasoningMode", "apply_reasoning_to_request",
    "discover_model_reasoning_capability", "get_model_reasoning_capability",
    "ordered_reasoning_efforts",
]


def ordered_reasoning_efforts(values: list[str]) -> list[str]:
    """Order UI choices by increasing effort without changing provider metadata."""
    ascending = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "on"]
    choices = list(dict.fromkeys(["auto", *(value for value in values if value != "auto")]))
    return sorted(choices, key=lambda value: ascending.index(value) if value in ascending else len(ascending))
