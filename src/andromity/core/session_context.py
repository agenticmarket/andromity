"""Text a session hands to a session started from it."""
import re
from typing import Any, Dict


def message_text(message: Dict[str, Any]) -> str:
    """A message's visible text, without the IDE or session context appended after a '---' line."""
    content = message.get("content") if isinstance(message, dict) else ""
    if isinstance(content, list):
        content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    text = str(content or "")
    cut = text.find("\n---\n[")
    return (text[:cut] if cut >= 0 else text).strip()


SESSION_CONTEXT_MARKERS = ("\n---\n[Started from session ", "\n---\n[Background sessions]")


def without_session_context(text: str) -> str:
    """The prompt as the user wrote it, without the context Andromity appended for the model."""
    text = text or ""
    cuts = [i for i in (text.find(m) for m in SESSION_CONTEXT_MARKERS) if i >= 0]
    return text[:min(cuts)].rstrip() if cuts else text


_MAILBOX_NOTICE = re.compile(r"\n\n\[Co-Agent Mailbox: (?:Pending questions: |\d+ unread message)")


def prompt_as_written(text: str) -> str:
    """A sent prompt without the session context and the co-agent mailbox notice added to it for the model."""
    text = without_session_context(text)
    notice = _MAILBOX_NOTICE.search(text)
    return text[:notice.start()] if notice and text.endswith("]") else text


def shorten(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def background_context(parent: Any) -> str:
    """What a session started from another one needs to know about it."""
    messages = getattr(parent, "messages", None) or []
    last_request = next((message_text(m) for m in reversed(messages) if m.get("role") == "user" and message_text(m)), "")
    last_reply = next((message_text(m) for m in reversed(messages) if m.get("role") == "assistant" and message_text(m)), "")
    lines = [f'\n\n---\n[Started from session "{getattr(parent, "name", "")}"]']
    if last_request:
        lines.append(f"Its last request: {shorten(last_request, 1500)}")
    if last_reply:
        lines.append(f"Its last reply: {shorten(last_reply, 2000)}")
    return "\n".join(lines)
