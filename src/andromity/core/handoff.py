import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from andromity.config import get_config_dir
from andromity.core.debug_log import get_logger
from andromity.core.events import HandoffWritten

log = get_logger("handoff")


@dataclass
class HandoffDoc:
    phase: str
    from_session: str
    status: str  # "complete" | "in_progress" | "blocked"
    produced: Dict[str, Any] = field(default_factory=dict)
    blocked_on: List[str] = field(default_factory=list)
    next_steps: List[str] = field(default_factory=list)
    notes: str = ""
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    to_session: str = ""

    def to_dict(self) -> Dict[str, Any]:
        doc = {
            "phase": self.phase,
            "from_session": self.from_session,
            "status": self.status,
            "produced": self.produced,
            "blocked_on": self.blocked_on,
            "next_steps": self.next_steps,
            "notes": self.notes,
            "created_at": self.created_at,
        }
        if self.to_session:
            doc["to_session"] = self.to_session
        return doc


def get_handoff_dir(project_path: Optional[str] = None) -> Path:
    if project_path:
        p = Path(project_path) / ".andromity" / "handoffs"
    else:
        p = get_config_dir() / "handoffs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_handoff(
    phase: str,
    from_session: str,
    status: str,
    produced: Optional[Dict[str, Any]] = None,
    blocked_on: Optional[List[str]] = None,
    next_steps: Optional[List[str]] = None,
    notes: str = "",
    project_path: Optional[str] = None,
    to_session: str = "",
    to_session_id: str = "",
    from_session_id: str = "",
) -> Dict[str, Any]:
    """Write a structured handoff document and notify the session bus.

    With ``to_session_id`` (already resolved within the author's project) the target
    session is woken to pick the handoff up; without it the handoff is project-wide.
    """
    clean_phase = phase.strip().lower().replace(" ", "_")
    doc = HandoffDoc(
        phase=clean_phase,
        from_session=from_session,
        status=status.lower(),
        produced=produced or {},
        blocked_on=blocked_on or [],
        next_steps=next_steps or [],
        notes=notes,
        to_session=to_session,
    )
    doc_dict = doc.to_dict()
    handoff_dir = get_handoff_dir(project_path)
    file_path = handoff_dir / f"{clean_phase}.json"
    file_path.write_text(json.dumps(doc_dict, indent=2), encoding="utf-8")
    log.info("Wrote handoff document: %s (%s)", file_path, status)

    try:
        from andromity.core.session_bus import SessionBus
        summary_line = f"Phase '{clean_phase}' marked {status} by session '{from_session}'"
        SessionBus.get_instance()._emit_event(HandoffWritten(
            phase=clean_phase,
            from_session=from_session,
            status=status,
            summary=summary_line,
            timestamp=doc.created_at,
            to_session=to_session,
            to_session_id=to_session_id,
            from_session_id=from_session_id,
        ))
    except Exception as e:
        log.warning("Could not announce handoff %s: %s", clean_phase, e)

    return doc_dict


def read_handoff(phase: str, project_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Read a structured handoff document by phase name."""
    clean_phase = phase.strip().lower().replace(" ", "_")
    handoff_dir = get_handoff_dir(project_path)
    file_path = handoff_dir / f"{clean_phase}.json"
    if not file_path.exists():
        return None
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("Failed to parse handoff %s: %s", file_path, e)
        return None


def list_handoffs(project_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """List all available handoff documents."""
    handoff_dir = get_handoff_dir(project_path)
    results = []
    for p in handoff_dir.glob("*.json"):
        try:
            results.append(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            continue
    return sorted(results, key=lambda x: x.get("created_at", ""), reverse=True)
