"""Exception hierarchy shared by every LexiQode core layer."""

from __future__ import annotations


class LexiQodeError(Exception):
    """Base class so callers can catch every core failure in one clause."""


class ConfigError(LexiQodeError):
    """Settings are missing, malformed or unusable."""


class ProviderError(LexiQodeError):
    """The OpenAI-compatible endpoint refused or failed the request."""

    def __init__(self, message: str, *, status: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class WorkspaceError(LexiQodeError):
    """A path escaped the workspace root or does not exist."""


class ToolError(LexiQodeError):
    """A tool could not complete its work."""


class ApprovalDenied(ToolError):
    """The user refused the action a tool requested."""


class ApprovalUnavailable(LexiQodeError):
    """Nobody answered an approval request, so the tool never ran.

    Deliberately *not* a :class:`ToolError`: a tool error is a result the model
    reads and works around, and working around an unanswered prompt means asking
    again - which is the loop this exists to end. It is raised out of the tool
    call and ends the turn with the reason stated.
    """


class McpError(LexiQodeError):
    """An MCP server could not be reached or answered incorrectly."""