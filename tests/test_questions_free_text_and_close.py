"""Clarifying questions: answer in your own words, or close them without answering."""
import asyncio

import pytest
from textual.app import App
from textual.widgets import Input

from andromity.server.rpc_handler import JsonRpcHandler
from andromity.tui.overlays.questions import QUESTIONS_DISMISSED, QuestionPanel, format_question_answers


def test_closing_is_not_the_same_as_answering_nothing():
    assert format_question_answers([{"question": "Which db?"}], None) == QUESTIONS_DISMISSED
    assert "Do not assume an answer" in QUESTIONS_DISMISSED
    assert format_question_answers([{"question": "Which db?"}], {}).startswith("The user did not answer")


@pytest.mark.asyncio
async def test_server_passes_a_close_to_the_agent():
    handler = JsonRpcHandler()
    fut = asyncio.get_running_loop().create_future()
    handler._pending_questions["q1"] = ("s1", fut)
    res = await handler.rpc_agent_answer_question({"session_id": "s1", "question_id": "q1", "answers": "", "dismissed": True})
    assert res["success"] is True
    assert fut.result() == QUESTIONS_DISMISSED


class _PanelApp(App):
    def compose(self):
        yield QuestionPanel(id="question-panel")


QUESTIONS = [
    {"question": "Which database?", "type": "single", "options": ["Postgres", "MySQL"]},
    {"question": "Which targets?", "type": "multi", "options": ["web", "cli"]},
    {"question": "Anything else?", "type": "text"},
]


async def _ask(pilot, app, questions):
    got = {}
    panel = app.query_one(QuestionPanel)
    await panel.ask(questions, lambda answers: got.setdefault("answers", answers))
    for _ in range(3):
        await pilot.pause()
    return panel, got


@pytest.mark.asyncio
async def test_tui_typed_text_replaces_a_single_choice_and_joins_a_multiple_choice():
    app = _PanelApp()
    async with app.run_test(size=(100, 40)) as pilot:
        panel, got = await _ask(pilot, app, QUESTIONS)
        assert app.query_one("#qp-q-0-other", Input).placeholder == "Something else…"
        assert app.query_one("#qp-q-1-other", Input)
        assert not app.query("#qp-q-2-other"), "a free-text question needs no extra line"
        app.query_one("#qp-q-0-other", Input).value = "SQLite for tests"
        app.query_one("#qp-q-1-other", Input).value = "desktop"
        panel.action_submit()
        assert got["answers"][0] == "SQLite for tests"
        assert got["answers"][1] == ["desktop"]
        text = format_question_answers(QUESTIONS, got["answers"])
        assert "1. Which database?: SQLite for tests" in text and "2. Which targets?: desktop" in text


@pytest.mark.asyncio
async def test_tui_esc_closes_without_answering():
    app = _PanelApp()
    async with app.run_test(size=(100, 40)) as pilot:
        panel, got = await _ask(pilot, app, QUESTIONS[:1])
        await pilot.press("escape")
        await pilot.pause()
        assert got["answers"] is None
        assert format_question_answers(QUESTIONS[:1], got["answers"]) == QUESTIONS_DISMISSED
