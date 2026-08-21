import re


def escape_textual(text) -> str:
    """Escape `[` so Textual renders it as a literal character.

    ``rich.markup.escape`` (and Textual's own ``escape``) only escape a bracket
    when it is followed by a lowercase letter, ``#``, ``/`` or ``@``. Textual's
    markup tokenizer, however, treats *any* unescaped ``[`` as a tag start, so
    text like ``[NOTE: ... start_line=201, end_line=400 ...]`` (from tool
    output) either raises ``MarkupError: Expected markup value`` or silently
    swallows the wrapped text (e.g. ``[DIR]``).

    This escapes every ``[`` that isn't already escaped, and leaves ``]`` alone
    (a lone ``]`` is literal in Textual markup, and escaping it renders a stray
    backslash).
    """
    text = str(text)
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            # Copy a run of backslashes; a `[` after an ODD run is already escaped.
            j = i
            while j < n and text[j] == "\\":
                j += 1
            count = j - i
            out.append("\\" * count)
            if j < n and text[j] == "[":
                out.append("[" if count % 2 else "\\[")
                i = j + 1
            else:
                i = j
        elif ch == "[":
            out.append("\\[")
            i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _textually_safe(text: str) -> bool:
    """True if Textual parses `text` without erroring or losing visible text.

    Textual's parser is lenient: broken tags like ``[NOTE: ... key=value ...]``
    raise ``MarkupError``, while ``[DIR]`` / ``[foo bar]`` parse fine but the
    wrapped text silently disappears (it becomes a bogus style span). Intentional
    markup (``[bold]...[/]``) uses paired close tags, so only those need
    parse-validation; any other bracket text must survive a full round-trip.
    """
    try:
        from textual.markup import to_content
    except Exception:
        return False
    try:
        if "[/" in text or "[" not in text:
            to_content(text)
            return True
        return to_content(text).plain == text
    except Exception:
        return False


def safe_markup(text: str) -> str:
    '''Pre-validate Textual markup. Falls back to escaped plain text if tags are broken.'''
    # If the text contains obvious HTML tags, escape the whole thing, as it's not valid markup
    # e.g., <button class="theme-toggle">
    if re.search(r'<[a-zA-Z][^>]*>', str(text)):
        return escape_textual(str(text))

    if _textually_safe(str(text)):
        return str(text)
    return escape_textual(str(text))


def safe_update(widget, text: str) -> None:
    '''Safely call widget.update() with markup, falling back to escaped text on MarkupError.'''
    try:
        widget.update(safe_markup(text))
    except Exception:
        try:
            widget.update(escape_textual(str(text)))
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f"safe_update failed for {widget}: {e}")
