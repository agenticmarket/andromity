"""Session export engine — Markdown / HTML / JSON transcripts.

Pure functions with no Textual dependencies so they can be unit-tested
without booting the TUI. `export_session()` resolves the output format
from the filename extension, generates a default name when none is given,
writes the file, and returns the resolved path.
"""
import html as _html
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_STEM = "andromity-session"
SUPPORTED_EXTENSIONS = (".md", ".html", ".json")


# ── Turn building ─────────────────────────────────────────────────────────────

def build_export_data(session) -> Dict[str, Any]:
    """Flatten a Session into an export-ready dict.

    Messages are grouped into turns keyed by their user prompt; assistant
    replies and tool calls/results are attached to the turn they follow.
    """
    turns: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for msg in session.messages:
        role = msg.get("role")
        if role == "system":
            continue
        if role == "user":
            current = {
                "prompt": str(msg.get("content", "") or ""),
                "ts": msg.get("ts"),
                "responses": [],
                "tools": [],
            }
            turns.append(current)
            continue

        if current is None:
            current = {"prompt": "(no user prompt)", "ts": msg.get("ts"), "responses": [], "tools": []}
            turns.append(current)

        if role == "assistant":
            text = str(msg.get("content") or "")
            if text:
                current["responses"].append({
                    "text": text,
                    "thinking": msg.get("thinking") or "",
                    "ts": msg.get("ts"),
                })
            for tc in msg.get("tool_calls") or []:
                fn = tc.get("function", {}) or {}
                args_raw = fn.get("arguments") or "{}"
                try:
                    parsed_args = json.loads(args_raw)
                except (json.JSONDecodeError, TypeError):
                    parsed_args = {}
                current["tools"].append({
                    "name": fn.get("name", "unknown"),
                    "args": parsed_args if isinstance(parsed_args, dict) else {},
                    "id": tc.get("id"),
                    "result": None,
                    "duration_s": None,
                    "ts": msg.get("ts"),
                })
        elif role == "tool":
            call_id = msg.get("tool_call_id")
            for tc in reversed(current["tools"]):
                if tc["id"] == call_id and tc["result"] is None:
                    tc["result"] = str(msg.get("content") or "")
                    start = _parse_ts(current["ts"])
                    end = _parse_ts(msg.get("ts"))
                    if start is not None and end is not None:
                        tc["duration_s"] = max(0.0, round(end - start, 2))
                    break

    return {
        "session_id": session.id,
        "session_name": getattr(session, "name", ""),
        "project_path": getattr(session, "project_path", ""),
        "created_at": session.created_at,
        "updated_at": getattr(session, "updated_at", session.created_at),
        "model": f"{getattr(session, 'provider', '')}/{getattr(session, 'model', '')}".strip("/"),
        "token_total": int(getattr(session, "token_total", 0) or 0),
        "usage_breakdown": dict(getattr(session, "usage_breakdown", {}) or {}),
        "cost_usd": float(getattr(session, "cost_usd", 0.0) or 0.0),
        "cost_source": getattr(session, "cost_source", "unpriced"),
        "turns": turns,
    }


def _parse_ts(value: Optional[str]) -> Optional[float]:
    try:
        return datetime.fromisoformat(value).timestamp()
    except (TypeError, ValueError):
        return None


def _format_ts(value: Optional[str]) -> str:
    dt = _parse_dt(value)
    return dt.strftime("%Y-%m-%d %H:%M:%S UTC") if dt else ""


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ── Renderers ────────────────────────────────────────────────────────────────

def render_markdown(data: Dict[str, Any]) -> str:
    lines: List[str] = [
        "# Andromity Session Export",
        "",
        "| Field | Value |",
        "| --- | --- |",
        f"| **Date** | {_format_ts(data['created_at'])} |",
        f"| **Model** | `{data['model'] or 'unknown'}` |",
        f"| **Tokens** | {data['token_total']:,} |",
        f"| **Cost** | ${data['cost_usd']:.4f} ({data['cost_source']}) |",
        "",
        "---",
        "",
    ]
    for i, turn in enumerate(data["turns"], 1):
        lines.append(f"## Turn {i}")
        lines.append("")
        lines.append("### 🧑 User")
        lines.append("")
        lines.append(turn["prompt"] or "*(empty)*")
        lines.append("")
        for resp in turn["responses"]:
            lines.append("### 🤖 Andromity")
            lines.append("")
            lines.append(resp["text"])
            lines.append("")
        for tool in turn["tools"]:
            dur = f"{tool['duration_s']:.2f}s" if tool["duration_s"] is not None else "n/a"
            result = tool["result"] if tool["result"] is not None else "(no result)"
            lines.append(f"- **🔧 Tool:** `{tool['name']}` — duration: {dur}")
            if tool["args"]:
                lines.append(f"  - Args: `{json.dumps(tool['args'], ensure_ascii=False)}`")
            snippet = result if len(result) <= 400 else result[:400] + "…"
            one_line = snippet.replace("\n", " ")
            lines.append(f"  - Result: {one_line}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
body {{ font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }}
h1 {{ border-bottom: 2px solid #22c55e; padding-bottom: .4rem; }}
table {{ border-collapse: collapse; margin: 1rem 0; }}
th, td {{ border: 1px solid #d4d4d4; padding: .35rem .8rem; text-align: left; }}
th {{ background: #efefef; }}
.turn {{ background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }}
.turn h2 {{ margin-top: 0; font-size: 1.05rem; color: #555; }}
.role-user {{ color: #0891b2; font-weight: 600; }}
.role-ai {{ color: #16a34a; font-weight: 600; }}
.tool {{ background: #f4f4f5; border-left: 3px solid #a1a1aa; padding: .45rem .8rem; margin: .5rem 0; border-radius: 0 6px 6px 0; font-size: .92em; }}
.tool .dur {{ color: #71717a; }}
pre {{ white-space: pre-wrap; word-break: break-word; }}
</style>
</head>
<body>
<h1>Andromity Session Export</h1>
<table>
<tr><th>Date</th><td>{created}</td></tr>
<tr><th>Model</th><td><code>{model}</code></td></tr>
<tr><th>Tokens</th><td>{tokens}</td></tr>
<tr><th>Cost</th><td>${cost} ({source})</td></tr>
</table>
{turns}
</body>
</html>
"""


def render_html(data: Dict[str, Any]) -> str:
    turns_html: List[str] = []
    for i, turn in enumerate(data["turns"], 1):
        parts: List[str] = [f"<h2>Turn {i}</h2>"]
        parts.append('<div class="role-user">🧑 You</div>')
        parts.append(f"<pre>{_html.escape(turn['prompt'] or '(empty)')}</pre>")
        for resp in turn["responses"]:
            parts.append('<div class="role-ai">🤖 Andromity</div>')
            parts.append(f"<pre>{_html.escape(resp['text'])}</pre>")
        for tool in turn["tools"]:
            dur = f"{tool['duration_s']:.2f}s" if tool["duration_s"] is not None else "n/a"
            result = tool["result"] if tool["result"] is not None else "(no result)"
            snippet = result if len(result) <= 400 else result[:400] + "…"
            args_str = ""
            if tool["args"]:
                args_str = f'<div class="args"><code>{_html.escape(json.dumps(tool["args"], ensure_ascii=False))}</code></div>'
            parts.append(
                f'<div class="tool">🔧 <strong>{_html.escape(str(tool["name"]))}</strong> '
                f'<span class="dur">— duration: {_html.escape(dur)}</span>'
                f'{args_str}'
                f"<div class=\"result\">{_html.escape(snippet)}</div>"
            )
        turns_html.append(f'<div class="turn">{"".join(parts)}</div>')

    return _HTML_TEMPLATE.format(
        title=_html.escape(data.get("session_name") or "Andromity Session Export"),
        created=_html.escape(_format_ts(data["created_at"])),
        model=_html.escape(data["model"] or "unknown"),
        tokens=f"{data['token_total']:,}",
        cost=f"{data['cost_usd']:.4f}",
        source=_html.escape(data["cost_source"]),
        turns="\n".join(turns_html),
    )


# ── File writing ─────────────────────────────────────────────────────────────

def default_export_filename(ext: str = ".md", now: Optional[datetime] = None) -> str:
    """`andromity-session-%Y%m%d-%H%M%S<ext>` — minute resolution, no colons."""
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    ext = ext if ext.startswith(".") else "." + ext
    return f"{DEFAULT_STEM}-{stamp}{ext}"


def resolve_output_path(filename: str, project_path: str = "") -> Path:
    """Resolve a user-supplied filename against the project root."""
    base = Path(project_path) if project_path else Path.cwd()
    path = Path(filename).expanduser()
    if not path.is_absolute():
        path = base / path
    return path


def export_session(session, output_path: str = "", project_path: str = "") -> Path:
    """Export a session to `<filename>.md|.html|.json`; returns the written path.

    Empty `output_path` → default Markdown file named
    `andromity-session-<timestamp>.md` in the project root.
    Raises ValueError for unsupported extensions.
    """
    project_root = Path(project_path) if project_path else Path.cwd()
    if output_path.strip():
        out = resolve_output_path(output_path.strip().strip('"'), str(project_root))
        ext = out.suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise ValueError(
                f"Unsupported export format '{ext or out.name}'. Use .md, .html or .json."
            )
    else:
        out = project_root / default_export_filename(".md")
        ext = ".md"

    data = build_export_data(session)

    if ext == ".md":
        content = render_markdown(data)
    elif ext == ".html":
        content = render_html(data)
    else:
        content = json.dumps(data, indent=2, ensure_ascii=False, default=str)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, encoding="utf-8")
    return out
