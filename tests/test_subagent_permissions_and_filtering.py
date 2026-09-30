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
    from andromity.config import config
    config.set_trusted(str(tmp_path))
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


@pytest.mark.asyncio
async def test_subagent_planner_profile_strips_and_blocks_mutations(tmp_path):
    """Planner profile cannot grant mutating tools to child subagents."""
    from andromity.config import config
    config.set_trusted(str(tmp_path))
    subagent = SubAgent(
        parent_session_id="parent-planner",
        role="coder",
        task="Modify codebase",
        project_path=str(tmp_path),
        permission_mode="trust",
        parent_profile="planner",
    )
    # 1. Allowed tools must NOT contain mutating write or shell tools
    tool_names = [t["function"]["name"] for t in subagent.allowed_tools]
    assert "write_file" not in tool_names
    assert "edit_file" not in tool_names
    assert "edit_file_multi" not in tool_names
    assert "shell_exec" not in tool_names
    assert "shell_bg" not in tool_names

    # 2. Defense in depth: if the model attempts to invoke write_file anyway, _exec_tool blocks it
    _, _, res_str = await subagent._exec_tool({
        "id": "call_illegal_write",
        "function": {
            "name": "write_file",
            "arguments": '{"path": "exploit.py", "content": "import os"}'
        }
    })
    assert "SECURITY BLOCKED" in res_str
    assert "parent profile 'planner' is restricted" in res_str


@pytest.mark.asyncio
async def test_subagent_reviewer_profile_strips_and_blocks_shell(tmp_path):
    """Reviewer profile cannot grant shell execution to child subagents."""
    from andromity.config import config
    config.set_trusted(str(tmp_path))
    subagent = SubAgent(
        parent_session_id="parent-reviewer",
        role="coder",
        task="Run dangerous command",
        project_path=str(tmp_path),
        permission_mode="yolo",
        parent_profile="reviewer",
    )
    tool_names = [t["function"]["name"] for t in subagent.allowed_tools]
    assert "shell_exec" not in tool_names
    assert "shell_bg" not in tool_names

    _, _, res_str = await subagent._exec_tool({
        "id": "call_illegal_shell",
        "function": {
            "name": "shell_exec",
            "arguments": '{"command": "rm -rf /"}'
        }
    })
    assert "SECURITY BLOCKED" in res_str
    assert "parent profile 'reviewer' is restricted" in res_str


@pytest.mark.asyncio
async def test_subagent_untrusted_folder_blocks_in_yolo_and_full(tmp_path):
    """Untrusted workspace blocks mutating tools unconditionally in YOLO and FULL modes."""
    from andromity.config import config
    # Ensure folder is untrusted
    config.set("security", "trusted_folders", [])
    assert not config.is_trusted(str(tmp_path))

    for mode in ("yolo", "full"):
        subagent = SubAgent(
            parent_session_id=f"parent-{mode}",
            role="coder",
            task="Write file in untrusted directory",
            project_path=str(tmp_path),
            permission_mode=mode,
            parent_profile="builder",
        )
        # Upfront tool schema strip
        tool_names = [t["function"]["name"] for t in subagent.allowed_tools]
        assert "write_file" not in tool_names
        assert "shell_exec" not in tool_names

        # Execution block
        _, _, res_str = await subagent._exec_tool({
            "id": "call_write_untrusted",
            "function": {
                "name": "write_file",
                "arguments": '{"path": "test.txt", "content": "hello"}'
            }
        })
        assert "TOOL BLOCKED" in res_str
        assert "untrusted workspace" in res_str

