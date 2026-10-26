"""The agent loop, driven by a scripted client."""

from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path

from lexiqode.agent.loop import AgentLoop
from lexiqode.agent.loop import SUMMARY_MARKER, estimate_tokens
from lexiqode.agent.tools.base import ApprovalDecision
from lexiqode.agent.tools.registry import default_registry
from lexiqode.config import AgentSettings, ModelProfile
from lexiqode.errors import ProviderError
from lexiqode.llm.types import Chunk, Usage

from .fakes import FakeClient, text_chunks, tool_chunks


def make_profile(**overrides) -> ModelProfile:
    base = {"id": "test", "base_url": "https://provider.test/v1", "model": "m"}
    base.update(overrides)
    return ModelProfile(**base).normalised()


class LoopTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)
        (self.workspace / "hello.txt").write_text("line one\nline two\n", encoding="utf-8")
        self.events: list[tuple[str, dict]] = []

    def build(
        self,
        script,
        *,
        settings: AgentSettings | None = None,
        approve=None,
        profile: ModelProfile | None = None,
        client=None,
        **kwargs,
    ):
        client = client or FakeClient(script)
        loop = AgentLoop(
            profile=profile or make_profile(),
            settings=settings or AgentSettings(auto_approve=True, max_steps=6),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=client,
            approve=approve,
            **kwargs,
        )
        return loop, client

    def types(self) -> list[str]:
        return [event_type for event_type, _ in self.events]

    def payload(self, event_type: str) -> dict:
        for name, data in self.events:
            if name == event_type:
                return data
        raise AssertionError(f"{event_type} was never emitted; saw {self.types()}")


class PlainAnswerTest(LoopTestCase):
    def test_text_answer_finishes_in_one_step(self) -> None:
        loop, client = self.build([text_chunks("All done.", usage=Usage(total_tokens=5))])
        result = loop.run("say hi")

        self.assertEqual(result.text, "All done.")
        self.assertEqual(result.stopped, "completed")
        self.assertEqual(result.steps, 1)
        self.assertEqual(result.tool_calls, 0)
        self.assertEqual(result.usage.total_tokens, 5)
        self.assertIn("text_delta", self.types())
        self.assertEqual(self.payload("turn_end")["stopped"], "completed")

    def test_system_prompt_carries_environment_and_tools(self) -> None:
        loop, client = self.build([text_chunks("ok")])
        loop.run("hi")
        system = client.last_messages[0]
        self.assertEqual(system["role"], "system")
        self.assertIn(self.workspace.as_posix(), system["content"])
        self.assertIn("read_file", system["content"])
        self.assertIn("run_command", system["content"])

    def test_tool_schemas_are_offered_to_the_model(self) -> None:
        loop, client = self.build([text_chunks("ok")])
        loop.run("hi")
        names = {schema["function"]["name"] for schema in client.calls[0]["tools"]}
        self.assertIn("edit_file", names)

    def test_history_is_kept_across_turns(self) -> None:
        loop, client = self.build([text_chunks("first"), text_chunks("second")])
        loop.run("one")
        loop.run("two")
        roles = [message["role"] for message in client.last_messages]
        self.assertEqual(roles[0], "system")
        self.assertEqual(roles.count("user"), 2)

    def test_a_turn_can_run_without_tools(self) -> None:
        loop, client = self.build([text_chunks("just the text"), text_chunks("second")])
        result = loop.run("rewrite this selection", tools=False)

        self.assertEqual(result.text, "just the text")
        self.assertIsNone(client.calls[0]["tools"], "no tool schemas may be offered for an inline edit")

        # The flag is per turn: the next normal turn offers them again.
        loop.run("now change something")
        self.assertIsNotNone(client.calls[1]["tools"])


class ToolUseTest(LoopTestCase):
    def test_read_then_answer(self) -> None:
        loop, client = self.build(
            [
                tool_chunks("read_file", {"path": "hello.txt"}),
                text_chunks("The file has two lines."),
            ]
        )
        result = loop.run("read hello.txt")

        self.assertEqual(result.stopped, "completed")
        self.assertEqual(result.tool_calls, 1)
        self.assertEqual(result.steps, 2)
        self.assertIn("tool_start", self.types())
        self.assertIn("tool_end", self.types())
        self.assertTrue(self.payload("tool_end")["ok"])
        self.assertEqual(self.payload("tool_start")["name"], "read_file")

        # The tool result must reach the model as a 'tool' message.
        roles = [message["role"] for message in client.last_messages]
        self.assertIn("tool", roles)
        tool_message = next(m for m in client.last_messages if m["role"] == "tool")
        self.assertIn("line one", tool_message["content"])
        self.assertEqual(tool_message["tool_call_id"], "call_1")

    def test_edit_tool_writes_the_file(self) -> None:
        loop, _ = self.build(
            [
                tool_chunks(
                    "edit_file",
                    {"path": "hello.txt", "old_text": "line two", "new_text": "line 2"},
                ),
                text_chunks("Edited."),
            ]
        )
        loop.run("rename the second line")
        self.assertIn("line 2", (self.workspace / "hello.txt").read_text(encoding="utf-8"))

    def test_tool_failure_is_fed_back_and_the_model_can_recover(self) -> None:
        loop, client = self.build(
            [
                tool_chunks("read_file", {"path": "missing.txt"}),
                text_chunks("That file does not exist."),
            ]
        )
        result = loop.run("read the missing file")

        self.assertEqual(result.stopped, "completed")
        self.assertFalse(self.payload("tool_end")["ok"])
        tool_message = next(m for m in client.last_messages if m["role"] == "tool")
        self.assertIn("does not exist", tool_message["content"])

    def test_denied_write_is_reported_to_the_model(self) -> None:
        loop, client = self.build(
            [
                tool_chunks("write_file", {"path": "new.txt", "content": "hi"}),
                text_chunks("Understood, I will not write it."),
            ],
            settings=AgentSettings(auto_approve=False, approve_writes=True, max_steps=4),
            approve=lambda _request: ApprovalDecision(approved=False, reason="keep the tree clean"),
        )
        result = loop.run("create new.txt")

        self.assertEqual(result.stopped, "completed")
        self.assertFalse((self.workspace / "new.txt").exists())
        tool_message = next(m for m in client.last_messages if m["role"] == "tool")
        self.assertIn("keep the tree clean", tool_message["content"])
        self.assertIn("approval_request", self.types())

    def test_usage_accumulates_over_steps(self) -> None:
        loop, _ = self.build(
            [
                tool_chunks("read_file", {"path": "hello.txt"})[:-1]
                + [Chunk(finish_reason="tool_calls", usage=Usage(total_tokens=10))],
                text_chunks("done", usage=Usage(total_tokens=4)),
            ]
        )
        result = loop.run("read it")
        self.assertEqual(result.usage.total_tokens, 14)


class LimitsTest(LoopTestCase):
    def test_step_budget_is_enforced(self) -> None:
        infinite = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"call_{index}")
            for index in range(10)
        ]
        loop, _ = self.build(infinite, settings=AgentSettings(auto_approve=True, max_steps=3))
        result = loop.run("loop forever")
        self.assertEqual(result.stopped, "max_steps")
        self.assertEqual(result.steps, 3)

    def test_provider_error_stops_the_turn(self) -> None:
        class Boom(FakeClient):
            def stream(self, messages, tools=None, **kwargs):
                from lexiqode.errors import ProviderError

                raise ProviderError("provider exploded", status=500)
                yield  # pragma: no cover

        loop = AgentLoop(
            profile=make_profile(),
            settings=AgentSettings(auto_approve=True),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=Boom([]),
        )
        result = loop.run("hi")
        self.assertEqual(result.stopped, "error")
        self.assertIn("provider exploded", self.payload("error")["message"])

    def test_cancel_stops_a_running_turn(self) -> None:
        class Slow(FakeClient):
            def stream(self, messages, tools=None, **kwargs):
                for _ in range(50):
                    time.sleep(0.01)
                    yield Chunk(text="tick ")

        loop = AgentLoop(
            profile=make_profile(),
            settings=AgentSettings(auto_approve=True),
            workspace=self.workspace,
            registry=default_registry(),
            emit=lambda event_type, data: self.events.append((event_type, data)),
            client=Slow([]),
        )
        threading.Thread(target=lambda: (time.sleep(0.05), loop.cancel()), daemon=True).start()
        result = loop.run("keep going")
        self.assertEqual(result.stopped, "cancelled")

    def test_history_trimming_never_orphans_a_tool_result(self) -> None:
        # Tool calls first and the answer last. A script of tool/text pairs used
        # to end the turn at the first text reply, so the history never reached
        # the ceiling and this test passed without testing the trimming at all.
        script = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"c{index}")
            for index in range(12)
        ]
        script.append(text_chunks("done"))
        script.append(text_chunks("second turn"))
        loop, client = self.build(
            script,
            settings=AgentSettings(auto_approve=True, max_steps=14, max_history_messages=10),
        )
        loop.run("do a lot")
        # The trim runs when the turn ends, so the trimmed history is what the
        # next request sends - which is the payload that has to stay valid.
        loop.run("again")

        roles = [message["role"] for message in client.last_messages[1:]]
        self.assertLessEqual(len(roles), 11, "the ceiling should have dropped the oldest")
        for index, role in enumerate(roles):
            if role != "tool":
                continue
            self.assertGreater(index, 0, "a tool message must follow its assistant call")
            self.assertEqual(roles[index - 1], "assistant")

    def test_loop_can_be_reset(self) -> None:
        loop, _ = self.build([text_chunks("a"), text_chunks("b")])
        loop.run("one")
        self.assertTrue(loop.messages)
        loop.reset()
        self.assertEqual(loop.messages, [])


class FailingSummaryClient(FakeClient):
    """Answers everything, and refuses the quiet summarisation request.

    The summary is the one call the loop makes with no tools, which is how this
    recognises it without depending on the prompt's wording.
    """

    def stream(self, messages, tools=None, **kwargs):
        if tools is None:
            self.calls.append({"messages": list(messages), "tools": None})
            raise ProviderError("the endpoint refused the summary", status=500)
        return super().stream(messages, tools=tools, **kwargs)


class ContextCompactionTest(LoopTestCase):
    """The conversation is compacted instead of being sent until it overflows."""

    #: 800 characters, about 200 tokens by the loop's own estimate: a realistic
    #: message in a small window, and small enough that dropping the oldest one
    #: genuinely buys room.
    MESSAGE = 800

    def small_window(self, script, *, window=2000, max_output=0, compact_at=0.5, **kwargs):
        settings = AgentSettings(auto_approve=True, max_steps=4, compact_at=compact_at)
        profile = make_profile(context_window=window, max_output_tokens=max_output)
        return self.build(script, settings=settings, profile=profile, **kwargs)

    def test_the_estimate_grows_with_the_text_and_the_tool_arguments(self) -> None:
        small = estimate_tokens([{"role": "user", "content": "a" * 400}])
        large = estimate_tokens([{"role": "user", "content": "a" * 8000}])
        self.assertGreater(large, small)
        with_call = estimate_tokens(
            [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"function": {"name": "read_file", "arguments": "p" * 400}}
                    ],
                }
            ]
        )
        self.assertGreater(with_call, estimate_tokens([{"role": "assistant", "content": ""}]))

    def test_nothing_is_dropped_while_the_conversation_fits(self) -> None:
        loop, client = self.small_window(
            [text_chunks("one"), text_chunks("two"), text_chunks("three")],
            window=100_000,
        )
        for message in ("one", "two", "three"):
            loop.run(message)

        self.assertNotIn("context_compacted", self.types())
        self.assertEqual(len(loop.messages), 6)
        self.assertNotIn(SUMMARY_MARKER, client.last_messages[1]["content"])

    def test_a_full_window_is_summarised_by_the_model(self) -> None:
        loop, client = self.small_window(
            [
                text_chunks("answer one"),
                text_chunks("answer two"),
                # The summary request, then the turn's own request.
                text_chunks("summary of the earlier turns"),
                text_chunks("the real answer"),
            ]
        )
        loop.run("a" * self.MESSAGE)
        loop.run("b" * self.MESSAGE)
        result = loop.run("c" * self.MESSAGE)

        self.assertEqual(result.text, "the real answer")
        # Four requests for three turns: the third turn paid for a summary.
        self.assertEqual(len(client.calls), 4)
        self.assertIsNone(client.calls[2]["tools"], "the summary is asked without tools")
        self.assertIn("summary of the earlier turns", result.messages[0]["content"])
        self.assertTrue(result.messages[0]["content"].startswith(SUMMARY_MARKER))

        prompt = client.calls[3]["messages"]
        self.assertTrue(prompt[1]["content"].startswith(SUMMARY_MARKER))
        self.assertIn("summary of the earlier turns", prompt[1]["content"])
        sent = " ".join(str(m.get("content")) for m in prompt)
        self.assertNotIn("a" * self.MESSAGE, sent, "the dropped part must not be sent")
        self.assertIn("b" * self.MESSAGE, sent, "the newest part must be kept")

        event = self.payload("context_compacted")
        self.assertEqual(event["reason"], "window")
        self.assertTrue(event["summarised"])
        self.assertGreaterEqual(event["dropped"], 1)
        self.assertGreater(event["tokens_before"], event["tokens_after"])
        self.assertEqual(event["context_window"], 2000)
        # The summary is housekeeping: it must never appear in the transcript the
        # user watches, which is what a stray text_delta event would do.
        self.assertFalse(
            [
                data
                for event_type, data in self.events
                if "summary of the earlier turns" in str(data.get("text", ""))
            ]
        )

    def test_a_refused_summary_still_frees_the_window(self) -> None:
        client = FailingSummaryClient(
            [
                text_chunks("answer one"),
                text_chunks("answer two"),
                text_chunks("the real answer"),
            ]
        )
        loop, _ = self.small_window([], client=client)
        loop.run("a" * self.MESSAGE)
        loop.run("b" * self.MESSAGE)
        result = loop.run("c" * self.MESSAGE)

        self.assertEqual(result.text, "the real answer")
        self.assertEqual(result.stopped, "completed")
        event = self.payload("context_compacted")
        self.assertFalse(event["summarised"])
        self.assertEqual(event["reason"], "window")
        note = result.messages[0]["content"]
        self.assertTrue(note.startswith(SUMMARY_MARKER))
        # The note says what was lost, so a surprising answer can be traced to it.
        self.assertIn("could not be summarised", note)
        self.assertNotIn("a" * self.MESSAGE, note)

    def test_the_message_ceiling_drops_the_oldest_and_reports_it(self) -> None:
        script = [
            tool_chunks("read_file", {"path": "hello.txt"}, call_id=f"c{index}")
            for index in range(8)
        ]
        script.append(text_chunks("done"))
        loop, _ = self.build(
            script,
            settings=AgentSettings(auto_approve=True, max_steps=10, max_history_messages=10),
        )
        loop.run("do a lot")

        event = self.payload("context_compacted")
        self.assertEqual(event["reason"], "messages")
        self.assertFalse(event["summarised"])
        self.assertEqual(event["message_limit"], 10)
        self.assertLessEqual(len(loop.messages), 10)
        self.assertGreaterEqual(event["dropped"], 1)


if __name__ == "__main__":
    unittest.main()