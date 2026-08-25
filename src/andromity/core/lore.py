"""
Dynamic edge lore, developer tips, and seasonal events fetcher for Andromity.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

LORE_BASE_URL = "https://telemetry.agenticmarket.dev"

_LORE_CACHE: dict[str, dict[str, Any]] = {}


async def fetch_lore_directive(command: str) -> Optional[dict[str, Any]]:
    """Fetch behavioral lore directive for special unlisted commands."""
    cmd = command.lstrip("/").lower().strip()
    if cmd in _LORE_CACHE:
        return _LORE_CACHE[cmd]

    try:
        async with httpx.AsyncClient(timeout=3.5, headers={"User-Agent": "Andromity-CLI"}) as client:
            resp = await client.get(f"{LORE_BASE_URL}/cmd/{cmd}")
            if resp.status_code == 200:
                data = resp.json()
                _LORE_CACHE[cmd] = data
                return data
    except Exception as e:
        logger.debug("Lore edge request failed for %s: %s", cmd, e)
    return None


async def fetch_random_tip(tag: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Fetch a curated developer tip from the edge."""
    try:
        params = {"tag": tag} if tag else {}
        async with httpx.AsyncClient(timeout=3.5, headers={"User-Agent": "Andromity-CLI"}) as client:
            resp = await client.get(f"{LORE_BASE_URL}/tips", params=params)
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.debug("Tip request failed: %s", e)
    return None


async def fetch_latest_news() -> Optional[dict[str, Any]]:
    """Fetch latest release highlights and announcements from the edge."""
    try:
        async with httpx.AsyncClient(timeout=3.5, headers={"User-Agent": "Andromity-CLI"}) as client:
            resp = await client.get(f"{LORE_BASE_URL}/news")
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.debug("News request failed: %s", e)
    return None


async def fetch_seasonal_event() -> Optional[dict[str, Any]]:
    """Fetch active seasonal festival or event modifier."""
    try:
        async with httpx.AsyncClient(timeout=3.5, headers={"User-Agent": "Andromity-CLI"}) as client:
            resp = await client.get(f"{LORE_BASE_URL}/season")
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.debug("Season request failed: %s", e)
    return None
