"""Rigid regression tests for updater air-gap safety enforcement."""
import os
from unittest.mock import patch

from andromity.core.updater import check_for_updates_sync, perform_update


def test_updater_airgap_blocks_check():
    """Verify that check_for_updates_sync makes zero outbound network requests when air-gapped."""
    with patch.dict(os.environ, {"ANDROMITY_AIRGAP": "1"}):
        with patch("urllib.request.urlopen") as mock_urlopen:
            res = check_for_updates_sync(force=True)
            assert res.get("update_available") is False
            mock_urlopen.assert_not_called()


def test_updater_airgap_blocks_perform_update():
    """Verify that perform_update aborts immediately without subprocess execution when air-gapped."""
    with patch.dict(os.environ, {"ANDROMITY_AIRGAP": "1"}):
        with patch("subprocess.run") as mock_subproc:
            success, msg = perform_update()
            assert success is False
            assert "blocked by air-gap policy" in msg
            mock_subproc.assert_not_called()
