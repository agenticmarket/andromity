from pathlib import Path
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Tree
from textual.widgets.tree import TreeNode
from andromity.core.git_ops import get_repo, get_git_status


class FileTreePanel(VerticalScroll):
    def compose(self) -> ComposeResult:
        tree = Tree("[bold]Files[/]", id="file-tree")
        tree.root.expand()
        self._build_tree(tree.root, Path.cwd())
        yield tree

    def _build_tree(self, parent_node: TreeNode, path: Path):
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
                self._build_tree(node, item)
            else:
                ext = item.suffix.lower()
                icons = {".py": "[green].py[/]", ".js": "[yellow].js[/]", ".ts": "[blue].ts[/]",
                         ".json": "[cyan].json[/]", ".toml": "[cyan].toml[/]", ".md": "[dim].md[/]"}
                icon = icons.get(ext, f"[dim]{ext or '?'}[/]")
                parent_node.add(f"{icon} {item.name}{git_marker}", data=str(item))

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
            # Rebuild tree to pick up new files
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
