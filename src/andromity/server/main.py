import asyncio
import json
import logging
import os
import sys
import threading
from typing import Optional

from andromity.server.protocol import (
    PARSE_ERROR,
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
)
from andromity.server.rpc_handler import JsonRpcHandler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stderr,  # IMPORTANT: log to stderr so stdout remains pure JSON-RPC
)
log = logging.getLogger("andromity.server")

# LiteLLM attaches its own colored handler to its "LiteLLM" logger AND that
# logger propagates to the root handler above — every litellm record was
# written twice to the daemon log. Keep litellm's own handler only and raise
# its level so per-request INFO spam stops.
_LITELLM_LOGGER = logging.getLogger("LiteLLM")
_LITELLM_LOGGER.propagate = False
_LITELLM_LOGGER.setLevel(logging.WARNING)


def _ensure_litellm_stub():
    try:
        candidates = []
        if getattr(sys, "frozen", False):
            mei = getattr(sys, "_MEIPASS", None)
            if mei:
                candidates.append(os.path.join(mei, "litellm"))
        temp_dir = os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp"
        if os.path.exists(temp_dir):
            for entry in os.listdir(temp_dir):
                if entry.startswith("_MEI"):
                    candidates.append(os.path.join(temp_dir, entry, "litellm"))
        for d in candidates:
            try:
                target = os.path.join(d, "model_prices_and_context_window_backup.json")
                if not os.path.exists(target):
                    os.makedirs(d, exist_ok=True)
                    with open(target, "w", encoding="utf-8") as f:
                        f.write("{}")
            except Exception:
                pass
    except Exception:
        pass

_ensure_litellm_stub()

def _prewarm_dependencies():
    """Background pre-warm for heavy AI packages so the first turn starts with 0ms import delay."""
    try:
        _ensure_litellm_stub()
        import litellm
        litellm.suppress_debug_info = True
        litellm.drop_params = True
    except Exception:
        pass

threading.Thread(target=_prewarm_dependencies, daemon=True).start()


import secrets
from pathlib import Path
from andromity.config import get_config_dir

MAX_LINE_LENGTH = 1024 * 1024  # 1MB max line size


def _get_or_create_daemon_token() -> str:
    """Retrieve or generate the daemon authentication token."""
    config_dir = get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    token_file = config_dir / "daemon.token"
    if token_file.exists():
        try:
            tok = token_file.read_text(encoding="utf-8").strip()
            if tok:
                return tok
        except Exception:
            pass
    token = secrets.token_urlsafe(32)
    try:
        token_file.write_text(token, encoding="utf-8")
        if os.name != "nt":
            try:
                os.chmod(str(token_file), 0o600)
            except Exception:
                pass
    except Exception as e:
        log.warning("Failed to save daemon token: %s", e)
    return token


async def start_stdio_server():
    """Run JSON-RPC server communicating over standard input/output with thread-safe queue."""
    log.info("Starting Andromity JSON-RPC stdio server...")

    loop = asyncio.get_running_loop()
    input_queue = asyncio.Queue()

    def _stdin_reader_thread():
        try:
            while True:
                line = sys.stdin.readline(MAX_LINE_LENGTH + 1)
                if not line:
                    break
                if len(line) > MAX_LINE_LENGTH:
                    log.warning("Line exceeded max length limit (%d bytes), dropping", MAX_LINE_LENGTH)
                    continue
                loop.call_soon_threadsafe(input_queue.put_nowait, line)
        except Exception as e:
            log.warning("stdin reader thread error: %s", e)
        finally:
            loop.call_soon_threadsafe(input_queue.put_nowait, None)

    reader_thread = threading.Thread(target=_stdin_reader_thread, daemon=True)
    reader_thread.start()

    write_lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(16)

    async def _send_dict(data: dict):
        line = json.dumps(data) + "\n"
        async with write_lock:
            sys.stdout.write(line)
            sys.stdout.flush()

    async def _send_notification(notif: JsonRpcNotification):
        await _send_dict(notif.to_dict())

    handler = JsonRpcHandler(send_notification=_send_notification)
    # Start MCP manager in background (non-blocking) so mcp.list reports live status immediately
    try:
        asyncio.create_task(handler._ensure_mcp_started())
    except Exception as e:
        log.debug("MCP background start failed: %s", e)

    async def _dispatch_request(msg_data: dict):
        async with semaphore:
            try:
                req = JsonRpcRequest.from_dict(msg_data)
                resp = await handler.handle_request(req)
                if resp is not None:
                    await _send_dict(resp.to_dict())
            except Exception as e:
                log.exception("Error processing RPC request: %s", e)

    while True:
        try:
            line = await input_queue.get()
            if line is None:
                log.info("EOF received on stdin, shutting down stdio server.")
                break

            line_str = line.strip()
            if not line_str:
                continue

            try:
                msg = json.loads(line_str)
            except json.JSONDecodeError as e:
                err_resp = JsonRpcResponse.err(None, PARSE_ERROR, f"Invalid JSON: {e}")
                await _send_dict(err_resp.to_dict())
                continue

            if isinstance(msg, dict):
                asyncio.create_task(_dispatch_request(msg))

        except asyncio.CancelledError:
            log.info("Server task cancelled.")
            break
        except Exception as e:
            log.exception("Unexpected error in stdio server loop: %s", e)


async def start_tcp_server(host: str = "127.0.0.1", port: int = 8765, allow_remote: bool = False):
    """Run JSON-RPC server listening on a TCP socket with token auth and connection limits."""
    # Enforce loopback check unless explicitly allowed
    if host not in ("127.0.0.1", "::1", "localhost") and not allow_remote:
        raise ValueError(
            f"Refusing to bind TCP server to non-loopback host {host!r} without --allow-remote flag"
        )

    daemon_token = _get_or_create_daemon_token()
    log.info("Starting Andromity JSON-RPC TCP server on %s:%d (auth enabled)...", host, port)

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        write_lock = asyncio.Lock()
        semaphore = asyncio.Semaphore(8)

        async def _send_dict(data: dict):
            line = json.dumps(data) + "\n"
            async with write_lock:
                writer.write(line.encode("utf-8"))
                await writer.drain()

        async def _send_notification(notif: JsonRpcNotification):
            await _send_dict(notif.to_dict())

        handler = JsonRpcHandler(send_notification=_send_notification)
        try:
            asyncio.create_task(handler._ensure_mcp_started())
        except Exception:
            pass
        peer = writer.get_extra_info("peername")
        log.info("Client connected: %s", peer)

        async def _dispatch_request(msg_data: dict):
            async with semaphore:
                try:
                    req = JsonRpcRequest.from_dict(msg_data)
                    resp = await handler.handle_request(req)
                    if resp is not None:
                        await _send_dict(resp.to_dict())
                except Exception as e:
                    log.exception("Error processing TCP RPC request: %s", e)

        authenticated = False
        try:
            while True:
                line_bytes = await reader.readline()
                if not line_bytes:
                    break
                if len(line_bytes) > MAX_LINE_LENGTH:
                    log.warning("TCP line exceeded length limit from %s", peer)
                    break
                line = line_bytes.decode("utf-8").strip()
                if not line:
                    continue

                # First message can authenticate via token: {"auth": "<token>"} or regular JSON-RPC
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as e:
                    await _send_dict(JsonRpcResponse.err(None, PARSE_ERROR, f"Invalid JSON: {e}").to_dict())
                    continue

                if isinstance(msg, dict):
                    if not authenticated:
                        auth_token = msg.get("auth") or (msg.get("params", {}) if isinstance(msg.get("params"), dict) else {}).get("token")
                        # Local loopback connects automatically or validates token if provided
                        is_local = peer and isinstance(peer, (tuple, list)) and peer[0] in ("127.0.0.1", "::1", "localhost")
                        if is_local or (auth_token and secrets.compare_digest(str(auth_token), daemon_token)):
                            authenticated = True
                        else:
                            await _send_dict(JsonRpcResponse.err(msg.get("id"), -32001, "Unauthorized: Invalid daemon token").to_dict())
                            break

                    asyncio.create_task(_dispatch_request(msg))
        except Exception as e:
            log.warning("Connection error with %s: %s", peer, e)
        finally:
            log.info("Client disconnected: %s", peer)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    server = await asyncio.start_server(handle_client, host, port)
    async with server:
        await server.serve_forever()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Andromity JSON-RPC Daemon Server")
    parser.add_argument("--stdio", action="store_true", default=True, help="Run over stdio (default)")
    parser.add_argument("--port", type=int, default=None, help="Run TCP server on specified port")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="TCP host to bind (default 127.0.0.1)")
    parser.add_argument("--allow-remote", action="store_true", default=False, help="Allow non-loopback TCP host binding")
    args = parser.parse_args()

    if args.port is not None:
        asyncio.run(start_tcp_server(host=args.host, port=args.port, allow_remote=args.allow_remote))
    else:
        asyncio.run(start_stdio_server())


if __name__ == "__main__":
    main()
