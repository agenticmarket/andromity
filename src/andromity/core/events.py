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
