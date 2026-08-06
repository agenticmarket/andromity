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
