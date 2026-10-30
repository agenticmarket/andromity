"""Tests for config."""
import tempfile
from pathlib import Path
from andromity.config import ConfigManager


def test_config_creation():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        assert cm.config_path.exists()


def test_config_defaults():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        assert cm.get("default", "provider") == "andromity"
        assert cm.get("default", "profile") == "builder"
        assert cm.get("default", "permission_mode") == "safe"
        assert "npm run dev" in cm.get("default", "allowed_commands")


def test_unreadable_config_is_kept_before_it_can_be_overwritten():
    with tempfile.TemporaryDirectory() as tmpdir:
        broken = b'[[providers]]\nname = "anthropic"\napi_key = "sk-ant-keep-me"\n[default\n'
        (Path(tmpdir) / "config.toml").write_bytes(broken)
        cm = ConfigManager(config_dir=Path(tmpdir))
        assert cm.load_error and cm.unreadable_copy is not None
        assert cm.unreadable_copy.read_bytes() == broken
        assert cm.get("default", "provider", "fallback") == "fallback"

        cm.set("default", "provider", "anthropic")
        assert b"sk-ant-keep-me" in cm.unreadable_copy.read_bytes(), "saving must not lose the original keys"

        (Path(tmpdir) / "config.toml").write_bytes(broken)
        again = ConfigManager(config_dir=Path(tmpdir))
        assert again.unreadable_copy == cm.unreadable_copy
        assert len(list(Path(tmpdir).glob("config.toml.unreadable-*"))) == 1

        (Path(tmpdir) / "config.toml").write_text('[default]\nprovider = "groq"\n', encoding="utf-8")
        fixed = ConfigManager(config_dir=Path(tmpdir))
        assert fixed.load_error is None and fixed.unreadable_copy is None
        assert fixed.get("default", "provider") == "groq"


def test_config_get_set():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        cm.set("test", "key", "value")
        assert cm.get("test", "key") == "value"


def test_config_providers():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        names = [p["name"] for p in cm.list_providers()]
        assert "andromity" in names and "ollama" in names


def test_config_provider_lookup():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        assert cm.get_provider_config("andromity") is not None
        assert cm.get_provider_config("nonexistent") is None


# ─── Trust management tests ───────────────────────────────────────────────────

def test_trust_new_folder_untrusted():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        project = str(Path(tmpdir) / "myproject")
        assert cm.is_trusted(project) is False


def test_trust_set_and_check():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        project = str(Path(tmpdir) / "myproject")
        cm.set_trusted(project)
        assert cm.is_trusted(project) is True


def test_trust_revoke():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        project = str(Path(tmpdir) / "myproject")
        cm.set_trusted(project)
        cm.revoke_trust(project)
        assert cm.is_trusted(project) is False


def test_trust_different_paths_independent():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        p1 = str(Path(tmpdir) / "proj1")
        p2 = str(Path(tmpdir) / "proj2")
        cm.set_trusted(p1)
        assert cm.is_trusted(p1) is True
        assert cm.is_trusted(p2) is False


def test_add_mcp_server_writes_and_merges():
    """add_mcp_server writes to <project>/.andromity/mcp.json and preserves
    existing servers when adding more."""
    import json
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        assert cm.add_mcp_server(tmpdir, "first", {"command": "npx", "args": ["a"]})
        mcp_file = Path(tmpdir) / ".andromity" / "mcp.json"
        assert mcp_file.exists()
        data = json.loads(mcp_file.read_text(encoding="utf-8"))
        assert data["mcpServers"]["first"]["command"] == "npx"

        # Second add merges instead of overwriting
        assert cm.add_mcp_server(tmpdir, "second", {"serverUrl": "https://x/sse"})
        data = json.loads(mcp_file.read_text(encoding="utf-8"))
        assert "first" in data["mcpServers"]
        assert data["mcpServers"]["second"]["serverUrl"] == "https://x/sse"

        # Replacing an existing name keeps the file valid
        assert cm.add_mcp_server(tmpdir, "first", {"command": "uvx", "args": []})
        data = json.loads(mcp_file.read_text(encoding="utf-8"))
        assert data["mcpServers"]["first"]["command"] == "uvx"


def test_nvidia_provider_catalog_and_key(monkeypatch):
    from andromity.core.models import MODEL_CATALOG, get_models_for_provider
    assert "nvidia" in MODEL_CATALOG
    models = get_models_for_provider("nvidia")
    assert [m["id"] for m in models] == [
        "nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b",
        "mistralai/mistral-large-4-1t-a52b", "minimaxai/minimax-m3.1-flash",
    ]
    assert all(m.get("name") and m.get("context") for m in models)

    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test123")
        assert cm.get_api_key("nvidia") == "nvapi-test123"


def test_pinned_models_config():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        # Initial defaults
        defaults = cm.get_pinned_models()
        assert len(defaults) == 2
        assert defaults[0]["id"] == "auto"

        # Explicitly set pinned models
        cm.set_pinned_models([])
        assert cm.get_pinned_models() == []

        # Toggle to pin
        pinned = cm.toggle_pinned_model("anthropic/claude-3-5-sonnet", provider="openrouter", name="Claude 3.5 Sonnet")
        assert len(pinned) == 1
        assert pinned[0]["id"] == "anthropic/claude-3-5-sonnet"
        assert pinned[0]["provider"] == "openrouter"

        # Read back from newly created ConfigManager
        cm2 = ConfigManager(config_dir=Path(tmpdir))
        assert cm2.get_pinned_models() == pinned

        # Toggle to unpin
        unpinned = cm2.toggle_pinned_model("anthropic/claude-3-5-sonnet", provider="openrouter")
        assert len(unpinned) == 0
        assert cm2.get_pinned_models() == []






def test_set_ollama_base_url_updates_the_ollama_connection():
    import pytest
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        assert cm.set_ollama_base_url("http://192.168.1.20:11434/") == "http://192.168.1.20:11434"
        assert cm.get_provider_config("ollama")["base_url"] == "http://192.168.1.20:11434"
        assert ConfigManager(config_dir=Path(tmpdir)).get_provider_config("ollama")["base_url"] == "http://192.168.1.20:11434"
        for bad in ("ftp://host:11434", "http://user:pw@host:11434", "http://host:11434/?x=1", ""):
            with pytest.raises(ValueError):
                cm.set_ollama_base_url(bad)
        assert cm.get_provider_config("ollama")["base_url"] == "http://192.168.1.20:11434"


async def test_config_status_and_ollama_host_rpcs():
    import pytest
    from andromity.config import config
    from andromity.server.rpc_handler import JsonRpcHandler
    handler = JsonRpcHandler(send_notification=lambda n: None)
    status = await handler.rpc_config_status({})
    assert status == {"path": str(config.config_path), "load_error": None, "unreadable_copy": None}

    result = await handler.rpc_config_set_ollama_host({"url": "http://10.0.0.5:11434/"})
    assert result == {"success": True, "base_url": "http://10.0.0.5:11434"}
    assert config.get_provider_config("ollama")["base_url"] == "http://10.0.0.5:11434"
    with pytest.raises(ValueError):
        await handler.rpc_config_set_ollama_host({"url": "http://user:secret@10.0.0.5:11434"})
