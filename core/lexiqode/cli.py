"""Command line interface.

Six commands, each a thin adapter over the same session object:

``serve``   run the HTTP API and print the one-line handshake the editor reads;
``run``     execute a single task and exit;
``chat``    interactive terminal session;
``tools``   list the tools the agent may call;
``doctor``  report whether the environment and the configured endpoint work;
``config``  inspect or edit the settings file.

For ``serve`` the rule is strict: stdout carries exactly one line - the
handshake - and everything else goes to stderr. Any diagnostic printed to stdout
would be parsed as part of the handshake by the extension.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .agent.tools.base import ApprovalDecision, ApprovalRequest
from .config import (
    AgentSettings,
    ModelProfile,
    Settings,
    data_dir,
    redact,
    settings_path,
)
from .daemon import clear_descriptor, find_live_core, write_descriptor
from .errors import ConfigError, LexiQodeError
from .llm.openai import OpenAIChatClient
from .server.http import CoreServer
from .server.session import CoreSession
from .version import HANDSHAKE_PREFIX, PRODUCT_NAME, PROTOCOL_VERSION, __version__

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2


def _stderr(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _resolve_workspace(raw: str | None) -> Path:
    candidate = Path(raw).expanduser() if raw else Path.cwd()
    if not candidate.exists():
        raise ConfigError(f"workspace {candidate} does not exist")
    if not candidate.is_dir():
        raise ConfigError(f"workspace {candidate} is not a directory")
    return candidate.resolve()


def _load_settings(path: str | None) -> Settings:
    return Settings.load(Path(path).expanduser() if path else settings_path())


def _cli_approver(request: ApprovalRequest) -> ApprovalDecision:
    """Ask the human at the terminal, defaulting to refusal on anything else."""

    _stderr("")
    _stderr(f"  approval required: {request.tool} ({request.family})")
    if request.summary:
        _stderr(f"    {request.summary}")
    if request.detail:
        for line in request.detail.splitlines()[:20]:
            _stderr(f"    | {line}")
    try:
        answer = input("  allow? [y]es / [n]o / [a]lways: ").strip().lower()
    except EOFError:
        return ApprovalDecision(approved=False, reason="no input available")
    if answer in {"a", "always"}:
        return ApprovalDecision(approved=True, remember=True, reason="allowed for this session")
    if answer in {"y", "yes"}:
        return ApprovalDecision(approved=True, reason="allowed")
    return ApprovalDecision(approved=False, reason="declined by the user")


class _Printer:
    """Renders loop events for a terminal."""

    def __init__(self, *, show_tools: bool = True) -> None:
        self.show_tools = show_tools
        self._wrote_text = False

    def __call__(self, event_type: str, data: dict[str, Any]) -> None:
        if event_type == "text_delta":
            sys.stdout.write(str(data.get("text") or ""))
            sys.stdout.flush()
            self._wrote_text = True
        elif event_type == "assistant_text":
            if self._wrote_text:
                sys.stdout.write("\n")
                sys.stdout.flush()
                self._wrote_text = False
        elif event_type == "tool_start" and self.show_tools:
            self._end_text()
            arguments = data.get("arguments") or {}
            detail = arguments.get("command") or arguments.get("path") or ""
            _stderr(f"  -> {data.get('name')} {str(detail)[:160]}")
        elif event_type == "tool_end" and self.show_tools:
            mark = "ok" if data.get("ok") else "failed"
            _stderr(f"  <- {data.get('name')} {mark} ({data.get('elapsed_ms', 0)} ms)")
        elif event_type == "error":
            self._end_text()
            _stderr(f"  error: {data.get('message')}")
        elif event_type == "turn_end":
            self._end_text()
            usage = data.get("usage") or {}
            _stderr(
                f"  [{data.get('stopped')}] steps={data.get('steps')} "
                f"tools={data.get('tool_calls')} tokens={usage.get('total_tokens', 0)}"
            )

    def _end_text(self) -> None:
        if self._wrote_text:
            sys.stdout.write("\n")
            sys.stdout.flush()
            self._wrote_text = False


def _build_session(args: argparse.Namespace, *, interactive_approver: bool) -> CoreSession:
    settings = _load_settings(args.settings)
    if getattr(args, "auto_approve", False):
        settings.agent.auto_approve = True
    workspace = _resolve_workspace(getattr(args, "workspace", None))
    profile = settings.effective_profile(args.profile) if getattr(args, "profile", None) else None
    return CoreSession(
        workspace,
        settings,
        approver=_cli_approver if interactive_approver else None,
        profile_override=profile,
    )


# ---------------------------------------------------------------------- serve
def _cmd_serve(args: argparse.Namespace) -> int:
    try:
        session = _build_session(args, interactive_approver=False)
    except LexiQodeError as exc:
        _stderr(f"cannot start: {exc}")
        return EXIT_ERROR

    settings = session.settings
    server = CoreServer(session, host=args.host, port=args.port, token=args.token or "")
    server.start()

    write_descriptor(
        {
            "base_url": server.base_url,
            "host": args.host,
            "port": server.port,
            "token": server.token,
            "pid": os.getpid(),
            "workspace": session.workspace.as_posix(),
        }
    )
    settings.last_workspace = session.workspace.as_posix()
    try:
        settings.save()
    except OSError as exc:
        _stderr(f"warning: cannot save settings: {exc}")

    if args.handshake:
        # Exactly one line on stdout; the extension parses this and nothing else.
        print(
            f"{HANDSHAKE_PREFIX} {json.dumps(server.handshake(), ensure_ascii=False)}",
            flush=True,
        )
    _stderr(
        f"{PRODUCT_NAME} core {__version__} (protocol {PROTOCOL_VERSION}) listening on "
        f"{server.base_url} for {session.workspace}"
    )
    _stderr(f"  profile: {session.profile().id} -> {session.profile().model}")
    _stderr(f"  settings: {settings_path()}")

    stopping = threading.Event()
    shutdown_done = threading.Event()
    shutdown_lock = threading.Lock()

    def shutdown(reason: str) -> None:
        # The flag and the lock together make shutdown idempotent: a signal and
        # the stdin watcher can arrive at the same moment, and only one of them
        # may own the cleanup.
        with shutdown_lock:
            if stopping.is_set():
                return
            stopping.set()
        _stderr(f"shutting down ({reason})")
        try:
            # Each step is isolated: a failure while closing the socket must not
            # skip removing the runtime descriptor, or the next editor start
            # would find a descriptor pointing at a dead process.
            for label, action in (("http server", server.stop), ("session", session.close)):
                try:
                    action()
                except Exception as exc:  # noqa: BLE001 - shutdown must not raise
                    _stderr(f"warning: {label} shutdown failed: {exc}")
            try:
                clear_descriptor(only_pid=os.getpid())
            except OSError as exc:
                _stderr(f"warning: cannot remove the runtime descriptor: {exc}")
        finally:
            shutdown_done.set()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        signal_value = getattr(signal, name, None)
        if signal_value is None:
            continue
        try:
            signal.signal(signal_value, lambda *_: shutdown(name))
        except (ValueError, OSError):
            pass

    if args.exit_on_stdin_close:
        def watch_stdin() -> None:
            try:
                while sys.stdin.readline():
                    pass
            except (OSError, ValueError):
                pass
            shutdown("stdin closed")

        threading.Thread(target=watch_stdin, name="lexiqode-stdin", daemon=True).start()

    try:
        while not stopping.is_set():
            time.sleep(0.2)
    except KeyboardInterrupt:
        shutdown("interrupt")
    finally:
        shutdown("exit")
        # The watcher thread is a daemon, so leaving here immediately would let
        # the interpreter kill it mid-cleanup and leak the runtime descriptor.
        shutdown_done.wait(timeout=20)
    return EXIT_OK


# ------------------------------------------------------------------------ run
def _cmd_run(args: argparse.Namespace) -> int:
    try:
        session = _build_session(args, interactive_approver=not args.auto_approve)
        session.bus.subscribe(_Printer(show_tools=not args.quiet))
        session.start_turn(args.task)
        finished = session.wait(timeout=args.timeout)
    except LexiQodeError as exc:
        _stderr(f"error: {exc}")
        return EXIT_ERROR

    turn = session._turn  # noqa: SLF001 - single-shot command
    result = turn.result
    session.close()

    if not finished:
        _stderr("error: the turn did not finish within the timeout")
        return EXIT_ERROR
    if turn.error:
        _stderr(f"error: {turn.error}")
        return EXIT_ERROR
    if args.json and result is not None:
        print(
            json.dumps(
                {
                    "text": result.text,
                    "stopped": result.stopped,
                    "steps": result.steps,
                    "tool_calls": result.tool_calls,
                    "usage": {
                        "prompt_tokens": result.usage.prompt_tokens,
                        "completion_tokens": result.usage.completion_tokens,
                        "total_tokens": result.usage.total_tokens,
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return EXIT_OK if result is not None and result.stopped == "completed" else EXIT_ERROR


# ----------------------------------------------------------------------- chat
def _cmd_chat(args: argparse.Namespace) -> int:
    try:
        session = _build_session(args, interactive_approver=True)
    except LexiQodeError as exc:
        _stderr(f"error: {exc}")
        return EXIT_ERROR

    session.bus.subscribe(_Printer())
    _stderr(f"{PRODUCT_NAME} {__version__} - {session.workspace}")
    _stderr(f"profile {session.profile().id} -> {session.profile().model}")
    _stderr("type a task, /exit to quit, /reset to clear the conversation")

    try:
        while True:
            try:
                line = input("> ").strip()
            except EOFError:
                break
            if not line:
                continue
            if line in {"/exit", "/quit"}:
                break
            if line == "/reset":
                session.reset()
                _stderr("conversation cleared")
                continue
            try:
                session.start_turn(line)
            except ConfigError as exc:
                _stderr(f"error: {exc}")
                continue
            try:
                session.wait()
            except KeyboardInterrupt:
                session.cancel()
                _stderr("cancelled")
    except KeyboardInterrupt:
        _stderr("")
    finally:
        session.close()
    return EXIT_OK


# ---------------------------------------------------------------------- tools
def _cmd_tools(args: argparse.Namespace) -> int:
    from .agent.tools.registry import default_registry

    registry = default_registry()
    if args.json:
        print(json.dumps(registry.describe(), ensure_ascii=False, indent=2))
        return EXIT_OK
    for tool in registry.describe():
        print(f"  {tool['name']:<14} [{tool['family']:<7}] {tool['description']}")
    return EXIT_OK


# --------------------------------------------------------------------- doctor
def _cmd_doctor(args: argparse.Namespace) -> int:
    problems: list[str] = []
    notes: list[str] = []

    print(f"{PRODUCT_NAME} core {__version__} (protocol {PROTOCOL_VERSION})")
    print(f"  python       {sys.version.split()[0]} at {sys.executable}")
    print(f"  config dir   {settings_path().parent}")
    print(f"  data dir     {data_dir()}")

    try:
        settings = _load_settings(getattr(args, "settings", None))
    except ConfigError as exc:
        print(f"  settings     ERROR: {exc}")
        return EXIT_ERROR
    print(f"  settings     {settings_path()} ({len(settings.profiles)} profile(s))")

    try:
        profile = settings.effective_profile(getattr(args, "profile", None))
    except ConfigError as exc:
        print(f"  profile      ERROR: {exc}")
        return EXIT_ERROR
    print(f"  profile      {profile.id} -> {profile.model}")
    print(f"  endpoint     {profile.base_url or '<unset>'}")
    print(f"  api key      {redact(profile.api_key)}")

    if not profile.base_url:
        problems.append("no base_url is configured for the active profile")
    if not profile.api_key:
        notes.append("no API key set; the endpoint must not require one")

    if profile.base_url:
        try:
            with OpenAIChatClient(profile, timeout=10.0) as client:
                models = client.list_models()
            if models:
                print(f"  models       {len(models)} reachable, e.g. {', '.join(models[:3])}")
                if profile.model not in models:
                    notes.append(
                        f"the configured model {profile.model!r} is not in /models; some "
                        "gateways omit it, so this is not necessarily fatal"
                    )
            else:
                notes.append("the endpoint returned no model list")
        except LexiQodeError as exc:
            problems.append(f"endpoint check failed: {exc}")

    workspace_raw = getattr(args, "workspace", None) or settings.last_workspace or ""
    if workspace_raw:
        workspace = Path(workspace_raw).expanduser()
        if workspace.is_dir():
            print(f"  workspace    {workspace}")
        else:
            problems.append(f"workspace {workspace} no longer exists")
    else:
        notes.append("no workspace recorded yet")

    live = find_live_core()
    if live:
        print(f"  live core    pid {live.get('pid')} at {live.get('base_url')}")
    else:
        print("  live core    none")

    for note in notes:
        print(f"  note: {note}")
    for problem in problems:
        print(f"  PROBLEM: {problem}")
    print("ok" if not problems else f"{len(problems)} problem(s)")
    return EXIT_OK if not problems else EXIT_ERROR


# --------------------------------------------------------------------- config
def _cmd_config(args: argparse.Namespace) -> int:
    if args.action == "path":
        print(settings_path())
        return EXIT_OK

    settings = _load_settings(args.settings)

    if args.action == "show":
        print(json.dumps(settings.redacted(), ensure_ascii=False, indent=2))
        return EXIT_OK

    if args.action == "get":
        if not args.key:
            _stderr("config get needs a key, e.g. active_profile")
            return EXIT_USAGE
        current: Any = settings.redacted()
        for part in args.key.split("."):
            if not isinstance(current, dict) or part not in current:
                _stderr(f"no such key: {args.key}")
                return EXIT_ERROR
            current = current[part]
        if isinstance(current, (dict, list)):
            print(json.dumps(current, ensure_ascii=False, indent=2))
        else:
            print(current)
        return EXIT_OK

    if args.action == "init":
        if settings_path().exists() and not args.force:
            _stderr(f"{settings_path()} already exists; pass --force to overwrite")
            return EXIT_ERROR
        settings.profiles.setdefault("default", ModelProfile(id="default", label="Default"))
        settings.save()
        print(f"wrote {settings_path()}")
        return EXIT_OK

    if args.action == "set":
        if not args.key or args.value is None:
            _stderr("config set needs a key and a value")
            return EXIT_USAGE
        try:
            _apply_config_set(settings, args.key, args.value)
        except (ConfigError, ValueError) as exc:
            _stderr(f"error: {exc}")
            return EXIT_ERROR
        settings.save()
        print(f"{args.key} updated")
        return EXIT_OK

    _stderr(f"unknown config action: {args.action}")
    return EXIT_USAGE


def _apply_config_set(settings: Settings, key: str, value: str) -> None:
    """Set one dotted key. Profile fields use ``profile.<id>.<field>``."""

    parts = key.split(".")
    if parts[0] == "agent" and len(parts) == 2 and parts[1] in AgentSettings.__slots__:
        setattr(settings.agent, parts[1], _coerce(value, getattr(settings.agent, parts[1])))
        return
    if parts[0] in {"active_profile", "last_workspace"}:
        setattr(settings, parts[0], value)
        return
    if parts[0] == "port":
        settings.port = int(value)
        return
    if parts[0] == "profile" and len(parts) == 3:
        profile_id, field = parts[1], parts[2]
        if field not in ModelProfile.__slots__:
            raise ConfigError(f"unknown profile field {field!r}")
        current = settings.profiles.get(profile_id) or ModelProfile(id=profile_id)
        payload = {name: getattr(current, name) for name in ModelProfile.__slots__}
        payload[field] = _coerce(value, getattr(current, field))
        payload["id"] = profile_id
        settings.set_profile(ModelProfile(**payload))
        return
    raise ConfigError(
        "unknown key. Use agent.<field>, active_profile, port, or profile.<id>.<field>"
    )


def _coerce(value: str, like: Any) -> Any:
    if isinstance(like, bool):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(like, int):
        return int(value)
    if isinstance(like, float):
        return float(value)
    return value


# ------------------------------------------------------------------------ main
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lexiqode",
        description=f"{PRODUCT_NAME} core {__version__} - an OpenAI-compatible coding agent",
    )
    parser.add_argument("--version", action="version", version=f"{PRODUCT_NAME} {__version__}")
    sub = parser.add_subparsers(dest="command")

    def add_common(target: argparse.ArgumentParser) -> None:
        target.add_argument(
            "workspace",
            nargs="?",
            default=None,
            help="folder the agent works in (default: current directory)",
        )
        target.add_argument("--settings", default=None, help="path to settings.json")
        target.add_argument("--profile", default=None, help="model profile id to use")
        target.add_argument(
            "--auto-approve",
            action="store_true",
            help="run writes and commands without asking",
        )

    serve = sub.add_parser("serve", help="run the HTTP API for the editor")
    add_common(serve)
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=0, help="0 picks a free port")
    serve.add_argument("--token", default="", help="fixed bearer token (default: random)")
    serve.add_argument(
        "--no-handshake",
        dest="handshake",
        action="store_false",
        help="do not print the handshake line on stdout",
    )
    serve.add_argument(
        "--keep-alive",
        dest="exit_on_stdin_close",
        action="store_false",
        help="keep running after stdin closes",
    )
    serve.set_defaults(handshake=True, exit_on_stdin_close=True)

    run = sub.add_parser("run", help="run one task and exit")
    add_common(run)
    run.add_argument("task", help="what the agent should do")
    run.add_argument("--timeout", type=float, default=900.0)
    run.add_argument("--quiet", action="store_true", help="hide tool progress")
    run.add_argument("--json", action="store_true", help="print a JSON summary")

    add_common(sub.add_parser("chat", help="interactive terminal session"))

    tools = sub.add_parser("tools", help="list the available tools")
    tools.add_argument("--json", action="store_true")

    add_common(sub.add_parser("doctor", help="check the environment and the endpoint"))

    config = sub.add_parser("config", help="inspect or edit settings")
    config.add_argument("action", choices=["show", "get", "set", "path", "init"])
    config.add_argument("key", nargs="?", default=None)
    config.add_argument("value", nargs="?", default=None)
    config.add_argument("--settings", default=None)
    config.add_argument("--force", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    command = args.command or "doctor"

    handlers = {
        "serve": _cmd_serve,
        "run": _cmd_run,
        "chat": _cmd_chat,
        "tools": _cmd_tools,
        "doctor": _cmd_doctor,
        "config": _cmd_config,
    }
    handler = handlers.get(command)
    if handler is None:
        parser.print_help()
        return EXIT_USAGE
    for attribute, default in (("workspace", None), ("settings", None), ("profile", None)):
        if not hasattr(args, attribute):
            setattr(args, attribute, default)
    try:
        return handler(args)
    except KeyboardInterrupt:
        _stderr("interrupted")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())