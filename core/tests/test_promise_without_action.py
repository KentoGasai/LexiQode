"""A turn that promises work and then stops without doing it.

The reported symptom: the model wrote "Работаю" several times, called no tools,
and the turn ended. A promise to act is not an answer, and a turn that ends on
one has done nothing while looking like it tried.

The cause is in the loop: any assistant message with no tool calls ends the turn.
That is right for a real answer and wrong for a promise, and the two are told
apart by what the text says - which is exactly what these tests pin down.
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


class PromiseWithoutActionTest(unittest.TestCase):
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
            settings=settings or AgentSettings(auto_approve=True, max_steps=10),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=client,
        )
        return loop, client

    def types(self) -> list[str]:
        return [event_type for event_type, _ in self.events]

    def test_a_promise_is_not_an_answer(self) -> None:
        """The model says it is working, then actually works."""

        script = [
            text_chunks("Работаю."),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c1"),
            text_chunks("Прочитал файл: две строки."),
        ]
        loop, client = self.build(script)
        result = loop.run("посмотри файл")

        self.assertEqual(result.stopped, "completed")
        self.assertEqual(result.tool_calls, 1, "the promised work must actually happen")
        self.assertEqual(len(client.calls), 3, "the promise must not end the turn")
        self.assertIn("Прочитал файл", result.text)

    def test_a_real_answer_still_ends_the_turn(self) -> None:
        """An answer with no promise in it is the end of the turn, as before."""

        script = [text_chunks("В файле две строки: line one и line two.")]
        loop, client = self.build(script)
        result = loop.run("что в файле?")

        self.assertEqual(result.stopped, "completed")
        self.assertEqual(len(client.calls), 1, "a real answer is one request")
        self.assertEqual(result.tool_calls, 0)

    def test_a_promise_that_never_becomes_work_ends_the_turn(self) -> None:
        """The nudge is bounded: a model that only ever promises is stopped."""

        script = [text_chunks("Работаю.") for _ in range(20)]
        loop, client = self.build(script)
        result = loop.run("сделай что-нибудь")

        self.assertEqual(result.stopped, "completed")
        self.assertLess(len(client.calls), 20, "the turn must not run to the step budget")
        self.assertIn("Работаю", result.text)

    def test_the_model_is_told_that_a_promise_is_not_work(self) -> None:
        """The nudge has to be in the conversation, or the model cannot act on it."""

        script = [
            text_chunks("Работаю."),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c1"),
            text_chunks("Готово."),
        ]
        loop, _ = self.build(script)
        loop.run("посмотри файл")

        nudges = [
            message
            for message in loop.messages
            if message.get("role") == "user"
            and "promise" in str(message.get("content") or "").lower()
        ]
        self.assertTrue(nudges, "the model must be told that a promise is not an answer")


if __name__ == "__main__":
    unittest.main()
