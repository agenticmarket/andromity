import pytest
from pathlib import Path
from andromity.core.handoff import write_handoff, read_handoff, list_handoffs


def test_write_and_read_handoff(tmp_path):
    proj_dir = str(tmp_path)
    doc = write_handoff(
        phase="authentication",
        from_session="auth-worker",
        status="complete",
        produced={
            "endpoints": ["/api/auth/login", "/api/auth/refresh"],
            "middleware": "src/middleware/auth.py",
            "env_vars": ["JWT_SECRET", "JWT_EXPIRY"],
        },
        blocked_on=[],
        next_steps=["UI session should send Bearer token in headers"],
        notes="Uses RS256 signing algorithm.",
        project_path=proj_dir,
    )
    assert doc["phase"] == "authentication"
    assert doc["status"] == "complete"
    assert len(doc["produced"]["endpoints"]) == 2

    # Read back
    read_doc = read_handoff("authentication", project_path=proj_dir)
    assert read_doc is not None
    assert read_doc["from_session"] == "auth-worker"
    assert read_doc["produced"]["endpoints"] == ["/api/auth/login", "/api/auth/refresh"]

    # Nonexistent
    missing = read_handoff("database", project_path=proj_dir)
    assert missing is None


def test_list_handoffs(tmp_path):
    proj_dir = str(tmp_path)
    write_handoff(phase="phase_one", from_session="w1", status="complete", project_path=proj_dir)
    write_handoff(phase="phase_two", from_session="w2", status="in_progress", project_path=proj_dir)

    all_docs = list_handoffs(project_path=proj_dir)
    assert len(all_docs) == 2
    phases = [d["phase"] for d in all_docs]
    assert "phase_one" in phases
    assert "phase_two" in phases
