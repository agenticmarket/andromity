"""Automatic airgap enforcer loaded by Python runtime on startup via PYTHONPATH."""
import importlib.util
import os
import sys

# Load airgap_guard directly without polluting sys.path with parent directories
guard_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "airgap_guard.py")
if os.path.isfile(guard_file):
    try:
        spec = importlib.util.spec_from_file_location("airgap_guard", guard_file)
        if spec and spec.loader:
            mod = importlib.util.module_from_spec(spec)
            sys.modules["airgap_guard"] = mod
            spec.loader.exec_module(mod)
    except Exception as e:
        # If airgap guard fails to load, do not silently allow network access
        if os.environ.get("ANDROMITY_AIRGAP") == "1":
            raise RuntimeError(f"Failed to initialize airgap guard: {e}")
