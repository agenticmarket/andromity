"""Model Context Protocol (MCP) client manager — connects to MCP servers over stdio JSON-RPC."""
import asyncio
import json
import logging
import os
import sys
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# Suppress the Windows ProactorEventLoop "unclosed transport" ResourceWarning.
# This is a known Python bug on Windows (bpo-43232) where pipe handles raise
# ValueError("I/O operation on closed pipe") during GC after explicit close.
# The pipes ARE closed — they just report incorrectly during __del__.
if sys.platform == "win32":
    warnings.filterwarnings(
        "ignore",
        message="unclosed transport",
        category=ResourceWarning,
    )


@dataclass
class MCPToolInfo:
    server_name: str
    name: str
    description: str
    input_schema: Dict[str, Any]

    @property
    def full_name(self) -> str:
        """Prefixed tool name to avoid collisions across multiple MCP servers."""
        return f"mcp__{self.server_name}__{self.name}"

    def to_openai_schema(self) -> Dict[str, Any]:
        """Convert MCP inputSchema to OpenAI tool definition."""
        return {
            "type": "function",
            "function": {
                "name": self.full_name,
                "description": f"[{self.server_name}] {self.description}",
                "parameters": self.input_schema or {"type": "object", "properties": {}},
            },
        }


class MCPStdioSession:
    """Manages an active stdio connection to a single MCP server."""

    def __init__(
        self,
        name: str,
        command: str,
        args: List[str],
        env: Optional[Dict[str, str]] = None,
        cwd: Optional[str] = None,
    ):
        self.name = name
        self.command = command
        self.args = args
        self.env = env or {}
        self.cwd = cwd or os.getcwd()
        self.process: Optional[asyncio.subprocess.Process] = None
        self._request_id = 0
        self._pending_requests: Dict[int, asyncio.Future] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self.stderr_tail: List[str] = []   # ring buffer of recent stderr lines
        self.tools: List[MCPToolInfo] = []
        self._initialized = False
        self.error: Optional[str] = None

    async def start(self) -> bool:
        """Spawn server process, start JSON-RPC listener, and complete initialize handshake."""
        try:
            merged_env = dict(os.environ)
            merged_env.update(self.env)

            full_cmd = [self.command] + self.args
            log.info("Starting MCP server '%s': %s", self.name, " ".join(full_cmd))

            import shutil
            executable = shutil.which(self.command) or self.command

            self.process = await asyncio.create_subprocess_exec(
                executable,
                *self.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=merged_env,
                cwd=self.cwd,
            )

            # Start background stdout reader + stderr tail capture. The stderr
            # pipe MUST be drained or a chatty server can fill the pipe buffer
            # and deadlock. We keep the tail so failures are diagnosable.
            self._reader_task = asyncio.create_task(self._read_loop())
            self._stderr_task = asyncio.create_task(self._stderr_loop())

            # Perform initialize handshake
            init_res = await self.send_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "andromity", "version": "1.0.0"},
            })
            if not init_res:
                self.error = "Initialize handshake timed out or failed"
                log.warning("MCP server '%s' did not respond to initialize", self.name)
                await self._cleanup()
                return False

            # Send initialized notification
            await self.send_notification("notifications/initialized", {})
            self._initialized = True
            self.error = None

            # Query tools list
            await self.refresh_tools()
            log.info("MCP server '%s' ready with %d tools", self.name, len(self.tools))
            return True

        except Exception as e:
            self.error = str(e)
            log.warning("Failed to start MCP server '%s': %s", self.name, e)
            await self._cleanup()
            return False

    async def refresh_tools(self) -> List[MCPToolInfo]:
        """Fetch available tools from the MCP server."""
        if not self._initialized:
            return []
        try:
            res = await self.send_request("tools/list", {})
            raw_tools = res.get("tools", []) if res else []
            self.tools = [
                MCPToolInfo(
                    server_name=self.name,
                    name=t.get("name", ""),
                    description=t.get("description", ""),
                    input_schema=t.get("inputSchema", {}),
                )
                for t in raw_tools
            ]
            return self.tools
        except Exception as e:
            log.error("Failed to list tools for MCP server '%s': %s", self.name, e)
            return []

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """Invoke a tool on the MCP server and return string result."""
        if not self._initialized:
            return f"Error: MCP server '{self.name}' is not running."
        try:
            res = await self.send_request("tools/call", {
                "name": tool_name,
                "arguments": arguments,
            })
            if not res:
                return f"Error: No response from MCP server '{self.name}' for '{tool_name}'."

            content_blocks = res.get("content", [])
            text_outputs = []
            for block in content_blocks:
                if isinstance(block, dict) and block.get("type") == "text":
                    text_outputs.append(block.get("text", ""))
                elif isinstance(block, str):
                    text_outputs.append(block)

            result_str = "\n".join(text_outputs) if text_outputs else json.dumps(res, indent=2)
            if res.get("isError"):
                return f"MCP Tool Error: {result_str}"
            return result_str

        except Exception as e:
            return f"Error executing MCP tool '{tool_name}' on server '{self.name}': {e}"

    async def send_request(
        self,
        method: str,
        params: Dict[str, Any],
        timeout: float = 30.0,
    ) -> Optional[Dict[str, Any]]:
        """Send JSON-RPC request and await response."""
        if not self.process or not self.process.stdin:
            return None
        self._request_id += 1
        req_id = self._request_id
        future = asyncio.get_running_loop().create_future()
        self._pending_requests[req_id] = future

        msg = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params,
        }
        try:
            line = json.dumps(msg) + "\n"
            self.process.stdin.write(line.encode("utf-8"))
            await self.process.stdin.drain()
            return await asyncio.wait_for(future, timeout=timeout)
        except Exception as e:
            log.warning("MCP request %d (%s) failed: %s", req_id, method, e)
            return None
        finally:
            self._pending_requests.pop(req_id, None)

    async def send_notification(self, method: str, params: Dict[str, Any]):
        """Send JSON-RPC notification (no response expected)."""
        if not self.process or not self.process.stdin:
            return
        msg = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        try:
            line = json.dumps(msg) + "\n"
            self.process.stdin.write(line.encode("utf-8"))
            await self.process.stdin.drain()
        except Exception as e:
            log.debug("MCP notification failed: %s", e)

    async def _read_loop(self):
        """Continuously read JSON-RPC responses from server stdout."""
        if not self.process or not self.process.stdout:
            return
        while True:
            try:
                line = await self.process.stdout.readline()
                if not line:
                    break
                line_str = line.decode("utf-8", errors="replace").strip()
                if not line_str:
                    continue
                try:
                    data = json.loads(line_str)
                except json.JSONDecodeError:
                    continue

                req_id = data.get("id")
                if req_id in self._pending_requests:
                    fut = self._pending_requests.pop(req_id)
                    if not fut.done():
                        if "result" in data:
                            fut.set_result(data["result"])
                        elif "error" in data:
                            fut.set_result(data)
                        else:
                            fut.set_result(data)
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug("MCP read error: %s", e)
                break

    async def _stderr_loop(self):
        """Drain the server's stderr into a ring buffer (never block the pipe)."""
        if not self.process or not self.process.stderr:
            return
        try:
            while True:
                line = await self.process.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    self.stderr_tail.append(text)
                    if len(self.stderr_tail) > 50:
                        del self.stderr_tail[:-50]
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    def is_alive(self) -> bool:
        """True while the process is running and the handshake completed."""
        return (
            self._initialized
            and self.process is not None
            and self.process.returncode is None
        )

    async def _cleanup(self, process=None):
        """
        Close all subprocess pipes and cancel the reader task.
        Called by both stop() and failed start() to prevent Windows
        ResourceWarning: unclosed transport (bpo-43232).

        ``process`` should be passed explicitly by stop() so this method
        can close stdin/stdout BEFORE the caller nulls self.process.
        Falls back to self.process for backward compat (e.g. failed start).
        """
        # 1. Cancel and await the reader + stderr tasks so their pipe references
        #    die cleanly.
        for task_attr in ("_reader_task", "_stderr_task"):
            task = getattr(self, task_attr)
            if task and not task.done():
                task.cancel()
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=1.0)
                except Exception:
                    pass
            setattr(self, task_attr, None)

        # 2. Resolve all pending futures to avoid dangling coroutines
        for fut in self._pending_requests.values():
            if not fut.done():
                fut.cancel()
        self._pending_requests.clear()

        # 3. Close transports explicitly to prevent Windows ResourceWarning.
        proc = process or self.process
        if proc:
            if proc.stdin:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
            # Force close the underlying BaseSubprocessTransport to cleanly shut down Proactor pipes
            if hasattr(proc, "_transport") and proc._transport:
                try:
                    proc._transport.close()
                except Exception:
                    pass

        # 4. Yield so the event loop processes close callbacks before GC.
        await asyncio.sleep(0.1)

    async def stop(self):
        """Gracefully terminate MCP server process and close all pipes."""
        self._initialized = False

        proc = self.process  # save ref BEFORE nulling — passed to _cleanup()
        self.process = None  # null early so send_request() gates exit immediately

        if proc:
            # Terminate or kill the child process
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=3.0)
            except Exception:
                try:
                    proc.kill()
                    await asyncio.wait_for(proc.wait(), timeout=1.0)
                except Exception:
                    pass

        # Clean up pipes/tasks, passing the saved proc so stdin/stdout can
        # be closed even though self.process is now None.
        await self._cleanup(process=proc)


class MCPSseSession:
    """Connects to a remote MCP server over HTTP SSE using the official python SDK."""
    def __init__(self, name: str, url: str, headers: Optional[Dict[str, str]] = None):
        self.name = name
        self.url = url
        self.headers = headers or {}
        self.tools: List[Any] = []
        self.error: Optional[str] = None
        self.stderr_tail: List[str] = []

        self._session = None
        self._bg_task: Optional[asyncio.Task] = None
        self._init_event = asyncio.Event()

    def is_alive(self) -> bool:
        """True while the SSE background connection task is still running."""
        return self._bg_task is not None and not self._bg_task.done()

    async def start(self) -> bool:
        self.error = None
        self._init_event.clear()
        self._bg_task = asyncio.create_task(self._run())
        await self._init_event.wait()
        return self._session is not None

    async def _run(self):
        from mcp.client.sse import sse_client
        from mcp.client.session import ClientSession
        
        try:
            async with sse_client(self.url, headers=self.headers) as (read_stream, write_stream):
                async with ClientSession(read_stream, write_stream) as session:
                    self._session = session
                    await session.initialize()
                    
                    # Fetch tools — normalize raw SDK Tool objects → MCPToolInfo
                    tools_response = await session.list_tools()
                    self.tools = [
                        MCPToolInfo(
                            server_name=self.name,
                            name=getattr(t, 'name', '') or '',
                            description=getattr(t, 'description', '') or '',
                            input_schema=getattr(t, 'inputSchema', None) or {},
                        )
                        for t in (tools_response.tools or [])
                    ]
                    log.info("MCP SSE Server '%s' started with %d tools.", self.name, len(self.tools))
                    
                    self._init_event.set()
                    
                    # Wait until cancelled
                    try:
                        # Dummy await forever
                        await asyncio.sleep(86400 * 365)
                    except asyncio.CancelledError:
                        pass
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self.error = f"Failed to connect to SSE: {e}"
            log.error(self.error)
        finally:
            self._session = None
            if not self._init_event.is_set():
                self._init_event.set()

    async def stop(self):
        if self._bg_task:
            self._bg_task.cancel()
            try:
                await self._bg_task
            except asyncio.CancelledError:
                pass
            self._bg_task = None
        self._session = None
        
    async def get_tools(self) -> List[Any]:
        if self._session:
            try:
                resp = await self._session.list_tools()
                # Normalize to MCPToolInfo so callers always get a uniform type
                self.tools = [
                    MCPToolInfo(
                        server_name=self.name,
                        name=getattr(t, 'name', '') or '',
                        description=getattr(t, 'description', '') or '',
                        input_schema=getattr(t, 'inputSchema', None) or {},
                    )
                    for t in (resp.tools or [])
                ]
            except Exception as e:
                log.error("Failed to list tools: %s", e)
        return self.tools
        
    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        if not self._session:
            return f"Session '{self.name}' not connected"
        try:
            resp = await self._session.call_tool(tool_name, arguments)
            # The SDK returns CallToolResult with .content array of TextContent
            return "\n".join(c.text for c in resp.content if hasattr(c, 'text'))
        except Exception as e:
            return f"Error executing tool '{tool_name}': {e}"
            
    async def send_request(self, method: str, params: Dict[str, Any], timeout: float = 30.0) -> Optional[Dict[str, Any]]:
        # Map internal JSON-RPC calls to SDK calls if necessary, but TUI usually uses call_tool directly.
        # This acts as a dummy fallback for compatibility.
        log.warning("MCPSseSession.send_request called for %s - use SDK methods instead", method)
        return None

    async def send_notification(self, method: str, params: Dict[str, Any]):
        pass


class MCPClientManager:
    """Manages all configured MCP servers and tool dispatching for Andromity."""

    def __init__(self, project_path: str = ""):
        self.project_path = project_path or os.getcwd()
        self.sessions: Dict[str, MCPStdioSession] = {}
        self.server_status: Dict[str, dict] = {}

    def _set_status(self, name: str, status: str = None, tools: int = None,
                    error: str = None, command: str = None,
                    error_detail: str = None) -> None:
        """Update one server's status entry, stamping timestamps.

        Status entries carry: status, tools, error, command, error_detail,
        started_at (ISO), updated_at (ISO).
        """
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        entry = dict(self.server_status.get(name, {}))
        if status is not None:
            entry["status"] = status
        if tools is not None:
            entry["tools"] = tools
        if error is not None:
            entry["error"] = error
        if command is not None:
            entry["command"] = command
        if error_detail is not None:
            entry["error_detail"] = error_detail
        entry["updated_at"] = now
        if entry.get("status") == "running" and not entry.get("started_at"):
            entry["started_at"] = now
        elif entry.get("status") in ("error", "stopped", "disabled", "needs_auth"):
            entry["started_at"] = None
        self.server_status[name] = entry

    def load_config(self) -> Dict[str, Any]:
        """Load MCP server definitions from project or global config."""
        candidates = [
            Path(self.project_path) / ".andromity" / "mcp.json",
            Path(self.project_path) / ".vscode" / "mcp.json",
            Path.home() / ".andromity" / "mcp.json",
            Path.home() / ".gemini" / "config" / "mcp_config.json",
        ]
        merged_servers: Dict[str, Any] = {}
        for p in candidates:
            if p.is_file():
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    servers = data.get("mcpServers") or data.get("servers") or {}
                    for k, v in servers.items():
                        if k not in merged_servers and isinstance(v, dict):
                            merged_servers[k] = v
                except Exception as e:
                    log.warning("Failed to parse MCP config at %s: %s", p, e)
        return {"mcpServers": merged_servers}

    async def start_all(self):
        """Start all enabled configured MCP servers concurrently.

        For remote HTTP servers (serverUrl only, no command):
          - If a cached OAuth token exists → convert to mcp-remote with Bearer header
          - Otherwise → mark as needs_auth so the settings UI shows Connect button
        """
        from andromity.core.oauth import load_token, ensure_fresh_token
        from andromity.config import config as app_config

        mcp_config = self.load_config()
        servers    = mcp_config.get("mcpServers", {})
        self.server_status.clear()
        for name in servers.keys():
            self._set_status(name, status="initializing", tools=0, error=None, command="")

        # Start all servers concurrently
        await asyncio.gather(*[
            self.start_server(name, srv_conf)
            for name, srv_conf in servers.items()
        ], return_exceptions=True)

    async def start_server(self, name: str, srv_conf: Optional[dict] = None, trusted: bool = False):
        """Start a single configured MCP server."""
        from andromity.core.oauth import ensure_fresh_token

        # Set initializing state
        self._set_status(name, status="initializing", tools=0, error=None, command="")

        if srv_conf is None:
            srv_conf = self.load_config().get("mcpServers", {}).get(name, {})

        disabled   = srv_conf.get("disabled", False)
        command    = srv_conf.get("command", "")
        server_url = srv_conf.get("serverUrl") or srv_conf.get("url", "")
        args       = srv_conf.get("args", [])
        env        = srv_conf.get("env", {})

        if disabled:
            self._set_status(name, status="disabled", tools=0, error=None,
                             command=f"{command} {' '.join(str(a) for a in args)}".strip())
            return

        if not command and not server_url:
            self._set_status(
                name, status="error", tools=0,
                error="No command or serverUrl configured",
                error_detail="Add a 'command' (stdio) or 'serverUrl' (remote) entry to mcp.json.",
            )
            return

        # Check if this is an explicit remote server OR a legacy mcp-remote proxy command
        is_legacy_sse = "mcp-remote" in args or "mcp-remote" in command
        if is_legacy_sse:
            # Extract URL from args (e.g. ['-y', 'mcp-remote', 'https://mcp.neon.tech/sse'])
            for arg in args:
                if arg.startswith("http://") or arg.startswith("https://"):
                    server_url = arg
                    break
            command = "" # Nullify command to force remote mode

        # ── Remote HTTP / SSE server ──────────────────────────────────────
        if server_url and not command:
            # Check for cached OAuth token
            token = await ensure_fresh_token(name)
            if not token:
                # No token — check PAT headers in existing config
                headers = srv_conf.get("headers", {})
                pat = headers.get("Authorization", "").replace("Bearer ", "").strip()
                if not pat:
                    # Mark as needs_auth — settings UI will show Connect button
                    self._set_status(
                        name, status="needs_auth", tools=0,
                        error="Authentication required", command="",
                        error_detail=(
                            f"Server '{name}' needs an OAuth token or PAT. "
                            "Open Settings → MCP and authenticate to connect."
                        ),
                    )
                    return
                token = pat

            # Start native Python SSE session
            headers = {"Authorization": f"Bearer {token}"}
            session = MCPSseSession(name=name, url=server_url, headers=headers)
            success = await session.start()
            cmd_str = f"SSE {server_url}"
            if success:
                self.sessions[name] = session
                self._set_status(name, status="running", tools=len(session.tools),
                                 error=None, command=cmd_str)
            else:
                self._set_status(name, status="error", tools=0,
                                 error=session.error or "Failed to connect",
                                 command=cmd_str, error_detail=session.error)
            return

        # ── Stdio server ──────────────────────────────────────
        if not command:
            return

        from andromity.config import config
        is_user_home = Path(self.project_path).resolve() == Path.home().resolve()
        if not is_user_home and not trusted and not config.is_trusted(self.project_path) and not srv_conf.get("trusted"):
            cmd_str = f"{command} {' '.join(str(a) for a in args)}".strip()
            self._set_status(
                name, status="needs_trust", tools=0,
                error="Untrusted folder",
                command=cmd_str,
                error_detail=f"MCP stdio server '{name}' was blocked because this project folder is not trusted. Mark as trusted to enable local command execution."
            )
            return

        session = MCPStdioSession(
            name=name, command=command, args=args,
            env=env, cwd=self.project_path,
        )
        success = await session.start()
        cmd_str = f"{command} {' '.join(str(a) for a in args)}".strip()
        if success:
            self.sessions[name] = session
            self._set_status(name, status="running", tools=len(session.tools),
                             error=None, command=cmd_str)
        else:
            self._set_status(name, status="error", tools=0,
                             error=session.error or "Failed to connect",
                             command=cmd_str,
                             error_detail="\n".join(session.stderr_tail[-25:]) or session.error)

    async def restart(self, name: str) -> bool:
        """Stop (if running) and start a single server. Returns True if running."""
        srv_conf = self.load_config().get("mcpServers", {}).get(name, {})
        if name in self.sessions:
            await self.sessions[name].stop()
            del self.sessions[name]
        self.server_status.pop(name, None)
        await self.start_server(name, srv_conf, trusted=True)
        return self.server_status.get(name, {}).get("status") == "running"

    def check_liveness(self) -> List[str]:
        """
        Detect sessions whose process/connection died since the last check and
        mark them errored so the UI shows live status instead of stale 'running'.

        Returns the list of server names whose status changed. Runs synchronously
        (it only inspects process objects) — safe to call from the UI loop.
        """
        changed = []
        for name, session in list(self.sessions.items()):
            if session.is_alive():
                continue
            if isinstance(session, MCPStdioSession):
                code = session.process.returncode if session.process else None
                detail = "\n".join(session.stderr_tail[-25:])
                err = "Process exited unexpectedly"
                if code is not None:
                    err += f" (exit code {code})"
            else:
                err = "Connection lost"
                detail = ""
            self._set_status(name, status="error", tools=0, error=err,
                             error_detail=detail or None,
                             command=self.server_status.get(name, {}).get("command", ""))
            changed.append(name)
        for name in changed:
            self.sessions.pop(name, None)
        return changed

    def get_status_summary(self) -> dict:
        """Return an aggregated status dict suitable for UI display."""
        configured = len(self.server_status)
        active = len(self.sessions)
        failed = sum(1 for s in self.server_status.values() if s.get("status") == "error")
        initializing = sum(1 for s in self.server_status.values() if s.get("status") == "initializing")
        needs_auth = sum(1 for s in self.server_status.values() if s.get("status") == "needs_auth")
        disabled = sum(1 for s in self.server_status.values() if s.get("status") == "disabled")
        total_tools = len(self.get_all_tools())
        return {
            "configured": configured,
            "active": active,
            "failed": failed,
            "initializing": initializing,
            "needs_auth": needs_auth,
            "disabled": disabled,
            "tools_count": total_tools,
            "servers": dict(self.server_status),
        }

    def get_all_tools(self) -> List[MCPToolInfo]:
        """Collect all discovered tools across all active MCP sessions.
        Only returns MCPToolInfo instances — filters out any raw SDK Tool objects
        that may have slipped through (e.g. from SSE sessions before normalization).
        Servers disabled in mcp.json are skipped even if a stale session lingers.
        """
        all_tools = []
        for name, session in self.sessions.items():
            if self.server_status.get(name, {}).get("status") == "disabled":
                continue
            for t in session.tools:
                if isinstance(t, MCPToolInfo):
                    all_tools.append(t)
                else:
                    # Defensive: wrap raw SDK Tool objects into MCPToolInfo
                    try:
                        all_tools.append(MCPToolInfo(
                            server_name=session.name,
                            name=getattr(t, 'name', '') or '',
                            description=getattr(t, 'description', '') or '',
                            input_schema=getattr(t, 'inputSchema', None) or {},
                        ))
                    except Exception:
                        pass
        return all_tools

    async def execute_mcp_tool(self, full_tool_name: str, arguments: Dict[str, Any]) -> str:
        """Dispatch a tool call to the matching MCP server."""
        if not full_tool_name.startswith("mcp__"):
            return f"Error: '{full_tool_name}' is not an MCP tool."
        parts = full_tool_name.split("__", 2)
        if len(parts) < 3:
            return f"Error: Invalid MCP tool name format '{full_tool_name}'."
        server_name, tool_name = parts[1], parts[2]
        session = self.sessions.get(server_name)
        if not session:
            return f"Error: MCP server '{server_name}' is not active or configured."
        return await session.call_tool(tool_name, arguments)

    async def stop_server(self, name: str):
        """Safely stop and remove a single running MCP server session."""
        session = self.sessions.pop(name, None)
        if session:
            try:
                await session.stop()
            except Exception as e:
                log.warning("Error stopping MCP server %s: %s", name, e)
        self.server_status.pop(name, None)

    async def stop_all(self):
        """Stop all running MCP servers concurrently."""
        await asyncio.gather(*[
            session.stop() for session in list(self.sessions.values())
        ], return_exceptions=True)
        self.sessions.clear()
        self.server_status.clear()
