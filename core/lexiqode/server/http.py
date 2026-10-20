"""The core's HTTP API: JSON calls plus one SSE event stream.

Design notes
------------
* The socket binds to loopback only. The bearer token is generated per process
  and handed to the extension over the stdout handshake, so a token never has to
  be stored anywhere and dies with the process.
* ``/api/health`` is deliberately unauthenticated: it is how an editor finds out
  whether the process behind a stale runtime descriptor is still the right one.
* Events are pushed on a long-lived ``/api/events`` stream. Browsers and
  webviews cannot attach an Authorization header to an EventSource, so that one
  endpoint also accepts the token as a query parameter; every other endpoint
  requires the header.
"""

from __future__ import annotations

import hmac
import json
import os
import queue
import socket
import threading
import time
from dataclasses import asdict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from ..agent.events import EventBus
from ..config import AgentSettings, ModelProfile, Settings
from ..errors import ConfigError, LexiQodeError, ProviderError
from ..version import PROTOCOL_VERSION, PRODUCT_NAME, __version__
from .session import CoreSession

MAX_BODY_BYTES = 4 * 1024 * 1024
SSE_HEARTBEAT_SECONDS = 15.0
SSE_QUEUE_DEPTH = 2000


class _SseSubscriber:
    """Fan-out buffer for one connected editor."""

    def __init__(self) -> None:
        self.queue: queue.Queue[tuple[str, dict[str, Any]] | None] = queue.Queue(SSE_QUEUE_DEPTH)

    def send(self, event_type: str, data: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait((event_type, data))
        except queue.Full:
            # Dropping the oldest keeps the agent responsive; the client can
            # resynchronise from /api/state.
            try:
                self.queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait((event_type, data))
            except queue.Full:
                pass

    def close(self) -> None:
        try:
            self.queue.put_nowait(None)
        except queue.Full:
            pass


class CoreServer:
    """Binds the API, owns the accept loop and the shutdown path."""

    def __init__(
        self,
        session: CoreSession,
        *,
        token: str = "",
        host: str = "127.0.0.1",
        port: int = 0,
        bus: EventBus | None = None,
    ) -> None:
        self.session = session
        self.bus = bus or session.bus
        self.token = token or os.urandom(24).hex()
        self.host = host
        self.requested_port = port
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> "CoreServer":
        app = self

        class Handler(_RequestHandler):
            server_app = app

        httpd = ThreadingHTTPServer((self.host, self.requested_port), Handler)
        httpd.daemon_threads = True
        self._httpd = httpd
        self._thread = threading.Thread(target=httpd.serve_forever, name="lexiqode-http", daemon=True)
        self._thread.start()
        return self

    @property
    def port(self) -> int:
        return self._httpd.server_address[1] if self._httpd else 0

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def serve_forever(self) -> None:
        if self._httpd is None:
            self.start()
        assert self._httpd is not None
        try:
            while not self._stopping.is_set():
                time.sleep(0.25)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def stop(self) -> None:
        self._stopping.set()
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=5)
        self._thread = None

    def handshake(self) -> dict[str, Any]:
        """The one JSON line printed on stdout so the editor can attach."""

        return {
            "product": PRODUCT_NAME,
            "version": __version__,
            "protocol": PROTOCOL_VERSION,
            "base_url": self.base_url,
            "host": self.host,
            "port": self.port,
            "token": self.token,
            "pid": os.getpid(),
            "workspace": self.session.workspace.as_posix(),
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }


class _RequestHandler(BaseHTTPRequestHandler):
    """Routes ``/api/*``; anything else is a 404."""

    protocol_version = "HTTP/1.1"
    server_app: CoreServer

    # ------------------------------------------------------------------ plumbing
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        # Keep stderr for real diagnostics; the request log is noise here.
        return

    def _send(self, status: int, payload: Any, *, content_type: str = "application/json") -> None:
        body = b""
        if payload is not None:
            if isinstance(payload, (bytes, bytearray)):
                body = bytes(payload)
            else:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors_headers()
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")

    def _error(self, status: int, message: str, **extra: Any) -> None:
        self._send(status, {"ok": False, "error": message, **extra})

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ConfigError("request body is too large")
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ConfigError(f"body must be JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise ConfigError("body must be a JSON object")
        return data

    def _token_from_request(self) -> str:
        header = self.headers.get("Authorization") or ""
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        return ""

    def _authorised(self, *, allow_query: bool = False) -> bool:
        offered = self._token_from_request()
        if not offered and allow_query:
            offered = (parse_qs(urlparse(self.path).query).get("token") or [""])[0]
        expected = self.server_app.token
        return bool(offered) and hmac.compare_digest(offered, expected)

    # ------------------------------------------------------------------ verbs
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        app = self.server_app
        session = app.session

        if path == "/api/health":
            self._send(HTTPStatus.OK, {
                "ok": True,
                "product": PRODUCT_NAME,
                "version": __version__,
                "protocol": PROTOCOL_VERSION,
                "workspace": session.workspace.as_posix(),
                "pid": os.getpid(),
            })
            return

        if path == "/api/events":
            # A webview EventSource cannot set headers, so the query token is
            # accepted here and only here.
            if not self._authorised(allow_query=True):
                self._error(HTTPStatus.UNAUTHORIZED, "missing or invalid token")
                return
            self._stream_events()
            return

        if not self._authorised():
            self._error(HTTPStatus.UNAUTHORIZED, "missing or invalid token")
            return

        try:
            if path == "/api/state":
                self._send(HTTPStatus.OK, {"ok": True, **session.state()})
            elif path == "/api/settings":
                self._send(HTTPStatus.OK, {"ok": True, "settings": session.settings.redacted()})
            elif path == "/api/tools":
                self._send(HTTPStatus.OK, {"ok": True, "tools": session.registry.describe()})
            elif path == "/api/history":
                messages = session.loop().messages if session._loop else []
                self._send(HTTPStatus.OK, {"ok": True, "messages": messages})
            elif path == "/api/ping":
                self._send(HTTPStatus.OK, {"ok": True, "pong": True})
            else:
                self._error(HTTPStatus.NOT_FOUND, f"no route for GET {path}")
        except LexiQodeError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if not self._authorised():
            self._error(HTTPStatus.UNAUTHORIZED, "missing or invalid token")
            return
        session = self.server_app.session
        try:
            body = self._read_json()
            if path == "/api/settings":
                self._apply_settings(body)
                self._send(HTTPStatus.OK, {"ok": True, "settings": session.settings.redacted()})
            else:
                self._error(HTTPStatus.NOT_FOUND, f"no route for PUT {path}")
        except LexiQodeError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        if not self._authorised():
            self._error(HTTPStatus.UNAUTHORIZED, "missing or invalid token")
            return
        app = self.server_app
        session = app.session
        try:
            body = self._read_json()
            if path == "/api/chat":
                result = session.start_turn(
                    str(body.get("message") or ""),
                    tools=bool(body.get("tools", True)),
                )
                self._send(HTTPStatus.ACCEPTED, {"ok": True, **result})
            elif path == "/api/cancel":
                self._send(HTTPStatus.OK, {"ok": True, **session.cancel()})
            elif path == "/api/reset":
                session.reset()
                self._send(HTTPStatus.OK, {"ok": True})
            elif path == "/api/approval":
                delivered = session.resolve_approval(
                    str(body.get("id") or ""),
                    bool(body.get("approved")),
                    remember=bool(body.get("remember")),
                    reason=str(body.get("reason") or ""),
                )
                self._send(HTTPStatus.OK, {"ok": True, "delivered": delivered})
            elif path == "/api/models":
                self._send(HTTPStatus.OK, {"ok": True, "models": self._probe_models(body)})
            elif path == "/api/complete":
                self._send(HTTPStatus.OK, {"ok": True, "text": self._complete(body)})
            elif path == "/api/shutdown":
                self._send(HTTPStatus.OK, {"ok": True, "stopping": True})
                threading.Thread(target=app.stop, daemon=True).start()
            else:
                self._error(HTTPStatus.NOT_FOUND, f"no route for POST {path}")
        except ProviderError as exc:
            # The keyword must not be named "status": it would clash with the
            # positional status argument and the handler would raise a TypeError
            # instead of answering, which looks like a dropped connection.
            self._error(HTTPStatus.BAD_GATEWAY, str(exc), provider_status=exc.status)
        except LexiQodeError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))

    # ------------------------------------------------------------------ helpers
    def _apply_settings(self, body: dict[str, Any]) -> None:
        """Patch the settings file with the fields the editor may change."""

        session = self.server_app.session
        settings: Settings = session.settings

        if "active_profile" in body and str(body["active_profile"]).strip():
            settings.active_profile = str(body["active_profile"]).strip()

        raw_agent = body.get("agent")
        if isinstance(raw_agent, dict):
            for key, value in raw_agent.items():
                if key not in AgentSettings.__slots__:
                    continue
                setattr(settings.agent, key, value)

        raw_profile = body.get("profile")
        if isinstance(raw_profile, dict):
            profile_id = str(raw_profile.get("id") or settings.active_profile).strip()
            current = settings.profiles.get(profile_id) or ModelProfile(id=profile_id)
            payload = asdict(current)
            for key, value in raw_profile.items():
                if key in ModelProfile.__slots__ and value is not None:
                    payload[key] = value
            payload["id"] = profile_id
            settings.set_profile(ModelProfile(**payload))

        settings.save()
        session.invalidate_loop()

    def _probe_models(self, body: dict[str, Any]) -> list[str]:
        """Ask the configured endpoint which models it serves."""

        session = self.server_app.session
        return session.list_models(str(body.get("profile") or "") or None)

    def _complete(self, body: dict[str, Any]) -> str:
        """One-shot completion used by editor features such as an inline edit."""

        session = self.server_app.session
        max_tokens = body.get("max_tokens")
        temperature = body.get("temperature")
        return session.complete(
            str(body.get("prompt") or ""),
            system=str(body.get("system") or "") or None,
            max_tokens=int(max_tokens) if isinstance(max_tokens, (int, float)) else None,
            temperature=float(temperature) if isinstance(temperature, (int, float)) else None,
            profile_id=str(body.get("profile") or "") or None,
            model=str(body.get("model") or "") or None,
        )

    def _stream_events(self) -> None:
        """Open the SSE channel and pump events until the client goes away."""

        app = self.server_app
        subscriber = _SseSubscriber()
        unsubscribe = app.bus.subscribe(subscriber.send)
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self._cors_headers()
            self.end_headers()
            self.close_connection = True
            self._write_event("ready", {"protocol": PROTOCOL_VERSION})
            # Deliberately no replay of past events. Re-sending earlier text
            # deltas would duplicate assistant output in a client that is already
            # resynchronising via /api/history, and a replayed event cannot be
            # told apart from a fresh one. A client rebuilds its view from
            # /api/state and /api/history on connect and then follows this stream.
            while not app._stopping.is_set():  # noqa: SLF001
                try:
                    item = subscriber.queue.get(timeout=SSE_HEARTBEAT_SECONDS)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                if item is None:
                    break
                self._write_event(item[0], item[1])
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            # The window closed or reloaded; not an error worth surfacing.
            pass
        finally:
            unsubscribe()
            subscriber.close()

    def _write_event(self, event_type: str, data: dict[str, Any]) -> None:
        payload = json.dumps(data, ensure_ascii=False)
        frame = f"event: {event_type}\ndata: {payload}\n\n".encode("utf-8")
        self.wfile.write(frame)
        self.wfile.flush()


def serve(
    session: CoreSession,
    *,
    host: str = "127.0.0.1",
    port: int = 0,
    token: str = "",
    on_ready: Any = None,
) -> CoreServer:
    """Start the API and return the running server."""

    server = CoreServer(session, token=token, host=host, port=port).start()
    if callable(on_ready):
        on_ready(server)
    return server


def free_port(host: str = "127.0.0.1") -> int:
    """Ask the OS for an unused port (used by tests and the runtime descriptor)."""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return int(probe.getsockname()[1])