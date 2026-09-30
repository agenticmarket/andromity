"""Automatic airgap enforcer loaded by Python runtime on startup via PYTHONPATH."""
import os
import sys

# Ensure parent directory (src/andromity/core) is on sys.path to import airgap_guard
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

try:
    import airgap_guard  # noqa: F401
except Exception as e:
    # If airgap guard fails to load, do not silently allow network access
    if os.environ.get("ANDROMITY_AIRGAP") == "1":
        raise RuntimeError(f"Failed to initialize airgap guard: {e}")
