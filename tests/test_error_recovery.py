"""Tests for error recovery: classification, friendly error card generation,
vision guarding for text-only models, and transient 5xx auto-retry."""
import asyncio
from unittest.mock import patch, AsyncMock
import pytest

from andromity.core.provider import (
    classify_and_format_error,
    extract_clean_error_message,
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


def test_terminal_formatting_has_zero_html():
    """Verify that terminal output for TUI/CLI contains zero raw HTML/SVG/button tags."""
    fake_err = Exception("daily_limit_reached - free trial requests exceeded")
    term_text = classify_and_format_error(fake_err, provider="andromity", output_format="terminal")

    # Must NOT have any HTML tags
    assert "<div" not in term_text
    assert "<svg" not in term_text
    assert "<button" not in term_text
    assert "</" not in term_text

    # Must contain clean markdown with title, badge, reset timer, and TUI actions
    assert "[QUOTA LIMIT]" in term_text
    assert "Daily Limit Reached" in term_text
    assert "⏱ **Quota resets in" in term_text
    assert "Actions:" in term_text
    assert "BYOK" in term_text


def test_quota_exceeded_omits_raw_litellm_error():
    """Verify that raw internal litellm/OpenAIException details are NOT leaked to the user on quota limits."""
    fake_err = Exception("litellm.RateLimitError: RateLimitError: OpenAIException - daily_limit_reached")
    html_out = classify_and_format_error(fake_err, provider="andromity", output_format="html")

    assert "Daily Limit Reached" in html_out
    assert "Quota resets in" in html_out
    assert "<details" not in html_out
    assert "litellm.RateLimitError" not in html_out


@pytest.mark.asyncio
async def test_missing_credentials_fails_fast_without_retries(monkeypatch):
    """Verify that missing credentials (even wrapped in InternalServerError) fails immediately with auth_error card."""
    call_count = 0

    async def missing_cred_acompletion(**kwargs):
        nonlocal call_count
        call_count += 1
        raise Exception("InternalServerError: OpenAIException - Missing credentials. Please pass an `api_key` or set OPENAI_API_KEY")

    import litellm
    monkeypatch.setattr(litellm, "acompletion", missing_cred_acompletion)

    events = []
    async for ev in stream_completion([{"role": "user", "content": "hi"}], provider_name="openai", model="o4-mini"):
        events.append(ev)

    assert call_count == 1, "Missing credentials must not trigger retries"
    texts = "".join(getattr(e, "text", "") for e in events if isinstance(e, TextDelta))
    assert 'data-error-type="auth_error"' in texts
    assert 'data-action="open-settings"' in texts
    assert any(isinstance(e, Done) for e in events)


@pytest.mark.asyncio
async def test_daily_quota_fails_fast_without_retries(monkeypatch):
    """Verify that daily quota limit fails immediately on attempt 1 without backoff delays."""
    call_count = 0

    async def quota_acompletion(**kwargs):
        nonlocal call_count
        call_count += 1
        raise Exception("daily_limit_reached - free trial requests exceeded")

    import litellm
    monkeypatch.setattr(litellm, "acompletion", quota_acompletion)

    events = []
    async for ev in stream_completion([{"role": "user", "content": "hi"}], provider_name="andromity", model="o4-mini"):
        events.append(ev)

    assert call_count == 1, "Daily quota must fail fast on attempt 1"
    texts = "".join(getattr(e, "text", "") for e in events if isinstance(e, TextDelta))
    assert 'data-error-type="quota_exceeded"' in texts
    assert 'data-action="open-account-login"' in texts or 'data-action="open-settings"' in texts
    assert any(isinstance(e, Done) for e in events)


def test_extract_clean_error_message():
    """Verify that LiteLLM boilerplate, nested JSON payloads, and user IDs are cleanly stripped."""
    # 1. OpenRouter 404 with JSON and user_id (exact screenshot error)
    err1 = (
        'litellm.NotFoundError: NotFoundError: OpenrouterException - '
        '{"error":{"message":"No endpoints found for anthropic/claude-3.7-sonnet.","code":404},"user_id":"user_3EiZCW01tlR9E6IjromZ0smUe31"}'
    )
    clean1 = extract_clean_error_message(err1)
    assert clean1 == "No endpoints found for anthropic/claude-3.7-sonnet."
    assert "user_3EiZCW" not in clean1
    assert "OpenrouterException" not in clean1

    # 2. OpenAI Authentication error with JSON
    err2 = (
        'litellm.AuthenticationError: AuthenticationError: OpenAIException - '
        '{"error":{"message":"Incorrect API key provided: None. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}'
    )
    clean2 = extract_clean_error_message(err2)
    assert clean2 == "Incorrect API key provided: None. You can find your API key at https://platform.openai.com/account/api-keys."

    # 3. Plain exception prefix without JSON
    err3 = "litellm.InternalServerError: InternalServerError: OpenAIException - Missing credentials. Please pass an api_key."
    clean3 = extract_clean_error_message(err3)
    assert clean3 == "Missing credentials. Please pass an api_key."


def test_classify_not_found_error():
    """Verify that 404 / NotFoundError provides Model Not Available with Switch Model button."""
    fake_err = Exception(
        'litellm.NotFoundError: NotFoundError: OpenrouterException - '
        '{"error":{"message":"No endpoints found for anthropic/claude-3.7-sonnet.","code":404},"user_id":"user_3EiZCW01tlR9E6IjromZ0smUe31"}'
    )
    html_out = classify_and_format_error(fake_err, provider="openrouter", model="anthropic/claude-3.7-sonnet")
    assert 'data-error-type="model_not_found"' in html_out
    assert "Model Not Available" in html_out
    assert "No endpoints found for anthropic/claude-3.7-sonnet." in html_out
    assert 'data-action="switch-model-flyout"' in html_out
    # Visible card body must not leak user_id
    body_part = html_out.split('<details')[0]
    assert "user_3EiZCW" not in body_part


def test_html_404_is_an_endpoint_error_in_both_interfaces():
    from andromity.core.provider import classify_error_info, format_error_html, format_error_terminal

    error = Exception("NotFoundError: <!DOCTYPE html><html><head>private-page-marker</head><body>404 image quota 500</body></html>")
    info = classify_error_info(error, provider="custom", model="custom-model", has_images=True)
    assert info["type"] == "endpoint_not_found"
    for rendered in (format_error_html(info), format_error_terminal(info)):
        assert "API Endpoint Not Found" in rendered
        assert "/chat/completions" in rendered
        assert "private-page-marker" not in rendered
    assert 'data-action="open-settings"' in format_error_html(info)


@pytest.mark.parametrize("status,expected", [(401, "auth_error"), (403, "auth_error"), (429, "rate_limit"), (503, "provider_unavailable")])
def test_provider_status_code_does_not_require_error_message_keywords(status, expected):
    from andromity.core.provider import classify_error_info

    error = Exception("Request rejected")
    error.status_code = status
    assert classify_error_info(error)["type"] == expected


def test_authed_quota_omits_account_button(monkeypatch):
    """When the user is authenticated, quota limit card must NOT show Account or Sign In button."""
    from andromity.config import config
    monkeypatch.setattr(config, "get_api_key", lambda p: "fake-key" if p == "andromity" else None)

    fake_err = Exception("daily_limit_reached - gateway limit exceeded")
    html_out = classify_and_format_error(fake_err, provider="andromity", model="auto")

    assert "Daily Limit Reached" in html_out
    assert 'data-action="open-settings"' in html_out
    assert 'data-action="switch-model-flyout"' in html_out
    # Must NOT have Account button or Sign In button when already authed
    assert 'data-action="open-account-login"' not in html_out
    assert ">Account<" not in html_out
    assert ">Sign In<" not in html_out



