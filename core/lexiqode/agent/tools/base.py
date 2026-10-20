"""Tool contract: schema, execution context, result and approval protocol."""

from __future__ import annotations

import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ...config import AgentSettings
from ...errors import ToolError, WorkspaceError
from ...llm.types import tool_schema

#: Tool families decide the default approval policy.
FAMILY_READ = "read"
FAMILY_WRITE = "write"
FAMILY_COMMAND = "command"


@dataclass(slots=True)
class ApprovalRequest:
    """What the user is being asked to allow."""

    id: str
    tool: str
    family: str
    summary: str
    detail: str = ""
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ApprovalDecision:
    approved: bool
    reason: str = ""
    #: When true the caller may remember the decision for this tool family.
    remember: bool = False


ApprovalFn = Callable[[ApprovalRequest], ApprovalDecision]


@dataclass(slots=True)
class ToolResult:
    ok: bool
    content: str
    elapsed_ms: int = 0
    meta: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def failure(cls, message: str, **meta: Any) -> "ToolResult":
        return cls(ok=False, content=message, meta=meta)


@dataclass(slots=True)
class ToolContext:
    """Everything a tool needs that is not part of its arguments."""

    workspace: Path
    settings: AgentSettings
    emit: Callable[[str, dict[str, Any]], None]
    approve: ApprovalFn

    def resolve(self, raw_path: str, *, must_exist: bool = False) -> Path:
        """Resolve a model-supplied path and refuse to leave the workspace.

        A model can invent ``../../etc/passwd``; containment is enforced here, at
        the single point every filesystem tool goes through.
        """

        if not raw_path or not str(raw_path).strip():
            raise WorkspaceError("a file path is required")
        candidate = Path(str(raw_path).strip())
        if not candidate.is_absolute():
            candidate = self.workspace / candidate
        try:
            resolved = candidate.resolve()
        except OSError as exc:
            raise WorkspaceError(f"cannot resolve {raw_path!r}: {exc}") from exc
        root = self.workspace.resolve()
        if resolved != root and root not in resolved.parents:
            raise WorkspaceError(
                f"{raw_path!r} is outside the workspace; only paths under {root} are allowed"
            )
        if must_exist and not resolved.exists():
            raise WorkspaceError(f"{raw_path!r} does not exist")
        return resolved

    def relative(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.workspace.resolve()).as_posix()
        except (ValueError, OSError):
            return path.as_posix()


class Tool(ABC):
    """One callable capability exposed to the model."""

    name: str = ""
    description: str = ""
    family: str = FAMILY_READ
    #: JSON-schema properties of the arguments object.
    parameters: dict[str, Any] = {}
    required: list[str] = []

    def schema(self) -> dict[str, Any]:
        return tool_schema(self.name, self.description, self.parameters, self.required)

    def requires_approval(self, settings: AgentSettings) -> bool:
        if settings.auto_approve:
            return False
        if self.family == FAMILY_WRITE:
            return settings.approve_writes
        if self.family == FAMILY_COMMAND:
            return settings.approve_commands
        return False

    def describe(self, arguments: dict[str, Any]) -> str:
        """One line for the approval prompt; tools may override."""

        return self.name

    def approval_detail(self, arguments: dict[str, Any]) -> str:
        return ""

    @abstractmethod
    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        """Execute the call. Raise :class:`ToolError` for expected failures."""

    # ------------------------------------------------------------------ helper
    def _guard(self, arguments: dict[str, Any], context: ToolContext) -> None:
        """Apply the approval policy before a privileged tool runs."""

        if not self.requires_approval(context.settings):
            return
        request = ApprovalRequest(
            id=uuid.uuid4().hex[:12],
            tool=self.name,
            family=self.family,
            summary=self.describe(arguments),
            detail=self.approval_detail(arguments),
            arguments=arguments,
        )
        context.emit("approval_request", {
            "id": request.id,
            "tool": request.tool,
            "family": request.family,
            "summary": request.summary,
            "detail": request.detail,
        })
        decision = context.approve(request)
        if not decision.approved:
            reason = decision.reason or "the user declined this action"
            raise ToolError(f"denied: {reason}")
        if decision.remember:
            if self.family == FAMILY_WRITE:
                context.settings.approve_writes = False
            elif self.family == FAMILY_COMMAND:
                context.settings.approve_commands = False

    def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        """Timed wrapper around :meth:`run` that turns failures into results.

        The model needs to *see* a tool failure to recover from it, so expected
        errors become ``ok=False`` results instead of aborting the turn.
        """

        started = time.perf_counter()
        try:
            self._guard(arguments, context)
            result = self.run(arguments, context)
        except ToolError as exc:
            result = ToolResult.failure(str(exc), error="tool_error")
        except WorkspaceError as exc:
            result = ToolResult.failure(str(exc), error="workspace_error")
        except Exception as exc:  # unexpected: report, do not crash the turn
            result = ToolResult.failure(f"{type(exc).__name__}: {exc}", error="internal")
        result.elapsed_ms = int((time.perf_counter() - started) * 1000)
        return result