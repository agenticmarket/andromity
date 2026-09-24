import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from andromity.core.session_bus import SessionBus
from andromity.core.session import Session
from andromity.server.rpc_handler import JsonRpcHandler
from andromity.core.tools import (
    register_session,
    session_list,
    session_watch,
    session_ask_question_async,
    session_answer_question,
)


async def main():
    print("=" * 70)
    print("  ANDROMITY ROBUST AUTO-AWAKE & COLLABORATION INTEGRATION TEST")
    print("=" * 70)

    bus = SessionBus.reset_instance()
    handler = JsonRpcHandler()

    # 1. Initialize Sessions
    sess_backend = Session(name="BackendAgent", project_path=str(ROOT), session_id="sess_backend_live")
    sess_frontend = Session(name="FrontendAgent", project_path=str(ROOT), session_id="sess_frontend_live")

    sess_backend.status = "idle"
    sess_frontend.status = "idle"

    handler._active_sessions[sess_backend.id] = sess_backend
    handler._active_sessions[sess_frontend.id] = sess_frontend

    bus.register(sess_backend.id, sess_backend.name, sess_backend.project_path, ["api", "db"])
    bus.register(sess_frontend.id, sess_frontend.name, sess_frontend.project_path, ["ui", "react"])

    print("\n[STEP 1] Setup Sessions & Watch Mode")
    register_session(sess_frontend)
    watch_res = session_watch("BackendAgent", reason="Awaiting auth schema")
    print(f" -> FrontendAgent executed session_watch: {watch_res}")
    print(f" -> Frontend status: '{sess_frontend.status}'")
    print(f" -> Frontend watching_for: {sess_frontend.watching_for}")
    assert sess_frontend.status == "watching"

    print("\n[STEP 2] BackendAgent Asks FrontendAgent a Question (Auto-Awake Trigger)")
    register_session(sess_backend)

    # Mock the agent prompt execution when awakened so it answers the question
    async def simulate_frontend_agent_turn(params):
        prompt = params.get("prompt", "")
        session_id = params.get("session_id")
        print(f" [Auto-Awake Worker] Session '{session_id}' awakened with prompt:\n   >>> {prompt[:70]}...")
        # Verify Frontend is now marked running
        current_sess = handler._active_sessions[session_id]
        print(f" [Auto-Awake Worker] Current status: '{current_sess.status}', consecutive_wakes: {current_sess.consecutive_auto_wakes}")
        
        # Simulate agent finding the question and answering it
        pending = bus.get_pending_questions_for(session_id)
        if pending:
            q = pending[0]
            ans_res = session_answer_question(q["question_id"], "Use Bearer JWT token with claims: {sub, role}")
            print(f" [Auto-Awake Worker] Frontend answered question: {ans_res}")
        return {"success": True}

    handler.rpc_agent_prompt = simulate_frontend_agent_turn

    # Frontend should auto-wake and answer within 5 seconds
    print(" [BackendAgent] Invoking session_ask_question_async('FrontendAgent', 'What JWT format do you support?')...")
    answer = await session_ask_question_async(
        to_session="FrontendAgent",
        question="What JWT format do you support?",
        timeout=5.0,
    )
    print(f" [BackendAgent] Received Answer: '{answer}'")
    assert "Bearer JWT token" in answer
    assert sess_frontend.consecutive_auto_wakes == 1
    assert "BackendAgent" in sess_frontend.collaborators

    print("\n[STEP 3] Testing Circuit Breaker (Infinite Loop / Token Burn Protection)")
    # Set max limit reached
    sess_frontend.status = "idle"
    sess_frontend.consecutive_auto_wakes = 2  # At max limit

    print(" [BackendAgent] Sending another question when Frontend is already at MAX_AUTO_WAKES (2)...")
    try:
        # This question should NOT wake Frontend because limit is reached
        await session_ask_question_async(
            to_session="FrontendAgent",
            question="Are you still there?",
            timeout=1.0,
        )
    except asyncio.TimeoutError:
        print(" [BackendAgent] Timed out as expected - Frontend refused auto-wake due to circuit breaker!")

    print(f" -> Frontend status after limit reached: '{sess_frontend.status}'")
    assert sess_frontend.status == "paused_limit_reached"

    print("\n[STEP 4] Testing Human Intervention & Reset")
    print(" [Human] User clicks 'Resume Auto-Wake' / sends message to FrontendAgent...")
    reset_res = await handler.rpc_session_resetAutoWake({"session_id": sess_frontend.id})
    print(f" -> Reset RPC response: {reset_res}")
    assert sess_frontend.consecutive_auto_wakes == 0
    assert sess_frontend.status == "watching"

    print("\n[STEP 5] Testing Anti-Ping-Pong Protection")
    from andromity.core.events import SessionAnswerReceived

    # Answers must NOT trigger auto-wake
    print(" [Check] Ensuring session_answer_question does not wake the asking agent into an infinite reply loop...")
    wake_triggered = False
    
    async def trap_prompt(params):
        nonlocal wake_triggered
        wake_triggered = True
        return {"success": True}

    handler.rpc_agent_prompt = trap_prompt
    answer_event = SessionAnswerReceived(
        question_id="dummy_qid",
        from_session="FrontendAgent",
        to_session="BackendAgent",
        answer="dummy_answer",
        timestamp="2026-09-24T02:00:00Z",
        from_session_id=sess_frontend.id,
        to_session_id=sess_backend.id,
    )
    handler._on_session_bus_event(answer_event)
    await asyncio.sleep(0.1)
    print(f" -> Was auto-wake triggered by question answer? {wake_triggered}")
    assert not wake_triggered

    print("\n" + "=" * 70)
    print("  ALL ROBUSTNESS INTEGRATION CHECKS PASSED SUCCESSFULLY (100%)")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
