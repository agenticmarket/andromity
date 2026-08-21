"""Skills Screen — browse open-source skill registries and one-click install.

Separate from the settings screen on purpose: settings.py stays lean and
skills get their own full-screen manager with a Browse tab (searchable
registry, single-click install) and an Installed tab (uninstall, two-step
confirm). Keyboard: ↑/↓ move · Enter install/uninstall · R refresh ·
/ search · Esc close/back.
"""
import asyncio

from textual import events, on
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static, Button, Input, Checkbox

from andromity.core.skills import REGISTRY_SOURCES, RemoteSkill, SkillsManager
from andromity.tui.markup_utils import escape_textual as escape


class TickCheckbox(Checkbox):
    BUTTON_INNER = "✓"


class SkillsScreen(ModalScreen):
    """Full-screen modal for installing and managing skills."""

    DEFAULT_CSS = """\
SkillsScreen {
    align: center middle;
    background: $background 20%;
}
#sk-dialog {
    width: 94%; height: 92%;
    border: solid $accent-darken-2; background: $surface;
}
#sk-title-bar { height: 1; background: $accent-darken-2; }
#sk-title { width: 1fr; height: 1; padding: 0 1; color: $text; text-style: bold; }
#sk-title-count { height: 1; padding: 0 1; color: $text-muted; }
#sk-tabs { height: 3; padding: 0 1; align: left middle; }
#sk-tabs Button {
    height: 3; padding: 0 2; margin: 0 1 0 0;
    border: none; border-bottom: tall $surface-darken-3;
    background: transparent; color: $text-muted;
}
#sk-tabs Button:hover { color: $text; }
#sk-tabs Button.active { color: $text; text-style: bold; border-bottom: tall $accent; }
#sk-hint { width: 1fr; height: 1; color: $text-muted; content-align: right middle; }
.hidden { display: none; }
#sk-tab-browse, #sk-tab-installed { height: 1fr; }
#sk-search { margin: 1 1 0 1; }
#sk-status { height: 1; margin: 0 1; color: $text-muted; }
#sk-scope-project {
    height: 1;
    margin: 0 1;
    border: none;
    background: transparent;
    padding: 0;
}
#sk-scope-project:focus {
    border: none;
    background: transparent;
}
#sk-scope-project > .toggle--button {
    background: transparent;
    color: $text-muted;
}
#sk-scope-project.-on > .toggle--button {
    color: $success;
    text-style: bold;
}
#sk-scope-project > .toggle--label { color: $text-muted; }
#sk-scope-project.-on > .toggle--label { color: $text; }
#sk-browse-list { height: 1fr; overflow-y: auto; padding: 1; }
#sk-installed-list { height: 1fr; overflow-y: auto; padding: 1; }
.sk-row { padding: 1; border-left: tall $surface-darken-3; border-bottom: solid $accent-darken-3; }
.sk-row:hover { background: $surface-lighten-1; }
.sk-row.installed { border-left: tall $success; }
.sk-row.selected { background: $accent-darken-2; border-left: tall $primary; }
#sk-footer { dock: bottom; height: 1; padding: 0 1; background: $surface-darken-1; }
#sk-footer Button {
    height: 1 !important; width: auto !important; min-width: 0 !important;
    border: none !important; background: transparent !important;
    color: $text-muted !important; text-style: none !important;
    padding: 0 1 !important; margin: 0 !important;
}
#sk-footer Button:hover { color: $text !important; }
#sk-footer Button:focus { color: $text !important; text-style: bold; }
#sk-footer Button:disabled { color: $surface-darken-3 !important; }
#sk-footer #sk-install:hover { color: $success !important; }
#sk-footer #sk-uninstall:hover { color: $error !important; }
#sk-footer #sk-refresh:hover { color: $accent !important; }
"""

    def __init__(self, project_path: str, **kwargs):
        super().__init__(**kwargs)
        self._project_path = project_path
        self._manager = SkillsManager(project_path)
        self._browse = []
        self._browse_map: dict[str, RemoteSkill] = {}
        self._descriptions: dict[str, str] = {}  # lazy-loaded on selection
        self._desc_loading: set = set()
        self._browse_ids: list[str] = []
        self._installed_ids: list[str] = []
        self._selected_key: str | None = None
        self._pending_uninstall: str | None = None
        self._filter = ""
        self._scope = "user"  # "user" (all projects) | "project" (this repo)
        self._active_tab = "browse"  # "browse" | "installed"
        self._busy = False

    # ── Compose ────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        with Vertical(id="sk-dialog"):
            with Horizontal(id="sk-title-bar"):
                yield Static("🛠 Skills", id="sk-title")
                yield Static("", id="sk-title-count")
            with Horizontal(id="sk-tabs"):
                yield Button("Browse", id="tab-browse", classes="active")
                yield Button("Installed", id="tab-installed")
                yield Static("", id="sk-hint")
            with Vertical(id="sk-tab-browse"):
                yield Input(placeholder="Filter skills…", id="sk-search")
                yield TickCheckbox("Install for this project only", id="sk-scope-project", compact=True)
                yield Static("", id="sk-status")
                yield VerticalScroll(id="sk-browse-list")
            with Vertical(id="sk-tab-installed", classes="hidden"):
                yield VerticalScroll(id="sk-installed-list")
            with Horizontal(id="sk-footer"):
                yield Button("Close", id="sk-close")
                yield Button("⬇ Install", id="sk-install", disabled=True)
                yield Button("⬆ Uninstall", id="sk-uninstall", disabled=True)
                yield Button("↺ Refresh", id="sk-refresh")

    def on_mount(self):
        for tid in ("#tab-browse", "#tab-installed"):
            try:
                self.query_one(tid).can_focus = False
            except Exception:
                pass
        self._render_installed()
        self._update_title()
        self._update_hint()
        # Keyboard-first: blur after the screen's own auto-focus pass so ↑/↓ work.
        self.call_after_refresh(self._enter_keyboard_mode)
        self.run_worker(self._browse_worker(), group="skills")

    def on_unmount(self):
        """Cancel in-flight network workers when the modal is closed (e.g. Esc).
        A worker must never touch the DOM after the screen is gone."""
        try:
            self._workers.cancel_group(self, group="skills")
        except Exception:
            pass

    def _enter_keyboard_mode(self):
        try:
            self.set_focus(None)
        except Exception:
            pass

    # ── Small helpers ──────────────────────────────────────────────────────

    def _set_status(self, text: str):
        try:
            self.query_one("#sk-status", Static).update(text)
        except Exception:
            pass

    def _update_title(self):
        try:
            n = len(self._manager.installed())
            self.query_one("#sk-title-count", Static).update(
                f"{n} installed" + (f" · {len(self._browse)} available" if self._browse else "")
            )
        except Exception:
            pass

    def _update_hint(self):
        try:
            hint = self.query_one("#sk-hint", Static)
            if self._active_tab == "installed":
                hint.update("↑/↓ move · Enter uninstall (×2) · R refresh · Esc back")
            else:
                hint.update("↑/↓ move · Enter install · R refresh · / search · Esc close")
        except Exception:
            pass

    def _sync_buttons(self):
        try:
            has_sel = self._selected_key is not None
            self.query_one("#sk-install", Button).disabled = (
                self._active_tab != "browse" or not has_sel or self._busy
            )
            self.query_one("#sk-uninstall", Button).disabled = (
                self._active_tab != "installed" or not has_sel or self._busy
            )
            scope_label = "this project" if self._scope == "project" else "all projects"
            self.query_one("#sk-install", Button).label = f"⬇ Install ({scope_label})"
            self._reset_uninstall_label()
        except Exception:
            pass

    def _reset_uninstall_label(self):
        try:
            self.query_one("#sk-uninstall", Button).label = "⬆ Uninstall"
        except Exception:
            pass

    def _reset_pending(self):
        self._pending_uninstall = None
        self._reset_uninstall_label()

    # ── Tab switching ──────────────────────────────────────────────────────

    def _switch_tab(self, tab: str):
        self._active_tab = tab
        self.query_one("#sk-tab-browse").set_class(tab != "browse", "hidden")
        self.query_one("#sk-tab-installed").set_class(tab != "installed", "hidden")
        self.query_one("#tab-browse").set_class(tab == "browse", "active")
        self.query_one("#tab-installed").set_class(tab == "installed", "active")
        self._selected_key = None
        self._reset_pending()
        self._update_hint()
        self._sync_buttons()
        self._enter_keyboard_mode()

    # ── Rendering ──────────────────────────────────────────────────────────

    def _row_content(self, remote: RemoteSkill, key: str, is_installed: bool) -> str:
        tag = "[green]✓ installed[/]" if is_installed else f"[dim]{escape(remote.source_id)}[/]"
        lines = [f"[bold]{escape(remote.name)}[/]  {tag}"]
        desc = self._descriptions.get(key, "")
        if desc:
            lines.append(f"[dim]{escape(desc[:80])}{'…' if len(desc) > 80 else ''}[/]")
        return "\n".join(lines)

    def _render_browse(self):
        scroll = self.query_one("#sk-browse-list", VerticalScroll)
        scroll.remove_children()
        q = self._filter.lower()
        installed = self._manager.installed_names()
        self._browse_ids = []
        for r in self._browse:
            if q and q not in r.name.lower() and q not in self._descriptions.get(f"{r.source_id}::{r.name}", "").lower():
                continue
            key = f"{r.source_id}::{r.name}"
            self._browse_ids.append(key)
            is_installed = r.name in installed
            classes = "sk-row"
            if is_installed:
                classes += " installed"
            if key == self._selected_key:
                classes += " selected"
            scroll.mount(Static(self._row_content(r, key, is_installed), classes=classes, name=key))

    def _render_installed(self):
        scroll = self.query_one("#sk-installed-list", VerticalScroll)
        scroll.remove_children()
        skills = self._manager.installed()
        self._installed_ids = [s.name for s in skills]
        if not skills:
            scroll.mount(Static("[dim]  No skills installed — browse the registry to add some.[/]"))
            return
        for s in skills:
            scope_tag = "[green]all projects[/]" if s.scope == "user" else "[cyan]this project[/]"
            classes = "sk-row" + (" selected" if s.name == self._selected_key else "")
            scroll.mount(
                Static(
                    f"[bold]{escape(s.name)}[/]  [dim]({scope_tag})[/]\n[dim]{escape(s.description or '—')}[/]",
                    classes=classes,
                    name=s.name,
                )
            )

    def _select_row(self, key: str):
        self._selected_key = key
        for row in self.query(".sk-row"):
            if row.name == key:
                row.add_class("selected")
                try:
                    row.scroll_visible()
                except Exception:
                    pass
            else:
                row.remove_class("selected")
        self._reset_pending()
        self._sync_buttons()
        # Lazy-load this skill's description (one request, only when selected).
        if self._active_tab == "browse" and key not in self._descriptions and key not in self._desc_loading:
            self.run_worker(self._fetch_desc_worker(key), group="skills")

    def _move_selection(self, delta: int):
        ids = self._browse_ids if self._active_tab == "browse" else self._installed_ids
        if not ids:
            return
        if self._selected_key not in ids:
            self._select_row(ids[0] if delta > 0 else ids[-1])
            return
        idx = ids.index(self._selected_key)
        new_idx = max(0, min(len(ids) - 1, idx + delta))
        if new_idx != idx:
            self._select_row(ids[new_idx])

    # ── Workers (network off the UI thread) ────────────────────────────────

    async def _browse_worker(self):
        self._set_status("Fetching skills…")
        try:
            result = await asyncio.to_thread(self._manager.browse)
            self._browse = result
            self._browse_map = {f"{r.source_id}::{r.name}": r for r in result}
            self._render_browse()
            labels = ", ".join(s["label"] for s in REGISTRY_SOURCES)
            caps = [s["max_skills"] for s in REGISTRY_SOURCES if s.get("max_skills")]
            capped = " — showing top " + ", ".join(str(c) for c in caps) + " per source, type to search for more" if caps else ""
            self._set_status(f"{len(result)} skills available{capped} — {labels}")
        except Exception as e:
            self._set_status(
                f"[red]Couldn't reach the registries ({type(e).__name__}) — "
                "check your network, then press ↺ Refresh.[/]"
            )
        finally:
            if not self.is_attached:
                return
            self._update_title()
            self._sync_buttons()

    async def _fetch_desc_worker(self, key: str):
        remote = self._browse_map.get(key)
        if remote is None:
            return
        self._desc_loading.add(key)
        try:
            desc = await asyncio.to_thread(self._manager.fetch_description, remote)
        except Exception:
            desc = ""
        finally:
            self._desc_loading.discard(key)
        if not self.is_attached or not desc:
            return
        self._descriptions[key] = desc
        # Update the row in place so selection/scroll positions are preserved.
        try:
            installed = self._manager.installed_names()
            for row in self.query(".sk-row"):
                if row.name == key:
                    row.update(self._row_content(remote, key, remote.name in installed))
                    break
        except Exception:
            pass

    async def _install_worker(self, source_id: str, name: str, scope: str = "user"):
        try:
            info = await asyncio.to_thread(self._manager.install, name, source_id, scope)
            if info:
                scope_label = "this project" if scope == "project" else "all projects"
                self.notify(f"✓ Installed skill '{name}' for {scope_label}.", timeout=4)
            else:
                self.notify(f"Could not find '{name}' in the registry.", severity="error", timeout=4)
        except Exception as e:
            self.notify(f"Install failed: {e}", severity="error", timeout=5)
        finally:
            if not self.is_attached:
                return
            self._busy = False
            self._render_installed()
            self._render_browse()
            self._update_title()
            self._sync_buttons()
            self._set_status("")

    async def _uninstall_worker(self, name: str):
        try:
            await asyncio.to_thread(self._manager.uninstall, name)
            self.notify(f"Removed skill '{name}'.", timeout=4)
        except Exception as e:
            self.notify(f"Uninstall failed: {e}", severity="error", timeout=5)
        finally:
            if not self.is_attached:
                return
            self._reset_pending()
            self._render_installed()
            self._render_browse()
            self._update_title()
            self._sync_buttons()

    # ── Actions ────────────────────────────────────────────────────────────

    def _install_selected(self):
        if self._active_tab != "browse" or not self._selected_key or self._busy:
            return
        source_id, name = self._selected_key.split("::", 1)
        if name in self._manager.installed_names():
            self.notify(f"'{name}' is already installed.", timeout=3)
            return
        self._busy = True
        self._sync_buttons()
        scope = "project" if self._scope == "project" else "user"
        self._set_status(f"Installing '{name}'…")
        self.run_worker(self._install_worker(source_id, name, scope), group="skills")

    def _uninstall_selected(self):
        if self._active_tab != "installed" or not self._selected_key or self._busy:
            return
        if self._pending_uninstall != self._selected_key:
            self._pending_uninstall = self._selected_key
            self.query_one("#sk-uninstall", Button).label = "⚠ Confirm"
            self.notify("Press again to confirm uninstall.", severity="warning", timeout=4)
            return
        name = self._selected_key
        self._busy = True
        self._sync_buttons()
        self.run_worker(self._uninstall_worker(name), group="skills")

    def _focus_search(self):
        try:
            self.query_one("#sk-search", Input).focus()
        except Exception:
            pass

    # ── Events ─────────────────────────────────────────────────────────────

    @on(events.Click, ".sk-row")
    def on_row_click(self, event: events.Click):
        widget = event.widget
        if not widget or not widget.name:
            return
        self._select_row(widget.name)
        self._enter_keyboard_mode()

    @on(Input.Changed, "#sk-search")
    def on_search_changed(self, event: Input.Changed):
        self._filter = event.value.strip().lower()
        if self._selected_key not in self._browse_ids:
            self._selected_key = None
        self._render_browse()
        self._sync_buttons()

    @on(Checkbox.Changed, "#sk-scope-project")
    def on_scope_changed(self, event: Checkbox.Changed):
        self._scope = "project" if event.value else "user"
        self._sync_buttons()

    def on_button_pressed(self, event: Button.Pressed):
        btn_id = event.button.id
        if btn_id == "sk-close":
            self.dismiss()
        elif btn_id == "tab-browse":
            self._switch_tab("browse")
        elif btn_id == "tab-installed":
            self._switch_tab("installed")
        elif btn_id == "sk-install":
            self._install_selected()
        elif btn_id == "sk-uninstall":
            self._uninstall_selected()
        elif btn_id == "sk-refresh":
            self._reset_pending()
            self.run_worker(self._browse_worker(), group="skills")

    def on_key(self, event):
        key = event.key
        focused = self.focused
        typing = isinstance(focused, Input)

        if key == "escape":
            # Consume the key so it never reaches the app's global escape
            # binding (which cancels the streaming AI response on 2 presses).
            event.stop()
            if self._pending_uninstall:
                self._reset_pending()
            elif self._active_tab == "installed":
                self._switch_tab("browse")
            else:
                self.dismiss()
            return

        if key in ("up", "down"):
            self._move_selection(-1 if key == "up" else 1)
            return

        if typing:
            return

        if key in ("home", "end"):
            ids = self._browse_ids if self._active_tab == "browse" else self._installed_ids
            if ids:
                self._select_row(ids[0] if key == "home" else ids[-1])
            return

        if key in ("j", "k"):
            self._move_selection(-1 if key == "k" else 1)
        elif key == "enter":
            if self._active_tab == "browse":
                self._install_selected()
            else:
                self._uninstall_selected()
        elif key == "r":
            self._reset_pending()
            self.run_worker(self._browse_worker(), group="skills")
        elif key == "slash":
            self._focus_search()
