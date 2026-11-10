"""Load LiteLLM away from the event loop.

Importing it takes seconds of CPU and may download a price map, so an import on
the loop freezes every request the daemon is serving.
"""
import asyncio
import threading
from types import ModuleType
from typing import Optional

_ready = threading.Event()
_lock = threading.Lock()


def import_litellm() -> ModuleType:
    with _lock:
        import litellm
        litellm.suppress_debug_info = True
        litellm.drop_params = True
        _ready.set()
        return litellm


def loaded_litellm() -> Optional[ModuleType]:
    """LiteLLM if it has finished loading, without ever importing it on the caller's thread."""
    if not _ready.is_set():
        return None
    import litellm
    return litellm


async def load_litellm() -> ModuleType:
    if _ready.is_set():
        import litellm
        return litellm
    return await asyncio.to_thread(import_litellm)
