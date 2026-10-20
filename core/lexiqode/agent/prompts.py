"""System prompt assembly.

The prompt states the rules the loop actually enforces (workspace containment,
approval for writes and commands) so the model spends its steps on the task
rather than testing boundaries.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from .context import workspace_snapshot
from .tools.registry import ToolRegistry

if TYPE_CHECKING:
    from .modes import AgentMode

BASE_PROMPT = """You are LexiQode, a coding agent working directly in the user's workspace.

How you work:
- Inspect before you change. Read the relevant files and search the project
  before proposing or applying an edit.
- Make the smallest change that fully solves the problem, in the style already
  used by the surrounding code.
- Prefer grep and glob over guessing paths. Never invent file contents.
- After changing code, verify it: run the project's tests, linter or build when
  they exist, and report exactly what you ran and what it returned.
- If a task needs information you cannot obtain, say so plainly instead of
  guessing.

Tool contract:
- You may only touch paths inside the workspace. Requests outside it are refused.
- Writing files and running shell commands require the user's approval; a refusal
  comes back as a failed tool call, so adapt instead of retrying the same action.
- When a tool fails, read the message, correct the arguments and try a different
  approach. Do not repeat an identical failing call.

Answer style:
- Be concise and concrete. Lead with the outcome.
- Reference files as workspace-relative paths.
- Do not paste whole files back to the user; quote only the lines that matter.
"""


def build_system_prompt(
    workspace: Path,
    registry: ToolRegistry,
    *,
    extra_rules: str = "",
    mode: AgentMode | None = None,
) -> str:
    """Compose the system message: rules, environment, tools, project rules."""

    snapshot = workspace_snapshot(workspace)
    git = snapshot.get("git") or {}
    lines = [BASE_PROMPT]

    if mode is not None:
        lines += ["", f"Current mode: {mode.label} - {mode.summary}"]
        if mode.instructions.strip():
            lines.append(mode.instructions.strip())
        if not mode.can_write:
            lines.append(
                "In this mode you cannot change files. Describe what you would change "
                "instead of attempting it."
            )

    lines += ["", "Environment:"]
    lines.append(f"- Workspace root: {snapshot.get('path')}")
    if isinstance(git, dict) and git.get("is_repo"):
        branch = git.get("branch") or "detached"
        head = git.get("head") or "?"
        uncommitted = git.get("changed_files", 0)
        lines.append(f"- Git: branch {branch} at {head}, {uncommitted} uncommitted path(s)")
    else:
        lines.append("- Git: this workspace is not a repository")

    entries = snapshot.get("entries") or []
    if entries:
        lines.append("- Top level: " + ", ".join(str(item) for item in entries))

    lines += ["", "Available tools:"]
    allowed = None if mode is None else mode.tools
    available = registry.active_for(allowed)
    for tool in available:
        lines.append(f"- {tool.name}: {tool.description}")
    if not available:
        lines.append("- none: this mode offers no tools")

    if extra_rules.strip():
        lines += ["", "Project rules (from the workspace, follow these):", extra_rules.strip()]

    return "\n".join(lines)