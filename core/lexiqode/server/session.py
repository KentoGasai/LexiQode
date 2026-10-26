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
        self.validate_workspace()

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
                history=load_history(self._workspace),
                extra_rules=self.project_rules(),
                client=self._client_factory(profile) if self._client_factory else None,
            )
            return self._loop

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
            save_history(self._workspace, loop.messages)
        except Exception as exc:  # reported to the client verbatim
            self._turn.error = f"{type(exc).__name__}: {exc}"
            self.bus.emit("error", {"message": self._turn.error})
        finally:
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
        if self._loop is not None:
            self._loop.reset()
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
            "history_length": len(self._loop.messages) if self._loop else 0,
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