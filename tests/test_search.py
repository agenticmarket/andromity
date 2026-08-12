"""Tests for search module (grep_search, find_files, auto-ignores)."""
import os
import tempfile
from pathlib import Path
from andromity.core.search import (
    grep_search,
    find_files,
    _python_grep,
    _truncate_line,
    _is_excluded_path,
)


def test_truncate_line():
    short = "hello world"
    assert _truncate_line(short) == short
    long_line = "a" * 300
    res = _truncate_line(long_line, max_chars=100)
    assert len(res) < 300
    assert "truncated" in res


def test_is_excluded_path():
    root = Path("/project")
    assert _is_excluded_path(Path("/project/node_modules/foo/index.js"), root) is True
    assert _is_excluded_path(Path("/project/.venv/lib/site.py"), root) is True
    assert _is_excluded_path(Path("/project/.git/config"), root) is True
    assert _is_excluded_path(Path("/project/dist/bundle.min.js"), root) is True
    assert _is_excluded_path(Path("/project/package-lock.json"), root) is True
    assert _is_excluded_path(Path("/project/image.png"), root) is True
    assert _is_excluded_path(Path("/project/src/main.py"), root) is False


def test_grep_search_basic():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        (root / "src").mkdir()
        (root / "src" / "app.py").write_text("def hello():\n    print('secret_key_123')\n")
        (root / "src" / "util.py").write_text("secret_key_456 = True\n")

        res = grep_search("secret_key", path=tmpdir)
        assert "app.py:2:" in res or "app.py" in res
        assert "secret_key_123" in res
        assert "secret_key_456" in res


def test_grep_search_case_sensitive():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        (root / "test.txt").write_text("Hello World\nhello world\n")

        res_case = grep_search("Hello", path=tmpdir, case_sensitive=True)
        assert "Hello World" in res_case
        assert "hello world" not in res_case

        res_nocase = grep_search("Hello", path=tmpdir, case_sensitive=False)
        assert "Hello World" in res_nocase
        assert "hello world" in res_nocase


def test_grep_search_auto_ignores():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        # Normal file
        (root / "src").mkdir()
        (root / "src" / "good.py").write_text("target_token = 1\n")

        # Excluded directories
        (root / "node_modules" / "pkg").mkdir(parents=True)
        (root / "node_modules" / "pkg" / "bad.js").write_text("target_token = 2\n")

        (root / ".venv" / "lib").mkdir(parents=True)
        (root / ".venv" / "lib" / "bad.py").write_text("target_token = 3\n")

        (root / "dist").mkdir()
        (root / "dist" / "bundle.min.js").write_text("target_token = 4\n")

        res = grep_search("target_token", path=tmpdir)
        assert "good.py" in res
        assert "node_modules" not in res
        assert ".venv" not in res
        assert "bundle.min.js" not in res


def test_grep_search_file_pattern():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        (root / "file.py").write_text("needle in py\n")
        (root / "file.md").write_text("needle in md\n")

        res = grep_search("needle", path=tmpdir, file_pattern="*.py")
        assert "file.py" in res
        assert "file.md" not in res


def test_grep_search_max_results():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        lines = [f"item {i}: match_word" for i in range(100)]
        (root / "data.txt").write_text("\n".join(lines))

        res = grep_search("match_word", path=tmpdir, max_results=10)
        assert "capped at 10" in res or "showing first 10" in res or "Found 10" in res


def test_find_files_basic():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        (root / "src" / "components").mkdir(parents=True)
        (root / "src" / "app.tsx").touch()
        (root / "src" / "components" / "Button.tsx").touch()
        (root / "src" / "style.css").touch()

        # Excluded
        (root / "node_modules" / "react").mkdir(parents=True)
        (root / "node_modules" / "react" / "index.tsx").touch()

        res = find_files("*.tsx", path=tmpdir)
        assert "app.tsx" in res
        assert "Button.tsx" in res
        assert "style.css" not in res
        assert "node_modules" not in res


def test_python_grep_direct():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        (root / "sample.txt").write_text("alpha beta gamma\n")
        res = _python_grep("beta", root, case_sensitive=False, file_pattern=None, max_results=10)
        assert "sample.txt:1: alpha beta gamma" in res


def test_grep_search_regex():
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        (root / "module.py").write_text("def test_func():\n    pass\n\ndef helper():\n    pass\n")

        res = grep_search(r"def\s+\w+\(", path=tmpdir)
        assert "test_func" in res
        assert "helper" in res


def test_grep_search_empty_query():
    with tempfile.TemporaryDirectory() as tmpdir:
        res = grep_search("", path=tmpdir)
        assert "Error: query cannot be empty." in res


def test_grep_search_nonexistent_path():
    res = grep_search("anything", path="nonexistent_folder_xyz_123")
    assert "Error" in res and "does not exist" in res


def test_grep_search_no_matches():
    with tempfile.TemporaryDirectory() as tmpdir:
        (Path(tmpdir) / "test.txt").write_text("just some content")
        res = grep_search("nonexistent_needle_123", path=tmpdir)
        assert "No matches found" in res


def test_find_files_no_matches():
    with tempfile.TemporaryDirectory() as tmpdir:
        (Path(tmpdir) / "test.txt").write_text("hello")
        res = find_files("*.rs", path=tmpdir)
        assert "No files found matching pattern" in res
