"""Streaming client for any OpenAI-compatible ``/chat/completions`` endpoint.

Only the documented chat-completions subset is used, so the same client drives a
hosted gateway, a local runtime or a private proxy. Two pieces of real-world
friction are handled explicitly because they otherwise break the agent loop:

* some proxies reject ``stream_options``, so the request is retried once without
  it when the server says so;
* tool-call arguments arrive as fragments, so they are accumulated rather than
  parsed per chunk.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

import httpx

from ..config import ModelProfile
from ..errors import ProviderError
from .types import Chunk, ToolCall, Usage

_BODY_EXCERPT = 600


class OpenAIChatClient:
    """One profile's worth of HTTP plumbing."""

    def __init__(
        self,
        profile: ModelProfile,
        *,
        timeout: float = 120.0,
        connect_timeout: float = 30.0,
        client: httpx.Client | None = None,
    ) -> None:
        self.profile = profile
        self._owns_client = client is None
        self._client = client or httpx.Client(
            timeout=httpx.Timeout(timeout, connect=connect_timeout),
            follow_redirects=True,
        )

    # ------------------------------------------------------------------ plumbing
    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            # Some gateways sit behind a CDN that buffers without this.
            "Cache-Control": "no-cache",
        }
        if self.profile.api_key:
            headers["Authorization"] = f"Bearer {self.profile.api_key}"
        for key, value in self.profile.headers.items():
            headers[key] = str(value)
        return headers

    def _payload(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        *,
        stream: bool,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.profile.model,
            "messages": messages,
            "stream": stream,
            "temperature": self.profile.temperature if temperature is None else temperature,
            "max_tokens": max_tokens or self.profile.max_output_tokens,
        }
        if tools and self.profile.supports_tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if stream and self.profile.stream_usage:
            payload["stream_options"] = {"include_usage": True}
        # Reasoning off is stated rather than omitted. A model that reasons by
        # default - which is what this switch exists for - cannot be told to stop
        # by saying nothing, and ``reasoning_effort: "none"`` is the field both
        # DeepSeek and the o-series understand. On sends nothing at all, so an
        # endpoint that does not know the field is never asked about it.
        if not self.profile.reasoning:
            payload["reasoning_effort"] = "none"
        return payload

    def _raise_for_status(self, response: httpx.Response) -> None:
        if response.is_success:
            return
        try:
            body = response.text
        except Exception:  # pragma: no cover - stream already consumed
            body = ""
        detail = body[:_BODY_EXCERPT].replace("\n", " ").strip()
        raise ProviderError(
            f"{self.profile.base_url} returned HTTP {response.status_code}"
            + (f": {detail}" if detail else ""),
            status=response.status_code,
            body=body,
        )

    def _post_stream(self, payload: dict[str, Any]) -> httpx.Response:
        """Open the streaming response, dropping extras the server refuses.

        Two fields are optional by design - ``stream_options`` and the reasoning
        switch - and a gateway that predates either answers 400 rather than
        ignoring it. Each is dropped once, only when the refusal names it, and the
        same request is then sent again: a proxy that dislikes one of them must
        not turn a working endpoint into a broken one.
        """

        url = self.profile.chat_completions_url()
        response = self._send(url, payload)

        if response.status_code == 400:
            detail = response.read().decode("utf-8", "replace").lower()
            for field in ("stream_options", "reasoning_effort"):
                if field not in payload or field not in detail:
                    continue
                payload = {k: v for k, v in payload.items() if k != field}
                response = self._send(url, payload)
                break

        self._raise_for_status(response)
        return response

    def _send(self, url: str, payload: dict[str, Any]) -> httpx.Response:
        """One streaming POST, with the transport failure named."""

        try:
            request = self._client.build_request("POST", url, json=payload, headers=self._headers())
            return self._client.send(request, stream=True)
        except httpx.HTTPError as exc:
            raise ProviderError(f"cannot reach {url}: {exc}") from exc

    # ------------------------------------------------------------------ streaming
    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> Iterator[Chunk]:
        """Yield decoded chunks until the server sends ``[DONE]``."""

        payload = self._payload(messages, tools, stream=True, temperature=temperature, max_tokens=max_tokens)
        response = self._post_stream(payload)
        try:
            for line in response.iter_lines():
                chunk = self.decode_line(line)
                if chunk is not None:
                    yield chunk
        except httpx.HTTPError as exc:
            # A stream that dies mid-answer is not an answer. Left uncaught it
            # escaped the agent loop entirely, so the turn ended with no event and
            # nothing on screen - which is how "the chat simply stops" happens. It
            # is reported as a provider failure so `run` can say what happened.
            raise ProviderError(f"the response stream ended early: {exc}") from exc
        finally:
            response.close()

    @staticmethod
    def decode_line(line: str) -> Chunk | None:
        """Turn one SSE line into a chunk, or ``None`` for keep-alives."""

        if not line:
            return None
        text = line.strip()
        if not text or text.startswith(":"):
            return None
        if text.startswith("data:"):
            text = text[5:].strip()
        if text == "[DONE]":
            return None
        try:
            payload = json.loads(text)
        except ValueError:
            # A few gateways interleave vendor keep-alive text; ignore it rather
            # than aborting a long generation.
            return None
        if not isinstance(payload, dict):
            return None
        if isinstance(payload.get("error"), dict):
            message = payload["error"].get("message") or "provider returned an error object"
            raise ProviderError(str(message), body=json.dumps(payload)[:_BODY_EXCERPT])

        choices = payload.get("choices") or []
        chunk = Chunk(usage=Usage.from_payload(payload.get("usage")))
        if not choices:
            return chunk if chunk.usage else None

        choice = choices[0] or {}
        delta = choice.get("delta") or {}
        if isinstance(delta.get("content"), str):
            chunk.text = delta["content"]
        for key in ("reasoning_content", "reasoning"):
            if isinstance(delta.get(key), str):
                chunk.reasoning = delta[key]
                break
        for raw_call in delta.get("tool_calls") or []:
            if not isinstance(raw_call, dict):
                continue
            function = raw_call.get("function") or {}
            chunk.tool_calls.append(
                ToolCall(
                    index=int(raw_call.get("index") or 0),
                    id=str(raw_call.get("id") or ""),
                    name=str(function.get("name") or ""),
                    arguments=str(function.get("arguments") or ""),
                )
            )
        if choice.get("finish_reason"):
            chunk.finish_reason = str(choice["finish_reason"])
        return chunk

    # ------------------------------------------------------------------ one-shot
    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Non-streaming call, used for short housekeeping requests."""

        from .types import StreamAccumulator

        accumulator = StreamAccumulator()
        for chunk in self.stream(messages, tools, **kwargs):
            accumulator.feed(chunk)
        return accumulator.message()

    def list_models(self) -> list[str]:
        """Ask the endpoint which models it serves."""

        try:
            response = self._client.get(self.profile.models_url(), headers=self._headers())
        except httpx.HTTPError as exc:
            raise ProviderError(f"cannot reach {self.profile.models_url()}: {exc}") from exc
        self._raise_for_status(response)
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderError("the endpoint did not return JSON for /models") from exc
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            return []
        names: list[str] = []
        for entry in data:
            if isinstance(entry, dict) and entry.get("id"):
                names.append(str(entry["id"]))
        return sorted(names)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "OpenAIChatClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()