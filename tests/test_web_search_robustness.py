"""Offline regression tests for web search retries, fallbacks, result cleanup and error messages."""
import io
import json
import threading
import time
import urllib.error
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest

from andromity.core import web
from andromity.core.web import _normalize_results, fetch_url, web_search


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    monkeypatch.delenv("ANDROMITY_AIRGAP", raising=False)
    monkeypatch.setattr(web, "BACKOFF_BASE_S", 0.0)
    web._SEARCH_CACHE._cache.clear()
    web._URL_CACHE._cache.clear()
    yield
    web._SEARCH_CACHE._cache.clear()
    web._URL_CACHE._cache.clear()


def _hit(n: int, host: str = "example.com") -> Dict[str, str]:
    return {"title": f"Result {n}", "href": f"https://{host}/page{n}", "body": f"Snippet text for result number {n}."}


class _FakeDDGS:
    """Replays a scripted outcome per call and records the arguments of every call."""

    script: List[Any] = []
    calls: List[Dict[str, Any]] = []
    lock = threading.Lock()

    def __init__(self, timeout: int = 5, **kwargs: Any):
        self.timeout = timeout

    def text(self, query: str, **kwargs: Any) -> List[Dict[str, str]]:
        with _FakeDDGS.lock:
            index = len(_FakeDDGS.calls)
            _FakeDDGS.calls.append({"query": query, "timeout": self.timeout, **kwargs})
        outcome = _FakeDDGS.script[min(index, len(_FakeDDGS.script) - 1)]
        if callable(outcome):
            outcome = outcome()
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


@pytest.fixture
def fake_ddgs(monkeypatch):
    _FakeDDGS.script = []
    _FakeDDGS.calls = []
    monkeypatch.setattr(web, "DDGS", _FakeDDGS)
    return _FakeDDGS


def _no_fallbacks(monkeypatch):
    def _fail(*args, **kwargs):
        raise AssertionError("fallback should not run")

    monkeypatch.setattr(web, "_ddg_lite_search", _fail)
    monkeypatch.setattr(web, "_ddg_html_search", _fail)
    monkeypatch.setattr(web, "_stackexchange_search", _fail)


def test_first_ddgs_attempt_success_uses_library_defaults(fake_ddgs, monkeypatch):
    _no_fallbacks(monkeypatch)
    fake_ddgs.script = [[_hit(1), _hit(2)]]
    out = web_search("python asyncio")
    assert "**1. Result 1**" in out
    assert len(fake_ddgs.calls) == 1
    assert fake_ddgs.calls[0]["backend"] == "auto"
    assert fake_ddgs.calls[0]["region"] == "us-en"


def test_ddgs_retry_skips_encyclopedias_and_searches_worldwide(fake_ddgs, monkeypatch):
    _no_fallbacks(monkeypatch)
    from ddgs.exceptions import DDGSException

    fake_ddgs.script = [DDGSException("No results found."), [_hit(1)]]
    out = web_search("Pythonで辞書をソートする方法")
    assert "Result 1" in out
    retry = fake_ddgs.calls[1]
    assert retry["region"] == "wt-wt"
    backends = retry["backend"].split(",")
    assert "wikipedia" not in backends and "grokipedia" not in backends
    assert backends and backends != ["auto"]


def test_slow_first_attempt_is_hedged_by_parallel_retry(fake_ddgs, monkeypatch):
    _no_fallbacks(monkeypatch)
    monkeypatch.setattr(web, "DDGS_HEDGE_AFTER_S", 0.1)

    def _slow():
        time.sleep(1.5)
        return [_hit(9, "slow.example")]

    fake_ddgs.script = [_slow, [_hit(1, "fast.example")]]
    start = time.monotonic()
    out = web_search("hedged query")
    assert time.monotonic() - start < 1.2
    assert "fast.example" in out
    assert "slow.example" not in out


def test_ddgs_deadline_returns_timeout_message(fake_ddgs, monkeypatch):
    monkeypatch.setattr(web, "DDGS_BUDGET_S", 0.3)
    monkeypatch.setattr(web, "DDGS_HEDGE_AFTER_S", 0.1)
    monkeypatch.setattr(web, "_ddg_lite_search", lambda *a, **k: [])
    monkeypatch.setattr(web, "_ddg_html_search", lambda *a, **k: [])
    monkeypatch.setattr(web, "_stackexchange_search", lambda *a, **k: [])

    def _hang():
        time.sleep(2)
        return [_hit(1)]

    fake_ddgs.script = [_hang]
    start = time.monotonic()
    out = web_search("never answers")
    assert time.monotonic() - start < 1.5
    assert out.startswith("No results found for search query: 'never answers'")
    assert "did not respond in time" in out


def test_rate_limited_ddgs_falls_back_to_ddg_lite(fake_ddgs, monkeypatch):
    from ddgs.exceptions import RatelimitException

    fake_ddgs.script = [RatelimitException("202 Ratelimit")]
    lite = MagicMock(return_value=[{"title": "Lite hit", "url": "https://docs.example.org/a", "snippet": "From the lite endpoint."}])
    monkeypatch.setattr(web, "_ddg_lite_search", lite)
    out = web_search("fallback query")
    assert "Lite hit" in out
    assert lite.call_count == 1
    assert len(fake_ddgs.calls) == len(web._DDGS_ATTEMPTS)


def _fake_urlopen(routes: Dict[str, Any], seen: List[str]):
    def _open(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        seen.append(url)
        for prefix, outcome in routes.items():
            if url.startswith(prefix):
                if isinstance(outcome, BaseException):
                    raise outcome
                resp = MagicMock()
                resp.status = 200
                resp.read.return_value = outcome
                cm = MagicMock()
                cm.__enter__.return_value = resp
                cm.__exit__.return_value = False
                return cm
        raise AssertionError(f"unexpected request to {url}")

    return _open


def test_blocked_ddg_skips_html_endpoint_and_uses_stack_overflow(monkeypatch):
    monkeypatch.setattr(web, "DDGS", None)
    so_payload = json.dumps({
        "items": [{
            "title": "No &#39;Access-Control-Allow-Origin&#39; header",
            "link": "https://stackoverflow.com/questions/1/cors",
            "is_answered": True,
            "score": 42,
            "body": "<p>The server must send the <code>Access-Control-Allow-Origin</code> header.</p>",
        }],
        "quota_remaining": 250,
    }).encode()
    seen: List[str] = []
    routes = {
        "https://lite.duckduckgo.com": urllib.error.HTTPError("https://lite.duckduckgo.com/lite/", 403, "Forbidden", {}, io.BytesIO()),
        "https://api.stackexchange.com": so_payload,
    }
    with patch("urllib.request.urlopen", side_effect=_fake_urlopen(routes, seen)):
        out = web_search("No 'Access-Control-Allow-Origin' header is present")
    assert not any("html.duckduckgo.com" in u for u in seen)
    assert "came from Stack Overflow" in out or "come from Stack Overflow" in out
    assert "No 'Access-Control-Allow-Origin' header" in out
    assert "answered, score 42" in out


def test_ddg_lite_timeout_skips_html_endpoint(monkeypatch):
    monkeypatch.setattr(web, "DDGS", None)
    lite = MagicMock(side_effect=urllib.error.URLError(TimeoutError("timed out")))
    html_search = MagicMock(return_value=[{"title": "x", "url": "https://x.example/", "snippet": "y"}])
    monkeypatch.setattr(web, "_ddg_lite_search", lite)
    monkeypatch.setattr(web, "_ddg_html_search", html_search)
    monkeypatch.setattr(web, "_stackexchange_search", MagicMock(return_value=[]))
    out = web_search("hung duckduckgo")
    assert html_search.call_count == 0
    assert "did not respond in time" in out


def test_ddg_lite_challenge_page_is_reported_as_blocked(monkeypatch):
    seen: List[str] = []
    page = b"<html><body><form id='challenge-form'>Please verify you are human</form></body></html>"
    with patch("urllib.request.urlopen", side_effect=_fake_urlopen({"https://lite.duckduckgo.com": page}, seen)):
        with pytest.raises(web._SearchFailure) as exc_info:
            web._ddg_lite_search("anything", max_results=5)
    assert exc_info.value.kind == "blocked"


def test_all_providers_rate_limited_gives_actionable_message_without_internals(fake_ddgs, monkeypatch):
    from ddgs.exceptions import RatelimitException

    fake_ddgs.script = [RatelimitException("202 Ratelimit at https://internal/trace")]
    blocked = urllib.error.HTTPError("https://lite.duckduckgo.com/lite/", 403, "Forbidden", {}, io.BytesIO())
    monkeypatch.setattr(web, "_ddg_lite_search", MagicMock(side_effect=blocked))
    monkeypatch.setattr(web, "_stackexchange_search", MagicMock(return_value=[]))
    out = web_search("python release")
    assert out.startswith("No results found for search query: 'python release'")
    assert "rate-limiting or blocking" in out
    assert "fetch_url" in out
    assert "RatelimitException" not in out
    assert "Traceback" not in out
    assert "internal/trace" not in out


def test_offline_gives_network_message(fake_ddgs, monkeypatch):
    offline = urllib.error.URLError(OSError("getaddrinfo failed"))
    fake_ddgs.script = [ConnectionError("network unreachable")]
    monkeypatch.setattr(web, "_ddg_lite_search", MagicMock(side_effect=offline))
    monkeypatch.setattr(web, "_ddg_html_search", MagicMock(side_effect=offline))
    monkeypatch.setattr(web, "_stackexchange_search", MagicMock(side_effect=offline))
    out = web_search("anything")
    assert "No search provider could be reached" in out


def test_failures_are_not_cached(fake_ddgs, monkeypatch):
    from ddgs.exceptions import DDGSException

    monkeypatch.setattr(web, "_ddg_lite_search", MagicMock(return_value=[]))
    monkeypatch.setattr(web, "_ddg_html_search", MagicMock(return_value=[]))
    monkeypatch.setattr(web, "_stackexchange_search", MagicMock(return_value=[]))
    fake_ddgs.script = [DDGSException("No results found."), DDGSException("No results found."), [_hit(1)]]
    assert web_search("flaky").startswith("No results found")
    assert "Result 1" in web_search("flaky")


def test_domain_filter_enforced_and_multiple_domains_use_or(fake_ddgs, monkeypatch):
    _no_fallbacks(monkeypatch)
    fake_ddgs.script = [[
        _hit(1, "en.wikipedia.org"),
        _hit(2, "docs.python.org"),
        _hit(3, "peps.python.org"),
        _hit(4, "github.com"),
    ]]
    out = web_search("asyncio timeout", domains=["https://docs.python.org/3/", "github.com"])
    assert fake_ddgs.calls[0]["query"] == "asyncio timeout (site:docs.python.org OR site:github.com)"
    assert "docs.python.org/page2" in out
    assert "github.com/page4" in out
    assert "wikipedia" not in out
    assert "peps.python.org" not in out


def test_single_domain_keeps_plain_site_operator(fake_ddgs, monkeypatch):
    _no_fallbacks(monkeypatch)
    fake_ddgs.script = [[_hit(1, "docs.python.org")]]
    web_search("asyncio timeout", domains=["docs.python.org"])
    assert fake_ddgs.calls[0]["query"] == "asyncio timeout site:docs.python.org"


def test_normalize_results_unwraps_dedupes_and_drops_ads():
    raw = [
        {"title": "Ad", "url": "https://duckduckgo.com/y.js?ad_provider=x", "snippet": "Buy now"},
        {"title": "Docs &amp; guide", "url": "//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.org%2Fguide%2F&rut=1", "snippet": "  Guide\n text  "},
        {"title": "Docs duplicate", "url": "https://www.docs.example.org/guide", "snippet": "Same page"},
        {"title": "Relative", "url": "/local/path", "snippet": "Not a web URL"},
        {"title": "", "url": "https://other.example.org/", "snippet": "x" * 1000},
    ]
    results = _normalize_results(raw, [], 10)
    assert [r["url"] for r in results] == ["https://docs.example.org/guide/", "https://other.example.org/"]
    assert results[0]["title"] == "Docs & guide"
    assert results[0]["snippet"] == "Guide text"
    assert results[1]["title"] == "https://other.example.org/"
    assert len(results[1]["snippet"]) <= web.MAX_SNIPPET_CHARS + 4


@pytest.mark.parametrize("given,expected", [("3", 3), (-4, 1), (999, web.MAX_SEARCH_RESULTS), (None, 5), ("lots", 5)])
def test_max_results_is_coerced(fake_ddgs, monkeypatch, given, expected):
    _no_fallbacks(monkeypatch)
    fake_ddgs.script = [[_hit(i) for i in range(30)]]
    out = web_search(f"coerce {given}", max_results=given)
    assert fake_ddgs.calls[0]["max_results"] == expected
    assert out.count("- Link: ") == expected


def _opener_returning(*outcomes):
    opener = MagicMock()
    side_effects = []
    for outcome in outcomes:
        if isinstance(outcome, BaseException):
            side_effects.append(outcome)
        else:
            resp = MagicMock()
            resp.headers.get_content_type.return_value = outcome[0]
            resp.headers.get_content_charset.return_value = "utf-8"
            resp.read.return_value = outcome[1]
            cm = MagicMock()
            cm.__enter__.return_value = resp
            cm.__exit__.return_value = False
            side_effects.append(cm)
    opener.open.side_effect = side_effects
    return opener


def test_fetch_url_retries_transient_server_error():
    unavailable = urllib.error.HTTPError("https://example.com/a", 503, "Service Unavailable", {}, io.BytesIO())
    opener = _opener_returning(unavailable, ("text/plain", b"recovered body"))
    with patch("urllib.request.build_opener", return_value=opener):
        assert fetch_url("https://example.com/a") == "recovered body"
    assert opener.open.call_count == 2


def test_fetch_url_does_not_retry_404_and_explains_it():
    missing = urllib.error.HTTPError("https://example.com/gone", 404, "Not Found", {}, io.BytesIO())
    opener = _opener_returning(missing)
    with patch("urllib.request.build_opener", return_value=opener):
        out = fetch_url("https://example.com/gone")
    assert opener.open.call_count == 1
    assert out.startswith("Error fetching URL 'https://example.com/gone':")
    assert "not found (HTTP 404)" in out
    assert "HTTPError" not in out


def test_fetch_url_timeout_message_is_friendly():
    opener = _opener_returning(TimeoutError("The read operation timed out"), TimeoutError("The read operation timed out"))
    with patch("urllib.request.build_opener", return_value=opener):
        out = fetch_url("https://example.com/slow")
    assert opener.open.call_count == 2
    assert "timed out after" in out


def test_fetch_url_rejects_binary_content():
    opener = _opener_returning(("application/pdf", b"%PDF-1.7\n\x00\x01binary"))
    with patch("urllib.request.build_opener", return_value=opener):
        out = fetch_url("https://example.com/paper.pdf")
    assert "binary content (application/pdf)" in out
