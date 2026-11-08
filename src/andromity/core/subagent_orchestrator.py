import asyncio
import logging
from typing import Any, Dict, List, Optional

from andromity.core.debug_log import get_logger
from andromity.core.subagent import MODE_RANK as _MODE_RANK, SubAgent, SubAgentResult, normalize_mode
from andromity.core.subagent_config import SubAgentConfigManager

log = get_logger("subagent_orchestrator")


class SubAgentOrchestrator:
    """Manages the lifecycle, concurrency, and result aggregation of sub-agents."""

    def __init__(self, parent_session_id: str, project_path: Optional[str] = None, permission_mode: Optional[str] = None, parent_profile: Optional[str] = None):
        self.parent_session_id = parent_session_id
        self.project_path = project_path
        self.permission_mode = permission_mode
        self.parent_profile = parent_profile
        self._agents: Dict[str, SubAgent] = {}
        self._tasks: Dict[str, asyncio.Task] = {}
        self._results: Dict[str, SubAgentResult] = {}
        self._max_concurrent = SubAgentConfigManager.get_max_concurrent()
        self._semaphore = asyncio.Semaphore(self._max_concurrent)
        self.current_turn_id: Optional[str] = None

    async def spawn(
        self,
        role: str,
        task: str,
        model_override: Optional[str] = None,
        provider_override: Optional[str] = None,
        tools_override: Optional[List[str]] = None,
        timeout: Optional[float] = None,
        wait: bool = True,
        depth: int = 1,
        tool_id: Optional[str] = None,
        progress_callback: Optional[Any] = None,
        context_snapshot: Optional[Any] = None,
        permission_mode: Optional[str] = None,
        turn_id: Optional[str] = None,
        parent_profile: Optional[str] = None,
    ) -> SubAgentResult:
        """Spawn a sub-agent. If wait=True, waits for completion and returns SubAgentResult."""
        resolved_turn_id = turn_id or self.current_turn_id
        subagent = SubAgent(
            parent_session_id=self.parent_session_id,
            role=role,
            task=task,
            project_path=self.project_path,
            model_override=model_override,
            provider_override=provider_override,
            tools_override=tools_override,
            timeout=timeout,
            depth=depth,
            tool_id=tool_id,
            progress_callback=progress_callback,
            context_snapshot=context_snapshot,
            permission_mode=permission_mode or self.permission_mode,
            turn_id=resolved_turn_id,
            parent_profile=parent_profile or self.parent_profile,
        )
        self._agents[subagent.id] = subagent
        log.info("SubAgent spawned: id=%s role=%s model=%s provider=%s", subagent.id, subagent.role, subagent.model, subagent.provider)

        async def _run_with_semaphore() -> SubAgentResult:
            async with self._semaphore:
                res = await subagent.execute()
                self._results[subagent.id] = res
                return res

        task_handle = asyncio.create_task(_run_with_semaphore())
        self._tasks[subagent.id] = task_handle
        subagent._task_handle = task_handle

        if wait:
            try:
                return await task_handle
            except asyncio.CancelledError:
                self.kill(subagent.id, reason="parent_stream_cancelled")
                raise
        
        # When fire-and-forget, return immediate pending result descriptor
        return SubAgentResult(
            agent_id=subagent.id,
            role=subagent.role,
            status="running",
            summary=f"SubAgent {subagent.id} launched in background.",
        )


    def get_agent(self, agent_id: str) -> Optional[SubAgent]:
        return self._agents.get(agent_id)

    def get_status(self, agent_id: str) -> Optional[Dict[str, Any]]:
        agent = self._agents.get(agent_id)
        if not agent:
            return None
        res = self._results.get(agent_id)
        return {
            "id": agent.id,
            "role": agent.role,
            "status": res.status if res else agent.status,
            "model": agent.model,
            "provider": agent.provider,
            "summary": res.summary if res else "",
            "duration_ms": res.duration_ms if res else 0.0,
            "error": res.error if res else None,
        }

    def list_subagents(self) -> List[Dict[str, Any]]:
        return [
            self.get_status(aid) for aid in self._agents.keys()
            if self.get_status(aid) is not None
        ]

    def kill(self, agent_id: str, reason: str = "user_cancelled") -> bool:
        """Kill an active subagent."""
        agent = self._agents.get(agent_id)
        if not agent:
            return False
        agent.kill(reason=reason)
        task = self._tasks.get(agent_id)
        if task and not task.done():
            task.cancel()
        log.info("Killed subagent %s (reason: %s)", agent_id, reason)
        return True

    def has_running(self) -> bool:
        return any(not task.done() for task in self._tasks.values())

    def session_ids(self) -> List[str]:
        """Ids of the sub-agents' own sessions, under which their shell commands run."""
        ids = (getattr(getattr(agent, "session", None), "id", None) for agent in self._agents.values())
        return [sid for sid in ids if isinstance(sid, str) and sid]

    def restrict_to(self, mode: Optional[str]) -> None:
        """Lower this orchestrator's and its sub-agents' permission mode to `mode` when that is stricter."""
        rank = _MODE_RANK.get(str(mode or "").lower())
        if rank is None:
            return
        for holder in [self, *self._agents.values()]:
            current = _MODE_RANK.get(str(getattr(holder, "permission_mode", "") or "").lower())
            if current is None or rank < current:
                holder.permission_mode = str(mode).lower()

    def kill_all(self, reason: str = "orchestrator_shutdown"):
        """Kill all active subagents."""
        for aid in list(self._agents.keys()):
            self.kill(aid, reason=reason)

    async def await_all(self) -> List[SubAgentResult]:
        """Wait for all currently spawned subagents to finish."""
        pending_tasks = [t for t in self._tasks.values() if not t.done()]
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)
        return list(self._results.values())


def session_orchestrators(session: Any) -> List[SubAgentOrchestrator]:
    """The session's current orchestrator and earlier turns' ones whose sub-agents were still running."""
    current = getattr(session, "_orchestrator", None)
    earlier = getattr(session, "_earlier_orchestrators", None) or []
    return [o for o in [current, *earlier] if isinstance(o, SubAgentOrchestrator)]


def restrict_session_subagents(session: Any, mode: Any) -> None:
    """Lower the permission mode of every sub-agent the session started to `mode`, when that is stricter."""
    for orchestrator in session_orchestrators(session):
        orchestrator.restrict_to(normalize_mode(mode))


def kill_session_subagents(session: Any, reason: str) -> List[str]:
    """Stop every sub-agent the session started, in this turn or an earlier one. Returns their sessions' ids."""
    ids: List[str] = []
    for orchestrator in session_orchestrators(session):
        ids.extend(orchestrator.session_ids())
        orchestrator.kill_all(reason=reason)
    return ids
