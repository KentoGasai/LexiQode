"""A stuck turn is told why it was stopped, and gets one chance to recover.

The reported problem: the stop notice was drawn in the window and never written
to the conversation, so the model had no idea it had been stopped. It repeated
the same call in the next turn, was stopped again, and the user saw the same
message over and over. These tests pin the two halves of the fix - the model is
told, and it is given exactly one automatic retry.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lexiqode.agent.loop import REPEAT_MARKER, AgentLoop
from lexiqode.agent.tools.registry import default_registry
from lexiqode.config import AgentSettings, ModelProfile

from .fakes import FakeClient, text_chunks, tool_chunks


def make_profile(**overrides) -> ModelProfile:
    base = {"id": "test", "base_url": "https://provider.test/v1", "model": "m"}
    base.update(overrides)
    return ModelProfile(**base).normalised()


class RepeatRecoveryTest(unittest.TestCase):
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

    def test_the_model_is_told_why_it_was_stopped(self) -> None:
        """The notice must be in the conversation, not only in the window."""

        script = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"c{index}")
            for index in range(40)
        ]
        loop, _ = self.build(script)
        loop.run("read hello.txt")

        notices = [
            message
            for message in loop.messages
            if message.get("role") == "user"
            and str(message.get("content") or "").startswith(REPEAT_MARKER)
        ]
        self.assertTrue(notices, "the model must be told it repeated itself")
        text = notices[0]["content"]
        self.assertIn("read_file", text)
        self.assertIn("Do not repeat this call", text)

    def test_one_retry_is_granted_and_the_turn_carries_on(self) -> None:
        """Three identical calls, then the model changes its mind and answers."""

        script = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c1"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c2"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c3"),
            # After being told, the model does something else and finishes.
            text_chunks("I was stuck; here is what I found instead."),
        ]
        loop, client = self.build(script)
        result = loop.run("read hello.txt")

        self.assertEqual(result.stopped, "completed", "the retry must be allowed to finish")
        self.assertIn("repeat_retry", self.types())
        self.assertEqual(len(client.calls), 4, "the retry is one more request, not a loop")
        self.assertIn("here is what I found", result.text)

    def test_a_second_repeat_ends_the_turn(self) -> None:
        """The retries are bounded: a model that never recovers is stopped."""

        script = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"c{index}")
            for index in range(40)
        ]
        loop, client = self.build(script)
        result = loop.run("read hello.txt")

        self.assertEqual(result.stopped, "repeated")
        # Three calls trip the detector and buy a retry; the counter is cleared,
        # and three more trip it again. Four retries are granted, and the fifth
        # episode is the one that ends the turn: 5 x 3 = 15 steps, well short of
        # the 40-step budget.
        self.assertEqual(result.steps, 15, "four retries, then the turn ends")
        self.assertEqual(len(client.calls), 15)
        self.assertEqual(self.types().count("repeat_retry"), 4, "the episode budget is four")

    def test_the_retry_is_not_spent_on_a_turn_that_never_repeats(self) -> None:
        """A working turn must not be affected by the retry machinery at all."""

        script = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="c1"),
            tool_chunks("read_file", {"path": "hello.txt", "start_line": 2}, call_id="c2"),
            text_chunks("Done."),
        ]
        loop, _ = self.build(script)
        result = loop.run("read it")

        self.assertEqual(result.stopped, "completed")
        self.assertNotIn("repeat_retry", self.types())
        self.assertNotIn(
            REPEAT_MARKER,
            " ".join(str(m.get("content") or "") for m in loop.messages),
        )

    def test_the_retry_budget_is_per_turn(self) -> None:
        """Each turn gets its own retry; the second turn is not starved by the first."""

        script = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="a1"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="a2"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="a3"),
            text_chunks("First turn recovered."),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="b1"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="b2"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="b3"),
            text_chunks("Second turn recovered."),
        ]
        loop, _ = self.build(script)
        first = loop.run("first")
        second = loop.run("second")

        self.assertEqual(first.stopped, "completed")
        self.assertEqual(second.stopped, "completed")
        self.assertEqual(self.types().count("repeat_retry"), 2, "one retry per turn")

    def test_a_second_episode_in_one_turn_also_gets_a_retry(self) -> None:
        """Getting stuck, recovering, and getting stuck again is two episodes.

        The retry was a single flag for the whole turn, so the second episode
        ended the turn outright: the model was told it had repeated itself and
        then given no chance to act on it. Reported from a real session, where
        the agent was stopped for repeating after it had already recovered once.
        """

        script = [
            # First episode: three identical calls, then a change of approach.
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="a1"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="a2"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="a3"),
            tool_chunks("list_dir", {"path": "."}, call_id="a4"),
            # Second episode: three identical calls again, then recovery.
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="b1"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="b2"),
            tool_chunks("read_file", {"path": "hello.txt"}, call_id="b3"),
            text_chunks("Recovered the second time too."),
        ]
        loop, _ = self.build(script)
        result = loop.run("look around")

        self.assertEqual(result.stopped, "completed", "the second episode must be retried too")
        self.assertEqual(self.types().count("repeat_retry"), 2, "one retry per episode")
        self.assertIn("Recovered the second time too.", result.text)

    def test_a_second_episode_that_does_not_recover_still_ends_the_turn(self) -> None:
        """The retry is per episode, not unlimited: repeating again ends it."""

        script = []
        for episode in range(5):
            for index in range(3):
                script.append(
                    tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"e{episode}_{index}")
                )
            script.append(tool_chunks("list_dir", {"path": "."}, call_id=f"work{episode}"))
        loop, _ = self.build(script)
        result = loop.run("look around")

        self.assertEqual(result.stopped, "repeated")
        self.assertEqual(self.types().count("repeat_retry"), 4, "the episode budget is four")

    def test_the_episode_limit_stops_a_turn_that_keeps_alternating(self) -> None:
        """Alternating between a repeat and one other call must not run for ever.

        The per-episode retry is reset by any other call, so a model that repeats,
        does one different thing and repeats again would be retried indefinitely
        and the turn would never end. The episode budget is what bounds it.
        """

        script = []
        for index in range(30):
            script.append(
                tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"r{index}a")
            )
            script.append(
                tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"r{index}b")
            )
            script.append(
                tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"r{index}c")
            )
            script.append(tool_chunks("list_dir", {"path": "."}, call_id=f"d{index}"))
        loop, client = self.build(script)
        result = loop.run("look around")

        self.assertEqual(result.stopped, "repeated", "the turn must end, not alternate for ever")
        self.assertEqual(self.types().count("repeat_retry"), 4, "the episode budget is four")
        self.assertLess(len(client.calls), 30, "the turn must not run to the step budget")


if __name__ == "__main__":
    unittest.main()
