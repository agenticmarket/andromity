"""Tool-call ids that are unique within a session.

Refusals, approvals and receipts are keyed by the tool call's id, and some providers repeat ids across responses
or send none, so an old decision could otherwise attach itself to a new call."""
from __future__ import annotations

import uuid
from typing import Any, Dict, Iterable, Set


def used_call_ids(session: Any) -> Set[str]:
    """Every id this session's history or records already use, including records of compacted-away turns."""
    used: Set[str] = set()
    for message in getattr(session, "messages", None) or []:
        if not isinstance(message, dict):
            continue
        if isinstance(message.get("tool_call_id"), str):
            used.add(message["tool_call_id"])
        for call in message.get("tool_calls") or []:
            if isinstance(call, dict) and isinstance(call.get("id"), str):
                used.add(call["id"])
    for records in (getattr(session, "tool_gates", None), getattr(session, "tool_decisions", None)):
        if isinstance(records, dict):
            used.update(key for key in records if isinstance(key, str))
    return used


class UniqueCallIds:
    def __init__(self, used: Iterable[str]):
        self._used = {str(item) for item in used if item}
        self._response: Dict[str, str] = {}

    def next_response(self) -> None:
        """Start mapping a new model response; ids repeated inside one response stay the same call."""
        self._response = {}

    def fresh(self) -> str:
        unique = f"call_{uuid.uuid4().hex[:12]}"
        self._used.add(unique)
        return unique

    def map(self, provider_id: Any) -> str:
        key = str(provider_id or "")
        if key in self._response:
            return self._response[key]
        unique = key if key and key not in self._used else self.fresh()
        self._used.add(unique)
        self._response[key] = unique
        return unique
