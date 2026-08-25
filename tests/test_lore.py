import pytest
from unittest.mock import patch, MagicMock
from andromity.core.lore import (
    fetch_lore_directive,
    fetch_random_tip,
    fetch_latest_news,
    fetch_seasonal_event,
    _LORE_CACHE,
)

@pytest.mark.asyncio
async def test_fetch_lore_directive_success():
    _LORE_CACHE.clear()
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "command": "void",
            "flavor": "cosmic_nihilism",
            "directive": "You have entered the void.",
            "seasonal": None,
            "clue": "0x00",
        }
        mock_get.return_value = mock_resp

        res = await fetch_lore_directive("/void")
        assert res is not None
        assert res["command"] == "void"
        assert res["flavor"] == "cosmic_nihilism"
        assert "void" in _LORE_CACHE

@pytest.mark.asyncio
async def test_fetch_lore_directive_not_found():
    _LORE_CACHE.clear()
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 404
        mock_get.return_value = mock_resp

        res = await fetch_lore_directive("/unknown_cmd_xyz")
        assert res is None

@pytest.mark.asyncio
async def test_fetch_random_tip():
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "status": "ok",
            "tip": "Keep functions pure and test boundaries.",
            "tag": "arch",
            "id": 4,
        }
        mock_get.return_value = mock_resp

        res = await fetch_random_tip()
        assert res is not None
        assert "pure" in res["tip"]
        assert res["tag"] == "arch"

@pytest.mark.asyncio
async def test_fetch_latest_news():
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "status": "ok",
            "version": "0.2.1",
            "title": "Andromity 0.2.1",
            "highlights": ["Cron Scheduler", "Edge Telemetry"],
        }
        mock_get.return_value = mock_resp

        res = await fetch_latest_news()
        assert res is not None
        assert res["version"] == "0.2.1"
        assert len(res["highlights"]) == 2

@pytest.mark.asyncio
async def test_fetch_seasonal_event():
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "active": True,
            "season": "halloween",
            "name": "🎃 Spooky Halloween Season",
        }
        mock_get.return_value = mock_resp

        res = await fetch_seasonal_event()
        assert res is not None
        assert res["active"] is True
        assert res["season"] == "halloween"
