import json
import re
from typing import Any, Dict, List, Optional, Tuple

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widget import Widget
from textual.widgets import Button, Checkbox, Input, RadioButton, RadioSet, Static

from andromity.tui.markup_utils import escape_textual as escape


def extract_options_from_text(text: str) -> Tuple[str, List[str]]:
    """Extract embedded choices from a question string if present.
    Supports formats like:
      - "Question? (A) Option 1 (B) Option 2 (C) Option 3"
      - "Question? [A] Option 1 [B] Option 2"
      - "Question?\\nA) Option 1\\nB) Option 2"
      - "Question?\\n1. Option 1\\n2. Option 2"
      - "Question?\\n- Option 1\\n- Option 2"
    """
    text = text.strip()
    if not text:
        return "", []

    # Pattern 1: Inline (A) Option A (B) Option B ... or [A] Option A [B] Option B ...
    inline_matches = list(re.finditer(
        r'[\(\[]\s*([A-Za-z0-9]+)\s*[\)\]]\s*([^\(\[\n\r]+?)(?=\s*[\(\[][A-Za-z0-9]+[\)\]]|\s*$)',
        text
    ))
    if len(inline_matches) >= 2:
        prompt = text[:inline_matches[0].start()].strip()
        opts = [f"({m.group(1).strip()}) {m.group(2).strip()}" for m in inline_matches if m.group(2).strip()]
        if len(opts) >= 2:
            return prompt.rstrip(":").strip() or text, opts

    # Pattern 2: Multiline with A) / A. / 1) / 1. / - / * list items
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) >= 3:
        opt_lines = []
        prompt_lines = []
        for line in lines:
            m = re.match(r'^(?:(?:\(?([A-Za-z0-9]+)\)|([A-Za-z0-9]+)[\.\)])|[-*•])\s*(.+)$', line)
            if m:
                label = m.group(1) or m.group(2)
                content = m.group(3).strip()
                if label:
                    opt_lines.append(f"({label}) {content}")
                else:
                    opt_lines.append(content)
            else:
                if not opt_lines:
                    prompt_lines.append(line)
        if len(opt_lines) >= 2:
            prompt = " ".join(prompt_lines).rstrip(":").strip()
            return prompt or text, opt_lines

    # Pattern 3: Inline A) Foo B) Bar C) Baz
    letter_matches = list(re.finditer(
        r'(?:^|\s+)([A-Da-d0-9])[\.\)]\s+([^\n\r]+?)(?=\s+[A-Da-d0-9][\.\)]|\s*$)',
        text
    ))
    if len(letter_matches) >= 2:
        prompt = text[:letter_matches[0].start()].strip()
        opts = [f"({m.group(1).strip()}) {m.group(2).strip()}" for m in letter_matches if m.group(2).strip()]
        if len(opts) >= 2:
            return prompt.rstrip(":").strip() or text, opts

    return text, []


def normalize_questions(raw: Any) -> List[Dict[str, Any]]:
    """Normalize any shape of raw questions from LLM tool call into a uniform list of dicts:
    [
        {"question": str, "type": "single"|"multi"|"text", "options": list[str]}
    ]
    """
    if not raw:
        return []

    # If raw is a string, check if it's JSON or a single question
    if isinstance(raw, str):
        raw_str = raw.strip()
        if (raw_str.startswith("[") and raw_str.endswith("]")) or (raw_str.startswith("{") and raw_str.endswith("}")):
            try:
                raw = json.loads(raw_str)
            except Exception:
                pass

    # If raw is a dict with "questions" or "question" key
    if isinstance(raw, dict):
        if "questions" in raw and isinstance(raw["questions"], (list, tuple, str, dict)):
            raw = raw["questions"]
        elif "question" in raw and isinstance(raw["question"], (list, tuple)):
            raw = raw["question"]
        else:
            raw = [raw]

    if not isinstance(raw, (list, tuple)):
        raw = [raw]

    normalized: List[Dict[str, Any]] = []
    for i, item in enumerate(raw):
        if item is None:
            continue
        if isinstance(item, str):
            prompt, opts = extract_options_from_text(item)
            qtype = "single" if len(opts) >= 2 else "text"
            normalized.append({
                "question": prompt or item,
                "type": qtype,
                "options": opts,
            })
        elif isinstance(item, dict):
            qtext = (
                item.get("question")
                or item.get("text")
                or item.get("title")
                or item.get("prompt")
                or item.get("query")
                or f"Question {i + 1}"
            )
            if not isinstance(qtext, str):
                qtext = str(qtext)

            raw_opts = (
                item.get("options")
                or item.get("choices")
                or item.get("items")
                or []
            )
            opts: List[str] = []
            if isinstance(raw_opts, str):
                if "\n" in raw_opts:
                    opts = [o.strip() for o in raw_opts.split("\n") if o.strip()]
                elif "," in raw_opts:
                    opts = [o.strip() for o in raw_opts.split(",") if o.strip()]
                else:
                    opts = [raw_opts.strip()] if raw_opts.strip() else []
            elif isinstance(raw_opts, (list, tuple)):
                for opt in raw_opts:
                    if isinstance(opt, dict):
                        opt_str = opt.get("label") or opt.get("value") or opt.get("text") or str(opt)
                        opts.append(str(opt_str).strip())
                    elif opt is not None:
                        opts.append(str(opt).strip())

            # If no options in dict, check if embedded in question text
            if not opts:
                extracted_prompt, extracted_opts = extract_options_from_text(qtext)
                if len(extracted_opts) >= 2:
                    qtext = extracted_prompt
                    opts = extracted_opts

            is_multi = bool(
                item.get("is_multi_select")
                or item.get("multi_select")
                or item.get("isMultiSelect")
                or str(item.get("type", "")).lower() in ("multi", "checkbox", "multiple", "multi-select", "multiselect")
            )
            explicit_type = str(item.get("type", "")).lower()
            if is_multi:
                qtype = "multi"
            elif explicit_type in ("text", "string", "input", "free_form", "prompt"):
                qtype = "text"
            elif explicit_type in ("single", "radio", "select", "choice"):
                qtype = "single"
            elif len(opts) >= 2:
                qtype = "single"
            elif not opts:
                qtype = "text"
            else:
                qtype = "single"

            normalized.append({
                "question": qtext,
                "type": qtype,
                "options": opts,
            })
        else:
            normalized.append({
                "question": str(item),
                "type": "text",
                "options": [],
            })

    return normalized


def format_question_answers(questions: Any, answers: Optional[dict]) -> str:
    """Turn the panel's answers into the tool result text the model sees."""
    if not answers:
        return "The user did not answer the questions. Proceed with reasonable assumptions."
    if not isinstance(questions, list):
        questions = normalize_questions(questions)
    lines = []
    for i, q in enumerate(questions):
        a = answers.get(str(i), answers.get(i))
        if a in (None, "", []):
            continue
        if isinstance(a, (list, tuple)):
            a = ", ".join(str(x) for x in a)
        qtext = q.get("question", f"Question {i + 1}") if isinstance(q, dict) else str(q)
        lines.append(f"{i + 1}. {qtext}: {a}")
    if not lines:
        return "The user did not answer the questions. Proceed with reasonable assumptions."
    return "User answers:\n" + "\n".join(lines)


class TickCheckbox(Checkbox):
    BUTTON_INNER = "✓"


class QuestionPanel(Widget):
    """Inline question panel; submits with a {index: answer} dict via callback."""

    BINDINGS = [
        Binding("enter", "submit", "Submit", priority=True),
        Binding("escape", "skip", "Skip", priority=True),
    ]

    DEFAULT_CSS = """\
QuestionPanel {
    display: none;
    height: 24;
    border-top: solid $accent-darken-2;
    background: $surface-darken-1;
    padding: 0 1 0 1;
    layout: vertical;
}
QuestionPanel.visible { display: block; }
#qp-title {
    height: 1;
    padding: 0;
    text-style: bold;
    color: $text;
    dock: top;
}
#qp-body {
    height: 1fr;
    overflow-y: auto;
    scrollbar-gutter: stable;
}
#qp-body .qp-label {
    height: auto;
    margin: 1 0 0 0;
    color: $text;
}
#qp-body RadioSet    { height: auto; margin: 0 0 0 1; padding: 0; border: none; }
#qp-body RadioButton { height: 1; padding: 0; margin: 0; border: none; background: transparent; }
#qp-body Vertical    { height: auto; margin: 0 0 0 1; padding: 0; border: none; }
#qp-body Checkbox    { height: 1; margin: 0; padding: 0; border: none; background: transparent; }
#qp-body Checkbox:focus { background: $accent-darken-3; }
#qp-body Input {
    height: 1;
    margin: 0 0 0 1;
    border: none;
    background: $surface-darken-2;
}
#qp-footer {
    height: 3;
    dock: bottom;
    padding: 1 1 0 1;
    background: $surface-darken-2;
    border-top: solid $accent-darken-2;
    align: right middle;
}
#qp-footer Button {
    height: 1;
    min-width: 16;
    margin: 0 1;
    padding: 0 2;
    border: none;
}
#qp-footer #qp-submit {
    background: $success;
    color: $background;
    text-style: bold;
}
#qp-footer #qp-submit:hover, #qp-footer #qp-submit:focus {
    background: $success-lighten-1;
    color: $background;
}
#qp-footer #qp-skip {
    background: $surface;
    color: $text-muted;
}
#qp-footer #qp-skip:hover, #qp-footer #qp-skip:focus {
    background: $error;
    color: $text;
}
"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._questions: list = []
        self._on_done: Any = None

    def compose(self) -> ComposeResult:
        yield Static("", id="qp-title")
        yield VerticalScroll(id="qp-body")
        with Horizontal(id="qp-footer"):
            yield Button("Skip (Esc)", id="qp-skip")
            yield Button("Submit (Ctrl+Enter)", id="qp-submit")

    async def ask(self, questions: Any, on_done) -> None:
        """Fill the panel with questions and show it. `on_done(answers|None)`
        is called when the user submits (dict) or skips (None)."""
        norm_questions = normalize_questions(questions)
        self._questions = norm_questions
        self._on_done = on_done
        body = self.query_one("#qp-body", VerticalScroll)
        await body.remove_children()
        n = len(norm_questions)
        self.query_one("#qp-title", Static).update(
            f" ❓ [bold]Andromity needs {n} answer(s)[/]"
            f" [dim]Tab=next · Ctrl+Enter=submit · Esc=skip[/]"
        )
        widgets_to_mount = []
        for i, q in enumerate(norm_questions):
            qtext = q.get("question", f"Question {i + 1}")
            qtype = q.get("type", "single")
            options = q.get("options") or []
            widgets_to_mount.append(Static(f"[bold]{i + 1}. {escape(qtext)}[/]", classes="qp-label"))
            if qtype == "multi" and options:
                cbs = [TickCheckbox(escape(opt), compact=True) for opt in options]
                widgets_to_mount.append(Vertical(*cbs, id=f"qp-q-{i}"))
            elif options:  # single with choices → RadioSet
                rbs = [RadioButton(escape(opt), compact=True) for opt in options]
                widgets_to_mount.append(RadioSet(*rbs, id=f"qp-q-{i}"))
            else:  # text or single without options → free-text Input
                placeholder = "Type your answer… (Ctrl+Enter to submit)"
                widgets_to_mount.append(Input(placeholder=placeholder, id=f"qp-q-{i}"))
        await body.mount_all(widgets_to_mount)
        self.add_class("visible")
        # Focus the first interactive widget so keyboard works immediately
        try:
            for child in body.walk_children():
                if isinstance(child, (RadioButton, Checkbox, Input)):
                    child.focus()
                    break
        except Exception:
            pass

    def hide_questions(self):
        self.remove_class("visible")
        self._on_done = None
        try:
            self.app.focus_input()
        except Exception:
            pass

    def is_open(self) -> bool:
        return self.has_class("visible")

    def action_submit(self):
        if not self.is_open():
            return
        answers: Dict[str, Any] = {}
        for i in range(len(self._questions)):
            wid = f"qp-q-{i}"
            # Detect the actual rendered widget — don't trust qtype alone since
            # single+no-options renders as Input, not RadioSet.
            try:
                rs = self.query_one(f"#{wid}", RadioSet)
                # It's a single-choice RadioSet — collect and move on
                btn = rs.pressed_button
                if btn is None:
                    sel = getattr(rs, "_selected", None)
                    buttons = list(rs.query(RadioButton))
                    if sel is not None and 0 <= sel < len(buttons):
                        btn = buttons[sel]
                    elif buttons:
                        btn = buttons[0]
                if btn is not None:
                    val = getattr(btn.label, "plain", None) or str(btn.label or "")
                    if val:
                        answers[i] = val
                continue  # RadioSet found → done with this question
            except Exception:
                pass  # no RadioSet → try Checkbox or Input

            # Check for multi-select (Vertical container with TickCheckbox/Checkbox).
            # IMPORTANT: query() never raises, so only `continue` if the container
            # actually exists (i.e., at least one Checkbox child was found in the DOM).
            all_checkboxes = list(self.query(f"#{wid} Checkbox"))
            if all_checkboxes:
                checked = [
                    (getattr(cb.label, "plain", None) or str(cb.label or ""))
                    for cb in all_checkboxes if cb.value
                ]
                if checked:
                    answers[i] = checked
                continue  # Checkbox container found → done with this question

            # Fall back to free-text Input
            try:
                inp = self.query_one(f"#{wid}", Input)
                v = inp.value.strip()
                if v:
                    answers[i] = v
            except Exception:
                pass
        done = self._on_done
        self.hide_questions()
        if done:
            done(answers if answers else None)

    def action_skip(self):
        if not self.is_open():
            return
        done = self._on_done
        self.hide_questions()
        if done:
            done(None)

    def on_button_pressed(self, event: Button.Pressed):
        if event.button.id == "qp-submit":
            self.action_submit()
        elif event.button.id == "qp-skip":
            self.action_skip()

    def on_key(self, event) -> None:
        """Ctrl+Enter submits the whole form; plain Enter moves to the next field."""
        if event.key == "ctrl+j" or (event.key == "enter" and event.control):  # Ctrl+Enter
            event.stop()
            self.action_submit()

    @on(Input.Submitted)
    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Tab to next Input/RadioSet instead of submitting on Enter."""
        event.stop()
        # Find the next focusable widget in the body after this input
        body = self.query_one("#qp-body", VerticalScroll)
        focusable = [w for w in body.walk_children()
                     if isinstance(w, (Input, RadioButton, Checkbox))]
        try:
            idx = focusable.index(event.input)
            if idx + 1 < len(focusable):
                focusable[idx + 1].focus()
                return
        except (ValueError, AttributeError):
            pass
        # Already on last field — submit
        self.action_submit()

