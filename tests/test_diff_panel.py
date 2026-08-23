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

