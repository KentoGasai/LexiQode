"""The step loop: stream a completion, run the requested tools, repeat.

The loop owns no transport. It publishes events through a callback and asks for
approval through another one, which is what lets the same object serve an HTTP
SSE stream, a terminal REPL and a unit test without changes.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..config import AgentSettings, ModelProfile
from ..errors import ProviderError
from ..llm.openai import OpenAIChatClient
from ..llm.types import StreamAccumulator, ToolCall, Usage, tool_message, user_message
from .events import EventEmitter
from .prompts import build_system_prompt
from .tools.base import ApprovalDecision, ApprovalRequest, ToolContext
from .tools.registry import ToolRegistry


@dataclass(slots=True)
class LoopResult:
    """What came out of one :meth:`AgentLoop.run` call."""

    text: str = ""
    steps: int = 0
    tool_calls: int = 0
    usage: Usage = field(default_factory=Usage)
    stopped: str = "completed"
    messages: list[dict[str, Any]] = field(default_factory=list)


def _auto_approve(_request: ApprovalRequest) -> ApprovalDecision:
    return ApprovalDecision(approved=True, reason="auto-approved")


class AgentLoop:
    """Runs a conversation and keeps its message list between runs."""

    def __init__(
        self,
        *,
        profile: ModelProfile,
        settings: AgentSettings,
        workspace: Path,
        registry: ToolRegistry,
        emit: EventEmitter,
        approve: Callable[[ApprovalRequest], ApprovalDecision] | None = None,
        history: list[dict[str, Any]] | None = None,
        client: OpenAIChatClient | None = None,
        extra_rules: str = "",
        max_history_messages: int = 60,
    ) -> None:
        self.profile = profile
        self.settings = settings
        self.workspace = Path(workspace).resolve()
        self.registry = registry
        self._emit = emit
        self._approve = approve or _auto_approve
        self._client = client or OpenAIChatClient(profile)
        self._owns_client = client is None
        self._history: list[dict[str, Any]] = list(history or [])
        self._system = build_system_prompt(self.workspace, registry, extra_rules=extra_rules)
        self._cancel = threading.Event()
        self._max_history = max(10, max_history_messages)

    @property
    def messages(self) -> list[dict[str, Any]]:
        return list(self._history)

    def cancel(self) -> None:
        """Ask the running turn to stop at the next safe point."""

        self._cancel.set()

    def reset(self) -> None:
        self._history.clear()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def history_json(self) -> str:
        return json.dumps(self._history, ensure_ascii=False)

    # ------------------------------------------------------------------ the loop
    def run(self, user_text: str) -> LoopResult:
        self._cancel.clear()
        self._history.append(user_message(user_text))
        self._emit("turn_start", {"model": self.profile.model, "profile": self.profile.id})

        result = LoopResult()
        try:
            for step in range(1, max(1, self.settings.max_steps) + 1):
                if self._cancel.is_set():
                    result.stopped = "cancelled"
                    break
                result.steps = step
                self._emit("step_start", {"step": step, "max_steps": self.settings.max_steps})

                accumulator = self._stream_once()
                self._accumulate_usage(result.usage, accumulator.usage)

                text = accumulator.text
                if text:
                    self._emit("assistant_text", {"text": text})

                self._history.append(accumulator.message())

                # A cancel during streaming must not be reported as a completed
                # turn just because the partial answer happened to contain no
                # tool calls.
                if self._cancel.is_set():
                    result.stopped = "cancelled"
                    result.text = text
                    break

                calls = accumulator.tool_calls
                if not calls:
                    result.text = text
                    break

                for call in calls:
                    outcome = self._run_tool(call)
                    result.tool_calls += 1
                    self._history.append(
                        tool_message(call.id or f"call_{call.index}", call.name, outcome)
                    )
            else:
                result.stopped = "max_steps"
                result.text = self._last_assistant_text()
        except ProviderError as exc:
            result.stopped = "error"
            self._emit("error", {"message": str(exc), "status": exc.status})
        finally:
            self._trim()
            self._emit(
                "turn_end",
                {
                    "stopped": result.stopped,
                    "steps": result.steps,
                    "tool_calls": result.tool_calls,
                    "usage": {
                        "prompt_tokens": result.usage.prompt_tokens,
                        "completion_tokens": result.usage.completion_tokens,
                        "total_tokens": result.usage.total_tokens,
                    },
                },
            )
        result.messages = self.messages
        return result

    # ------------------------------------------------------------------ internals
    @staticmethod
    def _accumulate_usage(total: Usage, extra: Usage | None) -> None:
        if extra is None:
            return
        total.prompt_tokens += extra.prompt_tokens
        total.completion_tokens += extra.completion_tokens
        total.total_tokens += extra.total_tokens

    def _stream_once(self) -> StreamAccumulator:
        """One completion, published as events while it streams."""

        accumulator = StreamAccumulator()
        payload = [{"role": "system", "content": self._system}, *self._history]
        tools = self.registry.schemas() if self.profile.supports_tools else None

        for chunk in self._client.stream(payload, tools):
            if self._cancel.is_set():
                break
            accumulator.feed(chunk)
            for call in chunk.tool_calls:
                if call.name:
                    self._emit("tool_call_delta", {"index": call.index, "name": call.name})
            if chunk.text:
                self._emit("text_delta", {"text": chunk.text})
            if chunk.reasoning:
                self._emit("reasoning_delta", {"text": chunk.reasoning})
        return accumulator

    def _run_tool(self, call: ToolCall) -> str:
        """Execute one tool call and return the text that goes back to the model."""

        arguments = call.parsed_arguments()
        call_id = call.id or f"call_{call.index}"
        self._emit("tool_start", {"id": call_id, "name": call.name, "arguments": arguments})

        if self._cancel.is_set():
            outcome = "cancelled by the user before this tool ran"
            self._emit(
                "tool_end",
                {"id": call_id, "name": call.name, "ok": False, "cancelled": True, "content": outcome},
            )
            return outcome

        context = ToolContext(
            workspace=self.workspace,
            settings=self.settings,
            emit=self._emit,
            approve=self._approve,
        )
        result = self.registry.execute(call.name, arguments, context)

        content = result.content
        budget = self.settings.max_tool_output
        if len(content) > budget:
            content = content[:budget] + f"\n...truncated ({len(result.content)} chars)"

        preview = content if len(content) <= 4000 else content[:4000] + "..."
        self._emit(
            "tool_end",
            {
                "id": call_id,
                "name": call.name,
                "ok": result.ok,
                "elapsed_ms": result.elapsed_ms,
                "meta": result.meta,
                "content": preview,
            },
        )
        return content

    def _last_assistant_text(self) -> str:
        for message in reversed(self._history):
            if message.get("role") == "assistant" and message.get("content"):
                return str(message["content"])
        return ""

    def _trim(self) -> None:
        """Keep the newest messages, never splitting a tool call from its result."""

        if len(self._history) <= self._max_history:
            return
        cut = len(self._history) - self._max_history
        # A 'tool' message must keep the assistant message that requested it.
        while cut < len(self._history) and self._history[cut].get("role") == "tool":
            cut += 1
        self._history = self._history[cut:]