"""A repeated call is only a sign of being stuck if nothing happened in between.

The detector counts identical calls. But a real turn often runs the same command
more than once with work in between - run the tests, fix the failure, run the
tests again - and that is progress, not a loop. Counting those as repeats stops
turns that were working, which is what the user saw: the agent was stopped for
"repeating" while it was in fact editing files between runs.
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


class RepeatWithWorkTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)
        (self.workspace / "hello.txt").write_text("line one\nline two\n", encoding="utf-8")
        self.events: list[tuple[str, dict]] = []

    def build(self, script, *, settings=None):
        client = FakeClient(script)
        loop = AgentLoop(
            profile=make_profile(),
            settings=settings or AgentSettings(auto_approve=True, max_steps=40),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=client,
        )
        return loop, client

    def types(self) -> list[str]:
        return [event_type for event_type, _ in self.events]

    def test_the_same_command_after_an_edit_is_not_a_repeat(self) -> None:
        """Run tests, edit, run tests again: that is the normal working rhythm."""

        script = [
            tool_chunks("run_command", {"command": "pytest -q"}, call_id="c1"),
            tool_chunks("write_file", {"path": "fix.py", "content": "x = 1\n"}, call_id="c2"),
            tool_chunks("run_command", {"command": "pytest -q"}, call_id="c3"),
            tool_chunks("write_file", {"path": "fix.py", "content": "x = 2\n"}, call_id="c4"),
            tool_chunks("run_command", {"command": "pytest -q"}, call_id="c5"),
            text_chunks("The tests pass now."),
        ]
        loop, _ = self.build(script)
        result = loop.run("fix the failing test")

        self.assertEqual(result.stopped, "completed", "work between runs is not a loop")
        self.assertNotIn("repeat_retry", self.types())
        self.assertIn("The tests pass now.", result.text)

    def test_three_identical_calls_in_a_row_are_still_a_repeat(self) -> None:
        """The detector must keep working when nothing happens in between."""

        script = [
            tool_chunks("run_command", {"command": "pytest -q"}, call_id=f"c{index}")
            for index in range(40)
        ]
        loop, _ = self.build(script)
        result = loop.run("run the tests")

        self.assertEqual(result.stopped, "repeated")
        self.assertIn("repeat_retry", self.types())

    def test_a_read_between_identical_reads_breaks_the_chain(self) -> None:
        """Reading a different file is progress, even if the first read repeats."""

        script = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c1"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c2"),
            tool_chunks("list_dir", {"path": "."}, call_id="c3"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c4"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c5"),
            text_chunks("Done."),
        ]
        loop, _ = self.build(script)
        result = loop.run("look around")

        self.assertEqual(result.stopped, "completed")
        self.assertNotIn("repeat_retry", self.types())


if __name__ == "__main__":
    unittest.main()
