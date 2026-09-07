import pytest
from andromity.core.tools import register_session


@pytest.fixture(autouse=True)
def _reset_session_context():
    """Ensure no test leaks an active session into another test."""
    register_session(None)
    yield
    register_session(None)
