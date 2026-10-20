"""Wire types for the chat-completions dialect.

Messages are kept as plain dictionaries in the exact shape the OpenAI schema
expects. That is deliberate: every compatible server agrees on this shape, and
keeping it literal means no translation layer can silently drop a field such as
``tool_call_id`` or a multimodal content part.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

ROLE_SYSTEM = "system"
ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"
ROLE_TOOL = "tool"


def system_message(text: str) -> dict[str, Any]:
    return {"role": ROLE_SYSTEM, "content": text}


def user_message(text: str) -> dict[str, Any]:
    return {"role": ROLE_USER, "content": text}


def assistant_message(content: str = "", tool_calls: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {"role": ROLE_ASSISTANT, "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return message


def tool_message(tool_call_id: str, name: str, content: str) -> dict[str, Any]:
    return {
        "role": ROLE_TOOL,
        "tool_call_id": tool_call_id,
        "name": name,
        "content": content,
    }


@dataclass(slots=True)
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "Usage | None":
        if not isinstance(payload, dict):
            return None
        return cls(
            prompt_tokens=int(payload.get("prompt_tokens") or 0),
            completion_tokens=int(payload.get("completion_tokens") or 0),
            total_tokens=int(payload.get("total_tokens") or 0),
        )


@dataclass(slots=True)
class ToolCall:
    """A tool call as it appears in one stream chunk.

    The arguments arrive as fragments across many chunks, so they are stored as
    the raw string and only parsed once the stream ends.
    """

    index: int = 0
    id: str = ""
    name: str = ""
    arguments: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.arguments or "{}"},
        }

    def parsed_arguments(self) -> dict[str, Any]:
        """Parse arguments, tolerating the empty string some servers send."""

        raw = (self.arguments or "").strip()
        if not raw:
            return {}
        import json

        try:
            value = json.loads(raw)
        except ValueError:
            return {}
        return value if isinstance(value, dict) else {"value": value}


@dataclass(slots=True)
class Chunk:
    """One decoded stream delta."""

    text: str = ""
    #: Some reasoning models stream their scratchpad separately. Captured so it
    #: can be shown in the UI without being fed back as the answer.
    reasoning: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    usage: Usage | None = None


class StreamAccumulator:
    """Fold a chunk sequence into one assistant message."""

    def __init__(self) -> None:
        self._text: list[str] = []
        self._reasoning: list[str] = []
        self._calls: dict[int, ToolCall] = {}
        self.finish_reason: str | None = None
        self.usage: Usage | None = None

    def feed(self, chunk: Chunk) -> None:
        if chunk.text:
            self._text.append(chunk.text)
        if chunk.reasoning:
            self._reasoning.append(chunk.reasoning)
        for call in chunk.tool_calls:
            current = self._calls.get(call.index)
            if current is None:
                self._calls[call.index] = call
                continue
            if call.id:
                current.id = call.id
            if call.name:
                current.name = call.name
            if call.arguments:
                current.arguments += call.arguments
        if chunk.finish_reason:
            self.finish_reason = chunk.finish_reason
        if chunk.usage is not None:
            self.usage = chunk.usage

    @property
    def text(self) -> str:
        return "".join(self._text)

    @property
    def reasoning(self) -> str:
        return "".join(self._reasoning)

    @property
    def tool_calls(self) -> list[ToolCall]:
        return [self._calls[index] for index in sorted(self._calls)]

    def message(self) -> dict[str, Any]:
        calls = [call.to_wire() for call in self.tool_calls]
        return assistant_message(self.text, calls or None)


def tool_schema(
    name: str,
    description: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
) -> dict[str, Any]:
    """Build one entry of the request's ``tools`` array."""

    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required or [],
                "additionalProperties": False,
            },
        },
    }