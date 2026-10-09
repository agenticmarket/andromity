"""Rigid regression tests for airgap subprocess environment isolation and config API key synchronization."""
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from andromity.core.tools import get_clean_subprocess_env
from andromity.config import ConfigManager


def test_airgap_subprocess_env_no_core_path_pollution():
    """Verify that get_clean_subprocess_env with ANDROMITY_AIRGAP=1 does not pollute PYTHONPATH with core directory."""
    with patch.dict(os.environ, {"ANDROMITY_AIRGAP": "1", "PYTHONPATH": ""}):
        env = get_clean_subprocess_env()
        
        # Verify proxy and startup
        assert env.get("HTTP_PROXY") == "http://127.0.0.1:9"
        assert env.get("HTTPS_PROXY") == "http://127.0.0.1:9"
        assert "airgap_guard.py" in env.get("PYTHONSTARTUP", "")
        
        # Verify PYTHONPATH only contains sitecustomize, NOT core or andromity root
        pythonpath = env.get("PYTHONPATH", "")
        assert "airgap_sitecustomize" in pythonpath
        
        # Core directory must NOT be in PYTHONPATH (prevents shadowing user modules like db, tools, mcp)
        parts = pythonpath.split(os.pathsep)
        core_dir = str(Path(__file__).parent.parent / "src" / "andromity" / "core")
        andromity_dir = str(Path(__file__).parent.parent / "src" / "andromity")
        for part in parts:
            resolved_part = str(Path(part).resolve())
            assert resolved_part != str(Path(core_dir).resolve())
            assert resolved_part != str(Path(andromity_dir).resolve())


def test_sitecustomize_does_not_insert_core_into_sys_path():
    """Verify that sitecustomize loads airgap_guard without polluting sys.path with parent directory."""
    sitecustomize_path = Path(__file__).parent.parent / "src" / "andromity" / "core" / "airgap_sitecustomize" / "sitecustomize.py"
    core_dir = str((Path(__file__).parent.parent / "src" / "andromity" / "core").resolve())

    # Record sys.path before execution
    initial_sys_path = list(sys.path)
    
    with open(sitecustomize_path, "r", encoding="utf-8") as f:
        code = compile(f.read(), str(sitecustomize_path), "exec")
        # Execute in isolated globals
        exec(code, {"__file__": str(sitecustomize_path)})

    # Ensure core_dir was not prepended to sys.path
    assert sys.path[0] == initial_sys_path[0]
    for p in sys.path:
        if p not in initial_sys_path:
            assert Path(p).resolve() != Path(core_dir).resolve()


def test_config_set_api_key_nvidia_and_andromity(tmp_path):
    """Verify that set_api_key sets NVIDIA_API_KEY and ANDROMITY_API_KEY in os.environ and config."""
    cm = ConfigManager(config_dir=tmp_path)
    
    # Clean any preexisting env vars
    os.environ.pop("NVIDIA_API_KEY", None)
    os.environ.pop("ANDROMITY_API_KEY", None)
    
    cm.set_api_key("nvidia", "nv-test-key-999")
    assert os.environ.get("NVIDIA_API_KEY") == "nv-test-key-999"
    assert cm.get_api_key("nvidia") == "nv-test-key-999"
    
    cm.set_api_key("andromity", "andro-test-key-888")
    assert os.environ.get("ANDROMITY_API_KEY") == "andro-test-key-888"
    assert cm.get_api_key("andromity") == "andro-test-key-888"
