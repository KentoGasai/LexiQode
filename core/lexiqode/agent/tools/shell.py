"""Shell execution.

The agent must be able to build, test and lint a project, which means running
real commands with the user's privileges. That is why this tool belongs to the
``command`` family and is gated by the approval policy by default: nothing runs
until the user has seen the exact command line.
"""

from __future__ import annotations

import subprocess
from typing import Any

from ...errors import ToolError
from .base import FAMILY_COMMAND, Tool, ToolContext, ToolResult


def _decode(raw: bytes | None) -> str:
    if not raw:
        return ""
    for encoding in ("utf-8", "cp866", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


class RunCommandTool(Tool):
    name = "run_command"
    description = (
        "Run a shell command inside the workspace and return its exit code, "
        "stdout and stderr. Use it for builds, tests, linters and git."
    )
    family = FAMILY_COMMAND
    parameters = {
        "command": {"type": "string", "description": "Command line to execute."},
        "cwd": {"type": "string", "description": "Directory relative to the workspace root. Defaults to the root."},
        "timeout": {"type": "integer", "description": "Seconds before the command is stopped."},
    }
    required = ["command"]

    def describe(self, arguments: dict[str, Any]) -> str:
        return str(arguments.get("command") or "").strip()[:200]

    def approval_detail(self, arguments: dict[str, Any]) -> str:
        cwd = arguments.get("cwd") or "."
        return f"cwd: {cwd}\ntimeout: {arguments.get('timeout') or 'default'}"

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        command = str(arguments.get("command") or "").strip()
        if not command:
            raise ToolError("a command is required")
        cwd = context.resolve(str(arguments.get("cwd") or "."), must_exist=True)
        if not cwd.is_dir():
            raise ToolError(f"{context.relative(cwd)} is not a directory")
        timeout = int(arguments.get("timeout") or context.settings.command_timeout)
        timeout = max(1, min(timeout, 3600))
        budget = context.settings.max_tool_output

        try:
            completed = subprocess.run(
                command,
                shell=True,
                cwd=str(cwd),
                capture_output=True,
                # Nothing is behind this stdin: the editor starts the core with a
                # pipe nobody writes to. A command that waits for input - an
                # interactive prompt, an editor, a confirmation - would otherwise
                # sit there until the timeout and report a timeout instead of
                # saying that it wanted to ask something.
                stdin=subprocess.DEVNULL,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            partial = (_decode(exc.stdout) + _decode(exc.stderr)).strip()
            raise ToolError(
                f"command timed out after {timeout}s"
                + (f"; partial output:\n{partial[:2000]}" if partial else "")
            ) from exc
        except OSError as exc:
            raise ToolError(f"cannot start the command: {exc}") from exc

        stdout = _decode(completed.stdout)
        stderr = _decode(completed.stderr)
        parts: list[str] = [f"exit code: {completed.returncode}"]
        if stdout.strip():
            parts.append(f"stdout:\n{stdout.rstrip()}")
        if stderr.strip():
            parts.append(f"stderr:\n{stderr.rstrip()}")
        if not stdout.strip() and not stderr.strip():
            parts.append("(no output)")
        body = "\n\n".join(parts)
        truncated = len(body) > budget
        if truncated:
            # Keep the tail: build errors and failing assertions are at the end.
            body = "...output truncated...\n" + body[-budget:]

        return ToolResult(
            ok=completed.returncode == 0,
            content=body,
            meta={"exit_code": completed.returncode, "truncated": truncated},
        )