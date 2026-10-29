"""The step loop: stream a completion, run the requested tools, repeat.

The loop owns no transport. It publishes events through a callback and asks for
approval through another one, which is what lets the same object serve an HTTP
SSE stream, a terminal REPL and a unit test without changes.
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

from ..config import AgentSettings, ModelProfile
from ..errors import ApprovalUnavailable, ProviderError
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
from .tools.base import (
    ApprovalDecision,
    ApprovalRequest,
    QuestionAnswer,
    QuestionRequest,
    ToolContext,
)
from .tools.registry import ToolRegistry

#: Marker on the message that stands in for a dropped part of a conversation.
#: The panel recognises it and draws a notice instead of a user bubble, and the
#: model reads it as the context it is.
SUMMARY_MARKER = "[context summary]"

#: Marker on the message that tells the model it was stopped for repeating
#: itself. The panel recognises it and draws the stop notice, and the model reads
#: it as the reason its last call was not the way forward.
REPEAT_MARKER = "[stopped: repeated call]"

#: Marker on the message that tells the model a promise is not an answer. The
#: panel recognises it and draws a notice, and the model reads it as the reason
#: its last message did not end the turn.
PROMISE_MARKER = "[not an answer: promised work]"

#: Phrases that announce work instead of doing it. A model that writes one of
#: these and calls no tool has not answered: it has said what it is about to do,
#: and the turn ended before it did it. Matched case-insensitively against the
#: whole message, which must also be short - a long answer that happens to
#: contain "let me" is an answer, not a promise.
PROMISE_PHRASES: tuple[str, ...] = (
    "работаю",
    "приступаю",
    "начинаю",
    "сейчас сделаю",
    "сейчас посмотрю",
    "сейчас проверю",
    "сейчас исправлю",
    "сейчас найду",
    "сейчас прочитаю",
    "сейчас запущу",
    "сейчас выполню",
    "сейчас займусь",
    "займусь этим",
    "берусь за",
    "продолжаю работу",
    "выполняю",
    "проверяю",
    "ищу",
    "анализирую",
    "изучаю",
    "working on it",
    "working on that",
    "let me",
    "i'll",
    "i will",
    "i'm going to",
    "i am going to",
    "starting now",
    "on it",
    "looking into",
    "checking",
    "investigating",
    "analyzing",
    "analysing",
)

#: How long a message may be and still count as a bare promise. A promise is a
#: sentence; an answer is usually more, and a long message that merely contains
#: "let me" somewhere is an answer that happens to mention it.
PROMISE_MAX_CHARS = 200

#: How many times one turn may be nudged for promising without acting. One is
#: enough to correct a model that meant to work; a model that promises again
#: after being told is not going to act, and the turn should end rather than
#: spend its whole budget on promises.
PROMISE_NUDGE_LIMIT = 2

#: Marker on the message that tells the model its completion carried neither text
#: nor a tool call, so the turn had nothing to go on.
EMPTY_MARKER = "[stopped: empty answer]"

#: Marker on the message that tells the model the output limit cut its answer
#: off before the sentence was finished.
TRUNCATED_MARKER = "[stopped: output limit]"

#: How many identical calls may come back with an identical result in one turn
#: before the loop decides nothing is changing. See :meth:`_note_repeat`.
NO_PROGRESS_LIMIT = 3

#: How many times one turn may be nudged for answering with nothing. Two,
#: because an empty completion can be a provider hiccup; a third is a model that
#: is not going to answer, and asking again only spends the budget.
EMPTY_NUDGE_LIMIT = 2

#: How many times one turn may be nudged for an answer cut off at the output
#: limit. One: the model cannot give itself more room, so a second nudge would
#: ask for something it cannot do.
TRUNCATED_NUDGE_LIMIT = 1

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


def looks_like_promise(text: str) -> bool:
    """Whether a message announces work instead of doing it.

    A model that writes "Работаю" and calls no tool has not answered the user: it
    has said what it is about to do, and the turn ended before it did it. The
    user sees a message that looks like progress and a turn that produced
    nothing, which is worse than an error - an error at least says something
    went wrong.

    The test is deliberately narrow. It fires only on a *short* message that is
    essentially one of the phrases, because a long answer that happens to contain
    "let me" is an answer, and treating it as a promise would keep a finished
    turn running.
    """

    stripped = (text or "").strip()
    if not stripped or len(stripped) > PROMISE_MAX_CHARS:
        return False
    # Trailing punctuation and whitespace are not part of the phrase.
    lowered = stripped.lower().strip(" \t\r\n.!…,;:-—")
    if not lowered:
        return False
    for phrase in PROMISE_PHRASES:
        if lowered == phrase:
            return True
        # "Работаю над этим." and "Let me check the file." are the same promise
        # with a few more words; the phrase has to be at the start, and the rest
        # has to be short enough to still be an announcement rather than an
        # answer that begins with it.
        if lowered.startswith(phrase) and len(lowered) <= len(phrase) + 60:
            return True
    return False


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
        ask: Callable[[QuestionRequest], QuestionAnswer] | None = None,
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
        #: How the agent reaches the user with a question. ``None`` means there is
        #: no user to reach, and ``ask_user`` reports that instead of blocking.
        self._ask = ask
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
        #: How many times one identical tool call may be made in a turn before the
        #: loop decides the model is stuck. See :meth:`_note_repeat`.
        self._repeat_limit = 3
        #: How many episodes of repetition one turn may be helped through before
        #: the turn is ended. See :meth:`run`. Four, not two: the counter cannot
        #: tell a recovered episode from an unrecovered one, so it is a budget the
        #: turn spends rather than a count of failures, and it has to be generous
        #: enough that a turn which recovers a few times is not cut short.
        self._repeat_episode_limit = 4
        #: Identical calls seen this turn, keyed by tool name and arguments.
        self._repeats: dict[tuple[str, str], int] = {}
        #: Calls that came back with the same result, keyed by tool name and
        #: arguments: ``(digest of the result, how many times in a row)``. A
        #: different result resets the count, because a result that moves is
        #: progress however often the call is made. See :meth:`_note_repeat`.
        self._no_progress: dict[tuple[str, str], tuple[str, int]] = {}
        #: How many times the same call may return the same result in one turn.
        self._no_progress_limit = NO_PROGRESS_LIMIT
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
        self._repeats.clear()
        self._no_progress.clear()
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
        #: How many episodes of repetition this turn has already been helped
        #: through. The per-episode retry above must not become an unlimited
        #: supply: a model that repeats, is told, does one other thing and repeats
        #: again would otherwise be retried for ever, and the turn would never end.
        #:
        #: It counts *attempts*, not failures, and that is deliberate. Telling a
        #: recovered episode from an unrecovered one would mean judging whether the
        #: model's next call is real progress, and one `list_dir` between two
        #: episodes is not evidence of anything. Counting attempts is the honest
        #: bound: it is a budget the turn spends, and it is set high enough that a
        #: turn which genuinely recovers a few times is not cut short.
        repeat_episodes = 0
        #: How many times this turn has been nudged for promising work without
        #: doing it. Bounded, because a model that only ever promises is not going
        #: to act, and the turn should end rather than spend its budget on
        #: announcements.
        promise_nudges = 0
        #: How many times this turn has been nudged for a completion that carried
        #: no text at all. Bounded for the same reason as the others.
        empty_nudges = 0
        #: How many times this turn has been nudged for an answer the output limit
        #: cut off before it was finished.
        truncated_nudges = 0
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
                truncated = accumulator.finish_reason == "length"
                if not calls:
                    # A message with no tool calls is normally the answer, and the
                    # turn ends here. Three shapes are not answers, and every one
                    # of them used to end the turn in silence - which is exactly
                    # how "the agent stands still, calls nothing and stops" was
                    # reported, with nothing on screen to say why:
                    #
                    # * a completion that carries no text at all;
                    # * an answer the output limit cut off mid-sentence;
                    # * a message that only *announces* work ("Работаю").
                    #
                    # The first is a provider hiccup or a model that spent its
                    # whole output budget on its own reasoning, so it gets bounded
                    # retries and then an ending the reader can see. The second is
                    # named for what it is, because the fix for it is a setting -
                    # the output limit - rather than another attempt. Telling the
                    # model is the whole fix for the third: it cannot correct what
                    # it does not know it did.
                    if truncated:
                        self._emit(
                            "answer_truncated",
                            {
                                "finish_reason": "length",
                                "chars": len(text),
                                "reasoning_chars": len(accumulator.reasoning),
                            },
                        )
                        if text and truncated_nudges < TRUNCATED_NUDGE_LIMIT:
                            truncated_nudges += 1
                            self._history.append(user_message(self._truncated_notice(text)))
                            continue
                    if not text:
                        if empty_nudges < EMPTY_NUDGE_LIMIT:
                            empty_nudges += 1
                            self._history.append(user_message(self._empty_notice(truncated)))
                            self._emit(
                                "empty_answer_retry",
                                {
                                    "finish_reason": accumulator.finish_reason or "",
                                    "reasoning_chars": len(accumulator.reasoning),
                                },
                            )
                            continue
                        # The turn produced nothing and has nothing left to hide
                        # behind: it ends, and the reason is published so the
                        # window can say it instead of showing a turn that simply
                        # stopped.
                        result.stopped = "truncated_answer" if truncated else "empty_answer"
                        result.text = ""
                        self._emit(
                            "empty_answer",
                            {
                                "finish_reason": accumulator.finish_reason or "",
                                "reasoning_chars": len(accumulator.reasoning),
                                "steps": step,
                                "truncated": truncated,
                            },
                        )
                        break
                    if looks_like_promise(text) and promise_nudges < PROMISE_NUDGE_LIMIT:
                        promise_nudges += 1
                        self._history.append(user_message(self._promise_notice(text)))
                        self._emit("promise_nudge", {"text": text})
                        continue
                    result.text = text
                    break

                for call in calls:
                    outcome = self._run_tool(call)
                    result.tool_calls += 1
                    self._history.append(
                        tool_message(call.id or f"call_{call.index}", call.name, outcome)
                    )
                    stuck = self._note_repeat(call, outcome)
                    if stuck:
                        reason, times = stuck
                        # The model is stuck. Telling it so in the history is the
                        # whole point: the stop notice is drawn in the window, and
                        # a model that never sees it has no reason to change what
                        # it is doing - which is why the same turn was reported
                        # stuck again and again.
                        self._history.append(
                            user_message(self._repeat_notice(call, reason=reason, times=times))
                        )
                        if repeat_episodes < self._repeat_episode_limit:
                            repeat_episodes += 1
                            self._emit("repeat_retry", {"tool": call.name, "reason": reason})
                            # The counter is cleared so the retry is judged on its
                            # own: the model has been told, and one more identical
                            # call after that is a genuine second failure rather
                            # than the same one counted twice.
                            self._repeats.clear()
                            self._no_progress.clear()
                            break
                        result.stopped = "repeated"
                        result.text = self._last_assistant_text()
                        break
                if result.stopped == "repeated":
                    break
            else:
                result.stopped = "max_steps"
                result.text = self._last_assistant_text()
        except ApprovalUnavailable as exc:
            # The window never answered, so the tool never ran. Retrying is what
            # produced a turn of "let me look / looking" until the step budget ran
            # out, so the turn ends here and the reason is said once.
            result.stopped = "approval_unavailable"
            result.text = self._last_assistant_text()
            self._emit("error", {"message": str(exc), "status": 0})
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

        try:
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
        except httpx.HTTPError as exc:
            # The last line of defence. The client converts transport errors of its
            # own, but the loop must not end a turn by raising: an exception that
            # escapes here reaches the server, the turn produces no `turn_end` and
            # the window shows a chat that stopped for no stated reason. A transport
            # error is a provider failure, and it is reported as one.
            raise ProviderError(f"the response stream ended early: {exc}") from exc
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
            ask=self._ask,
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
                # What a write did to a file, so the editor can show it as a
                # diff. The window cannot work this out for itself: it would have
                # to read the file before the tool ran, and a local write finishes
                # before that read does. The tool is the only thing that knows
                # both sides, so it reports them.
                "change": result.change,
                "content": preview,
            },
        )
        return content

    def _last_assistant_text(self) -> str:
        for message in reversed(self._history):
            if message.get("role") == "assistant" and message.get("content"):
                return str(message["content"])
        return ""

    def _promise_notice(self, text: str) -> str:
        """What the model is told when it announced work instead of doing it.

        Written as a user message because that is the role the model treats as
        instruction, and phrased as a fact about the turn rather than a scolding:
        the message it just sent ended nothing, and the way forward is to make the
        call it was describing.
        """

        quoted = text.strip()
        if len(quoted) > 200:
            quoted = quoted[:200] + "…"
        return (
            f"{PROMISE_MARKER} Your last message was: {quoted!r}\n"
            "That is an announcement, not an answer: you said what you were about "
            "to do and then stopped, so nothing happened. The user is waiting for "
            "the work, not for a description of it. Make the tool call you were "
            "describing now. If you cannot, say plainly what is blocking you "
            "instead of announcing that you are working."
        )

    def _empty_notice(self, truncated: bool) -> str:
        """What the model is told when its completion carried nothing.

        There is nothing to quote back, so the notice says what was missing and
        what is expected instead. The truncated case names the output limit,
        because the model can answer in fewer words and cannot give itself more.
        """

        missing = (
            "Your last response was cut off by the output limit before any answer "
            "or tool call began - your own reasoning used the whole output budget."
            if truncated
            else "Your last response contained no text and no tool call."
        )
        return (
            f"{EMPTY_MARKER} {missing}\n"
            "The turn cannot continue without one of the two. Make the tool call "
            "you need now, or write the answer, even if it is short and plain. If "
            "the request cannot be done, say what is blocking it."
        )

    def _truncated_notice(self, text: str) -> str:
        """What the model is told when the output limit cut its answer short."""

        quoted = text.strip()
        if len(quoted) > 200:
            quoted = quoted[:200] + "…"
        return (
            f"{TRUNCATED_MARKER} Your last message was cut off by the output limit "
            f"before it was finished: {quoted!r}\n"
            "Answer again, briefly: say only what is needed, or make the tool call "
            "instead of describing it. Do not repeat the whole plan."
        )

    def _repeat_notice(self, call: ToolCall, *, reason: str, times: int) -> str:
        """What the model is told when it has repeated one call too many times.

        Written as a user message because that is the role the model treats as
        instruction, and phrased as a fact about the turn rather than a scolding:
        the call it just made is the one that was repeated, and the way forward is
        to change the approach rather than to make the same call again. When the
        result has not changed, that is what the model is told, because it explains
        why repeating cannot help: whatever it changed is not reaching this call.
        """

        arguments = json.dumps(call.parsed_arguments(), ensure_ascii=False, sort_keys=True)
        if len(arguments) > 400:
            arguments = arguments[:400] + "…"
        because = (
            "The call repeated with nothing in between."
            if reason == "consecutive"
            else (
                f"Its result has not changed in {self._no_progress_limit} runs in this "
                "turn, so nothing you have changed is reaching it."
            )
        )
        return (
            f"{REPEAT_MARKER} You have called {call.name} with the same arguments "
            f"{times} times in this turn: {arguments}\n"
            f"{because} Calling it again will not help. "
            "Change the approach: use different arguments, use another tool, or stop "
            "and say what is blocking you. Do not repeat this call."
        )

    def _note_repeat(self, call: ToolCall, outcome: str) -> tuple[str, int] | None:
        """Notice that a call is not getting anywhere, and say which shape it is.

        The step budget alone ends a loop, but it ends it after forty steps of
        the same request - which reads as the agent being stuck rather than as a
        turn that ran out of room. A model that repeats one identical call is not
        making progress, and the honest thing is to stop and say so.

        Two shapes are stuck, and only one of them was noticed.

        The first is the same call three times in a row. Anything else in between
        breaks that chain, and that is deliberate: a turn that runs the tests,
        edits a file and runs the tests again is working, and counting those as
        repeats stopped turns that were making progress.

        The narrowing left the second shape unguarded, and it is the one the stored
        transcripts show: the same call returning the *same result* with unrelated
        work in between. Nothing in such a turn ever makes three identical calls in
        a row, so no count was ever reached - one command ran twenty-three times in
        a single turn and the guard never fired once. What makes that a loop is not
        the repetition but the absence of progress, so that is what is measured:
        the same call, the same result. A result that changes resets the count,
        because a result that changes is progress.

        The counter is per turn and is cleared by :meth:`run`.

        Returns the reason and the count when the model is stuck, else ``None``.
        """

        key = (call.name, json.dumps(call.parsed_arguments(), sort_keys=True, ensure_ascii=False))
        # Anything other than this exact call means the model moved on, so the
        # chain of identical calls is broken and starts again from here.
        for other in list(self._repeats):
            if other != key:
                del self._repeats[other]
        self._repeats[key] = self._repeats.get(key, 0) + 1

        # Hashed rather than kept: a result is up to thousands of characters, and
        # only its identity matters here.
        digest = hashlib.sha1(outcome.encode("utf-8", "replace")).hexdigest()
        previous, count = self._no_progress.get(key, ("", 0))
        count = count + 1 if previous == digest else 1
        self._no_progress[key] = (digest, count)

        if self._repeats[key] >= self._repeat_limit:
            reason, times = "consecutive", self._repeats[key]
        elif count >= self._no_progress_limit:
            reason, times = "no-progress", count
        else:
            return None
        self._emit(
            "repeated_call",
            {
                "tool": call.name,
                "arguments": call.parsed_arguments(),
                "times": times,
                "reason": reason,
            },
        )
        return reason, times

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