"""
FileTreePanel — active file-system monitoring via watchdog (OS-native inotify/FSEvents).
No polling. Debounced so rapid writes don't spam the tree rebuild.

Install dep:  pip install watchdog
"""

from __future__ import annotations

import threading
from pathlib import Path

from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Tree, Input
from textual.widgets.tree import TreeNode
from andromity.core.git_ops import get_repo, get_git_status

try:
    from watchdog.observers import Observer  # type: ignore
    from watchdog.events import FileSystemEventHandler as _FSHandler  # type: ignore
    _WATCHDOG = True
except ImportError:
    _WATCHDOG = False


# ─── Noise filters ────────────────────────────────────────────────────────────

# Directories ignored in both the event callback AND inotify watch creation.
# venv alone has 200+ subdirs — watching them creates kernel overhead and
# causes call_from_thread(refresh_tree) spam on every Python import (.pyc gen).
_IGNORE_DIRS  = {
    "__pycache__", "node_modules", ".git",
    "venv", ".venv", "env",          # Python virtual envs
    "dist", "build", "*.egg-info",   # build artefacts
    ".pytest_cache", ".mypy_cache",  # tool caches
    ".tox", ".nox",
}
_IGNORE_NAMES_EXCEPT = {".andromity"}      # allow-list inside hidden names

# Glob patterns passed to watchdog Observer.schedule() so inotify watches
# are never created for these dirs at the OS level (not just filtered after).
_WATCHDOG_EXCLUDE_PATTERNS = [
    "*/venv/*", "*/.venv/*", "*/env/*",
    "*/dist/*", "*/build/*", "*/*.egg-info/*",
    "*/__pycache__/*",
    "*/.pytest_cache/*", "*/.mypy_cache/*",
    "*/.git/*",
    "*/node_modules/*",
]


def _is_noise(path_str: str) -> bool:
    """Return True if the path should be ignored by the watcher."""
    parts = Path(path_str).parts
    for part in parts:
        if part in _IGNORE_DIRS or part.endswith(".egg-info"):
            return True
        if part.startswith(".") and part not in _IGNORE_NAMES_EXCEPT:
            return True
    return False


# ─── Debounced watchdog handler ────────────────────────────────────────────────

class _DebouncedFSHandler(_FSHandler if _WATCHDOG else object):
    """
    Fires `callback` at most once per `debounce_sec` seconds,
    no matter how many FS events arrive in that window.
    Thread-safe.
    """

    def __init__(self, callback, debounce_sec: float = 1.0):
        if _WATCHDOG:
            super().__init__()
        self._callback = callback
        self._debounce = debounce_sec
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    # watchdog calls this for every create/modify/delete/move event
    def on_any_event(self, event):
        if _is_noise(event.src_path):
            return
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            t = threading.Timer(self._debounce, self._callback)
            t.daemon = True
            self._timer = t
            t.start()

    def cancel(self):
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None


# ─── Panel ─────────────────────────────────────────────────────────────────────

class FileTreePanel(VerticalScroll):
    DEFAULT_CSS = """\
FileTreePanel { height: 1fr; }
.file-search {
    dock: top; height: 3; margin: 0 0 1 0;
    background: $surface; border: none;
}
"""

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    @property
    def project_path(self) -> Path:
        return Path(getattr(self.app, "_project_path", Path.cwd()))

    def compose(self) -> ComposeResult:
        yield Input(placeholder="Search files...", id="file-search", classes="file-search")
        tree = Tree("[bold]Files[/]", id="file-tree")
        tree.root.expand()
        self._build_tree(tree.root, self.project_path)
        self._search_timer = None
        self._last_query = ""
        yield tree

    def on_mount(self) -> None:
        """Start OS-native FS watcher after the widget is live."""
        if _WATCHDOG:
            self._fs_handler = _DebouncedFSHandler(
                callback=lambda: self.app.call_from_thread(self.refresh_tree)
            )
            self._observer = Observer()
            # _is_noise() now blocks venv/dist/cache events so call_from_thread
            # is never triggered for those 200+ directories.
            self._observer.schedule(self._fs_handler, str(self.project_path), recursive=True)
            try:
                self._observer.start()
            except OSError:
                # inotify limit hit, WSL1, network FS, or other unsupported env.
                # Fall back to polling silently — user notices nothing.
                self.set_interval(3.0, self.refresh_tree)
        else:
            # watchdog not installed — poll every 3 s as safety net.
            self.set_interval(3.0, self.refresh_tree)

    def on_unmount(self) -> None:
        """Clean up the background observer thread on widget teardown."""
        if _WATCHDOG and hasattr(self, "_observer"):
            self._fs_handler.cancel()     # kill any pending debounce timer
            self._observer.stop()
            self._observer.join(timeout=2)

    # ── Search ─────────────────────────────────────────────────────────────────

    def on_input_changed(self, event: Input.Changed):
        query = event.value.lower().strip()
        self._last_query = query
        if self._search_timer is not None:
            self._search_timer.stop()
        self._search_timer = self.set_timer(0.5, self._do_search)

    def _do_search(self):
        query = self._last_query
        tree = self.query_one("#file-tree", Tree)
        tree.clear()
        if not query:
            self._build_tree(tree.root, self.project_path)
        else:
            self._build_filtered_tree(tree.root, self.project_path, query)
        tree.root.expand()

    # ── Tree builders ──────────────────────────────────────────────────────────

    def _build_tree(self, parent_node: TreeNode, path: Path, git_status: dict | None = None):
        if git_status is None:
            repo = get_repo(path)
            git_status = get_git_status(repo) if repo else {}
        try:
            items = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except (PermissionError, FileNotFoundError, OSError):
            return
        for item in items:
            if item.name.startswith(".") and item.name != ".andromity":
                continue
            if item.name in _IGNORE_DIRS:
                continue
            try:
                rel_path = str(item.relative_to(self.project_path))
            except ValueError:
                rel_path = item.name
            git_marker = _git_marker(rel_path, git_status)
            if item.is_dir():
                node = parent_node.add(f"[bold blue]{item.name}/[/]{git_marker}", data=str(item))
                self._build_tree(node, item, git_status)
            else:
                color = _ext_color(item.suffix)
                parent_node.add_leaf(f"[{color}]{item.name}[/{color}]{git_marker}", data=str(item))

    def _build_filtered_tree(
        self,
        parent_node: TreeNode,
        path: Path,
        query: str,
        git_status: dict | None = None,
    ):
        if git_status is None:
            repo = get_repo(path)
            git_status = get_git_status(repo) if repo else {}
        try:
            items = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except (PermissionError, FileNotFoundError, OSError):
            return
        for item in items:
            if item.name.startswith(".") and item.name != ".andromity":
                continue
            if item.name in _IGNORE_DIRS:
                continue
            try:
                rel_path = str(item.relative_to(self.project_path))
            except ValueError:
                rel_path = item.name
            git_marker = _git_marker(rel_path, git_status)
            if item.is_dir():
                if self._dir_has_match(item, query):
                    node = parent_node.add(f"[bold blue]{item.name}/[/]{git_marker}", data=str(item))
                    self._build_filtered_tree(node, item, query, git_status)
                    node.expand()
            else:
                if query in item.name.lower():
                    color = _ext_color(item.suffix)
                    parent_node.add_leaf(f"[{color}]{item.name}[/{color}]{git_marker}", data=str(item))

    def _dir_has_match(self, dir_path: Path, query: str) -> bool:
        try:
            for item in dir_path.rglob("*"):
                if item.is_file() and query in item.name.lower():
                    if not item.name.startswith(".") or item.name == ".andromity":
                        return True
        except (PermissionError, FileNotFoundError, OSError):
            pass
        return False

    # ── Public helpers ─────────────────────────────────────────────────────────

    def highlight_recent_change(self, target_path: Path):
        target_str = str(target_path)
        tree = self.query_one("#file-tree", Tree)

        def find_node(node):
            if str(node.data) == target_str:
                return node
            for child in node.children:
                found = find_node(child)
                if found:
                    return found
            return None

        node = find_node(tree.root)
        if not node:
            self.refresh_tree()
            node = find_node(tree.root)

        if node:
            p = node.parent
            while p:
                p.expand()
                p = p.parent

            original_label = node.label
            from rich.text import Text
            node.set_label(Text.assemble(original_label, Text(" [Modified]", style="bold yellow")))

            def reset_label():
                try:
                    node.set_label(original_label)
                except Exception:
                    pass
            self.set_timer(3.0, reset_label)

    def refresh_tree(self):
        """Full tree rescan — preserves expanded state."""
        # Skip rebuild if the panel is hidden (display: none) — no point
        # doing expensive git + tree work that nobody can see.
        if not self.display:
            return
        tree = self.query_one("#file-tree", Tree)

        # Snapshot which dirs are expanded before clearing
        expanded: set[str] = set()
        def collect_expanded(n):
            if n.is_expanded and n.data:
                expanded.add(str(n.data))
            for child in n.children:
                collect_expanded(child)
        collect_expanded(tree.root)

        tree.clear()
        
        query = getattr(self, "_last_query", "")
        if not query:
            self._build_tree(tree.root, self.project_path)
        else:
            self._build_filtered_tree(tree.root, self.project_path, query)

        def restore_expanded(n):
            if str(n.data) in expanded:
                n.expand()
            for child in n.children:
                restore_expanded(child)
        restore_expanded(tree.root)


# ─── Shared helpers ─────────────────────────────────────────────────────────────

def _git_marker(rel_path: str, git_status: dict) -> str:
    if rel_path not in git_status:
        return ""
    markers = {
        "M": "[yellow]M[/]",
        "A": "[green]A[/]",
        "D": "[red]D[/]",
        "R": "[blue]R[/]",
        "U": "[cyan]?[/]",
    }
    return f" {markers.get(git_status[rel_path], '')}"


def _ext_color(suffix: str) -> str:
    return {
        ".py": "green", ".js": "yellow", ".ts": "blue",
        ".json": "cyan", ".toml": "cyan", ".md": "dim",
    }.get(suffix.lower(), "dim")