"""Tests for ask_questions tool normalization, UI formatting, and agent loop handling."""
import json
import pytest
from unittest.mock import AsyncMock, patch

from andromity.tui.overlays.questions import (
    extract_options_from_text,
    normalize_questions,
    format_question_answers,
)
from andromity.core.agent import Agent
from andromity.core.session import Session
from andromity.core.events import ToolCallStart, ToolCallDelta, ToolCallEnd, Done, TextDelta


def test_extract_options_inline_parens():
    text = "Q1: What is the capital of India? (A) Mumbai (B) New Delhi (C) Kolkata (D) Chennai"
    prompt, opts = extract_options_from_text(text)
    assert prompt == "Q1: What is the capital of India?"
    assert opts == ["(A) Mumbai", "(B) New Delhi", "(C) Kolkata", "(D) Chennai"]


def test_extract_options_inline_brackets():
    text = "Which platform? [1] Web [2] Mobile [3] Desktop"
    prompt, opts = extract_options_from_text(text)
    assert prompt == "Which platform?"
    assert opts == ["(1) Web", "(2) Mobile", "(3) Desktop"]


def test_extract_options_multiline():
    text = "Select your frontend framework:\nA) React\nB) Vue\nC) Svelte"
    prompt, opts = extract_options_from_text(text)
    assert prompt == "Select your frontend framework"
    assert opts == ["(A) React", "(B) Vue", "(C) Svelte"]


def test_extract_options_no_options():
    text = "What is your project name?"
    prompt, opts = extract_options_from_text(text)
    assert prompt == "What is your project name?"
    assert opts == []


def test_normalize_questions_string_list_with_options():
    raw = [
        "Q1: What is the capital of India? (A) Mumbai (B) New Delhi (C) Kolkata (D) Chennai",
        "Q2: Which river is considered the holiest river in India? (A) Godavari (B) Yamuna (C) Ganges (D) Brahmaputra",
    ]
    norm = normalize_questions(raw)
    assert len(norm) == 2
    assert norm[0]["type"] == "single"
    assert len(norm[0]["options"]) == 4
    assert norm[0]["options"][1] == "(B) New Delhi"
    assert norm[1]["type"] == "single"
    assert len(norm[1]["options"]) == 4


def test_normalize_questions_string_list_plain_text():
    raw = ["What is your name?", "What is your team size?"]
    norm = normalize_questions(raw)
    assert len(norm) == 2
    assert norm[0]["type"] == "text"
    assert norm[0]["question"] == "What is your name?"
    assert norm[0]["options"] == []
    assert norm[1]["type"] == "text"


def test_normalize_questions_single_string():
    raw = "What database should we use?"
    norm = normalize_questions(raw)
    assert len(norm) == 1
    assert norm[0]["question"] == "What database should we use?"
    assert norm[0]["type"] == "text"


def test_normalize_questions_dict_with_questions_key():
    raw = {
        "questions": [
            {"question": "Select auth method", "options": ["JWT", "OAuth", "Session"]},
            {"question": "Enable billing?", "type": "single", "options": ["Yes", "No"]},
        ]
    }
    norm = normalize_questions(raw)
    assert len(norm) == 2
    assert norm[0]["question"] == "Select auth method"
    assert norm[0]["type"] == "single"
    assert norm[0]["options"] == ["JWT", "OAuth", "Session"]


def test_normalize_questions_is_multi_select():
    raw = [
        {
            "question": "Which features do you want?",
            "is_multi_select": True,
            "options": ["Auth", "Payments", "Analytics"],
        }
    ]
    norm = normalize_questions(raw)
    assert len(norm) == 1
    assert norm[0]["type"] == "multi"
    assert norm[0]["options"] == ["Auth", "Payments", "Analytics"]


def test_normalize_questions_string_options():
    raw = [
        {
            "question": "Choose a color",
            "options": "Red, Green, Blue",
        }
    ]
    norm = normalize_questions(raw)
    assert len(norm) == 1
    assert norm[0]["options"] == ["Red", "Green", "Blue"]
    assert norm[0]["type"] == "single"


def test_normalize_questions_dict_options():
    raw = [
        {
            "question": "Choose a DB",
            "options": [{"label": "PostgreSQL", "value": "pg"}, {"label": "SQLite"}],
        }
    ]
    norm = normalize_questions(raw)
    assert len(norm) == 1
    assert norm[0]["options"] == ["PostgreSQL", "SQLite"]


def test_normalize_questions_json_string():
    raw = json.dumps([{"question": "Are you ready?", "options": ["Yes", "No"]}])
    norm = normalize_questions(raw)
    assert len(norm) == 1
    assert norm[0]["question"] == "Are you ready?"
    assert norm[0]["options"] == ["Yes", "No"]


def test_format_question_answers():
    questions = [
        {"question": "What is the capital of India?", "options": ["(A) Mumbai", "(B) New Delhi"]},
        {"question": "Select features", "options": ["Auth", "Payments"]},
    ]
    answers = {"0": "(B) New Delhi", 1: ["Auth", "Payments"]}
    res = format_question_answers(questions, answers)
    assert "User answers:" in res
    assert "1. What is the capital of India?: (B) New Delhi" in res
    assert "2. Select features: Auth, Payments" in res


def test_format_question_answers_empty_or_none():
    questions = [{"question": "Q1"}]
    res = format_question_answers(questions, None)
    assert res == "The user did not answer the questions. Proceed with reasonable assumptions."
    res2 = format_question_answers(questions, {})
    assert res2 == "The user did not answer the questions. Proceed with reasonable assumptions."


def test_format_question_answers_with_raw_strings():
    questions = ["What is your name?"]
    answers = {"0": "Alice"}
    res = format_question_answers(questions, answers)
    assert "1. What is your name?: Alice" in res


@pytest.mark.asyncio
async def test_agent_ask_questions_interactive(tmp_path):
    session = Session(name="test", project_path=str(tmp_path))
    user_callback_called = False

    async def mock_on_questions(questions):
        nonlocal user_callback_called
        user_callback_called = True
        assert len(questions) == 2
        return format_question_answers(questions, {"0": "New Delhi", "1": "Ganges"})

    agent = Agent(
        session,
        profile="builder",
        auto_approve=True,
        on_questions=mock_on_questions,
    )

    call_count = 0

    async def mock_stream(messages, tools=None, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolCallStart(tool_name="ask_questions", tool_id="tc_ask_1")
            yield ToolCallDelta(
                tool_id="tc_ask_1",
                args_json_chunk=json.dumps({
                    "questions": [
                        "Q1: What is the capital of India? (A) Mumbai (B) New Delhi",
                        "Q2: Which river is holiest? (A) Yamuna (B) Ganges",
                    ]
                }),
            )
            yield ToolCallEnd(tool_id="tc_ask_1")
            yield Done()
        else:
            yield TextDelta(text="Got your quiz answers!")
            yield Done(usage={"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25})

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        events = []
        async for event in agent.run("start quiz"):
            events.append(event)

    assert user_callback_called is True
    tool_msgs = [m for m in session.messages if m["role"] == "tool"]
    assert len(tool_msgs) == 1
    assert "User answers:" in tool_msgs[0]["content"]
    assert "New Delhi" in tool_msgs[0]["content"]


@pytest.mark.asyncio
async def test_agent_ask_question_singular_tool_name(tmp_path):
    session = Session(name="test", project_path=str(tmp_path))
    user_callback_called = False

    async def mock_on_questions(questions):
        nonlocal user_callback_called
        user_callback_called = True
        return format_question_answers(questions, {"0": "SQLite"})

    agent = Agent(
        session,
        profile="builder",
        auto_approve=True,
        on_questions=mock_on_questions,
    )

    call_count = 0

    async def mock_stream(messages, tools=None, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolCallStart(tool_name="ask_question", tool_id="tc_ask_singular")
            yield ToolCallDelta(
                tool_id="tc_ask_singular",
                args_json_chunk=json.dumps({
                    "question": "Which DB?",
                    "options": ["Postgres", "SQLite"],
                }),
            )
            yield ToolCallEnd(tool_id="tc_ask_singular")
            yield Done()
        else:
            yield TextDelta(text="Using SQLite!")
            yield Done()

    with patch("andromity.core.agent.stream_completion", side_effect=mock_stream):
        events = []
        async for event in agent.run("setup db"):
            events.append(event)

    assert user_callback_called is True
    tool_msgs = [m for m in session.messages if m["role"] == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0]["name"] == "ask_question"
    assert "SQLite" in tool_msgs[0]["content"]
