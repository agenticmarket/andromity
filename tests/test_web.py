"""Tests for web search and URL content fetching tools."""
from unittest.mock import patch, MagicMock
import io
import pytest
from andromity.core.web import fetch_url, web_search, _clean_html
from andromity.core.security import is_domain_allowed, get_domain


def test_clean_html():
    raw_html = """
    <html>
    <head><title>Test Page</title><style>body { color: red; }</style></head>
    <body>
        <h1>Main Title</h1>
        <script>alert('malicious');</script>
        <p>This is a <b>test</b> paragraph with a <a href="https://example.com">link</a>.</p>
        <div>Second section with details.</div>
    </body>
    </html>
    """
    cleaned = _clean_html(raw_html)
    assert "Main Title" in cleaned
    assert "This is a **test** paragraph with a [link]" in cleaned
    assert "Second section with details." in cleaned
    assert "alert('malicious')" not in cleaned
    assert "<style>" not in cleaned


def test_fetch_url_invalid_scheme():
    res = fetch_url("ftp://example.com/file")
    assert "Error: URL must start with http://" in res


def test_fetch_url_mocked_success():
    mock_resp = MagicMock()
    mock_resp.headers.get_content_type.return_value = "text/html"
    mock_resp.headers.get_content_charset.return_value = "utf-8"
    mock_resp.read.return_value = b"<html><body><h1>Docs</h1><p>Documentation content</p></body></html>"

    with patch("urllib.request.OpenerDirector.open") as mock_open:
        mock_open.return_value.__enter__.return_value = mock_resp
        res = fetch_url("https://docs.python.org/3/")
        assert "Docs" in res
        assert "Documentation content" in res


def test_clean_html_semantic_article_extraction():
    html_doc = """
    <html>
    <body>
        <nav><a href="/home">Home</a><a href="/docs">Docs</a></nav>
        <header><h1>Site Header</h1></header>
        <article>
            <h2>Lifespan Events</h2>
            <p>Define startup and shutdown logic with an async context manager:</p>
            <pre><code>async def lifespan(app): yield</code></pre>
        </article>
        <footer><p>Copyright 2026</p></footer>
    </body>
    </html>
    """
    cleaned = _clean_html(html_doc)
    assert "Lifespan Events" in cleaned
    assert "startup and shutdown" in cleaned
    assert "async def lifespan" in cleaned
    assert "Site Header" not in cleaned
    assert "Copyright 2026" not in cleaned


def test_fetch_url_private_ip_blocked():
    assert "not allowed" in fetch_url("http://127.0.0.1:8080/secret")
    assert "not allowed" in fetch_url("http://192.168.1.10/admin")
    assert "not allowed" in fetch_url("http://169.254.169.254/latest/meta-data/")


def test_fetch_url_cache():
    mock_resp = MagicMock()
    mock_resp.headers.get_content_type.return_value = "text/plain"
    mock_resp.headers.get_content_charset.return_value = "utf-8"
    mock_resp.read.return_value = b"Cached Content"

    with patch("urllib.request.OpenerDirector.open") as mock_open:
        mock_open.return_value.__enter__.return_value = mock_resp
        url = "https://example.com/cache-test"
        res1 = fetch_url(url)
        res2 = fetch_url(url)
        assert res1 == "Cached Content"
        assert res2 == "Cached Content"
        assert mock_open.call_count == 1


def test_ddg_lite_search_parsing():
    from andromity.core.web import _ddg_lite_search
    fake_lite_html = """
    <table>
        <tr><td><a class="result-link" href="https://docs.python.org/3/">Python 3 Documentation</a></td></tr>
        <tr><td class="result-snippet">Official documentation and API reference for Python 3.</td></tr>
        <tr><td><a class="result-link" href="https://github.com/python">Python GitHub</a></td></tr>
        <tr><td class="result-snippet">Python organization repositories.</td></tr>
    </table>
    """
    mock_resp = MagicMock()
    mock_resp.read.return_value = fake_lite_html.encode("utf-8")
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value.__enter__.return_value = mock_resp
        results = _ddg_lite_search("python docs", max_results=2)
        assert len(results) == 2
        assert results[0]["title"] == "Python 3 Documentation"
        assert results[0]["url"] == "https://docs.python.org/3/"
        assert "Official documentation" in results[0]["snippet"]


def test_web_search_with_fetch_top():
    mock_results = [{"title": "FastAPI Docs", "url": "https://fastapi.tiangolo.com/", "snippet": "Modern API framework."}]
    with patch("andromity.core.web.DDGS", None):
        with patch("andromity.core.web._ddg_lite_search", return_value=mock_results):
            with patch("andromity.core.web.fetch_url", return_value="# FastAPI\nHigh performance web framework."):
                output = web_search("fastapi docs", max_results=1, fetch_top=1)
                assert "FastAPI Docs" in output
                assert "Content Extract #1" in output
                assert "High performance web framework" in output


def test_domain_allowlisting():
    allowed = ["docs.python.org", "github.com", "*.cloudflare.com"]
    
    assert is_domain_allowed("https://docs.python.org/3/library/os.html", allowed) is True
    assert is_domain_allowed("https://github.com/agenticmarket/andromity", allowed) is True
    assert is_domain_allowed("https://api.github.com/repos", allowed) is True
    assert is_domain_allowed("https://dash.cloudflare.com/overview", allowed) is True
    assert is_domain_allowed("https://malicious-site.com/steal", allowed) is False
    assert is_domain_allowed("https://notgithub.com/fake", allowed) is False

