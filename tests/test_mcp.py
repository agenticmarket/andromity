"""Tests for MCP stdio client, tool schema conversion, and live JSON-RPC execution."""
import asyncio
import json
import sys
import tempfile
import pytest
from pathlib import Path
from unittest.mock import patch
from andromity.core.mcp import MCPClientManager, MCPToolInfo, MCPStdioSession
from andromity.core.tools import register_mcp_manager, ToolRegistry, execute_tool, execute_tool_async, list_tools


# Python code for a mock MCP server communicating over stdio JSON-RPC
MOCK_MCP_SERVER_CODE = """
import sys
import json

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        
        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})

        if method == "initialize":
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "mock-mcp", "version": "1.0"},
                    "capabilities": {"tools": {}}
                }
            }
            sys.stdout.write(json.dumps(resp) + "\\n")
            sys.stdout.flush()

        elif method == "notifications/initialized":
            pass

        elif method == "tools/list":
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "tools": [
                        {
                            "name": "calc_add",
                            "description": "Add two numbers together",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "a": {"type": "number"},
                                    "b": {"type": "number"}
                                },
                                "required": ["a", "b"]
                            }
                        },
                        {
                            "name": "to_upper",
                            "description": "Convert text to uppercase",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "text": {"type": "string"}
                                },
                                "required": ["text"]
                            }
                        }
                    ]
                }
            }
            sys.stdout.write(json.dumps(resp) + "\\n")
            sys.stdout.flush()

        elif method == "tools/call":
            tool_name = params.get("name")
            args = params.get("arguments", {})

            if tool_name == "calc_add":
                res = str(args.get("a", 0) + args.get("b", 0))
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": res}]
                    }
                }
            elif tool_name == "to_upper":
                res = str(args.get("text", "")).upper()
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": res}]
                    }
                }
            else:
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": f"Unknown tool {tool_name}"}]
                    }
                }
            sys.stdout.write(json.dumps(resp) + "\\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
"""


def test_mcp_tool_info_to_schema():
    tool = MCPToolInfo(
        server_name="git",
        name="git_status",
        description="Show working tree status",
        input_schema={
            "type": "object",
            "properties": {
                "repo_path": {"type": "string", "description": "Path to repository"}
            },
            "required": ["repo_path"],
        },
    )
    schema = tool.to_openai_schema()
    assert schema["type"] == "function"
    assert schema["function"]["name"] == "mcp__git__git_status"
    assert "Show working tree status" in schema["function"]["description"]
    assert "[git]" in schema["function"]["description"]
    assert schema["function"]["parameters"]["properties"]["repo_path"]["type"] == "string"


def test_mcp_client_manager_load_config(tmp_path):
    andromity_dir = tmp_path / ".andromity"
    andromity_dir.mkdir()
    config_file = andromity_dir / "mcp.json"
    config_file.write_text(json.dumps({
        "mcpServers": {
            "sqlite": {
                "command": "uvx",
                "args": ["mcp-server-sqlite", "--db-path", "test.db"],
                "env": {"DEBUG": "1"}
            }
        }
    }), encoding="utf-8")

    manager = MCPClientManager(str(tmp_path))
    configs = manager.load_config()

    servers = configs.get("mcpServers", {})
    assert "sqlite" in servers
    assert servers["sqlite"]["command"] == "uvx"
    assert servers["sqlite"]["args"] == ["mcp-server-sqlite", "--db-path", "test.db"]
    assert servers["sqlite"]["env"] == {"DEBUG": "1"}


@pytest.mark.asyncio
async def test_mcp_execute_unknown_server():
    manager = MCPClientManager("/nonexistent")
    res = await manager.execute_mcp_tool("mcp__unknown__tool", {})
    assert "Error: MCP server 'unknown' is not active" in res


@pytest.mark.asyncio
async def test_mcp_live_stdio_server_integration(tmp_path):
    # 1. Create a mock MCP server python script
    server_script = tmp_path / "mock_mcp_server.py"
    server_script.write_text(MOCK_MCP_SERVER_CODE, encoding="utf-8")

    # 2. Configure .andromity/mcp.json
    andromity_dir = tmp_path / ".andromity"
    andromity_dir.mkdir(exist_ok=True)
    config_file = andromity_dir / "mcp.json"
    config_file.write_text(json.dumps({
        "mcpServers": {
            "mockserver": {
                "command": sys.executable,
                "args": [str(server_script)],
            }
        }
    }), encoding="utf-8")

    # 3. Start MCP Client Manager
    with patch("pathlib.Path.home", return_value=tmp_path):
        manager = MCPClientManager(str(tmp_path))
        await manager.start_all()

    try:
        # Check server connected and discovered tools
        assert "mockserver" in manager.sessions
        tools = manager.get_all_tools()
        tool_names = [t.full_name for t in tools]
        assert "mcp__mockserver__calc_add" in tool_names
        assert "mcp__mockserver__to_upper" in tool_names

        # 4. Call calc_add tool
        calc_result = await manager.execute_mcp_tool(
            "mcp__mockserver__calc_add", {"a": 42, "b": 58}
        )
        assert calc_result == "100"

        # 5. Call to_upper tool
        upper_result = await manager.execute_mcp_tool(
            "mcp__mockserver__to_upper", {"text": "hello andromity"}
        )
        assert upper_result == "HELLO ANDROMITY"

        # 6. Test Error from unknown tool call on server
        err_result = await manager.execute_mcp_tool(
            "mcp__mockserver__nonexistent_tool", {}
        )
        assert "MCP Tool Error" in err_result

        # 7. Test integration with ToolRegistry & execute_tool
        register_mcp_manager(manager)
        registry = ToolRegistry()

        # Check deferred prompt includes MCP tools
        prompt_catalog = registry.get_deferred_prompt_catalog()
        assert "mcp__mockserver__calc_add" in prompt_catalog

        # 7. Check list_tools and execute_tool_async
        register_mcp_manager(manager)
        executed = await execute_tool_async("mcp__mockserver__calc_add", {"a": 15, "b": 25})
        assert executed == "40"

        # 8. Check status summary
        summary = manager.get_status_summary()
        assert summary["configured"] == 1
        assert summary["active"] == 1
        assert summary["failed"] == 0
        assert summary["tools_count"] == 2
        assert "mockserver" in summary["servers"]
        assert summary["servers"]["mockserver"]["status"] == "running"

    finally:
        await manager.stop_all()
        register_mcp_manager(None)


@pytest.mark.asyncio
async def test_mcp_server_failure_handling(tmp_path):
    """Test that a misconfigured or crashing MCP server records error status."""
    bad_config = {
        "mcpServers": {
            "bad_server": {
                "command": "nonexistent_binary_xyz_123",
                "args": []
            }
        }
    }
    andromity_dir = tmp_path / ".andromity"
    andromity_dir.mkdir(parents=True)
    (andromity_dir / "mcp.json").write_text(json.dumps(bad_config), encoding="utf-8")

    with patch("pathlib.Path.home", return_value=tmp_path):
        manager = MCPClientManager(project_path=str(tmp_path))
        await manager.start_all()

    summary = manager.get_status_summary()
    assert summary["configured"] == 1
    assert summary["active"] == 0
    assert summary["failed"] == 1
    assert summary["servers"]["bad_server"]["status"] == "error"
    assert summary["servers"]["bad_server"]["error"] is not None

