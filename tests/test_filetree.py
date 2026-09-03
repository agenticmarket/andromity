import os
from pathlib import Path
from unittest.mock import patch

from rich.text import Text
from textual.widgets import Tree
from andromity.tui.panels.filetree import (
    FileTreePanel,
    _DebouncedFSHandler,
    _is_noise,
    _is_system_or_root_path,
)


def _label(node) -> str:
    return node.label.plain if hasattr(node.label, "plain") else str(node.label)


def _find_by_data(root, path_str: str):
    for child in root.children:
        if str(child.data) == path_str:
            return child
    return None


def test_is_noise_filtering():
    assert _is_noise("venv/lib/site-packages/pkg.py") is True
    assert _is_noise(".git/HEAD") is True
    assert _is_noise("AppData/Local/Temp") is True
    assert _is_noise(".andromity/settings.json") is False
    assert _is_noise("src/main.py") is False


def test_is_system_or_root_path():
    # Root drive / system paths
    if os.name == "nt":
        assert _is_system_or_root_path(Path("C:/")) is True
    assert _is_system_or_root_path(Path("/")) is True
    # Typical project path should NOT be detected as root
    assert _is_system_or_root_path(Path("/home/user/my_project")) is False


def test_populate_node_is_lazy(tmp_path):
    # Setup nested folder structure:
    # tmp_path/
    # ├── root_file.txt
    # └── sub_dir/
    #     └── nested_file.txt
    (tmp_path / "root_file.txt").write_text("root file")
    sub_dir = tmp_path / "sub_dir"
    sub_dir.mkdir()
    (sub_dir / "nested_file.txt").write_text("nested file")

    panel = FileTreePanel(project_path=tmp_path)
    tree = Tree("Files")
    # Populate root
    panel._populate_node(tree.root, tmp_path)

    # Root should contain root_file.txt and sub_dir/
    child_names = [child.label.plain if hasattr(child.label, "plain") else str(child.label) for child in tree.root.children]
    assert any("root_file.txt" in name for name in child_names)
    assert any("sub_dir" in name for name in child_names)

    # Lazy loading check: sub_dir node must NOT have children loaded yet!
    sub_dir_node = next(child for child in tree.root.children if "sub_dir" in (child.label.plain if hasattr(child.label, "plain") else str(child.label)))
    assert len(sub_dir_node.children) == 0

    # Expand/populate sub_dir explicitly
    panel._populate_node(sub_dir_node, sub_dir)
    assert len(sub_dir_node.children) == 1
    nested_label = sub_dir_node.children[0].label.plain if hasattr(sub_dir_node.children[0].label, "plain") else str(sub_dir_node.children[0].label)
    assert "nested_file.txt" in nested_label


# ─── Incremental diff-sync tests ──────────────────────────────────────────────

def _make_panel(tmp_path: Path) -> FileTreePanel:
    return FileTreePanel(project_path=tmp_path)


def test_sync_node_adds_new_file_in_place(tmp_path):
    (tmp_path / "a_first.txt").write_text("x")
    (tmp_path / "c_last.txt").write_text("x")
    panel = _make_panel(tmp_path)
    tree = Tree("Files")
    panel._populate_node(tree.root, tmp_path)

    # New file sorts between the two existing ones.
    (tmp_path / "b_new.txt").write_text("new")

    panel._sync_node(tree.root, tmp_path, git_status={})

    names = [_label(c) for c in tree.root.children]
    assert [n for n in names if ".txt" in n] == ["a_first.txt", "b_new.txt", "c_last.txt"]
    assert len(tree.root.children) == 3


def test_sync_node_removes_deleted_file(tmp_path):
    (tmp_path / "keep.txt").write_text("x")
    (tmp_path / "gone.txt").write_text("x")
    panel = _make_panel(tmp_path)
    tree = Tree("Files")
    panel._populate_node(tree.root, tmp_path)

    (tmp_path / "gone.txt").unlink()

    panel._sync_node(tree.root, tmp_path, git_status={})

    names = [_label(c) for c in tree.root.children]
    assert any("keep.txt" in n for n in names)
    assert not any("gone.txt" in n for n in names)


def test_sync_preserves_expanded_state_and_children(tmp_path):
    (tmp_path / "root.txt").write_text("x")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "inner.txt").write_text("x")

    panel = _make_panel(tmp_path)
    tree = Tree("Files")
    panel._populate_node(tree.root, tmp_path)

    sub_node = _find_by_data(tree.root, str(sub))
    assert sub_node is not None
    panel._populate_node(sub_node, sub)
    panel._loaded_paths.add(str(sub))
    sub_node.expand()

    # Unrelated change at root level must NOT touch the expanded subtree.
    (tmp_path / "root2.txt").write_text("x")
    panel._sync_node(tree.root, tmp_path, git_status={})

    sub_node_after = _find_by_data(tree.root, str(sub))
    assert sub_node_after.is_expanded
    assert len(sub_node_after.children) == 1
    assert "inner.txt" in _label(sub_node_after.children[0])


def test_sync_updates_git_marker_label_only_when_changed(tmp_path):
    f = tmp_path / "tracked.py"
    f.write_text("x")
    panel = _make_panel(tmp_path)
    tree = Tree("Files")
    panel._populate_node(tree.root, tmp_path, git_status={})

    node = _find_by_data(tree.root, str(f))
    before_label = node.label

    # Same status → label object untouched (no redundant set_label).
    panel._sync_node(tree.root, tmp_path, git_status={})
    assert node.label is before_label

    # Status changed → relabeled with marker.
    panel._sync_node(tree.root, tmp_path, git_status={"tracked.py": "M"})
    assert "[Modified]" not in _label(node)
    assert "M" in _label(node)


def test_sync_prunes_loaded_paths_for_deleted_dirs(tmp_path):
    sub = tmp_path / "doomed"
    sub.mkdir()
    (sub / "f.txt").write_text("x")
    panel = _make_panel(tmp_path)
    tree = Tree("Files")
    panel._populate_node(tree.root, tmp_path)
    panel._loaded_paths.add(str(sub))

    (sub / "f.txt").unlink()
    sub.rmdir()

    panel._sync_node(tree.root, tmp_path, git_status={})

    assert str(sub) not in panel._loaded_paths
    assert _find_by_data(tree.root, str(sub)) is None


def test_debounced_handler_collects_and_flushes_dirs():
    import time
    got = []
    handler = _DebouncedFSHandler(callback=lambda dirs: got.append(dirs), debounce_sec=0.05)

    class _Ev:
        src_path = "D:/proj/src/newfile.py"

    handler.on_any_event(_Ev())
    handler.on_any_event(_Ev())  # duplicate events for same dir
    time.sleep(0.15)

    expected_parent = str(Path("D:/proj/src/newfile.py").parent)
    assert len(got) == 1
    assert got[0] == {expected_parent}


def test_debounced_handler_ignores_noise():
    import time
    got = []
    handler = _DebouncedFSHandler(callback=lambda dirs: got.append(dirs), debounce_sec=0.05)

    class _Ev:
        src_path = "D:/proj/.git/index"

    handler.on_any_event(_Ev())
    time.sleep(0.1)

    assert got == []
