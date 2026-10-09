"""Rigid regression tests for search and web security, integrity, and air-gap enforcement."""
import os
import io
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from andromity.core.search import ensure_ripgrep, RIPGREP_SHA256
from andromity.core.web import fetch_url, web_search


def test_ensure_ripgrep_airgap_blocks_network():
    """Verify that ANDROMITY_AIRGAP=1 immediately blocks ripgrep download attempts."""
    with patch.dict(os.environ, {"ANDROMITY_AIRGAP": "1"}):
        with patch("urllib.request.urlopen") as mock_url:
            res = ensure_ripgrep()
            assert res is None
            mock_url.assert_not_called()


def test_ensure_ripgrep_sha256_mismatch_rejection(tmp_path):
    """Verify that a corrupted or tampered ripgrep binary download is detected and purged."""
    mock_corrupted_data = b"tampered-binary-payload-data"
    
    mock_resp = MagicMock()
    mock_resp.read.side_effect = [mock_corrupted_data, b""]

    # Point home to tmp_path so ~/.andromity/bin is isolated
    with patch("pathlib.Path.home", return_value=tmp_path):
        with patch.dict(os.environ, {"ANDROMITY_AIRGAP": "0"}, clear=False):
            with patch("urllib.request.urlopen") as mock_url:
                mock_url.return_value.__enter__.return_value = io.BytesIO(mock_corrupted_data)
                
                # Mock target asset in RIPGREP_SHA256
                fake_asset = "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip"
                with patch("sys.platform", "win32"):
                    res = ensure_ripgrep()
                    assert res is None
                    # Verify target executable was NOT created
                    target_exe = tmp_path / ".andromity" / "bin" / "rg.exe"
                    assert not target_exe.exists()


def test_fetch_url_airgap_blocks_network():
    """Verify that ANDROMITY_AIRGAP=1 blocks fetch_url without network calls."""
    with patch.dict(os.environ, {"ANDROMITY_AIRGAP": "1"}):
        with patch("urllib.request.build_opener") as mock_opener:
            res = fetch_url("https://example.com/api/data")
            assert "blocked by air-gap policy" in res
            mock_opener.assert_not_called()


def test_web_search_airgap_blocks_network():
    """Verify that ANDROMITY_AIRGAP=1 blocks web_search without network calls."""
    with patch.dict(os.environ, {"ANDROMITY_AIRGAP": "1"}):
        with patch("urllib.request.urlopen") as mock_urlopen:
            res = web_search("python tutorial")
            assert "blocked by air-gap policy" in res
            mock_urlopen.assert_not_called()


def test_fetch_url_redirect_to_non_http_blocked():
    """Verify that redirects to non-http(s) schemes like file:// or gopher:// are rejected."""
    # Test internal _SafeRedirectHandler directly via fetch_url trigger
    mock_req = MagicMock()
    
    with patch.dict(os.environ, {"ANDROMITY_AIRGAP": "0"}):
        # Trigger redirect handler logic
        with patch("urllib.request.build_opener") as mock_build_opener:
            mock_opener = MagicMock()
            mock_build_opener.return_value = mock_opener
            
            # Simulate redirect handler instantiated during fetch_url
            fetch_url("https://example.com/redirect-test")
            assert mock_build_opener.call_count == 1
            handler = mock_build_opener.call_args[0][0]

            # 1. Non-http scheme (file://)
            with pytest.raises(urllib.error.HTTPError) as exc_info:
                handler.redirect_request(mock_req, None, 302, "Found", {}, "file:///etc/passwd")
            assert "Redirect to non-HTTP(S) scheme 'file' blocked" in str(exc_info.value)

            # 2. Non-http scheme (gopher://)
            with pytest.raises(urllib.error.HTTPError) as exc_info:
                handler.redirect_request(mock_req, None, 302, "Found", {}, "gopher://127.0.0.1:6379/_")
            assert "Redirect to non-HTTP(S) scheme 'gopher' blocked" in str(exc_info.value)

            # 3. Private IP target
            with pytest.raises(urllib.error.HTTPError) as exc_info:
                handler.redirect_request(mock_req, None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data")
            assert "Redirect to private/internal host" in str(exc_info.value)
