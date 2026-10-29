"""The tool that lets the agent ask the user a question.

An agent that cannot ask has only one way to deal with a decision it cannot make
on its own: guess, or repeat a call in the hope of a different answer. Both are
worse than a question. This tool is the question.

It is deliberately *not* an approval. An approval asks permission for something
the agent has already decided to do, and a refusal is a complete answer. This
asks for information the agent does not have, and the answer is the result of
the call - the turn carries on with it.
"""

from __future__ import annotations

from typing import Any

from .base import FAMILY_READ, QuestionRequest, Tool, ToolContext, ToolResult

#: How many options one question may offer. A wall of buttons is not a question,
#: it is a menu, and the model is better off asking in prose at that point.
MAX_OPTIONS = 6

#: How long one question may be. Long enough for a real decision, short enough
#: that the card stays readable.
MAX_QUESTION = 2000


class AskUserTool(Tool):
    """Ask the user a question and wait for the answer."""

    name = "ask_user"
    description = (
        "Ask the user a question and wait for their answer. Use this when the task "
        "cannot be carried out correctly without a decision only the user can make: "
        "which of two approaches to take, which file is meant, what the expected "
        "behaviour is. Offer the concrete options you would accept, so the answer is "
        "one click. Do not use it to ask permission to write or run something - that "
        "is asked for automatically - and do not use it to confirm a plan you can "
        "verify yourself by reading the code."
    )
    #: Reading, not writing: asking changes nothing, so it needs no approval of
    #: its own. Asking the user to approve a question would be absurd.
    family = FAMILY_READ
    parameters = {
        "question": {
            "type": "string",
            "description": "The question, in one or two sentences, ending in a question mark.",
        },
        "options": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Two to six concrete answers the user can pick with one click. "
                "Omit only when the answer is genuinely free-form."
            ),
        },
        "allow_free_text": {
            "type": "boolean",
            "description": (
                "Whether the user may type an answer instead of picking an option. "
                "Defaults to true."
            ),
        },
    }
    required = ["question"]

    def describe(self, arguments: dict[str, Any]) -> str:
        return str(arguments.get("question") or "").strip()

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        question = str(arguments.get("question") or "").strip()
        if not question:
            return ToolResult.failure("a question is required", error="bad_arguments")
        if len(question) > MAX_QUESTION:
            question = question[:MAX_QUESTION]

        options = self._options(arguments.get("options"))
        allow_free_text = arguments.get("allow_free_text")
        allow_free_text = True if allow_free_text is None else bool(allow_free_text)
        if not options and not allow_free_text:
            # Nothing to click and nothing to type: the question could never be
            # answered, and the turn would wait forever. Refuse it as a result the
            # model can correct, rather than blocking on an unanswerable card.
            return ToolResult.failure(
                "a question with no options must allow a free-text answer",
                error="bad_arguments",
            )

        if context.ask is None:
            # No user to reach. Saying so is a result the model can work around;
            # blocking would hang the turn until the process died.
            return ToolResult.failure(
                "there is no user to answer questions in this run; decide for "
                "yourself and state the assumption you made",
                error="no_user",
            )

        request = QuestionRequest(
            id=_new_id(),
            question=question,
            options=options,
            allow_free_text=allow_free_text,
        )
        context.emit(
            "question_request",
            {
                "id": request.id,
                "question": request.question,
                "options": list(request.options),
                "allow_free_text": request.allow_free_text,
            },
        )
        answer = context.ask(request)
        if answer.cancelled:
            return ToolResult.failure(
                "the user cancelled the turn while the question was open",
                error="cancelled",
            )
        text = (answer.text or "").strip()
        if not text:
            return ToolResult.failure(
                "the user answered without saying anything; ask again more concretely",
                error="empty_answer",
            )
        return ToolResult(ok=True, content=f"The user answered: {text}")

    @staticmethod
    def _options(raw: Any) -> list[str]:
        """Clean the offered options: strings, trimmed, deduplicated, capped."""

        if not isinstance(raw, list):
            return []
        seen: list[str] = []
        for item in raw:
            text = str(item or "").strip()
            if text and text not in seen:
                seen.append(text)
            if len(seen) >= MAX_OPTIONS:
                break
        return seen


def _new_id() -> str:
    import uuid

    return uuid.uuid4().hex[:12]
