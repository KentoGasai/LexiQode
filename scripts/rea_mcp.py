"""Minimal MCP stdio client - drives REA's MCP server from a plain terminal.

Why this file exists: MCP servers are started by the *client that hosts the
model* (Cline, Cursor, LexiQode's own MCP panel). An assistant session only gets
the MCP tools its host registered, so a REA conversation that lives inside an
editor without a REA registration sees no REA tools at all. This script closes
that gap the protocol way - it speaks the same JSON-RPC over stdio that an IDE
integration speaks, so REA's tools stay usable from any shell, including this
agent's `run_commands`.

    python scripts/rea_mcp.py tools
    python scripts/rea_mcp.py call analyze_javascript_application "{\"path\": \"D:/app\"}"
    python scripts/rea_mcp.py raw '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

REA is discovered in this order: ``REA_COMMAND`` (full command line) -> the
cached ``npx`` copy already on this machine -> ``npx -y rea-agents@latest``.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "lexiqode-rea-bridge", "version": "0.1.0"}
DEFAULT_TIMEOUT = 900.0


def cached_npx_rea() -> Path | None:
    """A ``rea-agents`` copy npx already downloaded, newest version first."""

    root = Path(os.environ.get("LOCALAPPDATA", "")) / "npm-cache" / "_npx"
    if not root.is_dir():
        return None
    candidates: list[tuple[tuple[int, ...], Path]] = []
    for entry in root.iterdir():
        package = entry / "node_modules" / "rea-agents"
        manifest = package / "package.json"
        if not manifest.is_file():
            continue
        try:
            version = json.loads(manifest.read_text(encoding="utf-8")).get("version", "0")
            numbers = tuple(int(part) for part in str(version).split(".") if part.isdigit())
        except (OSError, ValueError):
            continue
        script = package / "scripts" / "rea.mjs"
        if script.is_file():
            candidates.append((numbers, script))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def rea_command() -> list[str]:
    """Command that starts REA's MCP stdio server."""

    override = os.environ.get("REA_COMMAND", "").strip()
    if override:
        return [*override.split(), "mcp"] if "mcp" not in override.split() else override.split()
    script = cached_npx_rea()
    node = shutil.which("node")
    if script is not None and node:
        return [node, str(script), "mcp"]
    npx = shutil.which("npx") or "npx"
    return [npx, "-y", "rea-agents@latest", "mcp"]


class McpStdioClient:
    """JSON-RPC 2.0 over stdio, one message per line (the MCP stdio transport)."""

    def __init__(self, command: list[str], *, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.command = command
        self.timeout = timeout
        self.process: subprocess.Popen[str] | None = None
        self._inbox: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._stderr: list[str] = []
        self._next_id = 0
        self.log: list[str] = []

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> dict[str, Any]:
        self.process = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
        )
        threading.Thread(target=self._read_stdout, name="rea-mcp-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name="rea-mcp-stderr", daemon=True).start()
        return self.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": CLIENT_INFO,
            },
        )

    def close(self) -> None:
        if self.process is None:
            return
        try:
            if self.process.stdin:
                self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:  # pragma: no cover - safety net
            self.process.kill()
        self.process = None

    def __enter__(self) -> McpStdioClient:
        self.start()
        self.notify("notifications/initialized", {})
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------ reading
    def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                self.log.append(f"non-json stdout: {line[:200]}")
                continue
            if isinstance(message, dict):
                self._inbox.put(message)
        self._inbox.put(None)

    def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        for line in self.process.stderr:
            self._stderr.append(line.rstrip())

    def stderr_tail(self, lines: int = 20) -> str:
        return "\n".join(self._stderr[-lines:])

    # ------------------------------------------------------------------ protocol
    def send(self, message: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("the MCP server is not running")
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._next_id += 1
        wanted = self._next_id
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": wanted, "method": method}
        if params is not None:
            payload["params"] = params
        self.send(payload)
        while True:
            try:
                message = self._inbox.get(timeout=self.timeout)
            except queue.Empty as exc:
                raise TimeoutError(
                    f"no answer to {method} in {self.timeout:.0f}s\n{self.stderr_tail()}"
                ) from exc
            if message is None:
                raise RuntimeError(f"the MCP server exited during {method}\n{self.stderr_tail()}")
            if message.get("id") != wanted:
                # server-initiated request or notification: answer/ignore politely
                if "id" in message and "method" in message:
                    self._answer_server_request(message)
                else:
                    self.log.append(f"notification: {message.get('method')}")
                continue
            if "error" in message:
                raise RuntimeError(f"{method} failed: {json.dumps(message['error'])}")
            return message.get("result") or {}

    def _answer_server_request(self, message: dict[str, Any]) -> None:
        """Sampling/roots are optional here; a refusal keeps REA moving."""

        self.send(
            {
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {"code": -32601, "message": f"unsupported: {message.get('method')}"},
            }
        )

    # ------------------------------------------------------------- convenience
    def tools(self) -> list[dict[str, Any]]:
        return list(self.request("tools/list").get("tools") or [])

    def call(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        return self.request("tools/call", {"name": name, "arguments": arguments or {}})


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to a legacy code page; REA answers contain UTF-8
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):  # pragma: no cover - redirected stream
            pass

    parser = argparse.ArgumentParser(prog="rea_mcp", description="Drive REA's MCP server")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("command", help="print the command that starts REA's MCP server")
    sub.add_parser("tools", help="list the tools REA exposes")

    call = sub.add_parser("call", help="call one tool")
    call.add_argument("tool")
    call.add_argument("arguments", nargs="?", default="{}", help="JSON arguments")

    raw = sub.add_parser("raw", help="send one JSON-RPC message")
    raw.add_argument("message")

    args = parser.parse_args(argv)
    command = args.command or "tools"

    if command == "command":
        print(" ".join(rea_command()))
        return 0

    if command == "raw":
        message = json.loads(args.message)
        with McpStdioClient(rea_command(), timeout=args.timeout) as client:
            client.send(message)
            if "id" not in message:
                return 0
            while True:
                answer = client._inbox.get(timeout=args.timeout)  # noqa: SLF001
                if answer is None:
                    print("server exited", file=sys.stderr)
                    return 2
                if answer.get("id") == message["id"]:
                    print(json.dumps(answer, ensure_ascii=False, indent=2))
                    return 0

    with McpStdioClient(rea_command(), timeout=args.timeout) as client:
        if command == "tools":
            listed = client.tools()
            if args.json:
                print(json.dumps(listed, ensure_ascii=False, indent=2))
                return 0
            print(f"{len(listed)} tool(s):")
            for tool in listed:
                description = (tool.get("description") or "").strip().splitlines()
                summary = description[0] if description else ""
                print(f"  - {tool.get('name')}: {summary[:110]}")
            return 0
        if command == "call":
            arguments = json.loads(args.arguments)
            result = client.call(args.tool, arguments)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())