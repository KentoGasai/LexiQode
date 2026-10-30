"""The tool that lets the agent keep a list of the work it is doing.

A long task has a shape: read this, change that, run the tests, fix what broke.
The model holds that shape in its head, and the user cannot see it - so a turn
that is going well and a turn that has lost the thread look exactly the same
until it ends. This tool is the shape, written down where both can see it.

The whole list is sent on every call, never a patch. That is the point: a model
that has to restate every task cannot quietly drop one, and the window can redraw
the list from a single message instead of replaying a history of edits. It is the
same reason a diff is easier to trust than a log of keystrokes.

It is not an approval and not a question. Nothing is asked and nothing is
blocked: the list is a statement of intent, and the result is a receipt.
"""

from __future__ import annotations

from typing import Any

from .base import FAMILY_READ, Tool, ToolContext, ToolResult

#: The three states a task can be in. Deliberately the same three Cursor uses,
#: because a fourth would need a rule for what it means and nobody has one.
STATUS_PENDING = "pending"
STATUS_IN_PROGRESS = "in_progress"
STATUS_COMPLETED = "completed"

STATUSES = (STATUS_PENDING, STATUS_IN_PROGRESS, STATUS_COMPLETED)

#: How many tasks one list may hold. A list longer than this is not a plan, it is
#: a transcript, and the model is better off splitting the work into turns.
MAX_TODOS = 30

#: How long one task may be. Long enough for a real step, short enough that the
#: list stays scannable.
MAX_CONTENT = 200


class TodoWriteTool(Tool):
    """Replace the task list for the current conversation."""

    name = "todo_write"
    description = (
        "Keep a list of the tasks in the current piece of work, and update it as "
        "you go. Send the whole list every time, not just the change. Use it when "
        "the work has more than two steps: it shows the user what you are doing "
        "and what is left, and it keeps you from losing a step. Mark exactly one "
        "task in_progress at a time, and mark a task completed the moment it is "
        "done - not in a batch at the end. Do not use it for a single-step task."
    )
    #: Reading, not writing: the list is a note about the work, not a change to
    #: the workspace, so it needs no approval. Asking to approve a to-do list
    #: would be absurd.
    family = FAMILY_READ
    parameters = {
        "todos": {
            "type": "array",
            "description": "The complete list of tasks, in the order they will be done.",
            "items": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The task, in one short sentence.",
                    },
                    "status": {
                        "type": "string",
                        "enum": list(STATUSES),
                        "description": (
                            "pending: not started. in_progress: being worked on now. "
                            "completed: done and verified."
                        ),
                    },
                },
                "required": ["content", "status"],
            },
        }
    }
    required = ["todos"]

    def describe(self, arguments: dict[str, Any]) -> str:
        todos = self._clean(arguments.get("todos"))
        if not todos:
            return ""
        done = sum(1 for todo in todos if todo["status"] == STATUS_COMPLETED)
        return f"{done}/{len(todos)} done"

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        raw = arguments.get("todos")
        if not isinstance(raw, list):
            return ToolResult.failure(
                "todos must be a list of {content, status} objects",
                error="bad_arguments",
            )
        todos = self._clean(raw)
        if not todos:
            return ToolResult.failure(
                "the list is empty; send the tasks you are working on",
                error="bad_arguments",
            )

        # The window draws the list from this event, and the conversation keeps it
        # so that reopening the chat shows where the work stopped.
        context.emit("todos_changed", {"todos": todos})

        done = sum(1 for todo in todos if todo["status"] == STATUS_COMPLETED)
        current = next(
            (todo["content"] for todo in todos if todo["status"] == STATUS_IN_PROGRESS),
            "",
        )
        if current:
            summary = f"{done}/{len(todos)} done, now: {current}"
        else:
            summary = f"{done}/{len(todos)} done"
        return ToolResult(ok=True, content=summary, meta={"todos": todos})

    @staticmethod
    def _clean(raw: Any) -> list[dict[str, str]]:
        """Keep the tasks that make sense, in order, with a known status.

        A model that sends an unknown status gets ``pending`` rather than an
        error: the list is a note, and refusing the whole note over one word
        would cost the turn more than the word is worth.
        """

        if not isinstance(raw, list):
            return []
        cleaned: list[dict[str, str]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            content = str(item.get("content") or "").strip()
            if not content:
                continue
            if len(content) > MAX_CONTENT:
                content = content[: MAX_CONTENT - 1] + "…"
            status = str(item.get("status") or "").strip().lower()
            if status not in STATUSES:
                status = STATUS_PENDING
            cleaned.append({"content": content, "status": status})
            if len(cleaned) >= MAX_TODOS:
                break
        return cleaned
