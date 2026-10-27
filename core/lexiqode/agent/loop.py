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
from ..llm.types import (
    StreamAccumulator,
    ToolCall,
    Usage,
    system_message,
    tool_message,
    user_message,
)
from .events import EventEmitter
from .modes import AgentMode, get_mode
from .prompts import build_system_prompt
from .tools.base import ApprovalDecision, ApprovalRequest, ToolContext
from .tools.registry import ToolRegistry

#: Marker on the message that stands in for a dropped part of a conversation.
#: The panel recognises it and draws a notice instead of a user bubble, and the
#: model reads it as the context it is.
SUMMARY_MARKER = "[context summary]"

#: Characters per token used by :func:`estimate_tokens`. English prose runs near
#: four; code and Cyrillic are denser, so the estimate deliberately errs low and
#: the room is spent earlier rather than later.
CHARS_PER_TOKEN = 4

#: Cost per message that does not come from its text: role, delimiters, a tool
#: call id. Without it a conversation of short messages is counted as free.
MESSAGE_OVERHEAD_TOKENS = 8


def estimate_tokens(messages: list[dict[str, Any]]) -> int:
    """Approximately what these messages cost, measured locally.

    Asking the endpoint would cost a request per step and a real tokeniser would
    be a dependency the core does not have, so this is a rough count used to
    decide *when* to compact. The provider's own ``usage`` is preferred wherever
    it is available, and the panel says which of the two it is showing.
    """

    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            total += len(content) // CHARS_PER_TOKEN
        for call in message.get("tool_calls") or ():
            arguments = (call.get("function") or {}).get("arguments") or ""
            total += len(str(arguments)) // CHARS_PER_TOKEN
        total += MESSAGE_OVERHEAD_TOKENS
    return total


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
        max_history_messages: int | None = None,
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
        self._extra_rules = extra_rules
        # The prompt names the mode and its tools, so it is built per mode and
        # remembered: the workspace snapshot inside it costs a git call.
        self._system_cache: dict[str, str] = {}
        self._mode: AgentMode = get_mode(None)
        self._cancel = threading.Event()
        self._max_history = max(10, max_history_messages or settings.max_history_messages)
        # When to compact, as a fraction of the window. Clamped here rather than
        # trusted: a settings file is user input, and 0 would compact on every
        # step while 2 would never compact at all.
        self._compact_at = min(0.95, max(0.1, float(settings.compact_at or 0.75)))
        #: Messages that always survive, however little room is left: the newest
        #: exchange is what the turn is about.
        self._min_kept = 4
        #: Whether this turn has already paid for a summary. See :meth:`_compact`.
        self._summarised_this_turn = False
        # Whether the current turn may call tools. Inline edits turn this off so
        # the answer is a single piece of text the editor can insert directly.
        self._tools_enabled = True

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
    def run(self, user_text: str, *, tools: bool = True, mode: AgentMode | None = None) -> LoopResult:
        self._cancel.clear()
        self._summarised_this_turn = False
        self._mode = mode or get_mode(None)
        self._tools_enabled = bool(tools) and self.profile.supports_tools and self._mode.tools != ()
        self._history.append(user_message(user_text))
        self._emit(
            "turn_start",
            {"model": self.profile.model, "profile": self.profile.id, "mode": self._mode.id},
        )

        # A mode may ask for a smaller budget than the configured maximum; it may
        # never raise it, because that ceiling is the user's.
        budget = self.settings.max_steps
        if self._mode.steps:
            budget = min(budget, self._mode.steps)
        budget = max(1, budget)

        result = LoopResult()
        #: Prompt tokens the provider reported for the newest request, which is
        #: how full the model's window actually is. Zero when it reports none.
        measured_prompt_tokens = 0
        try:
            for step in range(1, budget + 1):
                if self._cancel.is_set():
                    result.stopped = "cancelled"
                    break
                result.steps = step
                self._emit("step_start", {"step": step, "max_steps": budget})
                # Before every request, not only the first: a turn that runs ten
                # tool calls grows its own history as it goes, and the last step
                # is the one that would exceed the window.
                self._compact()

                accumulator = self._stream_once()
                self._accumulate_usage(result.usage, accumulator.usage)
                if accumulator.usage and accumulator.usage.prompt_tokens:
                    measured_prompt_tokens = accumulator.usage.prompt_tokens

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
                    # What the conversation now costs against the model's window,
                    # and whether that number was measured or estimated. The panel
                    # shows it, and it is what makes compaction visible before it
                    # happens rather than after.
                    "context": self.context_usage(measured_prompt_tokens),
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
        payload = [{"role": "system", "content": self._system_for(self._mode)}, *self._history]
        tool_schemas = self.registry.schemas(self._mode.tools) if self._tools_enabled else None

        for chunk in self._client.stream(payload, tool_schemas):
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
        result = self.registry.execute(call.name, arguments, context, self._mode.tools)

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

    def _system_for(self, mode: AgentMode) -> str:
        cached = self._system_cache.get(mode.id)
        if cached is None:
            cached = build_system_prompt(
                self.workspace, self.registry, extra_rules=self._extra_rules, mode=mode
            )
            self._system_cache[mode.id] = cached
        return cached

    def _prompt_estimate(self, history: list[dict[str, Any]] | None = None) -> int:
        """What the next request would cost, the system prompt included."""

        messages = self._history if history is None else history
        return estimate_tokens(
            [{"role": "system", "content": self._system_for(self._mode)}, *messages]
        )

    def context_usage(self, measured_prompt_tokens: int = 0) -> dict[str, Any]:
        """How full the model's window is, for whoever is showing it.

        ``measured_prompt_tokens`` is what the provider reported for the newest
        request. Without it the loop's own estimate is used and the answer says
        which of the two it is, because a gauge that quietly mixes a reported
        count with a guessed one is worse than no gauge at all.
        """

        return {
            "tokens": int(measured_prompt_tokens or self._prompt_estimate()),
            "measured": bool(measured_prompt_tokens),
            "window": int(self.profile.context_window or 0),
            "compact_at": self._compact_at,
        }

    def _cut_index(self, limit: int) -> int:
        """How many of the oldest messages to drop to get back inside ``limit``.

        The newest messages are kept and the oldest are dropped, which is the
        part of a coding session that matters least - it is also the part a
        summary can replace. At least ``_min_kept`` messages always stay, and the
        cut never lands on a ``tool`` message whose requesting ``assistant``
        message was dropped: that pairing is what the wire format requires.
        """

        history = self._history
        budget = max(1, limit // 2)
        used = 0
        cut = len(history)
        for index in range(len(history) - 1, -1, -1):
            used += estimate_tokens([history[index]])
            if used > budget and len(history) - index > self._min_kept:
                break
            cut = index
        cut = max(0, min(cut, len(history) - self._min_kept))
        while cut < len(history) and history[cut].get("role") == "tool":
            cut += 1
        return cut

    def _summarise(self, messages: list[dict[str, Any]]) -> str:
        """Ask the model for a compact replacement of a dropped part.

        A quiet call: it emits no ``text_delta``, because the summary must not be
        appended to the answer the user is watching, and it does not enter the
        history, because the loop would then summarise its own summaries.
        """

        parts: list[str] = []
        for message in messages:
            content = message.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            parts.append(f"{message.get('role', 'user')}: {content}")
        transcript = "\n\n".join(parts)[: max(2000, int(self.settings.max_tool_output))]
        if not transcript.strip():
            return ""

        request = [
            system_message(
                "You compress a coding conversation so it can continue in less "
                "space. Keep decisions taken, files and paths touched, commands "
                "run and their outcomes, unresolved problems, and anything the "
                "user asked for. Drop greetings, repetition and your own "
                "reasoning. Answer with the summary only, as plain text."
            ),
            user_message(transcript),
        ]
        accumulator = StreamAccumulator()
        try:
            for chunk in self._client.stream(request, None):
                accumulator.feed(chunk)
        except Exception:
            # Every failure lands in the same place on purpose: a summary is an
            # optimisation, and a turn that cannot run at all is worse than a turn
            # whose oldest detail was dropped with a note saying so.
            return ""
        return accumulator.text.strip()

    def _compact(self) -> bool:
        """Summarise the oldest part of the conversation when it fills the window.

        Two limits answer different questions, and both are applied. The profile's
        ``context_window`` says how much the model will accept at once; the answer
        needs room inside it too, so ``max_output_tokens`` is subtracted before
        ``compact_at`` is applied. When the window is the binding limit the dropped
        part is compressed by the model first, so a long session keeps its
        decisions instead of losing them silently.

        The summary is written once per turn, not once per step. A single step that
        reads a dozen files can fill the window on its own, so a many-step turn
        used to pay for a summarising request before nearly every step: the same
        conversation compressed again and again, each time with the note that says
        so. After the first summary the rest of the turn drops the oldest messages
        instead - it costs nothing, it keeps the request inside the window just as
        well, and the note says plainly that this part was dropped.
        """

        window = int(self.profile.context_window or 0)
        if window <= 0 or len(self._history) <= self._min_kept:
            return False
        usable = max(1, window - max(0, int(self.profile.max_output_tokens or 0)))
        limit = int(usable * self._compact_at)
        before = self._prompt_estimate()
        if before <= limit:
            return False

        cut = self._cut_index(limit)
        if cut <= 0:
            return False

        if self._summarised_this_turn:
            return self._drop_oldest(cut, before, window)

        dropped = self._history[:cut]
        self._history = self._history[cut:]
        summary = self._summarise(dropped)
        self._summarised_this_turn = True
        if summary:
            note = f"{SUMMARY_MARKER} {summary}"
        else:
            note = (
                f"{SUMMARY_MARKER} {len(dropped)} earlier messages were dropped: "
                "they no longer fit the model's context window and could not be "
                "summarised."
            )
        self._history.insert(0, user_message(note))
        self._emit(
            "context_compacted",
            {
                "reason": "window",
                "dropped": len(dropped),
                "kept": len(self._history),
                "summarised": bool(summary),
                "tokens_before": before,
                "tokens_after": self._prompt_estimate(),
                "context_window": window,
            },
        )
        return True

    def _drop_oldest(self, cut: int, before: int, window: int) -> bool:
        """Make room by dropping the oldest messages, without a model call.

        The summary at the head is the most valuable message in the conversation -
        it is what an earlier compaction decided was worth remembering - so it is
        kept whenever anything else is being thrown away. That is why the drop
        starts at index one rather than at zero.
        """

        history = self._history
        head = str(history[0].get("content", "")) if history else ""
        keeps_summary = head.startswith(SUMMARY_MARKER)
        if keeps_summary and cut <= 1:
            return False
        if keeps_summary:
            dropped = history[1:cut]
            self._history = [history[0], *history[cut:]]
        else:
            dropped = history[:cut]
            self._history = history[cut:]
        if not dropped:
            return False
        self._emit(
            "context_compacted",
            {
                "reason": "window",
                "dropped": len(dropped),
                "kept": len(self._history),
                "summarised": False,
                "tokens_before": before,
                "tokens_after": self._prompt_estimate(),
                "context_window": window,
            },
        )
        return True

    def _trim(self) -> None:
        """Keep the newest messages, never splitting a tool call from its result.

        The backstop behind :meth:`_compact`: a conversation of many tiny messages
        can stay inside any token window and still be unmanageable, and this is
        the ceiling that ends it. It drops rather than summarises because it runs
        on the way out of a turn, where an extra model call would delay the answer
        the user is already reading.
        """

        if len(self._history) <= self._max_history:
            return
        cut = len(self._history) - self._max_history
        # A 'tool' message must keep the assistant message that requested it.
        while cut < len(self._history) and self._history[cut].get("role") == "tool":
            cut += 1
        dropped = self._history[:cut]
        self._history = self._history[cut:]
        if dropped:
            self._emit(
                "context_compacted",
                {
                    "reason": "messages",
                    "dropped": len(dropped),
                    "kept": len(self._history),
                    "summarised": False,
                    "message_limit": self._max_history,
                    "tokens_before": self._prompt_estimate(
                        [*dropped, *self._history]
                    ),
                    "tokens_after": self._prompt_estimate(),
                    "context_window": int(self.profile.context_window or 0),
                },
            )