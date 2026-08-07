from pathlib import Path
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Tree, Input
from textual.widgets.tree import TreeNode
from andromity.core.git_ops import get_repo, get_git_status


class FileTreePanel(VerticalScroll):
    DEFAULT_CSS = """\
FileTreePanel { height: 1fr; }
.file-search {
    dock: top; height: 3; margin: 0 0 1 0;
    background: $surface; border: none;
}
"""

    def compose(self) -> ComposeResult:
        yield Input(placeholder="Search files...", id="file-search", classes="file-search")
        tree = Tree("[bold]Files[/]", id="file-tree")
        tree.root.expand()
        self._build_tree(tree.root, Path.cwd())
        self._search_timer = None
        self._last_query = ""
        yield tree

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
            self._build_tree(tree.root, Path.cwd())
        else:
            self._build_filtered_tree(tree.root, Path.cwd(), query)
        tree.root.expand()

    def _build_filtered_tree(self, parent_node: TreeNode, path: Path, query: str, git_status: dict | None = None):
        """Build tree showing only files/folders matching query."""
        if git_status is None:
            repo = get_repo(path)
            git_status = get_git_status(repo) if repo else {}
        try:
            items = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return
        for item in items:
            if item.name.startswith(".") and item.name != ".andromity":
                continue
            if item.name in ("__pycache__", "node_modules", ".git"):
                continue
            rel_path = str(item.relative_to(Path.cwd()))
            git_marker = ""
            if rel_path in git_status:
                change = git_status[rel_path]
                markers = {"M": "[yellow]M[/]", "A": "[green]A[/]", "D": "[red]D[/]",
                           "R": "[blue]R[/]", "U": "[cyan]?[/]"}
                git_marker = f" {markers.get(change, '')}"
            if item.is_dir():
                # Check if any file in this dir matches
                if self._dir_has_match(item, query):
                    node = parent_node.add(f"[bold blue]{item.name}/[/]{git_marker}", data=str(item))
                    self._build_filtered_tree(node, item, query, git_status)
                    node.expand()
            else:
                if query in item.name.lower():
                    ext = item.suffix.lower()
                    colors = {".py": "green", ".js": "yellow", ".ts": "blue",
                              ".json": "cyan", ".toml": "cyan", ".md": "dim"}
                    color = colors.get(ext, "dim")
                    parent_node.add_leaf(f"[{color}]{item.name}[/{color}]{git_marker}", data=str(item))

    def _dir_has_match(self, dir_path: Path, query: str) -> bool:
        """Check if directory contains any file matching query."""
        try:
            for item in dir_path.rglob("*"):
                if item.is_file() and query in item.name.lower():
                    if not item.name.startswith(".") or item.name == ".andromity":
                        return True
        except PermissionError:
            pass
        return False

    def _build_tree(self, parent_node: TreeNode, path: Path, git_status: dict | None = None):
        if git_status is None:
            repo = get_repo(path)
            git_status = get_git_status(repo) if repo else {}
        try:
            items = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return
        for item in items:
            if item.name.startswith(".") and item.name != ".andromity":
                continue
            if item.name in ("__pycache__", "node_modules", ".git"):
                continue
            rel_path = str(item.relative_to(Path.cwd()))
            git_marker = ""
            if rel_path in git_status:
                change = git_status[rel_path]
                markers = {"M": "[yellow]M[/]", "A": "[green]A[/]", "D": "[red]D[/]",
                           "R": "[blue]R[/]", "U": "[cyan]?[/]"}
                git_marker = f" {markers.get(change, '')}"
            if item.is_dir():
                node = parent_node.add(f"[bold blue]{item.name}/[/]{git_marker}", data=str(item))
                self._build_tree(node, item, git_status)
            else:
                ext = item.suffix.lower()
                colors = {".py": "green", ".js": "yellow", ".ts": "blue",
                          ".json": "cyan", ".toml": "cyan", ".md": "dim"}
                color = colors.get(ext, "dim")
                parent_node.add_leaf(f"[{color}]{item.name}[/{color}]{git_marker}", data=str(item))

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
            # Ensure parents are expanded
            p = node.parent
            while p:
                p.expand()
                p = p.parent
                
            original_label = node.label
            
            # Textual nodes take strings or Rich Text objects.
            # We can append text.
            from rich.text import Text
            new_label = Text.assemble(original_label, Text(" [Modified]", style="bold yellow"))
            node.set_label(new_label)
            
            def reset_label():
                try:
                    node.set_label(original_label)
                except Exception:
                    pass
            self.set_timer(3.0, reset_label)

    def refresh_tree(self):
        """Full tree rescan — picks up new files, deleted folders, everything."""
        tree = self.query_one("#file-tree", Tree)
        expanded = set()
        def collect_expanded(n):
            if n.is_expanded and n.data:
                expanded.add(str(n.data))
            for child in n.children:
                collect_expanded(child)
        collect_expanded(tree.root)

        tree.clear()
        self._build_tree(tree.root, Path.cwd())

        def restore_expanded(n):
            if str(n.data) in expanded:
                n.expand()
            for child in n.children:
                restore_expanded(child)
        restore_expanded(tree.root)
