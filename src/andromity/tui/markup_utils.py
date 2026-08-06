from rich.markup import escape

def safe_markup(text: str) -> str:
    '''Pre-validate Rich/Textual markup. Falls back to plain escaped text if tags are broken.'''
    try:
        from textual.content import Content
        Content.from_markup(str(text))
        return str(text)
    except Exception:
        return escape(str(text))

def safe_update(widget, text: str) -> None:
    '''Safely call widget.update() with markup, falling back to escaped text on MarkupError.'''
    try:
        widget.update(safe_markup(text))
    except Exception:
        try:
            widget.update(escape(str(text)))
        except Exception:
            pass
