"""A loop that never repeats itself twice in a row is still a loop.

The guard counted *consecutive* identical calls, and narrowing it that way was
deliberate: counting every repeat stopped turns that were working. The narrowing
left the shape the user actually hit unguarded - a model that runs the same command,
does something unrelated, and runs it again, forever. The stored transcripts show it
plainly: one command in a single turn twenty-three times with no notice drawn once.

What makes that a loop is not the repetition but the absence of progress, so that is
what these tests pin: the same call returning the same result. Both directions
matter - a loop must be caught, and a call whose result moves must not be.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lexiqode.agent.loop import AgentLoop
from lexiqode.agent.tools.registry import default_registry
from lexiqode.config import AgentSettings, ModelProfile

from .fakes import FakeClient, text_chunks, tool_chunks


def make_profile(**overrides) -> ModelProfile:
    base = {"id": "test", "base_url": "https://provider.test/v1", "model": "m"}
    base.update(overrides)
    return ModelProfile(**base).normalised()


class NoProgressLoopTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)
        (self.workspace / "hello.txt").write_text("line one\nline two\n", encoding="utf-8")
        (self.workspace / "other.txt").write_text("other\n", encoding="utf-8")
        self.events: list[tuple[str, dict]] = []

    def build(self, script, *, settings=None):
        client = FakeClient(script)
        loop = AgentLoop(
            profile=make_profile(),
            settings=settings or AgentSettings(auto_approve=True, max_steps=64),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=client,
        )
        return loop, client

    def types(self) -> list[str]:
        return [event_type for event_type, _ in self.events]

    def test_the_same_result_with_work_in_between_is_caught(self) -> None:
        """The loop the transcripts show: same call, same result, other work between."""

        script = []
        for index in range(30):
            script.append(tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"r{index}"))
            # Unrelated work, whose own result is different every time: it must not
            # reset the read's count, because the read is what is not progressing.
            script.append(
                tool_chunks("read_file", {"path": f"note-{index}.txt"}, call_id=f"n{index}")
            )
        loop, _ = self.build(script)
        result = loop.run("read hello.txt until something changes")

        self.assertEqual(result.stopped, "repeated", "an unchanged result is not progress")
        self.assertIn("repeat_retry", self.types())
        reasons = [data.get("reason") for name, data in self.events if name == "repeated_call"]
        self.assertEqual(reasons[0], "no-progress", "the reason names what was measured")

    def test_a_result_that_moves_is_never_caught(self) -> None:
        """The same call whose result changes is work, however often it is made."""

        script = []
        for index in range(8):
            script.append(tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"r{index}"))
            script.append(
                tool_chunks(
                    "write_file",
                    {"path": "hello.txt", "content": f"line one\nline two\nrevision {index}\n"},
                    call_id=f"w{index}",
                )
            )
        script.append(text_chunks("Every revision read differently."))
        loop, _ = self.build(script)
        result = loop.run("revise the file and check it each time")

        self.assertEqual(result.stopped, "completed", "a changing result is progress")
        self.assertNotIn("repeat_retry", self.types())


if __name__ == "__main__":
    unittest.main()