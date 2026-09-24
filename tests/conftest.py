import pytest
from andromity.core.tools import register_session


@pytest.fixture(autouse=True)
def _isolate_test_env(tmp_path, monkeypatch):
    """Ensure tests run in an isolated config directory and database to prevent polluting real user sessions."""
    test_conf = tmp_path / "global_conf" / ".andromity"
    test_conf.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("ANDROMITY_CONFIG_DIR", str(test_conf))
    from andromity.core.db import set_custom_db_path
    set_custom_db_path(test_conf / "test_andromity.db")
    register_session(None)
    yield
    register_session(None)
    set_custom_db_path(None)
