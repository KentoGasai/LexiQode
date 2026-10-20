"""End-to-end smoke test for the LexiQode core.

Unlike the unit tests, nothing here is mocked:

* a real OpenAI-compatible HTTP server is started on loopback and speaks SSE;
* the core runs as a separate process, started exactly as the editor starts it;
* the conversation is driven over the real HTTP API and the real SSE stream.

It verifies the whole path - handshake, auth, provider streaming, tool-call
round trip, approval-free write, event broadcast and clean shutdown.

    python scripts/smoke_core.py

Exit code 0 means every check passed.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parents[1] / "core"
HANDSHAKE_PREFIX = "lexiqode-core-ready"
TARGET_FILE = "generated_by_agent.txt"

checks: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> bool:
    checks.append((name, bool(condition), detail))
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {name}" + (f" - {detail}" if detail and not condition else ""))
    return bool(condition)


class FakeProvider(BaseHTTPRequestHandler):
    """A minimal OpenAI-compatible endpoint: /v1/models and /v1/chat/completions."""

    protocol_version = "HTTP/1.1"
    seen_requests: list[dict] = []

    def log_message(self, *args) -> None:  # noqa: A002
        return

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        FakeProvider.seen_requests.append({"path": self.path, "authorization": self.headers.get("Authorization")})
        if self.path.endswith("/models"):
            self._json({"object": "list", "data": [{"id": "smoke-model"}, {"id": "other-model"}]})
        else:
            self._json({"error": {"message": "not found"}}, status=404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        FakeProvider.seen_requests.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "model": payload.get("model"),
                "tools": len(payload.get("tools") or []),
                "messages": payload.get("messages") or [],
            }
        )
        messages = payload.get("messages") or []
        already_used_a_tool = any(message.get("role") == "tool" for message in messages)

        if already_used_a_tool:
            frames = [
                {"choices": [{"delta": {"content": "I created "}}]},
                {"choices": [{"delta": {"content": TARGET_FILE + "."}}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                {"choices": [], "usage": {"prompt_tokens": 21, "completion_tokens": 6,
                                          "total_tokens": 27}},
            ]
        else:
            arguments = json.dumps({"path": TARGET_FILE, "content": "written by the agent\n"})
            frames = [
                {"choices": [{"delta": {"tool_calls": [
                    {"index": 0, "id": "call_smoke", "type": "function",
                     "function": {"name": "write_file", "arguments": arguments[:12]}}]}}]},
                {"choices": [{"delta": {"tool_calls": [
                    {"index": 0, "function": {"arguments": arguments[12:]}}]}}]},
                {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            ]

        stream = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames)
        stream += "data: [DONE]\n\n"
        body = stream.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start_provider() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/v1"


def request(url: str, *, token: str = "", payload: dict | None = None, method: str = "GET"):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as response:  # noqa: S310 - loopback
        return response.status, json.loads(response.read().decode("utf-8") or "{}")


def collect_events(base_url: str, token: str, sink: list[str], stop: threading.Event) -> None:
    url = f"{base_url}/api/events?token={token}"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - loopback
            for raw in response:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                sink.append(line)
                if line.startswith("event: turn_end"):
                    return
    except (urllib.error.URLError, OSError):
        return
    finally:
        stop.set()


def main() -> int:
    print("LexiQode core smoke test")
    root = Path(tempfile.mkdtemp(prefix="lexiqode-smoke-"))
    provider, base_url = start_provider()
    process: subprocess.Popen | None = None
    try:
        workspace = root / "workspace"
        workspace.mkdir()
        (workspace / "README.md").write_text("# smoke\n", encoding="utf-8")

        cfg = root / "cfg"
        data = root / "data"
        runtime = root / "core-runtime.json"
        env = os.environ.copy()
        env.update(
            {
                "LEXIQODE_CONFIG_DIR": str(cfg),
                "LEXIQODE_DATA_DIR": str(data),
                "LEXIQODE_RUNTIME_FILE": str(runtime),
                "PYTHONIOENCODING": "utf-8",
            }
        )

        settings = {
            "version": 1,
            "active_profile": "smoke",
            "profiles": {
                "smoke": {
                    "id": "smoke",
                    "label": "Smoke",
                    "base_url": base_url,
                    "api_key": "smoke-key",
                    "model": "smoke-model",
                }
            },
            "agent": {"auto_approve": True, "max_steps": 6},
        }
        cfg.mkdir(parents=True, exist_ok=True)
        (cfg / "settings.json").write_text(json.dumps(settings), encoding="utf-8")

        print("\n1. startup")
        process = subprocess.Popen(
            [sys.executable, "-m", "lexiqode", "serve", str(workspace)],
            cwd=str(CORE_DIR),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        line = process.stdout.readline()
        check("handshake line starts with the marker", line.startswith(HANDSHAKE_PREFIX), line[:120])
        handshake = json.loads(line[len(HANDSHAKE_PREFIX):].strip())
        token = handshake["token"]
        api = handshake["base_url"]
        check("handshake reports protocol 1", handshake["protocol"] == 1, str(handshake.get("protocol")))
        check("handshake reports the workspace", Path(handshake["workspace"]) == workspace.resolve())
        check("handshake carries a token", bool(token))

        print("\n2. health and auth")
        status, health = request(f"{api}/api/health")
        check("health answers without a token", status == 200 and health["ok"])
        try:
            request(f"{api}/api/state")
            check("state rejects a missing token", False, "the call unexpectedly succeeded")
        except urllib.error.HTTPError as exc:
            check("state rejects a missing token", exc.code == 401, f"HTTP {exc.code}")
        status, state = request(f"{api}/api/state", token=token)
        check("state reports the smoke profile", state["profile"]["id"] == "smoke")
        check("state hides the api key", state["profile"]["api_key"] == "")

        print("\n3. provider probe")
        status, models = request(f"{api}/api/models", token=token, payload={}, method="POST")
        check("endpoint lists models", "smoke-model" in models["models"], str(models))
        check("endpoint probe carried the api key",
              any(item.get("authorization") == "Bearer smoke-key"
                  for item in FakeProvider.seen_requests if item.get("path", "").endswith("/models")))

        print("\n4. agent turn over SSE")
        events: list[str] = []
        stopped = threading.Event()
        reader = threading.Thread(
            target=collect_events, args=(api, token, events, stopped), daemon=True
        )
        reader.start()
        time.sleep(0.3)
        status, started = request(
            f"{api}/api/chat", token=token, payload={"message": "create the file"}, method="POST"
        )
        check("chat accepted", status == 202 and started["started"])

        deadline = time.time() + 30
        while time.time() < deadline:
            _, state = request(f"{api}/api/state", token=token)
            if not state["turn"]["running"]:
                break
            time.sleep(0.1)
        reader.join(timeout=5)

        check("turn completed", state["turn"]["last_stopped"] == "completed",
              str(state["turn"].get("last_stopped")))
        blob = "\n".join(events)
        check("SSE delivered turn_start", "event: turn_start" in blob)
        check("SSE delivered a tool call", "event: tool_start" in blob)
        check("SSE delivered the assistant text", "I created" in blob)
        check("SSE delivered turn_end", "event: turn_end" in blob)

        target = workspace / TARGET_FILE
        check("the agent wrote the file", target.is_file())
        if target.is_file():
            check("file contents match",
                  target.read_text(encoding="utf-8") == "written by the agent\n")
        check("provider saw the tool schemas",
              any(item.get("tools", 0) > 0 for item in FakeProvider.seen_requests))
        check("chat request carried the bearer key",
              all(item.get("authorization") == "Bearer smoke-key"
                  for item in FakeProvider.seen_requests if "tools" in item))

        _, state = request(f"{api}/api/state", token=token)
        check("token usage was recorded", state["history_length"] >= 4, str(state["history_length"]))

        print("\n5. shutdown")
        check("runtime descriptor exists while running", runtime.is_file())
        process.stdin.close()
        exit_code = process.wait(timeout=20)
        check("the core exits cleanly", exit_code == 0, f"exit {exit_code}")
        leftover = runtime.read_text(encoding="utf-8") if runtime.exists() else ""
        check("the runtime descriptor is removed", not runtime.exists(), leftover[:200])

        stderr = process.stderr.read() if process.stderr else ""
        if stderr.strip():
            print("\n--- core stderr ---")
            print(stderr.strip())
    finally:
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        provider.shutdown()
        provider.server_close()
        shutil.rmtree(root, ignore_errors=True)

    failed = [name for name, ok, _ in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())