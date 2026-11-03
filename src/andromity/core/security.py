"""Security, domain allowlisting, and safety guardrails."""
import ipaddress
import socket
import re
from pathlib import Path, PurePath
from typing import List, Optional
from urllib.parse import urlparse


def get_domain(url: str) -> Optional[str]:
    """Extract lowercase hostname from a URL, never including port or userinfo."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname  # hostname strips port and userinfo; None if unparseable
        if host:
            return host.lower()
    except Exception:
        pass
    return None


def _is_private_ip(host: str) -> bool:
    """Return True if host resolves to a private, loopback, link-local, or cloud metadata address."""
    clean_host = host.strip("[]").strip().lower()
    
    # Handle hex/octal or standard IP formats
    try:
        addr = ipaddress.ip_address(clean_host)
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_unspecified
            or addr.is_reserved
            or str(addr) in ("169.254.169.254", "0.0.0.0", "::", "::1")
        ):
            return True
    except ValueError:
        pass

    # Resolve all addresses (IPv4 and IPv6) to prevent round-robin / DNS rebinding bypass
    try:
        infos = socket.getaddrinfo(clean_host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for info in infos:
            sockaddr = info[4]
            ip_str = sockaddr[0]
            try:
                addr = ipaddress.ip_address(ip_str)
                if (
                    addr.is_private
                    or addr.is_loopback
                    or addr.is_link_local
                    or addr.is_multicast
                    or addr.is_unspecified
                    or addr.is_reserved
                    or str(addr) in ("169.254.169.254", "0.0.0.0", "::", "::1")
                ):
                    return True
            except ValueError:
                return True
    except Exception:
        # If domain cannot be resolved or fails safely, fail-closed (treat as unsafe/private)
        return True

    return False


def is_domain_allowed(url: str, allowed_domains: Optional[List[str]] = None) -> bool:
    """Check if the URL's domain is in the allowed domains list or matches wildcard/subdomain."""
    if not allowed_domains:
        return False

    domain = get_domain(url)
    if not domain:
        return False

    for pattern in allowed_domains:
        pattern = pattern.strip().lower()
        if not pattern:
            continue
        # Exact match
        if domain == pattern:
            return True
        # Subdomain match (e.g. pattern "github.com" matches "raw.github.com" or "api.github.com")
        if domain.endswith(f".{pattern}"):
            return True
        # Wildcard pattern match (e.g. "*.python.org")
        if pattern.startswith("*."):
            suffix = pattern[2:]
            if domain == suffix or domain.endswith(f".{suffix}"):
                return True

    return False



SENSITIVE_NAMES = {
    ".env",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "authorized_keys",
    "known_hosts",
    "config.toml",
}

SENSITIVE_DIRS = {
    ".ssh",
    ".git",
    ".aws",
    ".gnupg",
}

SENSITIVE_KEYWORD_REGEX = re.compile(
    r"(^|[._\-/])(secret|password|credential|token)s?([._\-/]|$)",
    re.IGNORECASE,
)

SENSITIVE_EXACT_SYSTEM_PATHS = {
    "/etc/shadow",
    "/etc/passwd",
    "/proc/self/environ",
}

_LITERAL_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789"
    "_-.,:=+@/\\~"
)
_QUOTES = ("'", '"')


SOURCE_CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".java", ".cs", ".rb", ".php",
}


_DRIVE = re.compile(r"[A-Za-z]:")


def _policy_name(part: str) -> str:
    """A path component as Windows opens it: no NTFS stream suffix, no trailing dots or spaces."""
    name = part
    if ":" in name and not _DRIVE.fullmatch(name.rstrip("/\\")):
        name = name.split(":", 1)[0]
    stripped = name.rstrip(". ")
    return (stripped or name).lower()


def _policy_parts(path: str) -> List[str]:
    try:
        return [_policy_name(p) for p in PurePath(path.strip().replace("\\", "/")).parts]
    except Exception:
        return []


def _resolved_policy_path(path: str, root: Optional[str]) -> Optional[str]:
    """Where a path really lands, relative to the project when it is inside it.

    Catches symlinks, junctions, 8.3 short names and Windows name normalisation,
    which a check on the string the model sent cannot see.
    """
    if not path or not root:
        return None
    try:
        base = Path(root).resolve()
        candidate = Path(path.strip())
        resolved = (candidate if candidate.is_absolute() else base / candidate).resolve()
        try:
            return resolved.relative_to(base).as_posix()
        except ValueError:
            return resolved.as_posix()
    except (OSError, ValueError, RuntimeError):
        return None


def is_sensitive_path(path: str, root: Optional[str] = None) -> bool:
    if not path:
        return False
    if _is_sensitive_literal(path):
        return True
    resolved = _resolved_policy_path(path, root)
    return bool(resolved) and _is_sensitive_literal(resolved)


def _is_sensitive_literal(path: str) -> bool:
    normalized = path.strip().replace("\\", "/")
    lower = normalized.lower()

    for sys_path in SENSITIVE_EXACT_SYSTEM_PATHS:
        if sys_path in lower:
            return True

    try:
        pure = PurePath(normalized)
    except Exception:
        pure = None

    if pure:
        name_lower = _policy_name(pure.name) if pure.name else ""
        if name_lower in SENSITIVE_NAMES or name_lower.startswith(".env."):
            return True

        for part in pure.parts:
            if _policy_name(part) in SENSITIVE_DIRS:
                return True

        policy_name = PurePath(name_lower) if name_lower else pure
        if policy_name.suffix.lower() in SOURCE_CODE_EXTS:
            return policy_name.stem.lower() in {"secret", "secrets", "password", "passwords", "credential", "credentials"}

        if SENSITIVE_KEYWORD_REGEX.search(name_lower):
            return True
    else:
        if any(name in lower for name in SENSITIVE_NAMES):
            return True

    return False


# Writing these turns a file edit into later command execution (git fsmonitor/hooks,
# project crons and MCP servers, editor tasks, direnv, npm scripts run by allowlisted
# `npm run`), so they always need explicit approval outside FULL/YOLO.
# The second group is the other half of the same loop: an allowlisted runner such as
# `pytest`, `make` or `npm test` executes whatever these files say, so a silent write
# to one would turn an approved command into arbitrary code.
EXECUTION_CONTROL_DIRS = {".git", ".andromity", ".vscode", ".husky", ".github"}
EXECUTION_CONTROL_NAMES = {
    ".envrc", "package.json", ".mcp.json", ".gitmodules",
    "conftest.py", "pytest.ini", "tox.ini", "noxfile.py", "setup.py", "sitecustomize.py",
    "makefile", "gnumakefile", "justfile", "taskfile.yml", "taskfile.yaml",
    "rakefile", "gulpfile.js", "dockerfile", ".pre-commit-config.yaml",
}


def _is_execution_control_literal(path: str) -> bool:
    parts = _policy_parts(path)
    if not parts:
        return False
    return parts[-1] in EXECUTION_CONTROL_NAMES or any(p in EXECUTION_CONTROL_DIRS for p in parts[:-1])


def is_execution_control_path(path: str, root: Optional[str] = None) -> bool:
    if not path:
        return False
    if _is_execution_control_literal(path):
        return True
    resolved = _resolved_policy_path(path, root)
    return bool(resolved) and _is_execution_control_literal(resolved)


MCP_CHANGE_WORDS = ("write", "insert", "update", "delete", "create", "drop", "push", "exec", "post")


def mcp_tool_may_change(tool_name: str) -> bool:
    """TRUST mode asks before an MCP tool whose own name suggests a change.

    Only the tool part of ``mcp__<server>__<tool>`` counts, so a server named
    e.g. ``postgres`` does not make every one of its tools ask.
    """
    tool = tool_name.split("__", 2)[-1].lower()
    return any(word in tool for word in MCP_CHANGE_WORDS)


def _literal_tokens(command: str) -> Optional[List[str]]:
    """Split a command into the exact argv every supported shell produces, or None.

    A guard that tokenises one way while the shell expands, unquotes and rewrites
    the text another way approves a command it has not actually read. So this
    accepts only commands with no shell-significant character left in them:
    whitespace splitting is then the shell's own word splitting, and the result
    holds for bash, sh, zsh, cmd and PowerShell alike. Everything else — a quote
    inside a word, an expansion, a separator, a redirect — returns None and goes
    to a person.
    """
    if not command or "\x00" in command:
        return None

    tokens: List[str] = []
    current: Optional[str] = None
    quote: Optional[str] = None
    quoted_word = False

    for ch in command:
        if quote:
            if ch == quote:
                quote = None
            elif ch in _QUOTES or (ch not in _LITERAL_CHARS and ch not in " \t"):
                return None
            else:
                current = (current or "") + ch
            continue
        if ch in " \t":
            if current is not None:
                tokens.append(current)
                current = None
                quoted_word = False
            continue
        if ch in _QUOTES:
            # A quote may only wrap a whole word: `"a b"` is one argument in every
            # shell, while `".e"nv` is the quote-removal bypass, read as `.env`.
            if current is not None:
                return None
            quote = ch
            quoted_word = True
            current = ""
            continue
        if quoted_word or ch not in _LITERAL_CHARS:
            return None
        current = (current or "") + ch

    if quote:
        return None
    if current is not None:
        tokens.append(current)
    return tokens


def _token_readings(token: str) -> List[str]:
    """Every path one argument can mean, because the guard cannot know the shell.

    A backslash is a path separator to cmd and PowerShell and an escape to bash,
    so ``.e\\nv`` is two different files; an option may carry its value after an
    ``=``, and the part before it is still a path. Each reading is checked, and
    any unsafe one refuses the command.
    """
    readings = {token}
    if "\\" in token:
        readings.add(token.replace("\\", ""))
    for reading in list(readings):
        if "=" in reading:
            head, _, tail = reading.partition("=")
            readings.update({head, tail})
    return [r for r in readings if r]


# Programs that take their work from an argument: a script, a module, a remote
# host, another command. The allowlist cannot describe what they will run, so
# they auto-approve only as the exact prefix the user wrote, never with extra
# arguments. Pipes into these are already impossible — `|` never parses.
_PROGRAMS_THAT_RUN_CODE = {
    "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "ash", "busybox",
    "cmd", "command", "powershell", "pwsh",
    "python", "python2", "python3", "py", "pypy", "node", "nodejs", "deno", "bun",
    "ruby", "perl", "php", "lua", "rscript", "osascript", "java", "dotnet",
    "env", "xargs", "nohup", "timeout", "nice", "setsid", "stdbuf", "script",
    "sudo", "doas", "su", "runas", "start", "eval", "exec", "source",
    "find", "awk", "gawk", "mawk", "ssh", "scp", "sftp", "rsync", "telnet",
    "docker", "podman", "kubectl", "nc", "ncat", "netcat", "socat", "curl", "wget",
    "sqlite3", "psql", "mysql", "mongosh", "mongo", "redis-cli",
}


def _program_name(token: str) -> str:
    name = token.replace("\\", "/").rsplit("/", 1)[-1].lower()
    for suffix in (".exe", ".cmd", ".bat", ".com", ".ps1"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return name


def is_command_allowlisted(
    command: str, allowed: Optional[List[str]] = None, root: Optional[str] = None
) -> bool:
    """True when ``command`` may run without a person approving it.

    ``root`` is the project folder; arguments are resolved against it so a link,
    junction or short name that leaves the workspace is seen for what it is.
    """
    if not command or not allowed:
        return False

    tokens = _literal_tokens(command.strip())
    if not tokens:
        return False

    matched_prefix_tokens: Optional[List[str]] = None
    for prefix in allowed:
        p_tokens = _literal_tokens((prefix or "").strip())
        if not p_tokens:
            continue
        if len(tokens) >= len(p_tokens) and tokens[: len(p_tokens)] == p_tokens:
            matched_prefix_tokens = p_tokens
            break

    if matched_prefix_tokens is None:
        return False

    program = _program_name(tokens[0])
    extra_tokens = tokens[len(matched_prefix_tokens):]
    if program in _PROGRAMS_THAT_RUN_CODE and extra_tokens:
        return False

    unsafe_option = _UNSAFE_OPTIONS.get(program)
    for token in extra_tokens:
        if unsafe_option and unsafe_option.match(token):
            return False
        for reading in _token_readings(token):
            if is_sensitive_path(reading, root) or _escapes_workspace(reading):
                return False

    return True


# Options that make an otherwise read-only command write files, load code or
# reach outside the repository. A second layer: the program check above is what
# keeps a general-purpose runner out of the allowlist in the first place.
_UNSAFE_OPTIONS = {
    "git": re.compile(
        r"^(?:--output(?:=|$)|--ext-diff$|--textconv$|--no-index$|-O|--open-files-in-pager|--upload-pack|"
        r"--receive-pack|--exec(?:=|$)|--exec-path|-c$|--config-env|--git-dir|--work-tree)",
        re.IGNORECASE,
    ),
    "pytest": re.compile(r"^(?:-p|--plugin|--pyargs|--rootdir)", re.IGNORECASE),
    "tar": re.compile(r"^(?:--use-compress-program|--to-command|--checkpoint-action|-I$|-C$)", re.IGNORECASE),
    "npm": re.compile(r"^(?:--(?:script-shell|node-options|prefix|userconfig|globalconfig)(?:=|$))", re.IGNORECASE),
}


_WINDOWS_SWITCH = re.compile(r"^/[A-Za-z?]{1,2}(?::[A-Za-z-]*)?$")


def _escapes_workspace(value: str) -> bool:
    """Arguments an allowlisted command may not take without a person looking: other
    folders, home, network shares and globs that the shell expands to unseen paths."""
    if not value:
        return False
    if _WINDOWS_SWITCH.match(value):
        return False
    if value.startswith("~") or any(ch in value for ch in "*?[]"):
        return True
    if re.match(r"^(?:[A-Za-z]:|[\\/])", value):
        return True
    return any(part == ".." for part in re.split(r"[\\/]", value))


