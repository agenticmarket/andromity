"""SkillMentionPanel — @skill completion dropdown above the input bar.

While the user types `@...` in the chat input, this panel lists installed
skills matching the token. ↑/↓ move the highlight, Enter/Tab insert
`@name ` at the cursor, Esc dismisses. Same interaction model as the slash
command palette.
"""
import time

from rich.text import Text
from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import OptionList, Static
from textual.widgets.option_list import Option


def mention_query(text: str, cursor) -> str | None:
    """Return the active @token (without the '@') under the cursor, or None.

    None means there is no mention being typed (hide the panel). An empty
    string means the user just typed '@' (show everything).
    """
    try:
        row, col = cursor
    except Exception:
        return None
    lines = text.split("\n")
    if not lines:
        return None
    row = max(0, min(row, len(lines) - 1))
    line = lines[row]
    col = max(0, min(col, len(line)))
    before = line[:col]
    start = before.rfind(" ") + 1
    token = before[start:]
    if not token.startswith("@"):
        return None
    return token[1:].rstrip(",.;:!?)'\"").strip()


class SkillMentionPanel(Widget):
    """Dropdown listing installed skills for @-mention completion."""

    DEFAULT_CSS = """\
SkillMentionPanel {
    display: none;
    height: auto; max-height: 12;
    border-top: solid $accent-darken-2;
    background: $surface-darken-1;
}
SkillMentionPanel.visible { display: block; }
#sm-list {
    height: auto; max-height: 10;
    border: none !important; background: transparent !important;
    padding: 0 1;
}
#sm-list > .option-list--option { padding: 0 1; }
#sm-hint { height: 1; padding: 0 1; color: $text-muted; }
"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._skills: list[tuple[str, str]] = []  # (name, description)
        self._cache_time = 0.0

    def compose(self) -> ComposeResult:
        yield OptionList(id="sm-list")
        yield Static("", id="sm-hint")

    def _load_skills(self) -> list:
        # Reading installed SKILL.md files is cheap, but don't re-scan on every
        # keystroke — cache for a few seconds.
        now = time.time()
        if now - self._cache_time > 3.0:
            self._cache_time = now
            try:
                from andromity.core.skills import SkillsManager
                project = getattr(self.app, "_project_path", ".")
                mgr = SkillsManager(project)
                self._skills = [(s.name, s.description) for s in mgr.installed()]
            except Exception:
                self._skills = []
        return self._skills

    def update_query(self, query: str | None):
        if query is None:
            self.hide()
            return
        skills = self._load_skills()
        q = query.lower().strip()
        matches = [s for s in skills if not q or q in s[0].lower() or q in s[1].lower()]

        ol = self.query_one("#sm-list", OptionList)
        ol.clear_options()
        if not matches:
            ol.add_option(
                Option(
                    Text("[dim]No installed skill matches — use /skills to install[/dim]"),
                    id="sm-none",
                    disabled=True,
                )
            )
            ol.highlighted = None
        else:
            for name, desc in matches:
                ol.add_option(
                    Option(
                        Text.assemble(
                            Text("@", style="bold"),
                            Text(name, style="bold"),
                            Text("  "),
                            Text(desc or "", style="dim"),
                        ),
                        id=name,
                    )
                )
            ol.highlighted = 0
        try:
            self.query_one("#sm-hint", Static).update(
                f"[dim]{len(matches)} skill(s) · ↑↓ select · Enter insert · Esc close[/dim]"
            )
        except Exception:
            pass
        self.add_class("visible")

    def hide(self):
        self.remove_class("visible")

    def is_open(self) -> bool:
        return self.has_class("visible")

    def cursor_move(self, direction: str):
        if not self.is_open():
            return
        ol = self.query_one("#sm-list", OptionList)
        if direction == "up":
            ol.action_cursor_up()
        else:
            ol.action_cursor_down()
        try:
            ol.scroll_to_highlight()
        except Exception:
            pass

    def selected_skill(self) -> str | None:
        if not self.is_open():
            return None
        ol = self.query_one("#sm-list", OptionList)
        opt = ol.highlighted_option
        if opt is not None and opt.id and opt.id != "sm-none":
            return str(opt.id)
        return None
