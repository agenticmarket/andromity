import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from andromity.core.session_bus import SessionBus
from andromity.core.session import Session
from andromity.core.tools import (
    register_session,
    session_list,
    session_send_message_async,
    session_read_messages,
    session_ask_question_async,
    session_answer_question,
)


async def main():
    print("=" * 65)
    print("  ANDROMITY CONCURRENT MULTI-SESSION COORDINATION TEST")
    print("=" * 65)

    bus = SessionBus.reset_instance()

    sess_back = Session(name="Backend", project_path=str(ROOT), session_id="sess_backend_01")
    sess_front = Session(name="Frontend", project_path=str(ROOT), session_id="sess_frontend_02")

    bus.register(sess_back.id, sess_back.name, sess_back.project_path, ["api", "db"])
    bus.register(sess_front.id, sess_front.name, sess_front.project_path, ["ui", "react"])

    print("\n[1] Registered Sessions on SessionBus:")
    register_session(sess_back)
    print(session_list())

    print("\n[2] Backend sends asynchronous message to Frontend:")
    send_result = await session_send_message_async(
        to_session="Frontend",
        content="Authentication API ready at http://localhost:8000/api/v1/auth"
    )
    print(f" -> {send_result}")

    print(f" -> Frontend unread mailbox count: {bus.get_unread_count('sess_frontend_02')}")

    print("\n[3] Frontend switches active context and reads mailbox:")
    register_session(sess_front)
    unread_content = session_read_messages()
    print(unread_content)
    print(f" -> Frontend unread mailbox count after reading: {bus.get_unread_count('sess_frontend_02')}")

    print("\n[4] Running Concurrent Question & Answer between Frontend and Backend...")

    async def frontend_task():
        register_session(sess_front)
        print(" [Frontend] Asking Backend: 'What headers are needed for /api/v1/user?'")
        answer = await session_ask_question_async(
            to_session="Backend",
            question="What headers are needed for /api/v1/user?",
            timeout=10.0,
        )
        print(f" [Frontend] Received Answer from Backend: '{answer}'")
        return answer

    async def backend_task():
        await asyncio.sleep(0.5)
        register_session(sess_back)
        pending = bus.get_pending_questions_for("sess_backend_01")
        if not pending:
            print(" [Backend] No pending questions found!")
            return
        q = pending[0]
        qid = q["question_id"]
        print(f" [Backend] Detected question from {q['from_session']} (ID: {qid}): '{q['question']}'")
        ans_res = session_answer_question(qid, "Authorization: Bearer <token>, Content-Type: application/json")
        print(f" [Backend] {ans_res}")

    ans, _ = await asyncio.gather(frontend_task(), backend_task())

    print("\n" + "=" * 65)
    if "Authorization: Bearer <token>" in ans:
        print("  SUCCESS: Both sessions coordinated and exchanged data live!")
    else:
        print("  FAILURE: Question/Answer exchange failed.")
    print("=" * 65)


if __name__ == "__main__":
    asyncio.run(main())
