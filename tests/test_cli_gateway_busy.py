"""`andromity run` against a gateway at capacity, on a console that cannot print every symbol."""
import http.server
import io
import json
import os
import subprocess
import sys
import threading
import time

from andromity.cli import _tolerate_narrow_console

MESSAGE = "Andromity's shared models are in very high demand right now, so this request couldn't be served."


def test_narrow_console_replaces_symbols_instead_of_crashing(monkeypatch):
    raw = io.BytesIO()
    narrow = io.TextIOWrapper(raw, encoding="cp1252")
    monkeypatch.setattr(sys, "stdout", narrow)
    _tolerate_narrow_console()
    print("⏱ Expected back ✓ soon")
    narrow.flush()
    assert raw.getvalue().rstrip(b"\r\n") == b"? Expected back ? soon"


def test_headless_run_shows_the_busy_card_at_once(tmp_path):
    body = json.dumps({"error": {"message": MESSAGE, "type": "service_busy", "code": "high_demand",
                                 "action": "switch_model", "retry_after": 10800}}).encode()

    class Gateway(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            data = json.dumps({"object": "list", "data": [{"id": "auto", "object": "model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
            self.send_response(503)
            for key, value in (("Content-Type", "application/json"), ("Content-Length", str(len(body))), ("Retry-After", "10800"),
                               ("x-andromity-error-type", "service_busy"), ("x-andromity-error-action", "switch_model")):
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Gateway)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    conf = tmp_path / "conf"
    conf.mkdir()
    (conf / "config.toml").write_text(
        '[default]\nprovider = "andromity"\nmodel = "auto"\npermission_mode = "safe"\n\n'
        f'[[providers]]\nname = "andromity"\ntype = "andromity"\nbase_url = "http://127.0.0.1:{server.server_address[1]}/v1"\n',
        encoding="utf-8",
    )
    project = tmp_path / "project"
    project.mkdir()
    env = {k: v for k, v in os.environ.items() if k != "PYTEST_CURRENT_TEST"}
    env.update({"ANDROMITY_CONFIG_DIR": str(conf), "PYTHONIOENCODING": "cp1252", "ANDROMITY_TELEMETRY": "0"})
    started = time.monotonic()
    try:
        result = subprocess.run([sys.executable, "-m", "andromity.cli", "run", "say hi"], cwd=project, env=env,
                                capture_output=True, timeout=120)
    finally:
        server.shutdown()
    out = result.stdout.decode("cp1252", errors="replace")
    assert result.returncode == 0, result.stderr.decode("cp1252", errors="replace")[-2000:]
    assert "HIGH DEMAND" in out and MESSAGE in out
    assert "Expected back around" in out
    assert "Traceback" not in out
    assert time.monotonic() - started < 60, "a long wait is shown at once, not retried"
