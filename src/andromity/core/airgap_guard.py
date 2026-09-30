"""Air-gap socket-level security guard for benchmark and offline environments.

Injected into child processes via PYTHONSTARTUP when ANDROMITY_AIRGAP=1.
Blocks any outbound socket connection to non-loopback addresses at the Python socket layer.
"""
import os
import socket

_ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}

if os.environ.get("ANDROMITY_AIRGAP") == "1":
    _orig_connect = socket.socket.connect
    _orig_connect_ex = socket.socket.connect_ex

    def _is_allowed(address):
        host = address[0] if isinstance(address, (tuple, list)) else address
        host_str = str(host).lower().strip("[]")
        return host_str in _ALLOWED_HOSTS

    def _guarded_connect(self, address):
        if not _is_allowed(address):
            raise PermissionError(
                f"[AIRGAP-SECURITY-GUARD] Outbound socket connection to {address} is strictly blocked by air-gap policy."
            )
        return _orig_connect(self, address)

    def _guarded_connect_ex(self, address):
        if not _is_allowed(address):
            import errno
            return errno.EACCES
        return _orig_connect_ex(self, address)

    socket.socket.connect = _guarded_connect
    socket.socket.connect_ex = _guarded_connect_ex
