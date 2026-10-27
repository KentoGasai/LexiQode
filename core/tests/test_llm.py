"""The OpenAI-compatible client, driven through httpx.MockTransport."""

from __future__ import annotations

import json
import unittest

import httpx

from lexiqode.config import ModelProfile
from lexiqode.errors import ProviderError
from lexiqode.llm.openai import OpenAIChatClient
from lexiqode.llm.types import StreamAccumulator, Usage, tool_schema


def sse(*payloads: dict) -> bytes:
    body = "".join(f"data: {json.dumps(payload)}\n\n" for payload in payloads)
    return (body + "data: [DONE]\n\n").encode("utf-8")


def profile(**overrides) -> ModelProfile:
    base = {
        "id": "test",
        "base_url": "https://provider.test/v1",
        "model": "test-model",
        "api_key": "test-key",
    }
    base.update(overrides)
    return ModelProfile(**base).normalised()


def client_for(handler, prof: ModelProfile | None = None) -> OpenAIChatClient:
    transport = httpx.MockTransport(handler)
    return OpenAIChatClient(prof or profile(), client=httpx.Client(transport=transport))


class StreamingTest(unittest.TestCase):
    def test_text_deltas_and_usage(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["authorization"], "Bearer test-key")
            body = json.loads(request.content)
            self.assertEqual(body["model"], "test-model")
            self.assertTrue(body["stream"])
            self.assertEqual(body["stream_options"], {"include_usage": True})
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=sse(
                    {"choices": [{"delta": {"content": "Hel"}}]},
                    {"choices": [{"delta": {"content": "lo"}}]},
                    {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                    {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 2,
                                              "total_tokens": 9}},
                ),
            )

        accumulator = StreamAccumulator()
        with client_for(handler) as client:
            for chunk in client.stream([{"role": "user", "content": "hi"}]):
                accumulator.feed(chunk)

        self.assertEqual(accumulator.text, "Hello")
        self.assertEqual(accumulator.finish_reason, "stop")
        self.assertIsNotNone(accumulator.usage)
        self.assertEqual(accumulator.usage.total_tokens, 9)
        self.assertEqual(accumulator.message(), {"role": "assistant", "content": "Hello"})

    def test_tool_call_arguments_are_accumulated(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=sse(
                    {"choices": [{"delta": {"tool_calls": [
                        {"index": 0, "id": "call_a", "function": {"name": "read_file",
                                                                  "arguments": '{"pa'}}]}}]},
                    {"choices": [{"delta": {"tool_calls": [
                        {"index": 0, "function": {"arguments": 'th": "a.txt"}'}}]}}]},
                    {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
                ),
            )

        accumulator = StreamAccumulator()
        with client_for(handler) as client:
            for chunk in client.stream([], None):
                accumulator.feed(chunk)

        calls = accumulator.tool_calls
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].name, "read_file")
        self.assertEqual(calls[0].parsed_arguments(), {"path": "a.txt"})
        message = accumulator.message()
        self.assertEqual(message["tool_calls"][0]["function"]["name"], "read_file")

    def test_tools_are_sent_when_supported(self) -> None:
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "ok"}}]}))

        schema = tool_schema("t", "d", {"a": {"type": "string"}}, ["a"])
        with client_for(handler) as client:
            list(client.stream([{"role": "user", "content": "x"}], [schema]))

        self.assertEqual(seen["tools"][0]["function"]["name"], "t")
        self.assertEqual(seen["tool_choice"], "auto")

    def test_tools_are_omitted_when_profile_disables_them(self) -> None:
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "ok"}}]}))

        with client_for(handler, profile(supports_tools=False)) as client:
            list(client.stream([], [tool_schema("t", "d", {}, [])]))
        self.assertNotIn("tools", seen)

    def test_reasoning_on_sends_no_field_at_all(self) -> None:
        """The default must leave the request exactly as it was.

        An endpoint that has never heard of ``reasoning_effort`` would answer 400,
        and turning a setting on by omitting it is the only way to promise that
        nothing about a working profile changes.
        """

        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "ok"}}]}))

        with client_for(handler) as client:
            list(client.stream([]))
        self.assertNotIn("reasoning_effort", seen)

    def test_reasoning_off_is_stated_as_none(self) -> None:
        """Off is a field, because a model that reasons by default cannot be told
        to stop by silence: ``reasoning_effort: "none"`` is what both DeepSeek and
        the o-series read as "answer directly"."""

        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "ok"}}]}))

        with client_for(handler, profile(reasoning=False)) as client:
            list(client.stream([]))
        self.assertEqual(seen["reasoning_effort"], "none")

    def test_reasoning_field_is_captured_separately(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=sse(
                {"choices": [{"delta": {"reasoning_content": "thinking"}}]},
                {"choices": [{"delta": {"content": "answer"}}]},
            ))

        accumulator = StreamAccumulator()
        with client_for(handler) as client:
            for chunk in client.stream([]):
                accumulator.feed(chunk)
        self.assertEqual(accumulator.reasoning, "thinking")
        self.assertEqual(accumulator.text, "answer")


class ErrorHandlingTest(unittest.TestCase):
    def test_http_error_becomes_provider_error(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": {"message": "bad key"}})

        with client_for(handler) as client:
            with self.assertRaises(ProviderError) as caught:
                list(client.stream([]))
        self.assertEqual(caught.exception.status, 401)
        self.assertIn("401", str(caught.exception))

    def test_error_object_inside_the_stream_is_raised(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=sse({"error": {"message": "rate limited"}}))

        with client_for(handler) as client:
            with self.assertRaises(ProviderError) as caught:
                list(client.stream([]))
        self.assertIn("rate limited", str(caught.exception))

    def test_stream_options_rejection_is_retried_without_it(self) -> None:
        attempts: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            attempts.append(body)
            if "stream_options" in body:
                return httpx.Response(400, json={"error": {"message": "unknown field: stream_options"}})
            return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "ok"}}]}))

        with client_for(handler) as client:
            chunks = list(client.stream([]))

        self.assertEqual(len(attempts), 2)
        self.assertNotIn("stream_options", attempts[1])
        self.assertEqual("".join(chunk.text for chunk in chunks), "ok")

    def test_unreachable_endpoint_is_reported(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        with client_for(handler) as client:
            with self.assertRaises(ProviderError) as caught:
                list(client.stream([]))
        self.assertIn("cannot reach", str(caught.exception))

    def test_reasoning_field_rejection_is_retried_without_it(self) -> None:
        """A gateway that predates the field refuses it instead of ignoring it.

        The switch must not be able to break an endpoint that was working: the
        request is sent again without the field, and only when the refusal names
        it.
        """

        attempts: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            attempts.append(body)
            if "reasoning_effort" in body:
                return httpx.Response(
                    400, json={"error": {"message": "unknown field: reasoning_effort"}}
                )
            return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "ok"}}]}))

        with client_for(handler, profile(reasoning=False)) as client:
            chunks = list(client.stream([]))

        self.assertEqual(len(attempts), 2)
        self.assertNotIn("reasoning_effort", attempts[1])
        self.assertEqual("".join(chunk.text for chunk in chunks), "ok")

    def test_an_unresolvable_400_is_reported_rather_than_retried(self) -> None:
        """A refusal that names nothing we sent is the provider's answer, not a
        hint to start guessing: it is raised, once."""

        attempts: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(json.loads(request.content))
            return httpx.Response(400, json={"error": {"message": "context length exceeded"}})

        with client_for(handler, profile(reasoning=False)) as client:
            with self.assertRaises(ProviderError) as caught:
                list(client.stream([]))
        self.assertEqual(len(attempts), 1)
        self.assertEqual(caught.exception.status, 400)

    def test_vendor_keepalive_text_is_ignored(self) -> None:
        body = b": keep-alive\n\ndata: not-json\n\n" + sse(
            {"choices": [{"delta": {"content": "fine"}}]}
        )

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=body)

        with client_for(handler) as client:
            text = "".join(chunk.text for chunk in client.stream([]))
        self.assertEqual(text, "fine")


class DecodeTest(unittest.TestCase):
    def test_decode_line_variants(self) -> None:
        self.assertIsNone(OpenAIChatClient.decode_line(""))
        self.assertIsNone(OpenAIChatClient.decode_line(": ping"))
        self.assertIsNone(OpenAIChatClient.decode_line("data: [DONE]"))
        chunk = OpenAIChatClient.decode_line('data: {"choices":[{"delta":{"content":"x"}}]}')
        self.assertIsNotNone(chunk)
        self.assertEqual(chunk.text, "x")

    def test_usage_payload_is_optional(self) -> None:
        self.assertIsNone(Usage.from_payload(None))
        self.assertEqual(Usage.from_payload({"prompt_tokens": 1}).prompt_tokens, 1)


class ModelsTest(unittest.TestCase):
    def test_list_models_is_sorted(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertTrue(str(request.url).endswith("/v1/models"))
            return httpx.Response(200, json={"data": [{"id": "b"}, {"id": "a"}]})

        with client_for(handler) as client:
            self.assertEqual(client.list_models(), ["a", "b"])

    def test_unexpected_shape_yields_empty_list(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"nope": True})

        with client_for(handler) as client:
            self.assertEqual(client.list_models(), [])


if __name__ == "__main__":
    unittest.main()