"""suggest_next_step: one follow-up the user can start with a click at the end of a turn."""
import pytest

from andromity.core.agent import Agent
from andromity.core.events import Done, NextStepSuggested, TextDelta, ToolCallDelta, ToolCallEnd, ToolCallStart
from andromity.core.session import Session
from andromity.core.tools import execute_tool, parse_next_step, requires_workspace_trust
from andromity.server import rpc_handler as rpc_module
from andromity.server.rpc_handler import READ_ONLY_TOOLS, JsonRpcHandler


@pytest.fixture(autouse=True)
def _trusted(monkeypatch):
    from andromity.config import config
    monkeypatch.setattr(config, "is_trusted", lambda path: True)


def _step(title: str, prompt: str, new_session: bool = False) -> NextStepSuggested:
    return NextStepSuggested(options=[{"title": title, "prompt": prompt, "new_session": new_session}])


def _tool_names(agent: Agent) -> set:
    return {t["function"]["name"] for t in agent.allowed_tools}


def test_suggestion_is_normalised_for_display():
    step = parse_next_step({"title": "  Fix   the\nnull check ", "prompt": " Fix the null check in parser.py ", "new_session": 1})
    assert step == {"question": "", "options": [{"title": "Fix the null check", "prompt": "Fix the null check in parser.py", "new_session": True}]}
    long_title = parse_next_step({"title": "x" * 80, "prompt": "p"})["options"][0]["title"]
    assert len(long_title) == 60 and long_title.endswith("…")
    assert parse_next_step({"title": "Fix it", "prompt": "  "}) is None
    assert parse_next_step({"prompt": "Fix it"}) is None


def test_tool_tells_the_model_to_stop_and_never_needs_approval_or_trust():
    ok = execute_tool("suggest_next_step", {"title": "Add tests", "prompt": "Add tests for parse()"})
    assert "button" in ok and "Do not mention it" in ok, "the agent must not narrate the card"
    assert execute_tool("suggest_next_step", {"title": "", "prompt": "x"}).startswith("Error:")
    assert "suggest_next_step" in READ_ONLY_TOOLS
    assert requires_workspace_trust("suggest_next_step") is False


def test_only_interactive_chats_get_the_tool(tmp_path):
    session = Session(name="t", project_path=str(tmp_path))
    assert "suggest_next_step" not in _tool_names(Agent(session)), "cron and one-shot CLI runs have nobody to click"
    assert "suggest_next_step" in _tool_names(Agent(session, next_step_suggestions=True))
    assert "suggest_next_step" in _tool_names(Agent(session, profile="reviewer", next_step_suggestions=True))
    assert "suggest_next_step" not in _tool_names(Agent(session, profile="benchmark", next_step_suggestions=True))


def _suggesting_stream():
    calls = 0

    async def stream(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield ToolCallStart(tool_name="suggest_next_step", tool_id="call_next")
            yield ToolCallDelta(tool_id="call_next", args_json_chunk='{"title": "Fix the null check", "prompt": "Fix the null check in parser.py", "new_session": false}')
            yield ToolCallEnd(tool_id="call_next")
            yield Done()
        else:
            yield TextDelta(text="Found the bug in parser.py.")
            yield Done()

    return stream


@pytest.mark.asyncio
async def test_turn_reports_the_suggestion(tmp_path, monkeypatch):
    monkeypatch.setattr("andromity.core.agent.stream_completion", _suggesting_stream())
    agent = Agent(Session(name="t", project_path=str(tmp_path)), auto_approve=True, next_step_suggestions=True)
    events = [e async for e in agent.run("Why does parse() crash?")]
    suggested = [e for e in events if isinstance(e, NextStepSuggested)]
    assert suggested == [_step(title="Fix the null check", prompt="Fix the null check in parser.py", new_session=False)]


@pytest.mark.asyncio
async def test_turn_never_shows_a_suggestion_when_they_are_off(tmp_path, monkeypatch):
    monkeypatch.setattr("andromity.core.agent.stream_completion", _suggesting_stream())
    agent = Agent(Session(name="t", project_path=str(tmp_path)), auto_approve=True)
    events = [e async for e in agent.run("Why does parse() crash?")]
    assert not [e for e in events if isinstance(e, NextStepSuggested)]


def test_suggestion_reaches_clients():
    notes = []
    handler = JsonRpcHandler(send_notification=notes.append)
    handler._forward_agent_event("s1", None, None, _step(title="Add tests", prompt="Add tests for parse()", new_session=True))
    params = next(n.params for n in notes if n.method == "agent/nextStepSuggested")
    assert params["question"] == "" and params["options"] == [{"title": "Add tests", "prompt": "Add tests for parse()", "new_session": True}]
    assert (params["title"], params["prompt"], params["new_session"]) == ("Add tests", "Add tests for parse()", True), "first option, for earlier clients"


@pytest.mark.asyncio
@pytest.mark.parametrize("configured, expected", [(None, True), (False, False)])
async def test_chat_turns_follow_the_setting(tmp_path, monkeypatch, configured, expected):
    from andromity.config import config
    real_get = config.get
    monkeypatch.setattr(config, "get", lambda section, key, default=None, fallback=None: (
        default if (section, key) == ("default", "next_step_suggestions") and configured is None
        else configured if (section, key) == ("default", "next_step_suggestions")
        else real_get(section, key, default, fallback)
    ))
    seen = {}

    class CapturingAgent:
        def __init__(self, **kwargs):
            seen.update(kwargs)
            raise RuntimeError("stop after construction")

    monkeypatch.setattr(rpc_module, "Agent", CapturingAgent)
    handler = JsonRpcHandler()
    session = Session(name="t", project_path=str(tmp_path))
    session.storage_dir = tmp_path
    session.file_path = tmp_path / f"{session.id}.json"
    session.save()
    handler._active_sessions[session.id] = session
    with pytest.raises(RuntimeError, match="stop after construction"):
        await handler.rpc_agent_prompt({"session_id": session.id, "prompt": "hi", "project_path": str(tmp_path)})
    assert seen["next_step_suggestions"] is expected


@pytest.fixture
def tui_app(tmp_path, monkeypatch):
    from andromity.config import config
    from andromity.tui.app import AndromityApp

    cfg_dir = tmp_path / "cfg"
    cfg_dir.mkdir()
    monkeypatch.setattr(config, "config_dir", cfg_dir)
    monkeypatch.setattr(config, "config_path", cfg_dir / "config.toml")
    config._config_cache = {}
    config._load()
    monkeypatch.chdir(tmp_path)
    return AndromityApp()


async def _settle(pilot, n=5):
    for _ in range(n):
        await pilot.pause()


@pytest.mark.asyncio
async def test_tui_offers_the_tool_and_shows_a_card_with_tab_to_fill(tui_app):
    from textual.widgets import TextArea
    from andromity.tui.panels.chat import NextStepCard

    app = tui_app
    async with app.run_test(size=(120, 30)) as pilot:
        await _settle(pilot)
        assert "suggest_next_step" in _tool_names(app.agent)
        app._show_next_step(_step(title="Fix the null check", prompt="Fix the null check in parser.py", new_session=True))
        await _settle(pilot)
        field = app.query_one("#input-field", TextArea)
        assert field.placeholder == "Fix the null check  ·  Tab to use"
        card = app.query_one(NextStepCard)
        assert {b.id for b in card.query("Button")} == {"next-step-run", "next-step-new-session", "next-step-dismiss"}

        field.focus()
        await pilot.press("tab")
        await _settle(pilot)
        assert field.text == "Fix the null check in parser.py", "Tab fills the input"
        assert not app.query(NextStepCard)
        assert app._next_step is None
        assert field.has_focus, "Tab stays in the input instead of moving focus"


@pytest.mark.asyncio
async def test_tui_esc_dismisses_and_do_it_sends_without_clearing_a_draft(tui_app, monkeypatch):
    from textual.widgets import TextArea
    from andromity.tui.panels.chat import NextStepCard

    app = tui_app
    async with app.run_test(size=(120, 30)) as pilot:
        await _settle(pilot)
        field = app.query_one("#input-field", TextArea)
        app._show_next_step(_step(title="Add tests", prompt="Add tests for parse()"))
        await _settle(pilot)
        field.focus()
        await pilot.press("escape")
        await _settle(pilot)
        assert app._next_step is None and not app.query(NextStepCard)
        assert field.placeholder != "Add tests  ·  Tab to use"

        sent = []
        monkeypatch.setattr(app, "_submit_prompt", lambda prompt, images=None, steer=False: sent.append(prompt) or True)
        app._show_next_step(_step(title="Add tests", prompt="Add tests for parse()"))
        await _settle(pilot)
        field.text = "my draft"
        await pilot.click("#next-step-run")
        await _settle(pilot)
        assert sent == ["Add tests for parse()"]
        assert field.text == "my draft"


@pytest.mark.asyncio
async def test_tui_hides_the_tool_call_and_shows_the_card_after_the_turn(tui_app, monkeypatch):
    from andromity.config import config
    from andromity.tui.panels.chat import NextStepCard, ToolIndicator

    monkeypatch.setattr(config, "is_trusted", lambda path: True)
    monkeypatch.setattr("andromity.core.agent.stream_completion", _suggesting_stream())
    monkeypatch.setattr(config, "get", (lambda real: lambda section, key, default=None, fallback=None: (
        "test-model" if (section, key) == ("default", "model") else real(section, key, default, fallback)
    ))(config.get))
    app = tui_app
    async with app.run_test(size=(120, 30)) as pilot:
        await _settle(pilot)
        app.agent.auto_approve = True
        await app._stream_agent("Why does parse() crash?")
        await _settle(pilot)
        assert not [i for i in app.query(ToolIndicator) if i.tool_name == "suggest_next_step"]
        assert app.query_one(NextStepCard)
        assert app._next_step.prompt == "Fix the null check in parser.py"


def test_a_choice_carries_a_question_and_up_to_three_options():
    step = parse_next_step({"question": "Which fix first?", "options": [
        {"title": "Fix parser", "prompt": "Fix the parser null check"},
        {"title": "Fix tests", "prompt": "Fix the flaky test", "new_session": True},
        {"title": "", "prompt": "dropped: no title"},
        {"title": "Both", "prompt": "Fix both"},
        {"title": "Fourth", "prompt": "too many"},
    ]})
    assert step["question"] == "Which fix first?"
    assert [o["title"] for o in step["options"]] == ["Fix parser", "Fix tests", "Both"]
    assert step["options"][1]["new_session"] is True
    assert parse_next_step({"question": "Only one?", "options": [{"title": "A", "prompt": "a"}]})["question"] == "", "a lone option needs no question"
    assert "3 buttons" in execute_tool("suggest_next_step", {"question": "Which?", "options": step["options"]})
    assert execute_tool("suggest_next_step", {"options": [{"title": "", "prompt": ""}]}).startswith("Error:")


@pytest.mark.asyncio
async def test_tui_shows_choices_and_runs_the_one_picked(tui_app, monkeypatch):
    from andromity.tui.panels.chat import NextStepCard

    app = tui_app
    async with app.run_test(size=(120, 30)) as pilot:
        await _settle(pilot)
        sent = []
        monkeypatch.setattr(app, "_submit_prompt", lambda prompt, images=None, steer=False: sent.append(prompt) or True)
        app._show_next_step(NextStepSuggested(question="Which fix first?", options=[
            {"title": "Fix parser", "prompt": "Fix the parser", "new_session": False},
            {"title": "Fix tests", "prompt": "Fix the tests", "new_session": False},
        ]))
        await _settle(pilot)
        card = app.query_one(NextStepCard)
        assert [b.id for b in card.query("Button")] == ["next-step-opt-0", "next-step-opt-1", "next-step-dismiss"]
        await pilot.click("#next-step-opt-1")
        await _settle(pilot)
        assert sent == ["Fix the tests"]
