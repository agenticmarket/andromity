"""Air-gap self-test: tries each kind of outbound access and reports what stopped it.

Only run while air-gap mode is on (the RPC checks), so every probe is expected
to be refused before any packet leaves the machine. Targets are well-known
public addresses; nothing is sent to them when the guard works.
"""
import asyncio
import os
import socket
import subprocess
import sys
import urllib.request
from typing import Callable, Dict, List

from andromity.core.airgap_guard import AirgapBlockedError

_PUBLIC_IP = "1.1.1.1"
_PUBLIC_NAME = "example.com"


def _expect_blocked(name: str, layer: str, probe: Callable[[], object]) -> Dict:
    try:
        probe()
    except AirgapBlockedError as exc:
        return {"check": name, "ok": True, "layer": layer, "detail": f"Blocked ({exc.kind} to {exc.target})."}
    except OSError as exc:
        # urllib wraps the refusal; anything else means the guard did not decide.
        if isinstance(getattr(exc, "reason", None), AirgapBlockedError) or "Air-gap mode blocked" in str(exc):
            return {"check": name, "ok": True, "layer": layer, "detail": "Blocked by the air-gap guard."}
        return {"check": name, "ok": False, "layer": layer,
                "detail": f"Not stopped by the air-gap guard ({type(exc).__name__}). Check your firewall."}
    return {"check": name, "ok": False, "layer": layer, "detail": "The connection was allowed."}


def _tcp() -> None:
    socket.create_connection((_PUBLIC_IP, 443), timeout=3).close()


def _dns() -> None:
    socket.getaddrinfo(_PUBLIC_NAME, 443)


def _udp() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.sendto(b"\x00", ("8.8.8.8", 53))


def _https() -> None:
    urllib.request.urlopen(f"https://{_PUBLIC_NAME}", timeout=3).close()


def _loopback_still_works() -> Dict:
    server = socket.socket()
    try:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        socket.create_connection(("127.0.0.1", port), timeout=3).close()
        return {"check": "This machine (localhost) is still reachable", "ok": True, "layer": "engine",
                "detail": "Local model servers such as Ollama keep working."}
    except OSError as exc:
        return {"check": "This machine (localhost) is still reachable", "ok": False, "layer": "engine",
                "detail": f"Local connection failed ({type(exc).__name__})."}
    finally:
        server.close()


async def _async_connect() -> Dict:
    async def probe() -> None:
        _, writer = await asyncio.wait_for(asyncio.open_connection(_PUBLIC_IP, 443), 3)
        writer.close()

    try:
        await probe()
    except AirgapBlockedError as exc:
        return {"check": "Async connection (model and MCP clients)", "ok": True, "layer": "engine",
                "detail": f"Blocked ({exc.kind} to {exc.target})."}
    except (OSError, asyncio.TimeoutError) as exc:
        return {"check": "Async connection (model and MCP clients)", "ok": False, "layer": "engine",
                "detail": f"Not stopped by the air-gap guard ({type(exc).__name__}). Check your firewall."}
    return {"check": "Async connection (model and MCP clients)", "ok": False, "layer": "engine",
            "detail": "The connection was allowed."}


def _child_python() -> Dict:
    name = "Python program run by the agent"
    if getattr(sys, "frozen", False):
        return {"check": name, "ok": True, "layer": "commands", "skipped": True,
                "detail": "Skipped: this build has no separate Python interpreter."}
    from andromity.core.tools import get_clean_subprocess_env
    code = (
        "import socket\n"
        "try:\n"
        f"    socket.create_connection(('{_PUBLIC_IP}', 443), timeout=3)\n"
        "    print('ALLOWED')\n"
        "except PermissionError as e:\n"
        "    print('BLOCKED' if 'Air-gap' in str(e) else 'OTHER')\n"
        "except OSError:\n"
        "    print('OTHER')\n"
    )
    try:
        result = subprocess.run([sys.executable, "-c", code], env=get_clean_subprocess_env(),
                                capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"check": name, "ok": False, "layer": "commands", "detail": f"Could not start Python ({type(exc).__name__})."}
    verdict = (result.stdout or "").strip().splitlines()[-1:] or [""]
    if verdict[0] == "BLOCKED":
        return {"check": name, "ok": True, "layer": "commands", "detail": "Blocked by the guard loaded into Python programs."}
    return {"check": name, "ok": False, "layer": "commands",
            "detail": "A Python program run by the agent was not stopped by the guard. Check your firewall."}


def _command_proxy_settings() -> Dict:
    from andromity.core.tools import get_clean_subprocess_env
    env = get_clean_subprocess_env()
    dead = all(env.get(k, "").startswith("http://127.0.0.1:9") for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"))
    return {"check": "Proxy block for other commands (curl, git, npm, pip)", "ok": dead, "layer": "commands",
            "detail": ("Set. Tools that honour proxy settings fail instead of connecting; programs that ignore "
                       "them need your firewall.") if dead else "Proxy variables are missing from the command environment."}


async def run_self_test() -> List[Dict]:
    checks: List[Dict] = []
    checks.append(await asyncio.to_thread(_expect_blocked, "DNS lookup of a public name", "engine", _dns))
    checks.append(await asyncio.to_thread(_expect_blocked, "TCP connection to a public address", "engine", _tcp))
    checks.append(await asyncio.to_thread(_expect_blocked, "UDP packet to a public address", "engine", _udp))
    checks.append(await asyncio.to_thread(_expect_blocked, "HTTPS request", "engine", _https))
    checks.append(await _async_connect())
    checks.append(await asyncio.to_thread(_loopback_still_works))
    checks.append(await asyncio.to_thread(_child_python))
    checks.append(_command_proxy_settings())
    return checks
