"""Air-gap network guard.

When ANDROMITY_AIRGAP=1, outbound network access is refused except to this
machine (loopback) and private-network hosts listed in ANDROMITY_AIRGAP_ALLOW
(comma separated host names, IP addresses or CIDR ranges). Public addresses
are refused even when listed.

Enforcement uses Python audit hooks, so it also covers sockets created by C
code inside CPython and functions bound before the guard loaded; the Windows
asyncio proactor (which connects through ConnectEx, bypassing the socket audit
event) is patched separately. This is an in-process guard, not a sandbox:
ctypes or native libraries that call the OS directly, and programs that are
not Python, are outside it. Pair it with OS firewall rules for isolation.

This file must stay standard-library only: child processes load it by path
(PYTHONSTARTUP and airgap_sitecustomize) without the andromity package.
"""
import ipaddress
import os
import socket
import sys
import threading
import time
from collections import deque
from typing import Callable, Deque, Dict, List, Optional, Set, Tuple

ENV_FLAG = "ANDROMITY_AIRGAP"
ENV_ALLOW = "ANDROMITY_AIRGAP_ALLOW"

_LOOPBACK_NAMES = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}
_INSTALLED_MARKER = "_andromity_airgap_guard"
_MAX_LOG = 200


class AirgapBlockedError(PermissionError):
    """Raised for a refused network operation; an OSError, so callers treat it as a failed connection."""

    def __init__(self, target: str, kind: str):
        self.target = target
        self.kind = kind
        super().__init__(
            f"Air-gap mode blocked a {kind} to {target}. Only this machine and private hosts "
            f"you allow can be reached. Add the host to the air-gap allowed hosts if it is on your network."
        )


def is_enabled() -> bool:
    return os.environ.get(ENV_FLAG) == "1"


def _strip_host(entry: str) -> str:
    entry = entry.strip().lower()
    if entry.startswith("[") and "]" in entry:
        return entry[1:entry.index("]")]
    if entry.count(":") == 1:
        host, _, port = entry.partition(":")
        if port.isdigit():
            return host
    return entry


def _private(network) -> bool:
    return bool(network.is_private or network.is_loopback or network.is_link_local)


def parse_allowlist(raw: Optional[str]) -> Tuple[Set[str], List, List[str]]:
    """Split an allowlist into host names, private networks and ignored (public) entries."""
    names: Set[str] = set()
    networks: List = []
    ignored: List[str] = []
    for part in (raw or "").replace(";", ",").replace("\n", ",").split(","):
        entry = _strip_host(part)
        if not entry:
            continue
        try:
            network = ipaddress.ip_network(entry, strict=False)
        except ValueError:
            if all(ch.isalnum() or ch in "-._" for ch in entry):
                names.add(entry.rstrip("."))
            else:
                ignored.append(part.strip())
            continue
        if _private(network):
            networks.append(network)
        else:
            ignored.append(part.strip())
    return names, networks, ignored


class _Policy:
    def __init__(self) -> None:
        self.names, self.networks, self.ignored = parse_allowlist(os.environ.get(ENV_ALLOW))
        # Private addresses that allowed host names resolved to.
        self.resolved: Set[str] = set()

    def ip_allowed(self, value: str) -> bool:
        try:
            ip = ipaddress.ip_address(value.split("%", 1)[0])
        except ValueError:
            return False
        if ip.is_loopback or ip.is_unspecified:
            return True
        if getattr(ip, "ipv4_mapped", None) is not None:
            return self.ip_allowed(str(ip.ipv4_mapped))
        if any(ip in network for network in self.networks):
            return True
        return str(ip) in self.resolved and (ip.is_private or ip.is_link_local)

    def name_allowed(self, host: str) -> bool:
        host = host.lower().rstrip(".")
        if host in _LOOPBACK_NAMES or host.endswith(".localhost"):
            return True
        try:
            ipaddress.ip_address(host.split("%", 1)[0])
        except ValueError:
            return host in self.names
        return self.ip_allowed(host)


_policy: Optional[_Policy] = None
_blocked: Deque[Dict] = deque(maxlen=_MAX_LOG)
_blocked_lock = threading.Lock()
_listeners: List[Callable[[Dict], None]] = []
# Audit hooks cannot be removed, so the hook checks this flag; only tests clear it.
_active = False


def _get_policy() -> _Policy:
    global _policy
    if _policy is None:
        _policy = _Policy()
    return _policy


def host_allowed(host: str) -> bool:
    """Whether a host name or address may be contacted under the current policy."""
    if not is_enabled():
        return True
    return _get_policy().name_allowed(str(host))


def _record(target: str, kind: str) -> None:
    entry = {"time": time.time(), "target": target, "kind": kind}
    with _blocked_lock:
        _blocked.append(entry)
    for listener in list(_listeners):
        try:
            listener(entry)
        except Exception:
            pass


def blocked_attempts() -> List[Dict]:
    with _blocked_lock:
        return list(_blocked)


def add_listener(listener: Callable[[Dict], None]) -> None:
    _listeners.append(listener)


def _target_of(address) -> Optional[Tuple[str, str]]:
    """(host, printable target) for an inet address; None for local IPC (Unix sockets, pipes)."""
    if isinstance(address, (tuple, list)) and address:
        host = address[0]
        if isinstance(host, bytes):
            host = host.decode("ascii", "replace")
        port = address[1] if len(address) > 1 else ""
        return str(host), f"{host}:{port}" if port != "" else str(host)
    return None


def _check_address(address, kind: str) -> None:
    target = _target_of(address)
    if target is None:
        return
    host, printable = target
    if not _get_policy().name_allowed(host):
        _record(printable, kind)
        raise AirgapBlockedError(printable, kind)


def _check_name(host, kind: str) -> None:
    if host is None:
        return
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    host = str(host)
    if not host:
        return
    if not _get_policy().name_allowed(host):
        _record(host, kind)
        raise AirgapBlockedError(host, kind)


def _remember_resolution(host, results) -> None:
    """Record private addresses an allowed host name resolved to, so connecting to them is allowed."""
    policy = _get_policy()
    if not isinstance(host, str) or host.lower().rstrip(".") not in policy.names:
        return
    for result in results or []:
        try:
            ip = ipaddress.ip_address(str(result[4][0]).split("%", 1)[0])
        except (ValueError, IndexError, TypeError):
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            policy.resolved.add(str(ip))


def _audit_hook(event: str, args) -> None:
    if not _active or not event.startswith("socket."):
        return
    if event == "socket.connect":
        _check_address(args[1], "connection")
    elif event in ("socket.sendto", "socket.sendmsg"):
        if len(args) > 1 and args[1] is not None:
            _check_address(args[1], "network send")
    elif event == "socket.getaddrinfo":
        host = args[0]
        try:
            ipaddress.ip_address(str(host.decode("ascii", "replace") if isinstance(host, bytes) else host).split("%", 1)[0])
            kind = "connection"
        except ValueError:
            kind = "DNS lookup"
        _check_name(host, kind)
    elif event in ("socket.gethostbyname", "socket.gethostbyname_ex"):
        _check_name(args[0], "DNS lookup")
    elif event == "socket.gethostbyaddr":
        _check_name(args[0], "reverse DNS lookup")


def _wrap_getaddrinfo() -> None:
    original = socket.getaddrinfo

    def getaddrinfo(host, *args, **kwargs):
        results = original(host, *args, **kwargs)
        _remember_resolution(host, results)
        return results

    socket.getaddrinfo = getaddrinfo


def _patch_windows_proactor() -> None:
    """asyncio's IOCP proactor connects with ConnectEx, which raises no socket audit event."""
    try:
        from asyncio import windows_events  # type: ignore[attr-defined]
    except Exception:
        return
    proactor = getattr(windows_events, "IocpProactor", None)
    if proactor is None:
        return
    original_connect = proactor.connect
    original_sendto = getattr(proactor, "sendto", None)

    def connect(self, conn, address):
        if _active:
            _check_address(address, "connection")
        return original_connect(self, conn, address)

    proactor.connect = connect
    if original_sendto is not None:
        def sendto(self, conn, buf, flags=0, addr=None):
            if _active and addr is not None:
                _check_address(addr, "network send")
            return original_sendto(self, conn, buf, flags, addr)

        proactor.sendto = sendto


def install() -> bool:
    """Install the guard for this process. Idempotent; a no-op unless air-gap mode is on."""
    global _active
    if not is_enabled():
        return False
    _active = True
    if getattr(socket, _INSTALLED_MARKER, False):
        return True
    _get_policy()
    sys.addaudithook(_audit_hook)
    _wrap_getaddrinfo()
    _patch_windows_proactor()
    setattr(socket, _INSTALLED_MARKER, True)
    return True


def status() -> Dict:
    policy = _get_policy()
    return {
        "enabled": is_enabled(),
        "guard_installed": _active,
        "allowed_hosts": sorted(policy.names) + [str(n) for n in policy.networks],
        "ignored_hosts": list(policy.ignored),
        "blocked": blocked_attempts(),
    }


def _reset_for_tests() -> None:
    """Turn the installed guard off and forget the policy and log (tests only)."""
    global _active, _policy
    _active = False
    _policy = None
    with _blocked_lock:
        _blocked.clear()
    _listeners.clear()


if is_enabled():
    install()
