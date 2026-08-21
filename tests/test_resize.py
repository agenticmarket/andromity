"""Terminal resizes must never crash the app.

On Windows the console fires WINDOW_BUFFER_SIZE_EVENT with transiently tiny
sizes (e.g. 4x1) while the window is being expanded/dragged. Textual's
layout then hands a 0-width option region to Content._wrap_and_format, whose
fold path runs `range(0, cell_length, width)` and raises
"ValueError: range() arg 3 must not be zero" — killing the app whenever an
OptionList overlay (command palette, @-mentions, batch review) is open.
"""
import asyncio

import pytest
from textual import events
from textual.content import Content
from textual.geometry import Size

from andromity.config import config
from andromity.tui.app import AndromityApp


@pytest.fixture(autouse=True)
def _isolated_environment(tmp_path, monkeypatch):
    """Point the global config at a temp dir and run in a temp project dir
    so the test never touches the real config, sessions, or git state."""
    cfg_dir = tmp_path / "cfg"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "config_dir", cfg_dir)
    monkeypatch.setattr(config, "config_path", cfg_dir / "config.toml")
    config._config_cache = {}
    config._load()
    monkeypatch.chdir(tmp_path)


async def _settle(pilot, n=8):
    for _ in range(n):
        await pilot.pause()


def test_fold_guard_rejects_zero_width():
    """The textual workaround makes a 0-width fold a no-op instead of crashing."""
    c = Content("some content that is long enough to fold")
    # Previously raised: ValueError: range() arg 3 must not be zero
    lines = c._wrap_and_format(0, no_wrap=True)
    assert lines


def test_resize_to_tiny_sizes_with_palette_open_does_not_crash():
    async def _run():
        app = AndromityApp()
        async with app.run_test(size=(120, 30)) as pilot:
            await _settle(pilot)
            # Open the command palette (an OptionList overlay) — the widget
            # that used to crash during a tiny resize.
            app.query_one("#input-field").text = "/mo"
            await _settle(pilot)
            for w in (0, 1, 2, 3, 4, 5, 10, 120):
                for h in (0, 1, 2, 5, 30):
                    app.post_message(events.Resize(Size(w, h), Size(w, h)))
                    await _settle(pilot)
            # App must still be alive and back at a real size.
            assert app.size.width > 0 and app.size.height > 0

    asyncio.run(_run())


if __name__ == "__main__":
    import pytest as _pytest

    _pytest.main([__file__, "-v"])
