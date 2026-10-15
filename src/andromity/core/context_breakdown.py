"""What fills a session's context window, by category, for the VS Code context popover.

Sizes are estimates (about four characters per token, as elsewhere in Andromity)
of exactly what the agent sends each request: the system prompt and its parts,
the tool definitions for the active profile, and the conversation as
``Agent._messages_for_api`` builds it. Thinking text is stored for display but
never sent, so it is not counted. When the provider reported the size of the
last request, that number is the "used" total; otherwise the estimate is.
"""

import json
from typing import Any, Dict, List, Optional

from andromity.config import config

# Must match Agent._compact_context: auto-compaction starts above this share of the window.
AUTO_COMPACT_THRESHOLD = 0.80

_SUMMARY_PREFIXES = ("[Conversation summary of earlier turns]", "[Previous context summary")


def _tokens(text: Any) -> int:
    if not text:
        return 0
    return len(text if isinstance(text, str) else str(text)) // 4


def _content_tokens(content: Any) -> int:
    if isinstance(content, list):
        return sum(_tokens(part.get("text", "")) if isinstance(part, dict) else _tokens(part) for part in content)
    return _tokens(content)


def _system_parts(system_prompt: str, project_path: Optional[str]) -> Dict[str, int]:
    """Split the stored system message into its base prompt, deferred-tool catalog and skills list."""
    catalog = ""
    skills = ""
    try:
        from andromity.core.tools import ToolRegistry
        catalog = ToolRegistry.get_instance().get_deferred_prompt_catalog() or ""
    except Exception:
        catalog = ""
    try:
        from andromity.core.skills import SkillsManager
        skills = SkillsManager(project_path).prompt_block() or ""
    except Exception:
        skills = ""
    catalog_tokens = _tokens(catalog) if catalog and catalog in system_prompt else 0
    skills_tokens = _tokens(skills) if skills and skills in system_prompt else 0
    return {
        "system_prompt": max(0, _tokens(system_prompt) - catalog_tokens - skills_tokens),
        "deferred_tools": catalog_tokens,
        "skills": skills_tokens,
    }


def context_breakdown(
    session: Any,
    profile: Optional[str] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    messages = list(getattr(session, "messages", None) or [])
    system_prompt = ""
    if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
        system_prompt = str(messages[0].get("content") or "")
        messages = messages[1:]

    parts = _system_parts(system_prompt, getattr(session, "project_path", None))

    profile = profile or getattr(session, "profile", None) or config.get("default", "profile", "builder")
    if tools is None:
        try:
            from andromity.core.profiles import filter_tools_for_profile
            from andromity.core.tools import CORE_TOOLS
            tools = filter_tools_for_profile(CORE_TOOLS, profile)
        except Exception:
            tools = []
    tool_definitions = _tokens(json.dumps(tools)) if tools else 0

    summary = user = assistant = tool_calls = tool_results = 0
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        size = _content_tokens(m.get("content"))
        if role == "user":
            text = m.get("content") if isinstance(m.get("content"), str) else ""
            if text.lstrip().startswith(_SUMMARY_PREFIXES):
                summary += size
            else:
                user += size
        elif role == "assistant":
            assistant += size
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") if isinstance(tc, dict) else None
                if isinstance(fn, dict):
                    tool_calls += _tokens(fn.get("name", "")) + _tokens(fn.get("arguments", ""))
        elif role == "tool":
            tool_results += size + 2

    categories = [
        {"key": "system_prompt", "label": "System prompt", "tokens": parts["system_prompt"]},
        {"key": "tool_definitions", "label": "Tool definitions", "tokens": tool_definitions},
        {"key": "deferred_tools", "label": "MCP & deferred tools", "tokens": parts["deferred_tools"]},
        {"key": "skills", "label": "Skills", "tokens": parts["skills"]},
        {"key": "summary", "label": "Compacted summary", "tokens": summary},
        {"key": "user", "label": "Your messages", "tokens": user},
        {"key": "assistant", "label": "Replies", "tokens": assistant},
        {"key": "tool_calls", "label": "Tool calls", "tokens": tool_calls},
        {"key": "tool_results", "label": "Tool results", "tokens": tool_results},
    ]
    estimated = sum(c["tokens"] for c in categories)

    provider = provider or getattr(session, "provider", None) or config.get("default", "provider", "")
    model = model or getattr(session, "model", None) or config.get("default", "model", "")
    limit = 0
    if provider and model:
        try:
            from andromity.core.models import get_context_limit_for_model
            limit = int(get_context_limit_for_model(provider, model) or 0)
        except Exception:
            limit = 0

    reported = int(getattr(session, "context_tokens", 0) or 0)
    auto_compact = bool(config.get("advanced", "auto_compact", True))
    return {
        "session_id": getattr(session, "id", None),
        "limit": limit,
        "used_tokens": reported if reported > 0 else estimated,
        "used_source": "provider" if reported > 0 else "estimate",
        "reported_tokens": reported,
        "estimated_tokens": estimated,
        "categories": categories,
        "auto_compact": auto_compact,
        "compact_threshold": AUTO_COMPACT_THRESHOLD,
        "compact_at_tokens": int(limit * AUTO_COMPACT_THRESHOLD) if limit else 0,
        "message_count": len(messages),
    }
