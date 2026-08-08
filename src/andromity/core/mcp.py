"""Model Context Protocol (MCP) client manager — connects to MCP servers over stdio JSON-RPC."""
import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


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

    def __init__(self, name: str, command: str, args: List[str], env: Optional[Dict[str, str]] = None, cwd: Optional[str] = None):
        self.name = name
        self.command = command
        self.args = args
        self.env = env or {}
        self.cwd = cwd or os.getcwd()
        self.process: Optional[asyncio.subprocess.Process] = None
        self._request_id = 0
        self._pending_requests: Dict[int, asyncio.Future] = {}
        self._reader_task: Optional[asyncio.Task] = None
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

            # Start background stdout reader
            self._reader_task = asyncio.create_task(self._read_loop())

            # Perform initialize handshake
            init_res = await self.send_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "andromity", "version": "1.0.0"},
            })
            if not init_res:
                self.error = "Initialize handshake timed out or failed"
                log.warning("MCP server '%s' did not respond to initialize", self.name)
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

    async def send_request(self, method: str, params: Dict[str, Any], timeout: float = 30.0) -> Optional[Dict[str, Any]]:
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
            self._pending_requests.pop(req_id, None)
            return None

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

    async def stop(self):
        """Gracefully terminate MCP server process."""
        if self._reader_task:
            self._reader_task.cancel()
        if self.process:
            try:
                self.process.terminate()
                await asyncio.wait_for(self.process.wait(), timeout=2.0)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None
        self._initialized = False


class MCPClientManager:
    """Manages all configured MCP servers and tool dispatching for Andromity."""

    def __init__(self, project_path: str = ""):
        self.project_path = project_path or os.getcwd()
        self.sessions: Dict[str, MCPStdioSession] = {}
        self.server_status: Dict[str, dict] = {}

    def load_config(self) -> Dict[str, Any]:
        """Load MCP server definitions from project or global config."""
        candidates = [
            Path(self.project_path) / ".andromity" / "mcp.json",
            Path(self.project_path) / ".vscode" / "mcp.json",
            Path.home() / ".andromity" / "mcp.json",
        ]
        merged_servers: Dict[str, Any] = {}
        for p in candidates:
            if p.is_file():
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    # Support both "mcpServers" (Claude/Gemini/Andromity format) and "servers" (VS Code format)
                    servers = data.get("mcpServers") or data.get("servers") or {}
                    for k, v in servers.items():
                        if k not in merged_servers and isinstance(v, dict):
                            merged_servers[k] = v
                except Exception as e:
                    log.warning("Failed to parse MCP config at %s: %s", p, e)
        return {"mcpServers": merged_servers}

    async def start_all(self):
        """Start all configured MCP servers."""
        config = self.load_config()
        servers = config.get("mcpServers", {})
        self.server_status.clear()
        for name, srv_conf in servers.items():
            command = srv_conf.get("command")
            args = srv_conf.get("args", [])
            env = srv_conf.get("env", {})
            if command:
                session = MCPStdioSession(name=name, command=command, args=args, env=env, cwd=self.project_path)
                success = await session.start()
                if success:
                    self.sessions[name] = session
                    self.server_status[name] = {
                        "status": "running",
                        "tools": len(session.tools),
                        "error": None,
                        "command": f"{command} {' '.join(args)}".strip(),
                    }
                else:
                    self.server_status[name] = {
                        "status": "error",
                        "tools": 0,
                        "error": session.error or "Failed to connect",
                        "command": f"{command} {' '.join(args)}".strip(),
                    }

    def get_status_summary(self) -> dict:
        """Return an aggregated status dict suitable for UI display."""
        configured = len(self.server_status)
        active = len(self.sessions)
        failed = sum(1 for s in self.server_status.values() if s.get("status") == "error")
        total_tools = len(self.get_all_tools())
        return {
            "configured": configured,
            "active": active,
            "failed": failed,
            "tools_count": total_tools,
            "servers": dict(self.server_status),
        }

    def get_all_tools(self) -> List[MCPToolInfo]:
        """Collect all discovered tools across all active MCP sessions."""
        all_tools = []
        for session in self.sessions.values():
            all_tools.extend(session.tools)
        return all_tools

    async def execute_mcp_tool(self, full_tool_name: str, arguments: Dict[str, Any]) -> str:
        """Dispatch a tool call to the matching MCP server."""
        # Expected format: mcp__<server_name>__<tool_name>
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

    async def stop_all(self):
        """Stop all running MCP servers."""
        for session in list(self.sessions.values()):
            await session.stop()
        self.sessions.clear()
