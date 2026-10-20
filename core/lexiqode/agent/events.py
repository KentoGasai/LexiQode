"""Events the loop publishes to whoever is watching (terminal, editor, tests)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

EventEmitter = Callable[[str, dict[str, Any]], None]


@dataclass(slots=True)
class Event:
    """One thing that happened while the agent was working."""

    type: str
    data: dict[str, Any] = field(default_factory=dict)


class EventBus:
    """Fan-out to several listeners, and a bounded replay for late subscribers.

    The editor opens its event stream after the core has started, so the most
    recent events are kept to let a reconnecting client catch up instead of
    silently losing the beginning of a turn.
    """

    def __init__(self, *, replay: int = 200) -> None:
        self._listeners: list[EventEmitter] = []
        self._replay: list[Event] = []
        self._replay_limit = max(0, replay)

    def subscribe(self, listener: EventEmitter) -> Callable[[], None]:
        self._listeners.append(listener)

        def unsubscribe() -> None:
            try:
                self._listeners.remove(listener)
            except ValueError:
                pass

        return unsubscribe

    def emit(
        self,
        event_type: str,
        data: Mapping[str, Any] | None = None,
        **fields: Any,
    ) -> Event:
        """Publish an event.

        Both call styles are accepted on purpose: internal code passes a ready
        dictionary (``emit("tool_end", {...})``) because it builds the payload
        from a result object, while callers that already have loose values use
        keywords (``emit("error", message=...)``). Supporting only one of them
        silently broke every HTTP turn, so the union is the contract.
        """

        payload: dict[str, Any] = dict(data or {})
        payload.update(fields)
        event = Event(type=event_type, data=payload)
        if self._replay_limit:
            self._replay.append(event)
            if len(self._replay) > self._replay_limit:
                del self._replay[: len(self._replay) - self._replay_limit]
        for listener in list(self._listeners):
            try:
                listener(event_type, payload)
            except Exception:
                # A broken sink (closed socket, reloaded window) must never stop
                # the agent from finishing its turn.
                continue
        return event

    def recent(self, limit: int = 50) -> list[Event]:
        return self._replay[-limit:] if limit > 0 else []