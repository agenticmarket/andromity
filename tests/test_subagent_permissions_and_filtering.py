import pytest
from unittest.mock import patch
from andromity.core.session import Session, get_all_sessions
from andromity.core.subagent import SubAgent
from andromity.core.events import Done, ToolCallStart, ToolCallEnd, TextDelta


def test_session_list_subagent_filtering(tmp_path):
    main_sess = Session(name="main-user-session", project_path=str(tmp_path))
    main_sess.save()

    child_sess = Session(name="subagent-coder-1", project_path=str(tmp_path))
    child_sess.parent_session = main_sess.id
    child_sess.save()

    # Default listing should only include main sessions
    sessions_default = get_all_sessions(str(tmp_path), include_subagents=False)
    session_ids_default = [s.id for s in sessions_default]
    assert main_sess.id in session_ids_default
    assert child_sess.id not in session_ids_default

    # Explicit include_subagents should include both
    sessions_all = get_all_sessions(str(tmp_path), include_subagents=True)
    session_ids_all = [s.id for s in sessions_all]
    assert main_sess.id in session_ids_all
    assert child_sess.id in session_ids_all


@pytest.mark.asyncio
async def test_subagent_safe_mode_blocks_mutations(tmp_path):
    subagent = SubAgent(
        parent_session_id="parent-safe",
        role="coder",
        task="Write a new file",
        project_path=str(tmp_path),
        permission_mode="safe",
    )

    async def mock_tool_stream(*args, **kwargs):
        yield ToolCallStart(tool_id="call_write", tool_name="write_file")
        yield ToolCallEnd(tool_id="call_write")
        yield Done()

    with patch("andromity.core.subagent.stream_completion", side_effect=mock_tool_stream):
        await subagent.execute()

    tool_msgs = [m for m in subagent.session.messages if m.get("role") == "tool"]
    assert len(tool_msgs) > 0
    assert "TOOL BLOCKED" in tool_msgs[0].get("content", "")
    assert "SAFE mode" in tool_msgs[0].get("content", "")


@pytest.mark.asyncio
async def test_subagent_ssrf_blocked(tmp_path):
    subagent = SubAgent(
        parent_session_id="parent-search",
        role="search",
        task="Fetch private metadata",
        project_path=str(tmp_path),
        permission_mode="full",
    )

    async def mock_ssrf_stream(*args, **kwargs):
        yield ToolCallStart(tool_id="call_fetch", tool_name="fetch_url")
        yield ToolCallEnd(tool_id="call_fetch")
        yield Done()

    # Pass malicious private metadata IP in arguments
    with patch("json.loads", return_value={"url": "http://169.254.169.254/latest/meta-data/"}):
        with patch("andromity.core.subagent.stream_completion", side_effect=mock_ssrf_stream):
            await subagent.execute()

    tool_msgs = [m for m in subagent.session.messages if m.get("role") == "tool"]
    assert len(tool_msgs) > 0
    assert "SECURITY BLOCKED" in tool_msgs[0].get("content", "")
