"""Tests for error recovery: classification, friendly error card generation,
vision guarding for text-only models, and transient 5xx auto-retry."""
import asyncio
from unittest.mock import patch, AsyncMock
import pytest

from andromity.core.provider import (
    classify_and_format_error,
    stream_completion,
    _format_error_text,
)
from andromity.core.agent import Agent
from andromity.core.events import TextDelta, Done
from andromity.core.session import Session


@pytest.fixture
def session(tmp_path):
    return Session(name="test-error-recovery", project_path=str(tmp_path))


def test_classify_midstream_service_unavailable():
    """Matches the exact user screenshot: OpenRouter/Nvidia 503 MidStreamFallbackError."""
    fake_err = Exception(
        "litellm.MidStreamFallbackError: litellm.ServiceUnavailableError: ServiceUnavailableError: "
        "OpenrouterException - Message: Upstream error from Nvidia: Service Unavailable (503)"
    )
    html = classify_and_format_error(fake_err, provider="openrouter", model="deepseek/deepseek-r1")
    assert 'data-error-type="provider_unavailable"' in html
    assert "Upstream Service Interruption" in html
    assert 'data-action="retry-turn"' in html
    assert "Technical Details" in html
    assert "Service Unavailable (503)" in html


def test_classify_vision_unsupported():
    fake_err = Exception("BadRequestError: 400 Image input is not supported by model 'deepseek-r1'")
    html = classify_and_format_error(fake_err, provider="openrouter", model="deepseek-r1", has_images=True)
    assert 'data-error-type="vision_unsupported"' in html
    assert "Model Does Not Support Images" in html
    assert 'data-action="retry-without-image"' in html
    assert 'data-action="switch-model-flyout"' in html


def test_classify_rate_limit_with_seconds():
    fake_err = Exception("RateLimitError: 429 Too Many Requests. Please retry in 4.5s")
    html = classify_and_format_error(fake_err, provider="anthropic", model="claude-sonnet-4-6")
    assert 'data-error-type="rate_limit"' in html
    assert "Rate Limit / Quota Reached" in html
    assert "wait ~4s" in html
    assert 'data-action="retry-turn"' in html


def test_classify_context_length_exceeded():
    fake_err = Exception("InvalidRequestError: maximum context length exceeded (132000 tokens > 128000)")
    html = classify_and_format_error(fake_err, provider="openai", model="gpt-4o")
    assert 'data-error-type="context_exceeded"' in html
    assert "Context Window Limit Reached" in html
    assert 'data-action="trigger-compact"' in html
    assert 'data-action="new-session"' in html


def test_classify_auth_error():
    fake_err = Exception("AuthenticationError: 401 Unauthorized - invalid api key provided")
    html = classify_and_format_error(fake_err, provider="anthropic", model="claude-sonnet-4-6")
    assert 'data-error-type="auth_error"' in html
    assert "Authentication Error" in html
    assert 'data-action="open-settings"' in html


def test_classify_ollama_offline():
    fake_err = Exception("ConnectionRefusedError: [Errno 111] Failed to connect to 127.0.0.1:11434")
    html = classify_and_format_error(fake_err, provider="ollama", model="llama3.1")
    assert 'data-error-type="ollama_offline"' in html
    assert "Local Ollama Not Running" in html
    assert 'data-action="retry-turn"' in html


def test_format_error_text_compatibility():
    fake_err = Exception("503 Service Unavailable")
    res = _format_error_text(fake_err)
    assert 'andromity-error-card' in res
    assert 'data-action="retry-turn"' in res


def test_model_supports_vision_classification(session):
    agent = Agent(session, profile="builder", auto_approve=True, dry_run=True)

    # Known vision models
    for m in ["gpt-4o", "claude-sonnet-4-6", "gemini-2.5-flash", "llava", "gemma3", "llama-3.2-11b-vision", "qwen2-vl-7b"]:
        agent.model = m
        agent.provider = "openrouter"
        assert agent._model_supports_vision() is True, f"{m} should support vision"

    # Known text-only models
    for m in ["deepseek-r1", "deepseek-v3", "deepseek-chat", "llama-3.1-70b-instruct", "llama3.1", "qwen2.5-coder", "mistral-large"]:
        agent.model = m
        agent.provider = "openrouter"
        assert agent._model_supports_vision() is False, f"{m} should be recognized as text-only"


@pytest.mark.asyncio
async def test_transient_503_auto_retries_and_succeeds(monkeypatch):
    """Verify that transient 503 service unavailable retries automatically and recovers."""
    call_count = 0

    async def flaky_acompletion(**kwargs):
        nonlocal call_count
        call_count += 1
        if call_count < 2:
            raise Exception("503 Service Unavailable - Upstream provider error")

        async def _stream():
            chunk = type("Chunk", (), {})()
            chunk.choices = [type("Choice", (), {"delta": type("Delta", (), {"content": "Success after retry", "tool_calls": None})(), "finish_reason": "stop"})()]
            yield chunk
        return _stream()

    import litellm
    monkeypatch.setattr(litellm, "acompletion", flaky_acompletion)

    events = []
    async for ev in stream_completion([{"role": "user", "content": "hi"}], provider_name="openrouter", model="deepseek/deepseek-r1"):
        events.append(ev)

    assert call_count == 2, "acompletion should have retried after initial 503"
    texts = "".join(getattr(e, "text", "") for e in events if isinstance(e, TextDelta))
    assert "Success after retry" in texts
    assert any(isinstance(e, Done) for e in events)


@pytest.mark.asyncio
async def test_exhausted_retries_emits_friendly_error_card(monkeypatch):
    """When retries are exhausted, stream_completion must emit a friendly error card with retry button."""
    async def always_fails(**kwargs):
        raise Exception("503 Service Unavailable - Upstream provider overloaded")

    import litellm
    monkeypatch.setattr(litellm, "acompletion", always_fails)

    events = []
    async for ev in stream_completion([{"role": "user", "content": "hi"}], provider_name="nvidia", model="deepseek-ai/deepseek-r1"):
        events.append(ev)

    texts = "".join(getattr(e, "text", "") for e in events if isinstance(e, TextDelta))
    assert "andromity-error-card" in texts
    assert 'data-error-type="provider_unavailable"' in texts
    assert 'data-action="retry-turn"' in texts
    assert any(isinstance(e, Done) for e in events)
