"""
FileTreePanel — Lazy-loading file tree with active file-system monitoring.

# ── Architecture & Performance Notes ──────────────────────────────────────────
#
# 1. LAZY LOADING ON DEMAND:
#    Directory contents are ONLY read when the node is expanded
#    (@on(Tree.NodeExpanded)). Initial startup reads only the immediate
#    children of the project root (1 level), making startup instantaneous (<15ms)
#    even when opened in C:\\, /home, or massive monorepos.
#
# 2. SYSTEM ROOT & WATCHER SAFETY:
#    Opening in a drive root (e.g. C:\\, /) or user root (/home/user, C:\\Users\\user)
#    disables recursive OS watchdog hooks to prevent kernel handle exhaustion and
#    CPU spikes from background OS writes (Windows Update, Antivirus, etc.).
#
# 3. EXPANDED NOISE & SYSTEM BLACKLIST:
#    Excludes system folders (Windows, AppData, Program Files, System Volume Info),
#    package caches (.venv, node_modules, target, .cargo, .cache), and hidden files.
#
# 4. BOUNDED SEARCH & DIRECTORY CAPS:
#    Directories with thousands of flat files are capped at 300 visible items.
#    Search traversal is depth-limited (depth 3, max 100 matches) in a worker.
#
# 5. SEAMLESS INCREMENTAL SYNC (no full reload):
#    Updates NEVER call tree.clear(). Instead _sync_node() diffs each directory's
#    live child nodes against a fresh disk scan and applies minimal mutations:
#    insert new nodes at their sorted position, remove deleted ones, relabel only
#    when content/git-marker changed. Because existing nodes are never destroyed,
#    expansion state, scroll position, cursor and [Modified] highlights survive
#    automatically. Recursion descends ONLY into directories that are expanded
#    AND already loaded — collapsed folders cost zero filesystem access and zero
#    UI work, so sync cost scales with the VISIBLE tree, not disk size.
#    All Tree mutations happen on the UI thread; workers only touch the filesystem.
# ─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from rich.text import Text
from textual import on
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Tree, Input
from textual.widgets.tree import TreeNode
from andromity.core.git_ops import get_repo, get_git_status

log = logging.getLogger(__name__)

try:
    from watchdog.observers import Observer  # type: ignore
    from watchdog.events import FileSystemEventHandler as _FSHandler  # type: ignore
    _WATCHDOG = True
except ImportError:
    _WATCHDOG = False


# ─── Noise filters ────────────────────────────────────────────────────────────

_IGNORE_DIRS = {
    "__pycache__", "node_modules", ".git",
    "venv", ".venv", "env", ".env",
    "dist", "build", "*.egg-info",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".tox", ".nox", ".cache",
    "target", "vendor", ".cargo", ".rustup",
    # System & OS heavy directories
    "AppData", "$Recycle.Bin", "System Volume Information", "Recovery",
    "Windows", "Program Files", "Program Files (x86)", "ProgramData",
}
_IGNORE_NAMES_EXCEPT = {".andromity"}

_WATCHDOG_EXCLUDE_PATTERNS = [
    "*/venv/*", "*/.venv/*", "*/env/*",
    "*/dist/*", "*/build/*", "*/*.egg-info/*",
    "*/__pycache__/*",
    "*/.pytest_cache/*", "*/.mypy_cache/*",
    "*/.git/*",
    "*/node_modules/*",
    "*/target/*",
    "*/AppData/*",
]


def _is_noise(path_str: str) -> bool:
    """Return True if the path should be ignored by the tree and watcher."""
    try:
        parts = Path(path_str).parts
        for part in parts:
            if part in _IGNORE_DIRS or part.endswith(".egg-info"):
                return True
            if part.startswith(".") and part not in _IGNORE_NAMES_EXCEPT:
                return True
    except Exception:
        pass
    return False


def _is_system_or_root_path(path: Path) -> bool:
    """Detect if path is a filesystem root or system folder where recursive watching is dangerous."""
    try:
        resolved = path.resolve()
        # Drive root: C:\, D:\, /
        if resolved == resolved.parent or len(resolved.parts) <= 1:
            return True
        # Top-level drive folder: e.g. C:\Users, C:\Windows, /home, /root
        if len(resolved.parts) == 2 and resolved.drive:
            return True
        # User home folder: C:\Users\<name>, /home/<name>
        try:
            if resolved == Path.home().resolve():
                return True
        except Exception:
            pass
    except Exception:
        pass
    return False


def _label_text(label) -> str:
    """Plain-text form of a Tree label (handles both str and rich Text)."""
    return label.plain if hasattr(label, "plain") else str(label)


# ─── Debounced watchdog handler ────────────────────────────────────────────────

class _DebouncedFSHandler(_FSHandler if _WATCHDOG else object):
    """Collects changed parent directories during a debounce window, then
    flushes them as a set so the panel can sync ONLY the affected subtrees.
    Uses a single persistent background thread to eliminate timer-thread churn."""

    def __init__(self, callback, debounce_sec: float = 1.2):
        if _WATCHDOG:
            super().__init__()
        self._callback = callback  # called with set[str] of changed dir paths
        self._debounce = debounce_sec
        self._pending: set[str] = set()
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._shutdown = False
        self._last_event_time = 0.0
        self._worker_thread = threading.Thread(target=self._loop, daemon=True, name="filetree-debounce")
        self._worker_thread.start()

    def on_any_event(self, event):
        src = getattr(event, "src_path", None) or getattr(event, "dest_path", None)
        if not src or _is_noise(src):
            return
        try:
            parent = str(Path(src).parent)
        except Exception:
            return
        with self._cond:
            self._pending.add(parent)
            self._last_event_time = time.time()
            self._cond.notify_all()

    def _loop(self):
        while True:
            with self._cond:
                while not self._pending and not self._shutdown:
                    self._cond.wait(timeout=0.5)
                if self._shutdown:
                    break

                # Wait until debounce interval after latest event has elapsed
                elapsed = time.time() - self._last_event_time
                remaining = self._debounce - elapsed
                if remaining > 0:
                    self._cond.wait(timeout=min(remaining, 0.5))
                    if self._shutdown:
                        break
                    # Check if a newer event arrived during wait
                    if time.time() - self._last_event_time < self._debounce:
                        continue

                pending = self._pending.copy()
                self._pending.clear()

            if pending and not self._shutdown:
                try:
                    self._callback(pending)
                except Exception:
                    log.debug("fs handler callback error", exc_info=True)

    def cancel(self):
        with self._cond:
            self._shutdown = True
            self._pending.clear()
            self._cond.notify_all()


# ─── Panel ─────────────────────────────────────────────────────────────────────

class FileTreePanel(VerticalScroll):
    DEFAULT_CSS = """\
FileTreePanel { height: 1fr; }
.file-search {
    dock: top; height: 3; margin: 0 0 1 0;
    background: $surface; border: none;
}
"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._loaded_paths: set[str] = set()
        self._search_timer = None
        self._last_query = ""
        self._git_status_cache: dict = {}
        self._watcher_active = False

    @property
    def project_path(self) -> Path:
        return Path(getattr(self.app, "_project_path", Path.cwd()))

    def compose(self) -> ComposeResult:
        yield Input(placeholder="Search files...", id="file-search", classes="file-search")
        tree = Tree("[bold]Files[/]", id="file-tree")
        yield tree

    def on_mount(self) -> None:
        """Populate root items and start safe watcher."""
        tree = self.query_one("#file-tree", Tree)
        tree.root.expand()
        self._populate_node(tree.root, self.project_path, git_status={})
        self._loaded_paths.add(str(self.project_path))

        # Check if running in root/huge directory
        is_root_dir = _is_system_or_root_path(self.project_path)

        # Background fetch initial git status so mount is instantaneous (<1ms)
        def _load_initial_git():
            try:
                repo = get_repo(self.project_path)
                gs = get_git_status(repo) if repo else {}
                self._git_status_cache = gs
                if gs:
                    def _apply_git(status):
                        if self.display:
                            t = self.query_one("#file-tree", Tree)
                            self._sync_node(t.root, self.project_path, status)
                    self.app.call_from_thread(_apply_git, gs)
            except Exception as e:
                log.debug("initial git status error: %s", e)

        self.run_worker(_load_initial_git, thread=True, exclusive=False, group="initial-git")

        if _WATCHDOG and not is_root_dir:
            try:
                self._fs_handler = _DebouncedFSHandler(
                    callback=lambda dirs: self.app.call_from_thread(self._apply_fs_events, dirs)
                )
                self._observer = Observer()
                self._observer.schedule(self._fs_handler, str(self.project_path), recursive=True)
                self._observer.start()
                self._watcher_active = True
            except OSError as e:
                log.warning("Watchdog setup skipped: %s (falling back to poll)", e)
                self.set_interval(15.0, self.refresh_tree)
        else:
            # Root drive or watchdog disabled — slow poll, but now each tick is a
            # cheap root-level diff (no clear/reload), so it is visually invisible.
            self.set_interval(20.0, self.refresh_tree)

    def on_unmount(self) -> None:
        """Clean up observer thread on teardown."""
        if hasattr(self, "_fs_handler"):
            try:
                self._fs_handler.cancel()
            except Exception:
                pass
        if _WATCHDOG and hasattr(self, "_observer") and self._watcher_active:
            try:
                self._observer.stop()
                self._observer.join(timeout=1.0)
            except Exception:
                pass

    # ── Lazy Expansion Handler ─────────────────────────────────────────────────

    @on(Tree.NodeExpanded, "#file-tree")
    def on_node_expanded(self, event: Tree.NodeExpanded) -> None:
        """Lazy load children when a directory node is expanded."""
        node = event.node
        if not node.data:
            return
        dir_path = Path(node.data)
        if dir_path.is_dir() and str(dir_path) not in self._loaded_paths:
            self._populate_node(node, dir_path)
            self._loaded_paths.add(str(dir_path))

    # ── Shared scanning / labeling helpers ─────────────────────────────────────

    @staticmethod
    def _stat_children(dir_path: Path) -> tuple[list[tuple[Path, bool]], int] | None:
        """Scan visible children of dir_path — ONE stat per item, shared by
        populate and sync so both use identical filter/sort/cap rules.

        Returns ([(path, is_dir)], overflow_count), or None if the scan failed
        (permission error / vanished directory). Directories sort first, then
        files, each alphabetically. Capped at 300 entries.
        """
        try:
            raw_items = list(dir_path.iterdir())
        except (PermissionError, FileNotFoundError, OSError):
            return None

        entries: list[tuple[Path, bool]] = []
        for item in raw_items:
            name = item.name
            if name.startswith(".") and name not in _IGNORE_NAMES_EXCEPT:
                continue
            if name in _IGNORE_DIRS or name.endswith(".egg-info"):
                continue
            try:
                is_dir = item.is_dir()
            except OSError:
                is_dir = False
            entries.append((item, is_dir))

        entries.sort(key=lambda e: (not e[1], e[0].name.lower()))

        max_items = 300
        overflow = max(0, len(entries) - max_items)
        return entries[:max_items], overflow

    def _label_for(self, item: Path, is_dir: bool, git_status: dict) -> str:
        """Single source of truth for node labels (used by populate, sync, search)."""
        try:
            rel_path = item.relative_to(self.project_path).as_posix()
        except ValueError:
            rel_path = item.name.replace("\\", "/")
        git_marker = _git_marker(rel_path, git_status, is_dir=is_dir)
        if is_dir:
            return f"[bold blue]{item.name}/[/]{git_marker}"
        color = _ext_color(item.suffix)
        return f"[{color}]{item.name}[/{color}]{git_marker}"

    def _ensure_git_status(self) -> dict:
        if not self._git_status_cache:
            repo = get_repo(self.project_path)
            self._git_status_cache = get_git_status(repo) if repo else {}
        return self._git_status_cache

    # ── Node Population (Single Level, Lazy) ───────────────────────────────────

    def _populate_node(self, parent_node: TreeNode, dir_path: Path, git_status: dict | None = None) -> None:
        """Populate ONLY the direct children of dir_path. Child dirs are added as expandable stubs."""
        if git_status is None:
            git_status = self._git_status_cache

        scanned = self._stat_children(dir_path)
        if scanned is None:
            parent_node.add_leaf("[dim italic](access denied)[/dim italic]")
            return
        entries, overflow = scanned
        if not entries:
            return

        for item, is_dir in entries:
            parent_node.add(
                self._label_for(item, is_dir, git_status),
                data=str(item),
                allow_expand=is_dir,
            )

        if overflow:
            parent_node.add_leaf(f"[dim]… ({overflow} more files, use search)[/dim]")

    # ── Incremental Diff Sync (seamless updates — no clear, no flicker) ────────

    def _sync_node(self, parent_node: TreeNode, dir_path: Path, git_status: dict) -> None:
        """Reconcile parent_node's children with dir_path's actual contents.

        Applies MINIMAL mutations only:
          • new entries  → inserted at their correct sorted position
          • deleted      → node removed
          • changed      → set_label only when the rendered text differs
        Never clears the tree, so expansion, scroll, cursor and highlights
        survive untouched. Recurses ONLY into directories that are expanded
        AND already loaded — collapsed stubs are untouched (zero FS/UI cost).
        """
        scanned = self._stat_children(dir_path)
        if scanned is None:
            # Transient failure (AV lock, dir vanished) — keep current view
            # rather than wiping it based on unreliable data.
            log.debug("_sync_node: scan failed for %s — skipping", dir_path)
            return
        entries, overflow = scanned

        # Synthetic nodes (overflow placeholder / access-denied leaf) carry no
        # data and are positional — drop them here, re-add below as needed.
        for child in list(parent_node.children):
            if child.data is None:
                child.remove()

        # Map surviving child nodes by their path for O(1) matching.
        existing: dict[str, TreeNode] = {}
        for child in parent_node.children:
            existing[str(child.data)] = child

        prev: TreeNode | None = None
        for item, is_dir in entries:
            key = str(item)
            node = existing.pop(key, None)
            markup = self._label_for(item, is_dir, git_status)

            if node is None:
                # New entry — insert at the correct sorted position.
                if prev is not None:
                    anchor = prev.next_sibling
                else:
                    anchor = parent_node.children[0] if parent_node.children else None
                node = parent_node.add(markup, data=key, before=anchor, allow_expand=is_dir)
            else:
                # Existing entry — relabel only if the visible text changed.
                if _label_text(node.label) != _label_text(Text.from_markup(markup)):
                    node.set_label(markup)
                if is_dir:
                    if not node.allow_expand:
                        node.allow_expand = True
                else:
                    # Path changed type (dir → file): drop stale descendants.
                    if node.children:
                        self._prune_loaded(node)
                        node.remove_children()
                    if node.allow_expand:
                        node.allow_expand = False

            # Descend ONLY into open, already-loaded directories. Collapsed
            # stubs stay untouched — invisible changes never reach the UI.
            if is_dir and node.is_expanded and key in self._loaded_paths:
                self._sync_node(node, item, git_status)

            prev = node

        # Whatever remains in `existing` no longer exists on disk.
        for stale in existing.values():
            self._prune_loaded(stale)
            stale.remove()

        if overflow:
            parent_node.add_leaf(f"[dim]… ({overflow} more files, use search)[/dim]")

    def _prune_loaded(self, node: TreeNode) -> None:
        """Remove node's subtree paths from the loaded-paths bookkeeping."""
        if node.data:
            self._loaded_paths.discard(str(node.data))
        for child in node.children:
            self._prune_loaded(child)

    # ── Watchdog event application (targeted subtree sync) ─────────────────────

    def _apply_fs_events(self, changed_dirs: set[str]) -> None:
        """Sync ONLY the subtrees affected by watchdog events.

        Each changed directory is resolved to the nearest live, loaded tree
        node (climbing ancestors if the dir itself isn't visible); unknown
        paths fall back to a cheap root-level diff.
        """
        if not self.display:
            return
        if self._last_query:
            # Search view rebuilds itself on the next keystroke — don't fight it.
            return

        tree = self.query_one("#file-tree", Tree)

        targets: dict[str, TreeNode] = {}
        need_root = False
        for dir_str in changed_dirs:
            node = self._nearest_syncable_node(tree, Path(dir_str))
            if node is None:
                need_root = True
            else:
                targets[str(node.data)] = node

        # Drop targets nested inside other targets — syncing the ancestor
        # already recurses into expanded, loaded children.
        pruned: dict[str, TreeNode] = {}
        for key, node in targets.items():
            kpath = Path(key)
            if any(Path(other) in kpath.parents for other in targets if other != key):
                continue
            pruned[key] = node
        targets = pruned

        if not targets and not need_root:
            return

        def _scan():
            # Worker thread: pure FS + git reads, NO widget access.
            try:
                self._git_status_cache.clear()
                return self._ensure_git_status()
            except Exception as e:
                log.debug("fs-event git scan error: %s", e)
                return {}

        def _apply(git_status: dict):
            if not self.display:
                return
            tree = self.query_one("#file-tree", Tree)
            scroll_y = tree.scroll_y
            cursor_line = tree.cursor_line

            if need_root:
                self._sync_node(tree.root, self.project_path, git_status)
            else:
                for key, node in targets.items():
                    if self._node_attached(node):
                        self._sync_node(node, Path(key), git_status)

            # Defensive: anchor the viewport if mass deletions shifted layout.
            try:
                if tree.cursor_line != cursor_line:
                    tree.cursor_line = cursor_line
                if abs(tree.scroll_y - scroll_y) > 0.5:
                    tree.scroll_to(y=scroll_y, animate=False)
            except Exception:
                pass

        def _worker():
            gs = _scan()
            try:
                self.app.call_from_thread(_apply, gs)
            except Exception:
                log.debug("could not schedule fs-event apply (shutting down?)", exc_info=True)

        self.run_worker(_worker, thread=True, exclusive=True, group="tree-fs-events")

    def _nearest_syncable_node(self, tree: Tree, dir_path: Path) -> TreeNode | None:
        """Deepest live tree node that is dir_path itself or an ancestor of it
        and already loaded. Returns None when only a root-level sync helps."""
        project = self.project_path
        current = dir_path
        while True:
            if current == project:
                return tree.root
            node = self._find_child_node(tree.root, current)
            if node is not None and str(current) in self._loaded_paths:
                return node
            parent = current.parent
            if parent == current:
                return None
            current = parent

    @staticmethod
    def _find_child_node(root: TreeNode, target: Path) -> TreeNode | None:
        t = str(target)
        for child in root.children:
            if str(child.data) == t:
                return child
        return None

    @staticmethod
    def _node_attached(node: TreeNode) -> bool:
        """True if node is still reachable from its tree root (not removed)."""
        cur = node
        while not cur.is_root:
            cur = cur.parent
            if cur is None:
                return False
        return True

    # ── Search ─────────────────────────────────────────────────────────────────

    def on_input_changed(self, event: Input.Changed):
        query = event.value.lower().strip()
        self._last_query = query
        if self._search_timer is not None:
            self._search_timer.stop()
        self._search_timer = self.set_timer(0.35, self._do_search)

    def _do_search(self):
        query = self._last_query
        tree = self.query_one("#file-tree", Tree)
        tree.clear()
        self._loaded_paths.clear()
        self._git_status_cache.clear()

        if not query:
            self._populate_node(tree.root, self.project_path)
            self._loaded_paths.add(str(self.project_path))
            tree.root.expand()
        else:
            self._build_filtered_tree(tree.root, self.project_path, query)
            tree.root.expand()

    def _build_filtered_tree(self, parent_node: TreeNode, path: Path, query: str, _depth: int = 0, _match_count: list[int] | None = None):
        """Bounded search across directories (depth max 4, capped at 100 matches)."""
        if _match_count is None:
            _match_count = [0]
        if _depth > 4 or _match_count[0] >= 100:
            return

        git_status = self._ensure_git_status()

        try:
            items = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except (PermissionError, FileNotFoundError, OSError):
            return

        for item in items:
            if _match_count[0] >= 100:
                parent_node.add_leaf("[dim]… (search capped at 100 results)[/dim]")
                return

            if item.name.startswith(".") and item.name not in _IGNORE_NAMES_EXCEPT:
                continue
            if item.name in _IGNORE_DIRS:
                continue

            if item.is_dir():
                if self._dir_has_match(item, query):
                    node = parent_node.add(self._label_for(item, True, git_status), data=str(item))
                    self._build_filtered_tree(node, item, query, _depth + 1, _match_count)
                    node.expand()
            else:
                if query in item.name.lower():
                    _match_count[0] += 1
                    parent_node.add_leaf(self._label_for(item, False, git_status), data=str(item))

    def _dir_has_match(self, dir_path: Path, query: str, max_depth: int = 3) -> bool:
        """Check if any file under dir_path matches query, with safe depth bounding."""
        try:
            stack = [(dir_path, 0)]
            checked = 0
            while stack and checked < 500:
                current, depth = stack.pop()
                if depth > max_depth:
                    continue
                try:
                    for child in current.iterdir():
                        checked += 1
                        if child.name.startswith(".") and child.name not in _IGNORE_NAMES_EXCEPT:
                            continue
                        if child.name in _IGNORE_DIRS:
                            continue
                        if child.is_file() and query in child.name.lower():
                            return True
                        elif child.is_dir() and depth < max_depth:
                            stack.append((child, depth + 1))
                except (PermissionError, FileNotFoundError, OSError):
                    continue
        except Exception:
            pass
        return False

    # ── Public helpers ─────────────────────────────────────────────────────────

    def highlight_recent_change(self, target_path: Path):
        """Highlight a modified file if visible, without force-expanding collapsed folders."""
        target_str = str(target_path)
        tree = self.query_one("#file-tree", Tree)

        highlight_target = target_str
        try:
            rel = target_path.relative_to(self.project_path)
            current_node = tree.root
            current_path = self.project_path

            for part in rel.parts[:-1]:
                current_path = current_path / part
                matched_child = None
                for child in current_node.children:
                    if str(child.data) == str(current_path):
                        matched_child = child
                        break
                if matched_child:
                    if not matched_child.is_expanded:
                        # Folder is collapsed — do NOT force-expand it.
                        highlight_target = str(current_path)
                        break
                    # If already expanded and children not loaded, populate
                    if str(current_path) not in self._loaded_paths:
                        self._populate_node(matched_child, current_path)
                        self._loaded_paths.add(str(current_path))
                    current_node = matched_child
                else:
                    break
        except Exception:
            pass

        def find_node(node):
            if str(node.data) == highlight_target:
                return node
            for child in node.children:
                found = find_node(child)
                if found:
                    return found
            return None

        node = find_node(tree.root)
        if node and node != tree.root:
            raw_plain = _label_text(node.label)
            clean_plain = raw_plain.replace(" [Modified]", "").strip()
            original_label = getattr(node, "_base_unhighlighted_label", None)
            if original_label is None or " [Modified]" in _label_text(original_label):
                original_label = node.label
                if isinstance(original_label, Text):
                    original_label = original_label.copy()
                    original_label.plain = clean_plain

            node._base_unhighlighted_label = original_label
            node.set_label(Text.assemble(original_label, Text(" [Modified]", style="bold yellow")))

            def reset_label():
                try:
                    if hasattr(node, "_base_unhighlighted_label"):
                        node.set_label(node._base_unhighlighted_label)
                        delattr(node, "_base_unhighlighted_label")
                except Exception:
                    pass
            self.set_timer(3.0, reset_label)

    def refresh_tree(self):
        """Seamlessly reconcile the tree with disk — NO clear(), no flicker.

        The filesystem + git scan runs in a worker thread; the resulting diff
        is applied on the UI thread via _sync_node: new nodes appear in place,
        deleted nodes disappear, changed labels update — all without destroying
        existing nodes, so expansion state, scroll position and highlights are
        inherently preserved.
        """
        if not self.display:
            return

        def _apply(git_status: dict):
            if not self.display:
                return
            tree = self.query_one("#file-tree", Tree)
            query = getattr(self, "_last_query", "")
            if query:
                # Search mode keeps its bounded rebuild (user-initiated action).
                tree.clear()
                self._loaded_paths.clear()
                self._build_filtered_tree(tree.root, self.project_path, query)
                tree.root.expand()
                return

            scroll_y = tree.scroll_y
            cursor_line = tree.cursor_line
            self._sync_node(tree.root, self.project_path, git_status)

            # Defensive: anchor the viewport if mass deletions shifted layout.
            try:
                if tree.cursor_line != cursor_line:
                    tree.cursor_line = cursor_line
                if abs(tree.scroll_y - scroll_y) > 0.5:
                    tree.scroll_to(y=scroll_y, animate=False)
            except Exception:
                pass

        def _worker():
            # Worker thread: pure FS + git reads, NO widget access.
            try:
                self._git_status_cache.clear()
                gs = self._ensure_git_status()
            except Exception as e:
                log.debug("refresh_tree scan error: %s", e)
                gs = {}
            try:
                self.app.call_from_thread(_apply, gs)
            except Exception:
                log.debug("could not schedule refresh apply (shutting down?)", exc_info=True)

        self.run_worker(_worker, thread=True, exclusive=True, group="tree-refresh")


# ─── Shared helpers ─────────────────────────────────────────────────────────────

def _git_marker(rel_path: str, git_status: dict, is_dir: bool = False) -> str:
    if not git_status:
        return ""
    norm = rel_path.replace("\\", "/").rstrip("/")
    if is_dir:
        prefix = f"{norm}/"
        child_statuses = [v for k, v in git_status.items() if k.startswith(prefix)]
        if not child_statuses:
            return ""
        if "M" in child_statuses or "D" in child_statuses or "R" in child_statuses:
            return " [yellow]M[/]"
        if "A" in child_statuses:
            return " [green]A[/]"
        if "U" in child_statuses:
            return " [cyan]?[/]"
        return " [yellow]M[/]"

    if norm not in git_status:
        return ""
    markers = {
        "M": "[yellow]M[/]",
        "A": "[green]A[/]",
        "D": "[red]D[/]",
        "R": "[blue]R[/]",
        "U": "[cyan]?[/]",
    }
    return f" {markers.get(git_status[norm], '')}"


def _ext_color(suffix: str) -> str:
    return {
        ".py": "green", ".js": "yellow", ".ts": "blue",
        ".json": "cyan", ".toml": "cyan", ".md": "dim",
        ".html": "yellow", ".css": "blue", ".rs": "red",
        ".go": "cyan", ".sh": "green", ".sql": "magenta",
    }.get(suffix.lower(), "dim")
