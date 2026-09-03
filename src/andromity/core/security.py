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


def is_sensitive_path(path: str) -> bool:
    """Check if path targets sensitive files or directories."""
    path_lower = path.lower().replace("\\", "/")
    return any(pat in path_lower for pat in SENSITIVE_PATTERNS)
