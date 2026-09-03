#!/usr/bin/env python3
"""
Probe: drive the Andromity daemon over stdio exactly like the VS Code extension
does — but from plain core Python, with no VS Code involved — and timestamp
every line, so we can see precisely where a turn stalls (or that it doesn't).

Usage (from repo root):
    .\\venv\\Scripts\\python.exe scripts\\probe-daemon.py --engine binary --prompt "check python version"
    .\\venv\\Scripts\\python.exe scripts\\probe-daemon.py --engine python --prompt "check python version"

Interpretation:
    - Turn ends with agent/done  -> daemon is fine; stall (if any) is elsewhere.
    - No 'stream_completion start' after the tool -> hang is BEFORE the LLM call.
    - 'stream_completion start' but no end -> provider stream stalled.
    - [STDOUT-CORRUPT] lines     -> stdout corruption (transport bug).
"""
import argparse
import json
import subprocess
import sys
import threading
import time
import os

TERMINAL_METHODS = {"agent/done", "agent/error", "agent/cancelled"}


class Probe:
    def __init__(self):
        self.turn_ended = threading.Event()
        self.ended_method = None
        self.lock = threading.Lock()
        self.method_counts = {}
        self.parse_failures = 0
        self.last_line_at = None
        self.session_id = None
        self.ready = threading.Event()

    def ts(self):
        t = time.time()
        return time.strftime("%H:%M:%S", time.localtime(t)) + f".{int(t % 1 * 1000):03d}"

    def note(self, msg):
        print(f"[{self.ts()}] {msg}", flush=True)

    def handle_stdout_line(self, raw):
        line = raw.strip()
        if not line:
            return
        self.last_line_at = time.time()
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            with self.lock:
                self.parse_failures += 1
            self.note(f"[STDOUT-CORRUPT] {line[:200]!r}")
            return
        method = msg.get("method")
        if method:
            with self.lock:
                self.method_counts[method] = self.method_counts.get(method, 0) + 1
            if method in TERMINAL_METHODS:
                self.note(f"[STDOUT] << {method} >> {json.dumps(msg.get('params', {}))[:200]}")
                self.ended_method = method
                self.turn_ended.set()
            elif method.startswith("agent/"):
                detail = ""
                p = msg.get("params", {})
                if method == "agent/textDelta":
                    detail = repr(p.get("text", ""))[:80]
                elif method == "agent/toolStart":
                    detail = p.get("tool_name", "")
                elif method == "agent/toolResult":
                    detail = repr(p.get("result", ""))[:80]
                self.note(f"[STDOUT] {method} {detail}")
        else:
            result = msg.get("result")
            if (
                isinstance(result, dict)
                and self.session_id is None
                and result.get("id")
                and "name" in result
            ):
                self.session_id = result["id"]
                self.note(f"[STDOUT] response -> session_id={self.session_id}")
            else:
                self.note(f"[STDOUT] response {json.dumps(result)[:120]}")

    def pump(self, stream, tag, handler):
        for raw in iter(stream.readline, ""):
            if not raw:
                break
            if tag == "stderr" and "Starting Andromity JSON-RPC stdio server" in raw:
                self.ready.set()
            handler(raw)
        if tag == "stdout":
            self.note("[STDOUT] EOF — daemon closed stdout")

    def run(self, args):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        exe = args.exe or os.path.join(
            root, "vscode-extension", "bin", "win32-x64", "andromity-server.exe"
        )
        if args.engine == "python":
            venv_python = os.path.join(root, "venv", "Scripts", "python.exe")
            cmd = [venv_python, "-m", "andromity.server", "--stdio"]
            self.note(f"ENGINE: python subprocess ({venv_python})")
        else:
            cmd = [exe, "--stdio"]
            self.note(f"ENGINE: bundled binary ({exe})")

        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"

        t0 = time.time()
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            errors="replace", cwd=args.project, env=env,
        )
        self.note(f"spawned PID {proc.pid}")

        threading.Thread(target=self.pump, args=(proc.stdout, "stdout", self.handle_stdout_line), daemon=True).start()
        threading.Thread(
            target=self.pump, args=(proc.stderr, "stderr",
                                    lambda raw: print(f"[{self.ts()}] [STDERR] {raw.rstrip()}".encode("ascii", errors="replace").decode("ascii"), flush=True)),
            daemon=True,
        ).start()

        project = os.path.abspath(args.project)

        def send(obj):
            self.note(f"[STDIN ] >> {obj.get('method', '?')} {json.dumps(obj.get('params', {}))[:120]}")
            proc.stdin.write(json.dumps(obj) + "\n")
            proc.stdin.flush()

        # Wait for the daemon to actually be ready (onefile binaries can take
        # 10-30s to extract + initialize; never a fixed sleep).
        if not self.ready.wait(timeout=90):
            self.note("!! daemon never reported ready within 90s — aborting")
            proc.kill()
            return 2
        self.note(f"daemon ready after {time.time() - t0:.1f}s")
        send({"jsonrpc": "2.0", "id": 1, "method": "session.create",
              "params": {"name": "probe", "project_path": project}})

        for _ in range(100):
            if self.session_id:
                break
            time.sleep(0.1)
        if not self.session_id:
            self.note("!! no session_id received — aborting")
            proc.kill()
            return 2

        self.note("--- sending prompt (turn starts now) ---")
        prompt_params = {
            "session_id": self.session_id,
            "prompt": args.prompt,
            "project_path": project,
            "permission_mode": "full",
        }
        if args.provider:
            prompt_params["provider"] = args.provider
        if args.model:
            prompt_params["model"] = args.model
        send({"jsonrpc": "2.0", "id": 2, "method": "agent.prompt", "params": prompt_params})

        ended = self.turn_ended.wait(timeout=args.timeout)
        if ended:
            self.note(f"=== TURN ENDED ({self.ended_method}) after {time.time() - t0:.1f}s total ===")
            rc = 0
        else:
            self.note(f"=== STALL: no terminal event within {args.timeout}s ===")
            with self.lock:
                self.note(f"    notifications received: {self.method_counts}")
                self.note(f"    stdout parse failures: {self.parse_failures}")
            try:
                send({"jsonrpc": "2.0", "id": 3, "method": "agent.cancel",
                      "params": {"session_id": self.session_id}})
            except Exception:
                pass
            self.turn_ended.wait(timeout=5)
            rc = 1

        time.sleep(1.0)
        proc.kill()
        self.note("probe finished")
        return rc


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", choices=["binary", "python"], default="binary")
    p.add_argument("--exe", default=None)
    p.add_argument("--prompt", default="check python version")
    p.add_argument("--provider", default=None)
    p.add_argument("--model", default=None)
    p.add_argument("--project", default=os.getcwd())
    p.add_argument("--timeout", type=float, default=150)
    args = p.parse_args()
    sys.exit(Probe().run(args))


if __name__ == "__main__":
    main()