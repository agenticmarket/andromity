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
        assert cm.get("default", "provider") == "anthropic"
        assert cm.get("default", "profile") == "builder"


def test_config_get_set():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        cm.set("test", "key", "value")
        assert cm.get("test", "key") == "value"


def test_config_providers():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        names = [p["name"] for p in cm.list_providers()]
        assert "anthropic" in names and "ollama" in names


def test_config_provider_lookup():
    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        assert cm.get_provider_config("anthropic") is not None
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


def test_nvidia_provider_catalog_and_key(monkeypatch):
    from andromity.core.models import MODEL_CATALOG, get_models_for_provider
    assert "nvidia" in MODEL_CATALOG
    models = get_models_for_provider("nvidia")
    assert len(models) >= 4
    model_ids = [m["id"] for m in models]
    assert "nvidia/llama-3.1-nemotron-70b-instruct" in model_ids
    assert "deepseek-ai/deepseek-r1" in model_ids

    with tempfile.TemporaryDirectory() as tmpdir:
        cm = ConfigManager(config_dir=Path(tmpdir))
        monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test123")
        assert cm.get_api_key("nvidia") == "nvapi-test123"


