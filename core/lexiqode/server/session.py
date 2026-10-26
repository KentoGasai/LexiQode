"""Workspace session: the mutable state one open project owns.

One core process serves one workspace. The session holds the settings, the tool
registry, the conversation and the approval broker, so the HTTP layer stays a
thin adapter and the terminal REPL can drive exactly the same object.

Constants below: ``RULES_FILES`` are the workspace files checked for project
rules (first match wins), ``RULES_LIMIT`` caps how much of one is injected, and
``APPROVAL_TIMEOUT`` is how long a pending approval waits for the editor.
"""

from __future__ import annotations

import hashlib
import json
import queue
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable

from ..agent.events import EventBus
from ..agent.loop import AgentLoop, LoopResult
from ..agent.modes import MODES, AgentMode, catalogue, get_mode
from ..agent.tools.base import ApprovalDecision, ApprovalRequest
from ..agent.tools.registry import ToolRegistry, default_registry
from ..config import ModelProfile, Settings, sessions_dir
from ..conversations import ConversationStore, title_from
from ..errors import ConfigError, WorkspaceError
from ..llm.openai import OpenAIChatClient
from ..llm.types import system_message, user_message
from ..version import PROTOCOL_VERSION, __version__

RULES_FILES = ("LEXIQODE.md", "AGENTS.md", ".lexiqode/rules.md")
RULES_LIMIT = 8000
APPROVAL_TIMEOUT = 300.0


class ApprovalBroker:
    """Hands approval requests to the UI and blocks the tool until it answers.

    A timeout is treated as a refusal on purpose: if the window is gone, the
    safe outcome is that the write or command did not happen.
    """

    def __init__(self, timeout: float = APPROVAL_TIMEOUT) -> None:
        self.timeout = timeout
        self._pending: dict[str, queue.Queue[ApprovalDecision]] = {}
        self._lock = threading.Lock()

    def request(self, request: ApprovalRequest) -> ApprovalDecision:
        answer: queue.Queue[ApprovalDecision] = queue.Queue(maxsize=1)
        with self._lock:
            self._pending[request.id] = answer
        try:
            return answer.get(timeout=self.timeout)
        except queue.Empty:
            return ApprovalDecision(
                approved=False,
                reason="the editor did not answer the approval request in time",
            )
        finally:
            with self._lock:
                self._pending.pop(request.id, None)

    def resolve(self, request_id: str, decision: ApprovalDecision) -> bool:
        with self._lock:
            target = self._pending.get(request_id)
        if target is None:
            return False
        try:
            target.put_nowait(decision)
        except queue.Full:
            return False
        return True

    @property
    def pending(self) -> list[str]:
        with self._lock:
            return list(self._pending)


@dataclass(slots=True)
class TurnState:
    """Progress of the turn currently running, if any."""

    running: bool = False
    started_at: float = 0.0
    message: str = ""
    mode: str = ""
    result: LoopResult | None = None
    error: str = ""


class CoreSession:
    """Everything one workspace needs, independent of how it is driven."""

    def __init__(
        self,
        workspace: Path,
        settings: Settings,
        *,
        bus: EventBus | None = None,
        registry: ToolRegistry | None = None,
        approver: Callable[[ApprovalRequest], ApprovalDecision] | None = None,
        profile_override: ModelProfile | None = None,
        client_factory: Callable[[ModelProfile], Any] | None = None,
    ) -> None:
        self.settings = settings
        self.bus = bus or EventBus()
        self.registry = registry or default_registry()
        self.approvals = ApprovalBroker()
        self._approver = approver or self.approvals.request
        self._profile_override = profile_override
        self._client_factory = client_factory
        self._workspace = Path(workspace)
        self._lock = threading.Lock()
        self._loop: AgentLoop | None = None
        self._turn = TurnState()
        self._thread: threading.Thread | None = None
        self._conversation_id = ""
        self.validate_workspace()

        # Chats belong to the folder, and the folder belongs to the process: the
        # store is built once, here, so a turn and a listing see the same files.
        # Built after validation, because the store keeps the resolved path.
        self.conversations = ConversationStore(self._workspace)
        # A folder that was used before this existed has its transcript in the
        # single per-folder file. Importing it as the first conversation is what
        # keeps an upgrade from looking like lost history.
        if not self.conversations.list():
            legacy = load_history(self._workspace)
            if legacy:
                self._conversation_id = self.conversations.create(
                    messages=legacy, title=title_from(legacy)
                )["id"]

    @property
    def workspace(self) -> Path:
        return self._workspace

    def validate_workspace(self) -> None:
        if not self._workspace.exists():
            raise WorkspaceError(f"workspace {self._workspace} does not exist; open an existing folder")
        if not self._workspace.is_dir():
            raise WorkspaceError(f"workspace {self._workspace} is not a directory")
        self._workspace = self._workspace.resolve()

    def project_rules(self) -> str:
        """Read the workspace's own rule file, if the project has one."""

        for relative in RULES_FILES:
            candidate = self._workspace / relative
            if not candidate.is_file():
                continue
            try:
                text = candidate.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            return text[:RULES_LIMIT]
        return ""

    def profile(self) -> ModelProfile:
        """The profile a turn needs. Raises when it is not usable yet."""

        if self._profile_override is not None:
            return self._profile_override
        return self.settings.effective_profile()

    def described_profile(self) -> ModelProfile:
        """The profile for reporting only; never raises for a missing model."""

        if self._profile_override is not None:
            return self._profile_override
        return self.settings.describe_profile()

    def loop(self) -> AgentLoop:
        """Build the loop on first use, and rebuild it when the profile changes."""

        profile = self.profile()
        with self._lock:
            if self._loop is not None and self._loop.profile == profile:
                return self._loop
            if self._loop is not None:
                self._loop.close()
            self._loop = AgentLoop(
                profile=profile,
                settings=self.settings.agent,
                workspace=self._workspace,
                registry=self.registry,
                emit=self.bus.emit,
                approve=self._approver,
                # The open chat's messages, so switching chat is switching what
                # the model is looking at rather than clearing its memory.
                history=self.conversation_messages(),
                extra_rules=self.project_rules(),
                client=self._client_factory(profile) if self._client_factory else None,
            )
            return self._loop

    # ----------------------------------------------------------- conversations
    def conversation_messages(self) -> list[dict[str, Any]]:
        """The messages of the open chat, loading it if it is not open yet."""

        if not self._conversation_id:
            latest = self.conversations.latest()
            self._conversation_id = (
                latest["id"] if latest else self.conversations.create()["id"]
            )
        record = self.conversations.read(self._conversation_id)
        if record is None:
            # Deleted behind our back, or never written: a fresh chat is better
            # than a session that cannot answer.
            self._conversation_id = self.conversations.create()["id"]
            return []
        return list(record.get("messages") or [])

    def history_messages(self) -> list[dict[str, Any]]:
        """What is in the open chat right now, whether or not a turn has run.

        A turn is not the only way messages appear: opening a saved chat loads a
        transcript, and the window has to draw it before the next question. The
        loop is built on demand - and when the profile is not usable yet it is not
        built at all, because an unconfigured core still has a conversation to
        show rather than an error.
        """

        if self._loop is not None:
            return self._loop.messages
        try:
            return self.loop().messages
        except ConfigError:
            return self.conversation_messages()

    def current_conversation(self) -> dict[str, Any]:
        """The open chat as the window shows it: id, title, size."""

        messages = self.conversation_messages()
        record = self.conversations.read(self._conversation_id) or {}
        title = record.get("title") or title_from(messages) or ""
        return {"id": self._conversation_id, "title": title, "messages": len(messages)}

    def list_conversations(self) -> dict[str, Any]:
        return {
            "conversations": self.conversations.list(),
            "current": self.current_conversation(),
        }

    def _save_conversation(self) -> None:
        """Write the open chat, and report a title that appeared with it.

        Called at the end of every turn and after a reset. The title is derived
        from the first question, so the window learns it exactly once per chat -
        which is the event a tab strip needs to name a new tab.
        """

        if self._loop is None:
            return
        before = self.conversations.read(self._conversation_id) or {}
        record = self.conversations.save(self._conversation_id, self._loop.messages)
        if record.get("title") != before.get("title"):
            self.bus.emit(
                "conversation_changed",
                {
                    "id": record["id"],
                    "title": record["title"],
                    "reason": "saved",
                },
            )

    def new_conversation(self) -> dict[str, Any]:
        """Start an empty chat, keeping the one that was open."""

        self._save_conversation()
        record = self.conversations.create()
        self._conversation_id = record["id"]
        self.invalidate_loop()
        self.bus.emit(
            "conversation_changed",
            {"id": record["id"], "title": record["title"], "reason": "created"},
        )
        return {"id": record["id"], "title": record["title"], "messages": 0}

    def open_conversation(self, conversation_id: str) -> dict[str, Any]:
        """Make one saved chat the open one."""

        record = self.conversations.read(conversation_id)
        if record is None:
            raise ConfigError(f"no conversation {conversation_id!r} in this folder")
        if conversation_id != self._conversation_id:
            self._save_conversation()
        self._conversation_id = record["id"]
        self.invalidate_loop()
        self.bus.emit(
            "conversation_changed",
            {"id": record["id"], "title": record.get("title") or "", "reason": "opened"},
        )
        return self.current_conversation()

    def rename_conversation(self, conversation_id: str, title: str) -> dict[str, Any]:
        record = self.conversations.rename(conversation_id, title)
        if record is None:
            raise ConfigError(f"no conversation {conversation_id!r} in this folder")
        if conversation_id == self._conversation_id:
            self.bus.emit(
                "conversation_changed",
                {"id": record["id"], "title": record["title"], "reason": "renamed"},
            )
        return {"id": record["id"], "title": record["title"]}

    def delete_conversation(self, conversation_id: str) -> dict[str, Any]:
        """Forget one chat. Deleting the open one opens a new one."""

        removed = self.conversations.delete(conversation_id)
        if not removed:
            raise ConfigError(f"no conversation {conversation_id!r} in this folder")
        self.bus.emit("conversation_changed", {"id": conversation_id, "deleted": True, "reason": "deleted"})
        fresh = None
        if conversation_id == self._conversation_id:
            fresh = self.new_conversation()
        return {"deleted": conversation_id, "current": fresh or self.current_conversation()}

    def invalidate_loop(self) -> None:
        """Drop the cached loop so the next turn picks up new settings."""

        with self._lock:
            if self._loop is not None:
                self._loop.close()
            self._loop = None

    def start_turn(
        self, message: str, *, tools: bool = True, mode: str | None = None
    ) -> dict[str, Any]:
        """Run a turn on a worker thread; events flow through the bus.

        With ``tools=False`` the model answers without any tool schemas, which is
        what an inline edit needs: one piece of text to insert, not a plan.

        ``mode`` selects what the agent may do. An unknown id raises
        :class:`UnknownMode`, which the HTTP layer reports as a 400.
        """

        text = (message or "").strip()
        if not text:
            raise ConfigError("the message is empty")
        # Validate the input before the state: a caller who sent a bad mode should
        # learn that, whether or not a turn happens to be running.
        resolved = get_mode(mode)
        # A configuration problem is the caller's to fix, so it is reported on the
        # request rather than surfacing later as a failed turn.
        self.profile()
        if self._turn.running:
            raise ConfigError("a turn is already running in this workspace")

        self._turn = TurnState(
            running=True, started_at=time.time(), message=text, mode=resolved.id
        )
        self._thread = threading.Thread(
            target=self._run_turn, args=(text, tools, resolved), daemon=True
        )
        self._thread.start()
        return {
            "started": True,
            "message": text,
            "tools": bool(tools),
            "mode": resolved.id,
            "mode_tools": None if resolved.tools is None else list(resolved.tools),
        }

    def _run_turn(self, text: str, tools: bool, mode: AgentMode) -> None:
        try:
            loop = self.loop()
            result = loop.run(text, tools=tools, mode=mode)
            self._turn.result = result
        except Exception as exc:  # reported to the client verbatim
            self._turn.error = f"{type(exc).__name__}: {exc}"
            self.bus.emit("error", {"message": self._turn.error})
        finally:
            # Written here rather than at the end of the process: a window that is
            # closed, a core that is killed or a folder that is switched all end
            # this way, and a chat that only exists in memory until shutdown is a
            # chat the user cannot rely on. A turn that failed is saved too - what
            # the user typed happened.
            try:
                self._save_conversation()
                # The single per-folder file is kept in step as well: it is what
                # an older build of this application reads, and a downgrade should
                # not look like lost history.
                if self._loop is not None:
                    save_history(self._workspace, self._loop.messages)
            except OSError as exc:
                self.bus.emit(
                    "error", {"message": f"the conversation could not be saved: {exc}"}
                )
            self._turn.running = False

    def wait(self, timeout: float | None = None) -> bool:
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout=timeout)
        return not thread.is_alive()

    def cancel(self) -> dict[str, Any]:
        if self._loop is not None:
            self._loop.cancel()
        pending = self.approvals.pending
        for request_id in pending:
            self.approvals.resolve(
                request_id, ApprovalDecision(approved=False, reason="the user cancelled the turn")
            )
        return {"cancelled": self._loop is not None, "pending_approvals": len(pending)}

    def reset(self) -> None:
        """Start a new chat. The one that was open stays in the list."""

        self.new_conversation()
        save_history(self._workspace, [])

    def resolve_approval(
        self, request_id: str, approved: bool, *, remember: bool = False, reason: str = ""
    ) -> bool:
        return self.approvals.resolve(
            request_id,
            ApprovalDecision(approved=approved, remember=remember, reason=reason),
        )

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        profile_id: str | None = None,
        model: str | None = None,
    ) -> str:
        """One-shot text completion, outside the conversation.

        Deliberately not a turn: it does not touch the history, it cannot call a
        tool, and it uses its own client, so an inline edit never collides with a
        running chat turn or shows up in the transcript.
        """

        text = (prompt or "").strip()
        if not text:
            raise ConfigError("the prompt is empty")
        profile = self.settings.effective_profile(profile_id) if profile_id else self.profile()
        if model:
            # An editor feature may want a different model than the chat, for
            # example a fast one for inline edits.
            profile = replace(profile, model=model)
        messages = []
        if system:
            messages.append(system_message(system))
        messages.append(user_message(text))

        client = (
            self._client_factory(profile) if self._client_factory else OpenAIChatClient(profile, timeout=180.0)
        )
        try:
            message = client.complete(messages, None, max_tokens=max_tokens, temperature=temperature)
        finally:
            try:
                client.close()
            except Exception:  # noqa: BLE001 - cleanup must not mask the result
                pass
        content = message.get("content") if isinstance(message, dict) else None
        return content if isinstance(content, str) else ""

    def list_models(
        self,
        profile_id: str | None = None,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> list[str]:
        """Ask an endpoint which models it serves.

        Routed through the session like every other model call, so a single
        place decides which client talks to an endpoint.

        The connection fields can be overridden, because the endpoint worth
        asking about is usually the one somebody is still typing into a settings
        form. Requiring a save first would mean the answer describes the previous
        endpoint, and requiring a model id first would make the list impossible
        to reach exactly when it is needed - choosing that id.
        """

        profile = self.settings.describe_profile(profile_id)
        overrides: dict[str, Any] = {}
        if (base_url or "").strip():
            overrides["base_url"] = base_url.strip()
        if (api_key or "").strip():
            overrides["api_key"] = api_key.strip()
        if overrides:
            profile = replace(profile, **overrides).normalised()
        client = (
            self._client_factory(profile) if self._client_factory else OpenAIChatClient(profile, timeout=15.0)
        )
        try:
            return list(client.list_models())
        finally:
            try:
                client.close()
            except Exception:  # noqa: BLE001 - cleanup must not mask the result
                pass

    def state(self) -> dict[str, Any]:
        # Reported with a missing model allowed: the editor needs to render the
        # panel so it can offer to fix that.
        profile = self.described_profile()
        turn = self._turn
        return {
            "workspace": self._workspace.as_posix(),
            "profile": profile.to_public(),
            "profile_ready": bool(profile.model and profile.base_url),
            "agent": {
                "max_steps": self.settings.agent.max_steps,
                "auto_approve": self.settings.agent.auto_approve,
                "approve_writes": self.settings.agent.approve_writes,
                "approve_commands": self.settings.agent.approve_commands,
                "command_timeout": self.settings.agent.command_timeout,
                # What the window is and when the conversation is compacted are
                # numbers the user can see and change; the panel draws the gauge
                # from them instead of guessing at a threshold.
                "compact_at": self.settings.agent.compact_at,
                "max_history_messages": self.settings.agent.max_history_messages,
            },
            "tools": self.registry.describe(),
            "modes": catalogue(),
            "turn": {
                "running": turn.running,
                "message": turn.message,
                "mode": turn.mode or MODES[0].id,
                "elapsed_ms": int((time.time() - turn.started_at) * 1000) if turn.running else 0,
                "last_error": turn.error,
                "last_stopped": turn.result.stopped if turn.result else "",
            },
            "pending_approvals": self.approvals.pending,
            "history_length": len(self.history_messages()),
            # Which chat is open, so a window that reconnects draws the right tab
            # and names it.
            "conversation": self.current_conversation(),
            # What the window looks like right now, so a window opened in the
            # middle of a long conversation shows the gauge before the next turn
            # rather than after it. Null until a loop exists.
            "context": self._loop.context_usage() if self._loop else None,
            "protocol": PROTOCOL_VERSION,
            "version": __version__,
        }

    def close(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            self.cancel()
            self._thread.join(timeout=5)
        try:
            self._save_conversation()
        except OSError:
            # Shutting down is not the moment to raise about a file.
            pass
        self.invalidate_loop()


def _history_path(workspace: Path) -> Path:
    digest = hashlib.sha256(workspace.as_posix().encode("utf-8")).hexdigest()[:16]
    return sessions_dir() / f"{digest}.json"


def load_history(workspace: Path) -> list[dict[str, Any]]:
    """Restore the conversation for this workspace, if one was saved."""

    path = _history_path(workspace)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    messages = data.get("messages") if isinstance(data, dict) else None
    if not isinstance(messages, list):
        return []
    return [message for message in messages if isinstance(message, dict)]


def save_history(workspace: Path, messages: list[dict[str, Any]]) -> None:
    """Persist the conversation so reopening the folder restores it."""

    path = _history_path(workspace)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "workspace": workspace.as_posix(),
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "messages": messages,
        }
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)
    except OSError:
        # Losing history is not worth failing a completed turn over.
        return