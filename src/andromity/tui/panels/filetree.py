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
