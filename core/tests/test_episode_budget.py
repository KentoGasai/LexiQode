"""The episode budget should count failures, not attempts.

The counter that bounds the retries grows every time a retry is granted, whether
or not it worked. So a turn that gets stuck, recovers, works for a while, and
gets stuck again is treated as if it had already used up its chances - even
though the earlier episode ended in recovery. What the limit is meant to bound
is the number of times the model was told and did not listen.
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


class EpisodeBudgetTest(unittest.TestCase):
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
            settings=settings or AgentSettings(auto_approve=True, max_steps=60),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=client,
        )
        return loop, client

    def types(self) -> list[str]:
        return [event_type for event_type, _ in self.events]

    def test_recovering_does_not_end_the_turn_early(self) -> None:
        """A turn that recovers several times must not be cut short.

        The episode counter cannot tell a recovered episode from an unrecovered
        one - one `list_dir` between two episodes is not evidence of progress -
        so it is a budget the turn spends. It has to be generous enough that a
        turn which genuinely recovers a few times still finishes its work.
        """

        script = []
        for episode in range(3):
            # Three identical calls: the episode.
            for index in range(3):
                script.append(
                    tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"e{episode}_{index}")
                )
            # Real work: a different call, which closes the episode.
            script.append(tool_chunks("list_dir", {"path": "."}, call_id=f"work{episode}"))
        script.append(text_chunks("All three episodes recovered."))

        loop, _ = self.build(script)
        result = loop.run("look around")

        self.assertEqual(
            result.stopped,
            "completed",
            "three recovered episodes must not exhaust the budget",
        )
        self.assertIn("All three episodes recovered.", result.text)

    def test_the_episode_budget_is_finite(self) -> None:
        """However generous, the budget must end a turn that never recovers."""

        script = []
        for episode in range(20):
            for index in range(3):
                script.append(
                    tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"e{episode}_{index}")
                )
            script.append(tool_chunks("list_dir", {"path": "."}, call_id=f"work{episode}"))

        loop, client = self.build(script)
        result = loop.run("look around")

        self.assertEqual(result.stopped, "repeated", "the turn must end eventually")
        self.assertLess(len(client.calls), 20, "the turn must not run to the step budget")


if __name__ == "__main__":
    unittest.main()
