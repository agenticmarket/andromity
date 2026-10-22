from textual.content import Content
from textual.widgets import RadioButton


class DialogRadioButton(RadioButton):
    def render(self) -> Content:
        return Content.assemble(("✓ " if self.value else "  ", "bold"), self.label)


def dialog_styles(
    panel: str,
    title: str,
    footer: str,
    *,
    primary: tuple[str, ...] = (),
    danger: tuple[str, ...] = (),
    warning: tuple[str, ...] = (),
    toolbar: bool = False,
) -> str:
    styles = f"""
#{panel} {{
    border: solid $surface-lighten-2;
    background: $surface;
    color: $text;
}}
#{title} {{ background: $surface-lighten-1; color: $text; text-style: bold; }}
#{footer} {{
    height: {3 if toolbar else 4};
    padding: {"0 1" if toolbar else "1"};
    background: $surface;
    border-{"bottom" if toolbar else "top"}: solid $surface-lighten-1;
    align: {"left" if toolbar else "right"} middle;
}}
#{footer} Button {{
    height: 1 !important;
    width: auto !important;
    min-width: 8 !important;
    border: none !important;
    background: $surface-lighten-1 !important;
    color: $text !important;
    padding: 0 1 !important;
    margin: 0 0 0 1 !important;
    text-style: none !important;
}}
#{footer} Button:hover, #{footer} Button:focus {{
    background: $surface-lighten-2 !important;
    color: $text !important;
    text-style: bold !important;
}}
#{footer} Button:disabled {{
    background: $surface !important;
    color: $text-disabled !important;
}}
#{panel} Input > .input--placeholder {{ color: $text-muted; }}
#{panel} OptionList > .option-list--option-highlighted {{
    background: $surface-lighten-1; color: $text;
}}
#{panel} OptionList:focus > .option-list--option-highlighted {{
    background: $primary 25%; color: $text; text-style: bold;
}}
#{panel} RadioSet {{
    height: auto; width: 1fr; padding: 0; border: none; background: transparent;
}}
#{panel} RadioButton {{
    width: 1fr; height: 1; padding: 0 1; margin: 0; border: none; background: transparent;
}}
#{panel} RadioSet:focus RadioButton.-selected {{
    background: $primary 25%; color: $text; text-style: bold;
}}
#{panel} ListView > ListItem.-highlight {{ background: $primary 25%; color: $text; }}
#{panel} DataTable > .datatable--header {{
    background: $surface-lighten-1; color: $text; text-style: bold;
}}
#{panel} DataTable > .datatable--cursor {{ background: $primary 25%; color: $text; }}
"""
    for buttons, tone in ((primary, "$accent"), (danger, "$error"), (warning, "$warning")):
        for button in buttons:
            styles += f"""
#{footer} #{button} {{
    background: {tone} !important;
    color: auto 100% !important;
    text-style: bold !important;
}}
#{footer} #{button}:hover, #{footer} #{button}:focus {{
    background: {tone}-lighten-1 !important;
    color: auto 100% !important;
    text-style: bold !important;
}}
#{footer} #{button}:disabled {{
    background: $surface !important;
    color: $text-disabled !important;
    text-style: none !important;
}}
"""
    return styles
