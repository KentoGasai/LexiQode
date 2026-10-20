"""Tool registry: the single place that knows which tools exist."""

from __future__ import annotations

from typing import Any, Iterable

from .base import Tool, ToolContext, ToolResult
from .fs import EditFileTool, GlobTool, GrepTool, ListDirTool, ReadFileTool, WriteFileTool
from .shell import RunCommandTool

#: The default toolset. Ordering matters only for prompt stability.
BUILTIN_TOOLS: tuple[type[Tool], ...] = (
    ReadFileTool,
    ListDirTool,
    GlobTool,
    GrepTool,
    WriteFileTool,
    EditFileTool,
    RunCommandTool,
)


class ToolRegistry:
    """Name lookup plus the ``tools`` array sent to the model."""

    def __init__(self, tools: Iterable[Tool] = ()) -> None:
        self._tools: dict[str, Tool] = {}
        self.disabled: set[str] = set()
        for tool in tools:
            self.register(tool)

    def register(self, tool: Tool) -> None:
        if not tool.name:
            raise ValueError(f"{type(tool).__name__} has no name")
        self._tools[tool.name] = tool

    def names(self) -> list[str]:
        return sorted(self._tools)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def active(self) -> list[Tool]:
        return [tool for name, tool in sorted(self._tools.items()) if name not in self.disabled]

    def schemas(self) -> list[dict[str, Any]]:
        return [tool.schema() for tool in self.active()]

    def describe(self) -> list[dict[str, Any]]:
        """Metadata for the editor's tool list."""

        return [
            {
                "name": tool.name,
                "description": tool.description,
                "family": tool.family,
                "enabled": tool.name not in self.disabled,
            }
            for tool in self.active()
        ]

    def execute(self, name: str, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        tool = self._tools.get(name)
        if tool is None:
            return ToolResult.failure(f"unknown tool {name!r}", error="unknown_tool")
        if name in self.disabled:
            return ToolResult.failure(f"tool {name!r} is disabled in this workspace", error="disabled")
        if not isinstance(arguments, dict):
            return ToolResult.failure("tool arguments must be a JSON object", error="bad_arguments")
        return tool.execute(arguments, context)


def default_registry() -> ToolRegistry:
    return ToolRegistry(tool() for tool in BUILTIN_TOOLS)