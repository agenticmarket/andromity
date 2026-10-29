"""Helpers for pasting images into the chat.

Pillow is imported lazily inside the functions so the app starts fine even
before it is installed — the paste action simply degrades with a friendly
notification instead of crashing at import time.
"""
import base64
import binascii
import hashlib
import io
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Product limit: how many images one message may carry.
MAX_IMAGES = 5

# Providers reject very large images; downscale before encoding.
MAX_DIMENSION = 2048
JPEG_QUALITY = 88

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".ico"}

# The full bytes of a pasted image are kept in "<session storage>/images" under this name, whatever their format.
STORED_IMAGE_NAME = re.compile(r"[0-9a-f]{16}\.jpg")
MAX_STORED_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_BASE64_CHARS = (MAX_STORED_IMAGE_BYTES + 2) // 3 * 4
_MAX_OPEN_PIXELS = (2 * MAX_DIMENSION) ** 2


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


def store_prompt_image(image_data: str, storage_dir: Optional[Any] = None,
                       thumb_dimension: int = 360) -> Tuple[str, Optional[str]]:
    """Keep a pasted image's full bytes in the session's image store and return a compact thumbnail data URI
    (~10-15KB) for the chat history, with the stored file's name (None when it was not stored).
    """
    from PIL import Image

    if not isinstance(image_data, str) or not image_data.startswith("data:"):
        return image_data, None
    try:
        raw_bytes = base64.b64decode(image_data.split(",", 1)[1], validate=True)
    except (IndexError, binascii.Error, ValueError):
        return image_data, None
    if not raw_bytes:
        return image_data, None

    name = _store_image_bytes(raw_bytes, storage_dir) if storage_dir and image_mime(raw_bytes) else None
    try:
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
            return f"data:image/jpeg;base64,{thumb_b64}", name
    except Exception:
        return image_data, name


def _store_image_bytes(raw_bytes: bytes, storage_dir: Any) -> Optional[str]:
    """Write the bytes to the image store under their content hash, whole or not at all."""
    name = f"{hashlib.sha256(raw_bytes).hexdigest()[:16]}.jpg"
    try:
        img_dir = Path(storage_dir) / "images"
        img_dir.mkdir(parents=True, exist_ok=True)
        target = img_dir / name
        if target.is_file() and target.stat().st_size == len(raw_bytes):
            return name
        fd, temp_path = tempfile.mkstemp(dir=img_dir, prefix=".", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw_bytes)
            os.replace(temp_path, target)
        except BaseException:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            raise
        return name
    except OSError:
        return None


def image_mime(data: bytes) -> Optional[str]:
    """The image type the bytes themselves show, among those chat clients and model providers accept."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def stored_image_uri(storage_dir: Optional[Any], name: Any) -> Optional[str]:
    """A full-size image from a session's image store as a data URI, or None unless `name` has the store's form,
    resolves inside the store, and is an image of at most MAX_STORED_IMAGE_BYTES."""
    if not storage_dir or not isinstance(name, str) or not STORED_IMAGE_NAME.fullmatch(name):
        return None
    try:
        root = (Path(storage_dir) / "images").resolve()
        path = (root / name).resolve(strict=True)
        if path.parent != root or not path.is_file():
            return None
        with open(path, "rb") as handle:
            data = handle.read(MAX_STORED_IMAGE_BYTES + 1)
    except (OSError, RuntimeError):
        return None
    mime = image_mime(data) if len(data) <= MAX_STORED_IMAGE_BYTES else None
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}" if mime else None


def checked_image_uri(uri: Any) -> Optional[str]:
    """`uri` retyped by its bytes when it is a base64 data URI of an image of at most MAX_STORED_IMAGE_BYTES."""
    if not isinstance(uri, str) or not uri.startswith("data:image/"):
        return None
    header, _, payload = uri.partition(",")
    if not header.endswith(";base64") or not payload or len(payload) > _MAX_BASE64_CHARS:
        return None
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        return None
    mime = image_mime(data) if len(data) <= MAX_STORED_IMAGE_BYTES else None
    return f"data:{mime};base64,{payload}" if mime else None


def prompt_images(message: Dict[str, Any], storage_dir: Optional[Any]) -> List[str]:
    """A sent prompt's images as data URIs, at most MAX_IMAGES: each full-size file the prompt refers to while it is
    still in the session's image store, otherwise the thumbnail kept with the prompt."""
    thumbs = message.get("images")
    files = message.get("image_files")
    thumbs = thumbs if isinstance(thumbs, list) else []
    files = files if isinstance(files, list) else []
    found = []
    for index in range(min(max(len(thumbs), len(files)), MAX_IMAGES)):
        uri = (stored_image_uri(storage_dir, files[index] if index < len(files) else None)
               or checked_image_uri(thumbs[index] if index < len(thumbs) else None))
        if uri:
            found.append(uri)
    return found


def image_from_data_uri(uri: str) -> Optional["object"]:
    """A detached Pillow image from an image data URI, or None when it isn't a valid one or is too large to open."""
    from PIL import Image

    checked = checked_image_uri(uri)
    if not checked:
        return None
    try:
        with Image.open(io.BytesIO(base64.b64decode(checked.split(",", 1)[1]))) as img:
            width, height = img.size
            if width * height > _MAX_OPEN_PIXELS:
                return None
            img.load()
            return img.copy()
    except Exception:
        return None
