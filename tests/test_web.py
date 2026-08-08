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
    assert "This is a test paragraph with a link." in cleaned
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

    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.return_value.__enter__.return_value = mock_resp
        res = fetch_url("https://docs.python.org/3/")
        assert "Docs" in res
        assert "Documentation content" in res


def test_domain_allowlisting():
    allowed = ["docs.python.org", "github.com", "*.cloudflare.com"]
    
    assert is_domain_allowed("https://docs.python.org/3/library/os.html", allowed) is True
    assert is_domain_allowed("https://github.com/agenticmarket/andromity", allowed) is True
    assert is_domain_allowed("https://api.github.com/repos", allowed) is True
    assert is_domain_allowed("https://dash.cloudflare.com/overview", allowed) is True
    assert is_domain_allowed("https://malicious-site.com/steal", allowed) is False
    assert is_domain_allowed("https://notgithub.com/fake", allowed) is False
