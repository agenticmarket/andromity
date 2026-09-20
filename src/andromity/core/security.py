"""Security, domain allowlisting, and safety guardrails."""
import ipaddress
import socket
import re
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


SENSITIVE_PATTERNS = [
    ".env",
    ".ssh",
    ".git",
    "config.toml",
    "id_rsa",
    "id_ed25519",
    "secret",
    "password",
    "credentials",
    "token",
    "/etc/shadow",
    "/etc/passwd",
    "/proc/self/environ",
]

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

_SHELL_FORBIDDEN = re.compile(r'[;&|`$(){}<>\n\r%^]')


SOURCE_CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".java", ".cs", ".rb", ".php",
}


def is_sensitive_path(path: str) -> bool:
    if not path:
        return False
    from pathlib import PurePath
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
        name_lower = pure.name.lower()
        if name_lower in SENSITIVE_NAMES or name_lower.startswith(".env."):
            return True

        for part in pure.parts:
            if part.lower() in SENSITIVE_DIRS:
                return True

        if pure.suffix.lower() in SOURCE_CODE_EXTS:
            return pure.stem.lower() in {"secret", "secrets", "password", "passwords", "credential", "credentials"}

        if SENSITIVE_KEYWORD_REGEX.search(name_lower):
            return True
    else:
        if any(name in lower for name in SENSITIVE_NAMES):
            return True

    return False


def is_command_allowlisted(command: str, allowed: Optional[List[str]] = None) -> bool:
    if not command or not allowed:
        return False

    cmd_clean = command.strip()
    if not cmd_clean or "\x00" in cmd_clean or _SHELL_FORBIDDEN.search(cmd_clean):
        return False

    import os
    import shlex
    try:
        tokens = shlex.split(cmd_clean, posix=(os.name != 'nt' and '\\' not in cmd_clean))
    except ValueError:
        return False

    if not tokens:
        return False

    matched_prefix_tokens: Optional[List[str]] = None
    for prefix in allowed:
        p_str = prefix.strip()
        if not p_str:
            continue
        try:
            p_tokens = shlex.split(p_str, posix=(os.name != 'nt' and '\\' not in p_str))
        except ValueError:
            continue
        if not p_tokens:
            continue

        if len(tokens) >= len(p_tokens) and tokens[:len(p_tokens)] == p_tokens:
            matched_prefix_tokens = p_tokens
            break

    if matched_prefix_tokens is None:
        return False

    for token in tokens[len(matched_prefix_tokens):]:
        clean_token = token.split("=", 1)[-1].strip("'\"")
        if is_sensitive_path(clean_token):
            return False

    return True


