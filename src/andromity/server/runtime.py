"""Transient session state for clients attaching during a running turn."""
from copy import deepcopy
from threading import RLock
from typing import Any, Dict


class SessionRuntime:
    def __init__(self) -> None:
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._lock = RLock()

    def observe(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        sid = params.get("session_id")
        if not sid:
            return params
        with self._lock:
            state = self._sessions.setdefault(sid, {
                "event_seq": 0, "tools": {}, "interactions": {},
                "text": "", "thinking": "",
            })
            state["event_seq"] += 1
            event = {**params, "event_seq": state["event_seq"]}
            if method == "agent/started":
                state.update(tools={}, text="", thinking="")
            elif method == "agent/textDelta":
                state["text"] += params.get("text", "")
            elif method == "agent/thinkingDelta":
                state["thinking"] += params.get("text", "")
            elif method == "waterfall/llmEnd":
                # The completed response is committed to session history next.
                state.update(text="", thinking="")
            elif method == "agent/toolStart":
                state["tools"][params["tool_id"]] = {**event, "args_json": ""}
            elif method == "agent/toolDelta":
                tool = state["tools"].get(params["tool_id"])
                if tool is not None:
                    tool["args_json"] += params.get("chunk", "")
            elif method == "agent/toolResult":
                state["tools"].pop(params.get("tool_id"), None)
            elif method in ("agent/toolApprovalRequired", "agent/askQuestions", "agent/planApproval"):
                kind = {"agent/toolApprovalRequired": "tool_approval_required",
                        "agent/askQuestions": "ask_questions", "agent/planApproval": "plan_approval"}[method]
                identity = params.get("approval_id") or params.get("question_id") or "plan"
                state["interactions"][identity] = {"type": kind, **deepcopy(event)}
            elif method == "agent/interactionResolved":
                state["interactions"].pop(params.get("interaction_id"), None)
            elif method == "agent/planUpdated" and (params.get("plan") or {}).get("status") != "pending":
                state["interactions"].pop("plan", None)
            elif method in ("agent/done", "agent/cancelled", "agent/error"):
                state.update(tools={}, text="", thinking="")
                # Pending plans can outlive the turn that proposes them.
                state["interactions"] = {k: v for k, v in state["interactions"].items() if k == "plan"}
            return event

    def snapshot(self, sid: str) -> Dict[str, Any]:
        with self._lock:
            state = self._sessions.get(sid, {})
            return deepcopy({
                "event_seq": state.get("event_seq", 0),
                "tools": list(state.get("tools", {}).values()),
                "interactions": list(state.get("interactions", {}).values()),
                "text": state.get("text", ""), "thinking": state.get("thinking", ""),
            })
