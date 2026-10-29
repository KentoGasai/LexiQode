"""A completion that carries nothing must not end the turn in silence.

Two of the reported chats stop without calling a tool and without saying anything.
The stored messages are the evidence: `assistant` with an empty content and no tool
calls, twice in a row, once after the user typed "continue" and once after "are you
there". Nothing was on screen, because an empty message was treated as the answer.

The other shape in the same transcripts is an answer that stops mid-sentence ("...и
вот код." with no code), which is what a completion cut off at the output limit looks
like. With a reasoning model the whole output budget can go to the model's own
thinking, and then no answer arrives however often it is asked - so the ending has to
name that, because the fix is a setting rather than another attempt.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lexiqode.agent.loop import AgentLoop
from lexiqode.agent.tools.registry import default_registry
from lexiqode.config import AgentSettings, ModelProfile
from lexiqode.llm.types import Chunk

from .fakes import FakeClient, text_chunks, tool_chunks


def make_profile(**overrides) -> ModelProfile:
    base = {"id": "test", "base_url": "https://provider.test/v1", "model": "m"}
    base.update(overrides)
    return ModelProfile(**base).normalised()


def empty_chunks(*, finish_reason: str = "stop") -> list[Chunk]:
    """What the provider sends when it produces no text and no tool call."""

    return [Chunk(finish_reason=finish_reason)]


class EmptyAnswerTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)
        self.events: list[tuple[str, dict]] = []

    def build(self, script, *, settings=None):
        client = FakeClient(script)
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

    def test_an_empty_completion_is_retried_and_then_ended_visibly(self) -> None:
        """The model gets another chance, and the turn says so when there is none."""

        script = [empty_chunks() for _ in range(4)]
        loop, client = self.build(script)
        result = loop.run("продолжай работу")

        self.assertEqual(result.stopped, "empty_answer", "an empty answer is not an answer")
        self.assertIn("empty_answer_retry", self.types(), "the model is asked again first")
        self.assertIn("empty_answer", self.types(), "and the ending is published")
        # Bounded: the retries plus the turn that gave up, and not the whole script.
        self.assertEqual(len(client.calls), 3, "two retries, then the turn ends")
        ending = [data for name, data in self.events if name == "empty_answer"][0]
        self.assertFalse(ending["truncated"], "the provider said stop, not length")

    def test_the_reason_names_the_output_limit_when_it_was_hit(self) -> None:
        """A reasoning model that spent its whole budget is a different problem."""

        script = [empty_chunks(finish_reason="length") for _ in range(4)]
        loop, _ = self.build(script)
        result = loop.run("продолжай работу")

        self.assertEqual(result.stopped, "truncated_answer")
        ending = [data for name, data in self.events if name == "empty_answer"][0]
        self.assertTrue(ending["truncated"])
        self.assertEqual(ending["finish_reason"], "length")

    def test_a_cut_off_answer_is_asked_for_again(self) -> None:
        """Text that stops mid-message is not a finished answer either."""

        cut = [Chunk(text="Пишу файл. Вот"), Chunk(finish_reason="length")]
        script = [cut, tool_chunks("write_file", {"path": "out.txt", "content": "x\n"}, call_id="c1"), text_chunks("out.txt is written.")]
        loop, client = self.build(script)
        result = loop.run("сделай out.txt")

        self.assertEqual(result.stopped, "completed", "after being told, it acted")
        self.assertIn("answer_truncated", self.types(), "the cut-off answer is reported")
        self.assertEqual(result.tool_calls, 1)
        self.assertTrue((self.workspace / "out.txt").is_file())
        self.assertEqual(len(client.calls), 3)

    def test_one_empty_retry_is_enough_when_the_model_recovers(self) -> None:
        """The retry must be a way forward, not a punishment."""

        script = [empty_chunks(), tool_chunks("write_file", {"path": "out.txt", "content": "y\n"}, call_id="c1"), text_chunks("done")]
        loop, _ = self.build(script)
        result = loop.run("сделай out.txt")

        self.assertEqual(result.stopped, "completed")
        self.assertNotIn("empty_answer", self.types(), "no ending was needed")
        self.assertTrue((self.workspace / "out.txt").is_file())


if __name__ == "__main__":
    unittest.main()