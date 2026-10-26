"""Saved conversations: one file per chat, listed and reopened.

A conversation used to be a single file per folder, overwritten on every turn.
Nothing was lost to a crash, but nothing could be kept either, and "new
conversation" was a reset: the previous chat was gone the moment the user asked
for a new one, which is the opposite of what a new chat means anywhere else.

One file per conversation changes what a chat is - a thing with an id, a title
taken from its first question and a place in a list the window can show. The id
is the file name, the folder is derived from the workspace path, and a
conversation that is never opened again costs one small file. Nothing here reads
the network or the model: a conversation is messages, and messages are what the
loop already produces.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

from .config import _atomic_write_json, conversations_dir

#: Bumped when the stored layout changes in a way a reader has to know about.
CONVERSATION_VERSION = 1

#: A title is a label in a tab, not a sentence.
TITLE_LIMIT = 60

#: The marker the editor puts in front of the context it attaches to a message.
#: A title taken from that text would be a file path the user never typed.
CONTEXT_MARKER = "Context from the editor:"

#: What a chat is called before it has a question. It is a recognised value, not
#: just a word: a placeholder that counted as a title of its own would keep the
#: first question from ever naming the chat.
PLACEHOLDER_TITLE = "New chat"


def folder_key(workspace: Path) -> str:
    """A readable, stable directory name for one workspace.

    Readable so that a person looking inside the data folder can tell which
    project a chat belongs to; hashed as well, because two projects can share a
    name and a chat filed under the wrong one is worse than an unreadable name.
    """

    resolved = Path(workspace).resolve()
    digest = hashlib.sha256(resolved.as_posix().encode("utf-8")).hexdigest()[:16]
    name = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in resolved.name)[:24]
    return f"{name or 'workspace'}-{digest}"


def question_text(messages: Iterable[dict[str, Any]]) -> str:
    """The first thing the user said, without the editor's attached context."""

    for message in messages or ():
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        text = str(message.get("content") or "")
        if text.startswith(CONTEXT_MARKER):
            cut = text.find("\n\n")
            text = "" if cut == -1 else text[cut + 2 :]
        text = " ".join(text.split())
        if text:
            return text
    return ""


def title_from(messages: Iterable[dict[str, Any]]) -> str:
    text = question_text(messages)
    if not text:
        return ""
    return text[:TITLE_LIMIT] + ("…" if len(text) > TITLE_LIMIT else "")


class ConversationStore:
    """The conversations of one workspace, on disk."""

    def __init__(self, workspace: Path, *, root: Path | None = None) -> None:
        self.workspace = Path(workspace).resolve()
        self.root = Path(root) if root is not None else conversations_dir() / folder_key(self.workspace)

    # ------------------------------------------------------------------ paths
    def path_for(self, conversation_id: str) -> Path:
        safe = "".join(ch for ch in str(conversation_id) if ch.isalnum() or ch in "-_")
        return self.root / f"{safe or 'invalid'}.json"

    # ----------------------------------------------------------------- records
    def read(self, conversation_id: str) -> dict[str, Any] | None:
        path = self.path_for(conversation_id)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        messages = data.get("messages")
        if not isinstance(messages, list):
            data["messages"] = []
        return data

    def save(
        self,
        conversation_id: str,
        messages: list[dict[str, Any]],
        *,
        title: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        """Write one conversation, keeping its title and creation time.

        A title is only derived while there is none: the first question names the
        chat, and a rename after that is the user's decision rather than
        something the next turn overwrites.
        """

        existing = self.read(conversation_id) or {}
        clean = [message for message in messages if isinstance(message, dict)]
        previous = str(existing.get("title") or "")
        if title is not None:
            resolved = " ".join(str(title).split())[:TITLE_LIMIT]
        elif previous and previous != PLACEHOLDER_TITLE:
            # A title the user was given, or one they chose; the next turn must
            # not rename the chat back to its first question.
            resolved = previous
        else:
            resolved = title_from(clean)
        record = {
            "version": CONVERSATION_VERSION,
            "id": conversation_id,
            "title": resolved or PLACEHOLDER_TITLE,
            "created_at": float(created_at if created_at is not None else existing.get("created_at") or time.time()),
            "updated_at": time.time(),
            "workspace": self.workspace.as_posix(),
            "messages": clean,
        }
        _atomic_write_json(self.path_for(conversation_id), record)
        return record

    def create(
        self,
        *,
        messages: list[dict[str, Any]] | None = None,
        title: str = "",
    ) -> dict[str, Any]:
        return self.save(
            uuid.uuid4().hex[:12],
            list(messages or []),
            title=title or None,
        )

    def rename(self, conversation_id: str, title: str) -> dict[str, Any] | None:
        record = self.read(conversation_id)
        if record is None:
            return None
        return self.save(
            conversation_id,
            record.get("messages") or [],
            title=" ".join(str(title).split())[:TITLE_LIMIT] or record.get("title") or PLACEHOLDER_TITLE,
            created_at=record.get("created_at"),
        )

    def delete(self, conversation_id: str) -> bool:
        path = self.path_for(conversation_id)
        if not path.is_file():
            return False
        try:
            path.unlink()
        except OSError:
            return False
        return True

    def list(self) -> list[dict[str, Any]]:
        """Every conversation of this workspace, newest first.

        The messages themselves are not returned: a list of chats is a list of
        titles, and shipping every transcript to the window to draw a tab strip
        would be the expensive way to do it.
        """

        rows: list[dict[str, Any]] = []
        if not self.root.is_dir():
            return rows
        for path in sorted(self.root.glob("*.json")):
            record = self.read(path.stem)
            if record is None:
                continue
            messages = record.get("messages") or []
            rows.append(
                {
                    "id": record.get("id") or path.stem,
                    "title": record.get("title") or "",
                    "created_at": float(record.get("created_at") or 0.0),
                    "updated_at": float(record.get("updated_at") or 0.0),
                    "messages": len(messages),
                    "preview": self._preview(messages),
                }
            )
        rows.sort(key=lambda row: row["updated_at"], reverse=True)
        return rows

    def latest(self) -> dict[str, Any] | None:
        rows = self.list()
        if not rows:
            return None
        return self.read(rows[0]["id"])

    @staticmethod
    def _preview(messages: list[dict[str, Any]]) -> str:
        for message in reversed(messages):
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            text = " ".join(str(message.get("content") or "").split())
            if text:
                return text[:120]
        return ""