"""Helpers for pasting images into the chat.

Pillow is imported lazily inside the functions so the app starts fine even
before it is installed — the paste action simply degrades with a friendly
notification instead of crashing at import time.
"""
import base64
import io
import os
import shutil
import subprocess
from typing import Any, Optional

# Product limit: how many images one message may carry.
MAX_IMAGES = 5

# Providers reject very large images; downscale before encoding.
MAX_DIMENSION = 2048
JPEG_QUALITY = 88

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".ico"}


def load_image_file(path) -> "object":
    """Open an image file (validating it's actually an image) and return a
    detached Pillow Image. Raises on non-image or unreadable files."""
    from PIL import Image
    with Image.open(str(path)) as img:
        return img.copy()


def extract_image_path(text: str) -> Optional[str]:
    """If `text` is a single pasted image file path, return that path.

    Windows Terminal pastes a copied file as a quoted path, e.g.
    ``"C:\\Users\\me\\shot.png"`` — detect that so a Ctrl+V that the
    terminal swallowed as a text paste can still attach the image.
    Returns None for anything that isn't a clean image path.
    """
    t = str(text).strip()
    if not t:
        return None
    # Accept exactly one path: bare, or wrapped in a single pair of quotes.
    if t.startswith('"') and t.endswith('"') and len(t) > 2:
        if t.count('"') == 2:
            t = t[1:-1]
        else:
            return None  # multiple quoted paths (multi-file paste)
    if not t:
        return None
    # Require a path-like token, not prose.
    if not (os.path.isabs(t) or os.sep in t or "/" in t):
        return None
    if os.path.splitext(t)[1].lower() not in IMAGE_EXTENSIONS:
        return None
    return t if os.path.isfile(t) else None


def paste_image_from_clipboard() -> Optional["object"]:
    """Return a Pillow Image from the OS clipboard, or None if there is none.

    Works on Windows/macOS via Pillow's ImageGrab. On Linux, tries xclip
    (X11) and wl-paste (Wayland) when ImageGrab can't see an image.
    """
    try:
        from PIL import Image, ImageGrab

        grabbed = ImageGrab.grabclipboard()
        if isinstance(grabbed, Image.Image):
            return grabbed
        if grabbed:
            # Windows "Copy file(s)" puts a filename list on the clipboard.
            path = grabbed[0] if isinstance(grabbed, list) else grabbed
            if isinstance(path, (str, os.PathLike)) and os.path.isfile(str(path)):
                try:
                    with Image.open(str(path)) as img:
                        return img.copy()
                except Exception:
                    return None
        # Linux: ImageGrab may need xclip itself, but be explicit so the
        # Wayland path works even when xclip is missing.
        return _grab_linux_image()
    except Exception:
        return _grab_linux_image()


def _grab_linux_image() -> Optional["object"]:
    """Read an image from the clipboard via xclip (X11) or wl-paste (Wayland)."""
    import sys
    if sys.platform == "win32":
        return None
    commands = [
        ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
        ["wl-paste", "--type", "image/png"],
    ]
    for cmd in commands:
        if not shutil.which(cmd[0]):
            continue
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=5)
        except Exception:
            continue
        if proc.returncode == 0 and proc.stdout:
            try:
                from PIL import Image
                return Image.open(io.BytesIO(proc.stdout))
            except Exception:
                continue
    return None


def image_to_data_uri(image, max_dimension: int = MAX_DIMENSION) -> str:
    """Downscale `image` and encode it as a base64 JPEG data URI.

    The output is passed straight into the OpenAI-style ``image_url`` part
    that LiteLLM translates for every provider.
    """
    from PIL import Image

    img = image
    if getattr(img, "is_animated", False):
        img = img.copy()
        try:
            img.seek(0)
        except Exception:
            pass

    width, height = img.size
    if max(width, height) > max_dimension:
        scale = max_dimension / max(width, height)
        img = img.resize((int(width * scale), int(height * scale)), Image.LANCZOS)

    if img.mode != "RGB":
        img = img.convert("RGB")

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def image_label(image, index: int) -> str:
    """Short chip label, e.g. ``🖼 Image 1 · 1280×720``."""
    try:
        width, height = image.size
        return f"🖼 Image {index} · {width}×{height}"
    except Exception:
        return f"🖼 Image {index}"


def save_and_thumbnail_image(image_data: str, storage_dir: Optional[Any] = None, thumb_dimension: int = 360) -> str:
    """Save full image binary to disk and return a compact thumbnail data URI (~10-15KB)
    for session history and UI carousel rendering, preventing SQLite and JSON storage bloat.
    """
    from PIL import Image
    import hashlib

    if not isinstance(image_data, str) or not image_data.startswith("data:"):
        return image_data

    try:
        header, b64 = image_data.split(",", 1)
        raw_bytes = base64.b64decode(b64)

        if storage_dir:
            from pathlib import Path
            img_dir = Path(storage_dir) / "images"
            img_dir.mkdir(parents=True, exist_ok=True)
            img_hash = hashlib.sha256(raw_bytes).hexdigest()[:16]
            file_path = img_dir / f"{img_hash}.jpg"
            if not file_path.exists():
                file_path.write_bytes(raw_bytes)

        with Image.open(io.BytesIO(raw_bytes)) as img:
            w, height = img.size
            if max(w, height) > thumb_dimension:
                scale = thumb_dimension / max(w, height)
                img = img.resize((max(1, int(w * scale)), max(1, int(height * scale))), Image.LANCZOS)
            if img.mode != "RGB":
                img = img.convert("RGB")
            thumb_buf = io.BytesIO()
            img.save(thumb_buf, format="JPEG", quality=72, optimize=True)
            thumb_b64 = base64.b64encode(thumb_buf.getvalue()).decode("ascii")
            return f"data:image/jpeg;base64,{thumb_b64}"
    except Exception:
        return image_data
