"""The ask_user tool: the agent asks, the turn waits, the answer comes back.

The point of the tool is that the turn *blocks* until the user answers, so most
of these tests drive it from a second thread: the loop is running, the question
is open, and the answer arrives while it waits.
"""

from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path

from lexiqode.agent.loop import AgentLoop
from lexiqode.agent.tools.base import QuestionAnswer, QuestionRequest
from lexiqode.agent.tools.registry import default_registry
from lexiqode.config import AgentSettings, ModelProfile

from .fakes import FakeClient, text_chunks, tool_chunks


def make_profile(**overrides) -> ModelProfile:
    base = {"id": "test", "base_url": "https://provider.test/v1", "model": "m"}
    base.update(overrides)
    return ModelProfile(**base).normalised()


class AskUserTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)
        self.events: list[tuple[str, dict]] = []
        self.asked: list[QuestionRequest] = []

    def build(self, script, *, ask=None, settings=None):
        client = FakeClient(script)
        loop = AgentLoop(
            profile=make_profile(),
            settings=settings or AgentSettings(auto_approve=True, max_steps=6),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=client,
            ask=ask,
        )
        return loop, client

    def payload(self, event_type: str) -> dict:
        for name, data in self.events:
            if name == event_type:
                return data
        raise AssertionError(f"{event_type} was never emitted")

    def test_the_turn_waits_for_the_answer_and_carries_on(self) -> None:
        """The whole point: the loop blocks, the answer arrives, work continues."""

        answered = threading.Event()

        def ask(request: QuestionRequest) -> QuestionAnswer:
            self.asked.append(request)
            # Answer from another thread, as the window does, so the loop is
            # genuinely waiting when the answer arrives.
            threading.Timer(0.05, lambda: answered.set()).start()
            while not answered.is_set():
                time.sleep(0.01)
            return QuestionAnswer(text="Use the second approach.")

        script = [
            tool_chunks(
                "ask_user",
                {"question": "Which approach?", "options": ["First", "Second"]},
                call_id="c1",
            ),
            text_chunks("Understood, using the second approach."),
        ]
        loop, _ = self.build(script, ask=ask)
        result = loop.run("do the thing")

        self.assertEqual(result.stopped, "completed")
        self.assertEqual(result.steps, 2, "the turn carried on after the answer")
        self.assertEqual(len(self.asked), 1)
        self.assertEqual(self.asked[0].question, "Which approach?")
        self.assertEqual(self.asked[0].options, ["First", "Second"])
        # The answer reached the model as the result of the call.
        tool_messages = [m for m in loop.messages if m.get("role") == "tool"]
        self.assertIn("Use the second approach.", tool_messages[0]["content"])

    def test_the_question_is_announced_before_the_wait(self) -> None:
        """The window can only draw a card for a question it was told about."""

        def ask(_request: QuestionRequest) -> QuestionAnswer:
            return QuestionAnswer(text="yes")

        loop, _ = self.build(
            [
                tool_chunks("ask_user", {"question": "Proceed?"}, call_id="c1"),
                text_chunks("Done."),
            ],
            ask=ask,
        )
        loop.run("go")

        event = self.payload("question_request")
        self.assertEqual(event["question"], "Proceed?")
        self.assertTrue(event["id"], "the card needs an id to answer with")
        self.assertTrue(event["allow_free_text"])

    def test_options_are_cleaned_and_capped(self) -> None:
        def ask(_request: QuestionRequest) -> QuestionAnswer:
            return QuestionAnswer(text="a")

        loop, _ = self.build(
            [
                tool_chunks(
                    "ask_user",
                    {
                        "question": "Pick",
                        "options": ["a", "a", "  b  ", "", 3, "c", "d", "e", "f", "g"],
                    },
                    call_id="c1",
                ),
                text_chunks("Done."),
            ],
            ask=ask,
        )
        loop.run("go")

        options = self.payload("question_request")["options"]
        self.assertEqual(options, ["a", "b", "3", "c", "d", "e"], "trimmed, deduped, capped at six")

    def test_a_cancelled_turn_ends_the_wait(self) -> None:
        """A question has no timeout, so cancellation is what frees the loop."""

        def ask(_request: QuestionRequest) -> QuestionAnswer:
            return QuestionAnswer(cancelled=True)

        loop, _ = self.build(
            [
                tool_chunks("ask_user", {"question": "Proceed?"}, call_id="c1"),
                text_chunks("Done."),
            ],
            ask=ask,
        )
        result = loop.run("go")

        self.assertEqual(result.stopped, "completed")
        tool_messages = [m for m in loop.messages if m.get("role") == "tool"]
        self.assertIn("cancelled", tool_messages[0]["content"])

    def test_without_a_user_the_tool_says_so_instead_of_hanging(self) -> None:
        """A headless run has nobody to ask; blocking would hang for ever."""

        loop, _ = self.build(
            [
                tool_chunks("ask_user", {"question": "Proceed?"}, call_id="c1"),
                text_chunks("I decided myself."),
            ],
            ask=None,
        )
        result = loop.run("go")

        self.assertEqual(result.stopped, "completed")
        tool_messages = [m for m in loop.messages if m.get("role") == "tool"]
        self.assertIn("no user", tool_messages[0]["content"])

    def test_an_empty_question_is_refused(self) -> None:
        loop, _ = self.build(
            [
                tool_chunks("ask_user", {"question": "   "}, call_id="c1"),
                text_chunks("Sorry."),
            ],
            ask=lambda _request: QuestionAnswer(text="x"),
        )
        loop.run("go")

        tool_messages = [m for m in loop.messages if m.get("role") == "tool"]
        self.assertIn("a question is required", tool_messages[0]["content"])

    def test_a_question_with_no_options_and_no_free_text_is_refused(self) -> None:
        """Otherwise the card could never be answered and the turn would wait."""

        loop, _ = self.build(
            [
                tool_chunks(
                    "ask_user",
                    {"question": "Pick", "options": [], "allow_free_text": False},
                    call_id="c1",
                ),
                text_chunks("Sorry."),
            ],
            ask=lambda _request: QuestionAnswer(text="x"),
        )
        loop.run("go")

        tool_messages = [m for m in loop.messages if m.get("role") == "tool"]
        self.assertIn("free-text", tool_messages[0]["content"])

    def test_asking_does_not_need_approval(self) -> None:
        """Asking changes nothing, so it must not raise an approval card."""

        loop, _ = self.build(
            [
                tool_chunks("ask_user", {"question": "Proceed?"}, call_id="c1"),
                text_chunks("Done."),
            ],
            ask=lambda _request: QuestionAnswer(text="yes"),
            settings=AgentSettings(auto_approve=False, approve_writes=True, max_steps=6),
        )
        loop.run("go")

        self.assertNotIn("approval_request", [name for name, _ in self.events])


if __name__ == "__main__":
    unittest.main()
