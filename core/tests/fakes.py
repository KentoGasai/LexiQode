"""Test doubles: a scripted model, so the loop can be tested without a network.

``FakeClient`` answers each ``stream`` call from a pre-written script, which is
what makes multi-step tool use deterministic: step 1 asks for a tool, step 2
answers with the final text.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from lexiqode.llm.types import Chunk, ToolCall, Usage


def text_chunks(text: str, *, usage: Usage | None = None) -> list[Chunk]:
    if not text:
        return [Chunk(finish_reason="stop", usage=usage)]
    chunks = [Chunk(text=character) for character in text]
    chunks.append(Chunk(finish_reason="stop", usage=usage))
    return chunks


def tool_chunks(
    name: str,
    arguments: dict[str, Any],
    *,
    call_id: str = "call_1",
    index: int = 0,
) -> list[Chunk]:
    """Emit a tool call the way a real server does: id/name first, args after."""

    payload = json.dumps(arguments)
    half = max(1, len(payload) // 2)
    return [
        Chunk(tool_calls=[ToolCall(index=index, id=call_id, name=name, arguments=payload[:half])]),
        Chunk(tool_calls=[ToolCall(index=index, arguments=payload[half:])]),
        Chunk(finish_reason="tool_calls"),
    ]


class FakeClient:
    """A model that replays a fixed list of responses."""

    def __init__(self, script: Iterable[Iterable[Chunk]]) -> None:
        self.script = [list(entry) for entry in script]
        self.calls: list[dict[str, Any]] = []
        self.closed = False

    def stream(self, messages: list[dict[str, Any]], tools: Any = None, **_kwargs: Any):
        self.calls.append({"messages": list(messages), "tools": tools})
        if not self.script:
            raise AssertionError("FakeClient ran out of scripted responses")
        yield from self.script.pop(0)

    def close(self) -> None:
        self.closed = True

    @property
    def last_messages(self) -> list[dict[str, Any]]:
        return self.calls[-1]["messages"] if self.calls else []