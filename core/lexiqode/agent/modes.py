"""Agent modes: what the agent may do, decided before it starts.

A mode narrows the toolset and adds standing instructions. Narrowing the toolset
is a stronger guarantee than an approval prompt: a tool that is not offered
cannot be called, and the registry refuses it even when a model invents the name.
That is why "Ask" and "Plan" cannot write, rather than merely being asked not to.

The identifiers deliberately match the names users know from other agents, so
muscle memory transfers; the behaviour is defined here, in one table.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..errors import ConfigError

#: Tools that only look at the workspace. Every mode allows at least these.
READ_TOOLS: tuple[str, ...] = ("read_file", "list_dir", "glob", "grep")
WRITE_TOOLS: tuple[str, ...] = ("write_file", "edit_file")
#: The tool that asks the user a question. Offered only where the agent is
#: expected to carry a task through and may need a decision it cannot make
#: alone: Agent, Plan and Debug. Ask and Review answer from the code they read,
#: so a question there would be a way of avoiding the answer.
ASK_TOOL: str = "ask_user"


@dataclass(frozen=True, slots=True)
class AgentMode:
    """One selectable behaviour for the agent."""

    id: str
    label: str
    summary: str
    instructions: str = ""
    #: Allowed tool names; ``None`` means every tool the workspace offers.
    tools: tuple[str, ...] | None = None
    #: Step budget for this mode. The configured maximum still wins when lower.
    steps: int | None = None

    def allows(self, tool: str) -> bool:
        return self.tools is None or tool in self.tools

    @property
    def can_write(self) -> bool:
        return any(self.allows(name) for name in WRITE_TOOLS)

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "summary": self.summary,
            "tools": list(self.tools) if self.tools is not None else None,
            "steps": self.steps,
            "can_write": self.can_write,
        }


MODES: tuple[AgentMode, ...] = (
    AgentMode(
        id="agent",
        label="Agent",
        summary="Read, edit and run tests until the task is done.",
        instructions=(
            "You are in Agent mode: you are expected to carry the task through. "
            "Inspect, change, then verify by running the project's own checks. "
            "When a decision is genuinely the user's to make - which of two "
            "approaches, which file is meant, what the expected behaviour is - ask "
            "with ask_user instead of guessing; the turn waits for the answer."
        ),
        tools=(*READ_TOOLS, *WRITE_TOOLS, "run_command", ASK_TOOL),
    ),
    AgentMode(
        id="ask",
        label="Ask",
        summary="Answer questions about the code. Nothing is changed.",
        instructions=(
            "You are in Ask mode. Answer the question using the code you read. You "
            "have no ability to change anything, so never propose an edit as if you "
            "had applied it. Quote the lines that support your answer."
        ),
        tools=READ_TOOLS,
        steps=12,
    ),
    AgentMode(
        id="plan",
        label="Plan",
        summary="Produce a step-by-step plan with file references. Nothing is changed.",
        instructions=(
            "You are in Plan mode. Produce a plan, not an implementation: the files "
            "to touch, the order to touch them in, what could break, and how the "
            "result should be verified. Read enough code that every step names real "
            "paths and real symbols. Do not write files. When the plan depends on a "
            "choice only the user can make, ask with ask_user rather than planning "
            "both branches."
        ),
        tools=(*READ_TOOLS, ASK_TOOL),
        steps=16,
    ),
    AgentMode(
        id="debug",
        label="Debug",
        summary="Reproduce a failure and explain its cause. Nothing is changed.",
        instructions=(
            "You are in Debug mode. Reproduce the reported behaviour, gather "
            "evidence, and name the root cause with the lines that prove it. You may "
            "run commands to observe, but you cannot edit files: end with the fix you "
            "recommend, not with a change you made. When reproducing needs something "
            "only the user knows - the exact input, the environment, the steps they "
            "took - ask with ask_user instead of assuming it."
        ),
        tools=(*READ_TOOLS, "run_command", ASK_TOOL),
        steps=20,
    ),
    AgentMode(
        id="review",
        label="Review",
        summary="Critique the current changes and report problems. Nothing is changed.",
        instructions=(
            "You are in Review mode. Inspect the uncommitted changes and the code "
            "around them. Report concrete problems: correctness, edge cases, error "
            "handling, missing tests. Order findings by severity and cite file and "
            "line. Do not edit anything."
        ),
        tools=READ_TOOLS,
        steps=16,
    ),
)

#: The mode used when a request does not name one.
DEFAULT_MODE = "agent"

_BY_ID = {mode.id: mode for mode in MODES}


class UnknownMode(ConfigError):
    """Raised when a caller asks for a mode that does not exist.

    A subclass of :class:`ConfigError` on purpose: an unknown mode is caller
    input, so the HTTP layer already turns it into a 400 with this message.
    """

    def __init__(self, mode_id: str) -> None:
        self.mode_id = mode_id
        super().__init__(
            f"unknown mode {mode_id!r}; use one of: {', '.join(mode_ids())}"
        )


def get_mode(mode_id: str | None) -> AgentMode:
    """Resolve a mode id, falling back to the default for empty input."""

    wanted = (mode_id or "").strip() or DEFAULT_MODE
    mode = _BY_ID.get(wanted)
    if mode is None:
        raise UnknownMode(wanted)
    return mode


def catalogue() -> list[dict[str, Any]]:
    """Every mode, in display order, for the editor to render."""

    return [mode.to_public() for mode in MODES]


def mode_ids() -> list[str]:
    return [mode.id for mode in MODES]