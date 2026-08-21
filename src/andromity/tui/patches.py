"""Runtime patches for third-party libraries (e.g. Textual upstream edge cases)."""
import logging

log = logging.getLogger(__name__)

_PATCHED = False


def apply_textual_patches() -> None:
    """Safeguard Textual against known upstream race conditions and edge cases.

    1. Screen._forward_event NoneType.region crash:
       When widgets (e.g. MarkdownParagraph) are unmounted/removed during chat replay,
       session clearing, or undo while mouse events (MouseDown / MouseMove) are dispatched,
       Textual evaluates `container = content_widget.parent` which can be None.
       This raises `AttributeError: 'NoneType' object has no attribute 'region'`.
    """
    global _PATCHED
    if _PATCHED:
        return
    _PATCHED = True

    try:
        import textual.screen
        _orig_forward_event = textual.screen.Screen._forward_event

        def _safe_forward_event(self, event):
            try:
                _orig_forward_event(self, event)
            except AttributeError as e:
                # Catch Textual's unmounted widget container.region.offset bug
                if "region" in str(e) and "NoneType" in str(e):
                    return
                raise
            except Exception as e:
                log.debug("Handled transient mouse forwarding error: %s", e)

        textual.screen.Screen._forward_event = _safe_forward_event
    except Exception as err:
        log.warning("Failed to apply Textual screen forward_event patch: %s", err)
