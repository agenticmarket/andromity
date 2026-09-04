import pytest
from andromity.tui.panels.diff import _format_diff


def test_format_diff_single_hunk():
    diff_text = """--- a/src/example.py
+++ b/src/example.py
@@ -10,3 +10,4 @@ def example():
  first line
- old line
+ new line A
+ new line B
  last line"""
    result = _format_diff(diff_text)
    assert "[dim] 10 │[/dim]" in result
    assert "[dim] 11 │[/dim] [red]- old line[/red]" in result
    assert "[dim] 11 │[/dim] [green]+ new line A[/green]" in result
    assert "[dim] 12 │[/dim] [green]+ new line B[/green]" in result
    assert "[dim] 13 │[/dim]   last line" in result


def test_format_diff_multiple_hunks():
    diff_text = """--- a/file.py
+++ b/file.py
@@ -1,2 +1,2 @@
-alpha
+beta
@@ -100,2 +100,2 @@
-gamma
+delta"""
    result = _format_diff(diff_text)
    assert "[dim]  1 │[/dim] [red]-alpha[/red]" in result
    assert "[dim]  1 │[/dim] [green]+beta[/green]" in result
    assert "[dim]100 │[/dim] [red]-gamma[/red]" in result
    assert "[dim]100 │[/dim] [green]+delta[/green]" in result


def test_format_diff_empty_or_no_hunk():
    result = _format_diff("")
    assert result == ""


def test_file_viewer_long_lines_scroll_horizontally(tmp_path):
    """Long lines in the file viewer must overflow (scrollable), not clip.

    Regression: Static(Syntax(...)) was mounted without width:auto sizing CSS,
    so virtual_size stayed at container width and overflow-x never activated.
    """
    import asyncio
    from textual.app import App, ComposeResult
    from andromity.tui.panels.diff import DiffPanel

    async def _run():
        long_line = "x" * 300
        f = tmp_path / "long_lines.md"
        f.write_text(f"short line\n{long_line}\nanother short\n", encoding="utf-8")

        class Host(App):
            def compose(self) -> ComposeResult:
                yield DiffPanel(id="diff-panel")

        app = Host()
        async with app.run_test(size=(120, 30)) as pilot:
            panel = app.query_one(DiffPanel)
            panel.show_file(f)
            for _ in range(6):
                await pilot.pause()

            area = panel.query_one("#content-tab-1")
            assert area.virtual_size.width > area.size.width, (
                f"content should overflow horizontally: virtual={area.virtual_size} size={area.size}"
            )
            assert area.max_scroll_x > 0, "horizontal scrollbar must be active"

    asyncio.run(_run())


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

