from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union
import json


# JSON-RPC 2.0 Standard Error Codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Application-Specific Error Codes (-32000 to -32099)
SESSION_NOT_FOUND = -32001
AGENT_BUSY = -32002
EXECUTION_CANCELLED = -32003
TOOL_REJECTED = -32004
UNAUTHORIZED = -32005


@dataclass
class JsonRpcRequest:
    id: Optional[Union[str, int]]
    method: str
    params: Dict[str, Any] = field(default_factory=dict)
    jsonrpc: str = "2.0"

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "JsonRpcRequest":
        return cls(
            id=data.get("id"),
            method=data.get("method", ""),
            params=data.get("params") or {},
            jsonrpc=data.get("jsonrpc", "2.0"),
        )

    def is_notification(self) -> bool:
        return self.id is None


@dataclass
class JsonRpcResponse:
    id: Optional[Union[str, int]]
    result: Optional[Any] = None
    error: Optional[Dict[str, Any]] = None
    jsonrpc: str = "2.0"

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"jsonrpc": self.jsonrpc, "id": self.id}
        if self.error is not None:
            d["error"] = self.error
        else:
            d["result"] = self.result
        return d

    @classmethod
    def ok(cls, req_id: Optional[Union[str, int]], result: Any) -> "JsonRpcResponse":
        return cls(id=req_id, result=result)

    @classmethod
    def err(cls, req_id: Optional[Union[str, int]], code: int, message: str, data: Optional[Any] = None) -> "JsonRpcResponse":
        err_obj: Dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            err_obj["data"] = data
        return cls(id=req_id, error=err_obj)


@dataclass
class JsonRpcNotification:
    method: str
    params: Dict[str, Any] = field(default_factory=dict)
    jsonrpc: str = "2.0"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "jsonrpc": self.jsonrpc,
            "method": self.method,
            "params": self.params,
        }
