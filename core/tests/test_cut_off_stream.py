"""What happens when the model's stream is cut off in the middle?

The reported symptom: the window showed "работаю", then nothing, and the turn
stopped. That is not the model declining to call a tool - it is the response
ending early. This drives the loop against a client whose stream raises partway
through, and reports what the turn does with it.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any, Iterator

import httpx

from lexiqode.agent.loop import AgentLoop
from lexiqode.agent.tools.registry import default_registry
from lexiqode.config import AgentSettings, ModelProfile
from lexiqode.llm.types import Chunk

from .fakes import text_chunks, tool_chunks


def make_profile(**overrides) -> ModelProfile:
    base = {"id": "test", "base_url": "https://provider.test/v1", "model": "m"}
    base.update(overrides)
    return ModelProfile(**base).normalised()


class CutOffClient:
    """A client whose stream ends with a transport error, mid-answer."""

    def __init__(self, script: list[list[Chunk]], *, cut_at: int) -> None:
        self.script = script
        self.cut_at = cut_at
        self.calls: list[dict[str, Any]] = []

    def stream(self, messages, tools=None, **_kwargs) -> Iterator[Chunk]:
        self.calls.append({"messages": list(messages), "tools": tools})
        if not self.script:
            raise AssertionError("CutOffClient ran out of scripted responses")
        chunks = self.script.pop(0)
        for index, chunk in enumerate(chunks):
            if index >= self.cut_at:
                # What httpx raises when the connection dies mid-body.
                raise httpx.ReadError("connection closed while reading the response")
            yield chunk

    def close(self) -> None:
        pass


class CutOffStreamTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)
        (self.workspace / "hello.txt").write_text("line one\nline two\n", encoding="utf-8")
        self.events: list[tuple[str, dict]] = []

    def build(self, script, *, cut_at: int, settings=None):
        client = CutOffClient(script, cut_at=cut_at)
        loop = AgentLoop(
            profile=make_profile(),
            settings=settings or AgentSettings(auto_approve=True, max_steps=10),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=client,
        )
        return loop, client

    def types(self) -> list[str]:
        return [event_type for event_type, _ in self.events]

    def test_a_cut_off_stream_is_reported_as_an_error(self) -> None:
        """The turn must say the connection died, not pretend it answered."""

        script = [
            [
                *text_chunks("Пишу файл"),
                *tool_chunks("write_file", {"path": "out.txt", "content": "x"}, call_id="c1"),
            ]
        ]
        loop, _ = self.build(script, cut_at=1)
        result = loop.run("сделай out.txt")

        print(f"stopped: {result.stopped!r}")
        print(f"text:    {result.text!r}")
        print(f"events:  {sorted(set(self.types()))}")
        print(f"error:   {[d for n, d in self.events if n == 'error']}")

        self.assertNotEqual(
            result.stopped,
            "completed",
            "a cut-off stream must not be reported as a completed turn",
        )

    def test_the_turn_end_event_does_not_claim_success(self) -> None:
        """The window decides what to show from `turn_end`, so it must not lie."""

        script = [
            [
                *text_chunks("Пишу файл"),
                *tool_chunks("write_file", {"path": "out.txt", "content": "x"}, call_id="c1"),
            ]
        ]
        loop, _ = self.build(script, cut_at=1)
        loop.run("сделай out.txt")

        ends = [data for name, data in self.events if name == "turn_end"]
        self.assertTrue(ends, "turn_end must be emitted even when the stream dies")
        print(f"turn_end: {ends[0]}")
        self.assertNotEqual(
            ends[0].get("stopped"),
            "completed",
            "turn_end must not report a cut-off turn as completed",
        )


if __name__ == "__main__":
    unittest.main()
