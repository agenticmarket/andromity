from rich.markup import escape

def safe_markup(text: str) -> str:
    '''Pre-validate Rich/Textual markup. Falls back to plain escaped text if tags are broken.'''
    import re
    # If the text contains obvious HTML tags, escape the whole thing, as it's not valid Rich markup
    # e.g., <button class="theme-toggle">
    if re.search(r'<[a-zA-Z][^>]*>', str(text)):
        return escape(str(text))
        
    try:
        from rich.text import Text
        Text.from_markup(str(text))
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
