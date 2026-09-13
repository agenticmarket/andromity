import tempfile
import unittest
from unittest.mock import patch
from andromity.core.provider import sanitize_messages_for_api
from andromity.core.session import Session
from andromity.core.agent import Agent
from andromity.core.events import TextDelta, Done


class TestMessageSanitizer(unittest.TestCase):
    def test_sanitize_empty_and_valid(self):
        self.assertEqual(sanitize_messages_for_api([]), [])
        
        msgs = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        result = sanitize_messages_for_api(msgs)
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]["role"], "system")
        self.assertEqual(result[1]["role"], "user")
        self.assertEqual(result[2]["role"], "assistant")

    def test_sanitize_strips_invalid_keys(self):
        msgs = [
            {
                "role": "assistant",
                "content": "thinking aloud",
                "thinking": "huge reasoning string",
                "duration": 4.5,
                "turn_id": "turn_1",
            }
        ]
        result = sanitize_messages_for_api(msgs)
        self.assertEqual(len(result), 1)
        self.assertNotIn("thinking", result[0])
        self.assertNotIn("duration", result[0])
        self.assertNotIn("turn_id", result[0])
        self.assertEqual(result[0]["role"], "assistant")
        self.assertEqual(result[0]["content"], "thinking aloud")

    def test_sanitize_drops_orphaned_tool_messages(self):
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "summary of past conversation"},
            {"role": "assistant", "content": "Understood. I have the context."},
            {"role": "tool", "content": "orphaned tool output", "tool_call_id": "call_old123"},
            {"role": "user", "content": "Next request"},
        ]
        result = sanitize_messages_for_api(msgs)
        
        self.assertEqual(len(result), 4)
        roles = [m["role"] for m in result]
        self.assertEqual(roles, ["system", "user", "assistant", "user"])
        self.assertTrue(all(m.get("role") != "tool" for m in result))

    def test_sanitize_keeps_valid_tool_calls(self):
        msgs = [
            {"role": "user", "content": "Read file"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path": "a.txt"}'},
                    }
                ],
            },
            {"role": "tool", "content": "file contents", "name": "read_file", "tool_call_id": "call_1"},
            {"role": "assistant", "content": "The file contains: file contents"},
        ]
        result = sanitize_messages_for_api(msgs)
        self.assertEqual(len(result), 4)
        self.assertEqual(result[1]["role"], "assistant")
        self.assertEqual(len(result[1]["tool_calls"]), 1)
        self.assertEqual(result[2]["role"], "tool")
        self.assertEqual(result[2]["tool_call_id"], "call_1")

    def test_sanitize_synthesizes_unfulfilled_tool_calls(self):
        msgs = [
            {"role": "user", "content": "Do 2 things"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "f1", "arguments": "{}"}},
                    {"id": "call_2", "type": "function", "function": {"name": "f2", "arguments": "{}"}},
                ],
            },
            {"role": "tool", "content": "res1", "name": "f1", "tool_call_id": "call_1"},
            {"role": "user", "content": "User cancels and says something else"},
        ]
        result = sanitize_messages_for_api(msgs)
        
        roles = [m["role"] for m in result]
        self.assertEqual(roles, ["user", "assistant", "tool", "tool", "user"])
        self.assertEqual(result[2]["tool_call_id"], "call_1")
        self.assertEqual(result[3]["tool_call_id"], "call_2")
        content_lower = result[3]["content"].lower()
        self.assertTrue("cancelled" in content_lower or "interrupted" in content_lower)

    def test_sanitize_reorders_displaced_tool_messages(self):
        msgs = [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "f1", "arguments": "{}"}}
                ],
            },
            {"role": "user", "content": "Reminder"},
            {"role": "tool", "content": "res1", "name": "f1", "tool_call_id": "call_1"},
        ]
        result = sanitize_messages_for_api(msgs)
        roles = [m["role"] for m in result]
        self.assertEqual(roles, ["assistant", "tool", "user"])
        self.assertEqual(result[1]["tool_call_id"], "call_1")


class TestCompactionTurnBoundaries(unittest.IsolatedAsyncioTestCase):
    async def test_compaction_maintains_clean_turn_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp_path:
            session = Session(name="test_compact", project_path=tmp_path)
            agent = Agent(session, profile="builder")
            
            session.add_message("system", content="System prompt")
            session.add_message("user", content="Turn 1: list files")
            session.add_message("assistant", content=None, tool_calls=[
                {"id": "c1", "type": "function", "function": {"name": "list_dir", "arguments": "{}"}}
            ])
            session.add_message("tool", content="file1.txt\nfile2.txt", name="list_dir", tool_call_id="c1")
            session.add_message("assistant", content="Found files.")
            
            session.add_message("user", content="Turn 2: read file1")
            session.add_message("assistant", content=None, tool_calls=[
                {"id": "c2", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}
            ])
            session.add_message("tool", content="hello world", name="read_file", tool_call_id="c2")
            session.add_message("assistant", content="Content is hello world.")

            session.add_message("user", content="Turn 3: do something else")
            session.add_message("assistant", content="Doing it.")

            async def mock_stream(messages, **kwargs):
                yield TextDelta(text="Summary of previous turns.")
                yield Done()

            with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
                events = []
                async for ev in agent._compact_context(force=True):
                    events.append(ev)

            for i, m in enumerate(session.messages):
                if m["role"] == "tool":
                    self.assertGreater(i, 0)
                    prev = session.messages[i - 1]
                    self.assertEqual(prev["role"], "assistant")
                    self.assertIsNotNone(prev.get("tool_calls"))
                    tc_ids = [tc["id"] for tc in prev["tool_calls"]]
                    self.assertIn(m["tool_call_id"], tc_ids)

            summary_idx = -1
            for i, m in enumerate(session.messages):
                if m["role"] == "assistant" and "Understood." in str(m.get("content", "")):
                    summary_idx = i
                    break
            self.assertNotEqual(summary_idx, -1)
            self.assertEqual(session.messages[summary_idx + 1]["role"], "user")


if __name__ == "__main__":
    unittest.main()
