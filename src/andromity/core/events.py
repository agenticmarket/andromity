from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class StreamEvent:
    pass


@dataclass
class TextDelta(StreamEvent):
    text: str


@dataclass
class ThinkingDelta(StreamEvent):
    text: str


@dataclass
class ToolCallStart(StreamEvent):
    tool_name: str
    tool_id: str


@dataclass
class ToolCallDelta(StreamEvent):
    tool_id: str
    args_json_chunk: str


@dataclass
class ToolCallEnd(StreamEvent):
    tool_id: str


@dataclass
class Done(StreamEvent):
    usage: Optional[Dict[str, int]] = None


@dataclass
class ToolResult(StreamEvent):
    tool_id: str
    result: str


@dataclass
class PlanApprovalRequired(StreamEvent):
    plan: Any


# ── Sub-Agent Orchestration Events ───────────────────────────────────────────

@dataclass
class SubAgentSpawned(StreamEvent):
    agent_id: str
    role: str
    model: str
    provider: str
    task: str


@dataclass
class SubAgentProgress(StreamEvent):
    agent_id: str
    role: str = ""
    status: str = "running"
    event_type: str = "progress"  # "tool_call" | "tool_result" | "text" | "thinking"
    delta_text: Optional[str] = None
    tool_name: Optional[str] = None
    tool_args: Optional[str] = None
    tool_result: Optional[str] = None
    detail: Optional[str] = None



@dataclass
class SubAgentDone(StreamEvent):
    agent_id: str
    role: str
    result: str
    token_usage: Optional[Dict[str, int]] = None
    duration_ms: float = 0.0


@dataclass
class SubAgentFailed(StreamEvent):
    agent_id: str
    role: str
    error: str
    duration_ms: float = 0.0


@dataclass
class SubAgentKilled(StreamEvent):
    agent_id: str
    role: str
    reason: str = "user_or_parent_cancelled"


# ── Multi-Session Coordination Events ────────────────────────────────────────

@dataclass
class SessionRegistered(StreamEvent):
    session_id: str
    name: str
    project_path: Optional[str] = None


@dataclass
class SessionUnregistered(StreamEvent):
    session_id: str


@dataclass
class SessionMessageReceived(StreamEvent):
    from_session: str
    to_session: str
    content: str
    message_type: str = "message"
    timestamp: str = ""


@dataclass
class SessionQuestionReceived(StreamEvent):
    question_id: str
    from_session: str
    to_session: str
    question: str
    timestamp: str = ""


@dataclass
class SessionAnswerReceived(StreamEvent):
    question_id: str
    from_session: str
    to_session: str
    answer: str
    timestamp: str = ""


@dataclass
class SharedStateChanged(StreamEvent):
    key: str
    old_value: Any
    new_value: Any
    author_session: Optional[str] = None
    timestamp: str = ""


@dataclass
class HandoffWritten(StreamEvent):
    phase: str
    from_session: str
    status: str
    summary: str
    timestamp: str = ""
