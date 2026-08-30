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


def _prewarm_dependencies():
    """Background pre-warm for heavy AI packages so the first turn starts with 0ms import delay."""
    try:
        import litellm
        litellm.suppress_debug_info = True
        litellm.drop_params = True
    except Exception:
        pass

threading.Thread(target=_prewarm_dependencies, daemon=True).start()


async def start_stdio_server():
    """Run JSON-RPC server communicating over standard input/output with thread-safe queue."""
    log.info("Starting Andromity JSON-RPC stdio server...")

    loop = asyncio.get_running_loop()
    input_queue = asyncio.Queue()

    def _stdin_reader_thread():
        try:
            while True:
                line = sys.stdin.readline()
                if not line:
                    break
                loop.call_soon_threadsafe(input_queue.put_nowait, line)
        except Exception as e:
            log.warning("stdin reader thread error: %s", e)
        finally:
            loop.call_soon_threadsafe(input_queue.put_nowait, None)

    reader_thread = threading.Thread(target=_stdin_reader_thread, daemon=True)
    reader_thread.start()

    write_lock = asyncio.Lock()

    async def _send_dict(data: dict):
        line = json.dumps(data) + "\n"
        async with write_lock:
            sys.stdout.write(line)
            sys.stdout.flush()

    async def _send_notification(notif: JsonRpcNotification):
        await _send_dict(notif.to_dict())

    handler = JsonRpcHandler(send_notification=_send_notification)

    async def _dispatch_request(msg_data: dict):
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


async def start_tcp_server(host: str = "127.0.0.1", port: int = 8765):
    """Run JSON-RPC server listening on a TCP socket for multi-client connections."""
    log.info("Starting Andromity JSON-RPC TCP server on %s:%d...", host, port)

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        write_lock = asyncio.Lock()

        async def _send_dict(data: dict):
            line = json.dumps(data) + "\n"
            async with write_lock:
                writer.write(line.encode("utf-8"))
                await writer.drain()

        async def _send_notification(notif: JsonRpcNotification):
            await _send_dict(notif.to_dict())

        handler = JsonRpcHandler(send_notification=_send_notification)
        peer = writer.get_extra_info("peername")
        log.info("Client connected: %s", peer)

        async def _dispatch_request(msg_data: dict):
            try:
                req = JsonRpcRequest.from_dict(msg_data)
                resp = await handler.handle_request(req)
                if resp is not None:
                    await _send_dict(resp.to_dict())
            except Exception as e:
                log.exception("Error processing TCP RPC request: %s", e)

        try:
            while True:
                line_bytes = await reader.readline()
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as e:
                    await _send_dict(JsonRpcResponse.err(None, PARSE_ERROR, f"Invalid JSON: {e}").to_dict())
                    continue

                if isinstance(msg, dict):
                    asyncio.create_task(_dispatch_request(msg))
        except Exception as e:
            log.warning("Connection error with %s: %s", peer, e)
        finally:
            log.info("Client disconnected: %s", peer)
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle_client, host, port)
    async with server:
        await server.serve_forever()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Andromity JSON-RPC Daemon Server")
    parser.add_argument("--stdio", action="store_true", default=True, help="Run over stdio (default)")
    parser.add_argument("--port", type=int, default=None, help="Run TCP server on specified port")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="TCP host to bind")
    args = parser.parse_args()

    if args.port is not None:
        asyncio.run(start_tcp_server(host=args.host, port=args.port))
    else:
        asyncio.run(start_stdio_server())


if __name__ == "__main__":
    main()
