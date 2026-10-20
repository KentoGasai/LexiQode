# LexiQode core protocol, version 1

The contract between the editor extension and a running core process. Both sides
are versioned together: the core reports its contract version in the handshake
and in `/api/health`, and the extension must refuse to drive a core whose
`protocol` it does not implement.

## 1. Process model

One core process serves exactly one workspace.

| step | who | what |
|---|---|---|
| 1 | extension | look for a runtime descriptor, then validate it (see 3) |
| 2a | extension | valid descriptor: reuse it, do not spawn a second core |
| 2b | extension | no descriptor: spawn `python -m lexiqode serve <folder>` |
| 3 | extension | talk to `base_url` with the token from the handshake |
| 4 | extension | on dispose: close the child's stdin (see 8) |

The core binds to `127.0.0.1` only. It never listens on a public interface.

## 2. Handshake

The core writes **exactly one line** to stdout and never writes to stdout again.
Everything else - logs, warnings, tracebacks - goes to stderr.

```
lexiqode-core-ready {"product":"LexiQode","version":"1.0.0","protocol":1,"base_url":"http://127.0.0.1:52926","host":"127.0.0.1","port":52926,"token":"<48 hex>","pid":12345,"workspace":"C:/work/project","started_at":"2026-01-01T12:00:00"}
```

Parse it as: strip the literal prefix `lexiqode-core-ready`, then parse the rest
as JSON. A reader that sees anything else on the first line must treat the launch
as failed and surface the child's stderr.

If the core cannot start - missing workspace, unusable settings - it prints no
handshake at all, explains the problem on stderr, and exits with code 1.

## 3. Runtime descriptor

On startup the core writes `core-runtime.json` next to its settings
(`%APPDATA%\LexiQode\core-runtime.json` on Windows, or the path in
`LEXIQODE_RUNTIME_FILE`). It carries the same fields as the handshake plus
`written_at`.

An extension must validate a descriptor in two steps before reusing it:

1. the recorded `pid` must still be alive;
2. `GET /api/health` on the recorded `base_url` must answer, and its `workspace`
   must equal the folder being opened.

A descriptor that fails either check is stale, and the extension starts a fresh
core. The core removes its own descriptor on exit, and only a descriptor that
carries its own pid, so a restarted core never deletes a newer one.

## 4. Authentication

Every endpoint except `/api/health` requires the token from the handshake:

```
Authorization: Bearer <token>
```

`GET /api/events` additionally accepts `?token=<token>`, because a webview
`EventSource` cannot set headers. That is the only endpoint where a query token
is accepted. The token is generated per process and never persisted, so it dies
with the core.

## 5. Endpoints

| method | path | auth | body | returns |
|---|---|---|---|---|
| GET | `/api/health` | no | - | liveness and identity |
| GET | `/api/state` | yes | - | workspace, profile, agent settings, tools, turn |
| GET | `/api/settings` | yes | - | redacted settings with resolved paths |
| GET | `/api/tools` | yes | - | tool names, families, enabled flags |
| GET | `/api/history` | yes | - | the conversation messages |
| GET | `/api/ping` | yes | - | `{"ok":true,"pong":true}` |
| GET | `/api/events` | yes | - | SSE stream (section 6) |
| PUT | `/api/settings` | yes | patch | updated redacted settings |
| POST | `/api/chat` | yes | `{"message": "..."}` | `202` once the turn started |
| POST | `/api/cancel` | yes | - | cancels the turn and pending approvals |
| POST | `/api/reset` | yes | - | clears the conversation |
| POST | `/api/approval` | yes | `{"id","approved","remember","reason"}` | `{"delivered": bool}` |
| POST | `/api/models` | yes | `{"profile"?: "id"}` | model ids from the endpoint |
| POST | `/api/shutdown` | yes | - | stops the core |

Responses are JSON. Failures use the right status code and a body of the shape
`{"ok":false,"error":"<human readable>"}`. Statuses used: `400` bad request,
`401` missing or wrong token, `404` unknown route, `502` the configured model
endpoint failed.

`/api/chat` returns as soon as the turn has been queued; it does **not** stream.
Progress and the answer arrive on `/api/events`. Only one turn runs per workspace
at a time, and a second `POST /api/chat` while one is running is rejected with
`400`.

`PUT /api/settings` accepts a partial patch:

```json
{"agent": {"max_steps": 12}, "profile": {"id": "default", "model": "my-model"}}
```

Unknown fields are ignored. The patch is written to disk and the next turn picks
it up. An API key is never returned by any endpoint in clear text: a profile
carries `has_api_key` instead.

### Resynchronising

The event stream never replays past events. A replayed delta cannot be told apart
from a fresh one and would duplicate assistant text, so on connect - and after
any reconnect - a client rebuilds its view from `GET /api/state` and
`GET /api/history`, then follows the stream from that point.

## 6. Event stream

`GET /api/events` is `text/event-stream`. Frames are standard SSE:

```
event: text_delta
data: {"text":"Hel"}
```

A comment frame `: ping` is sent every 15 seconds so an idle proxy does not close
the connection. A client must ignore comment frames. The first frame is always:

```
event: ready
data: {"protocol":1}
```

### Turn events

| event | payload | meaning |
|---|---|---|
| `turn_start` | `model`, `profile` | a turn began |
| `step_start` | `step`, `max_steps` | a model round trip began |
| `text_delta` | `text` | append to the assistant answer |
| `reasoning_delta` | `text` | scratchpad text; show separately, never as the answer |
| `tool_call_delta` | `index`, `name` | a tool name was resolved; display only |
| `assistant_text` | `text` | the complete assistant message of the step |
| `tool_start` | `id`, `name`, `arguments` | a tool began running |
| `approval_request` | `id`, `tool`, `family`, `summary`, `detail` | the core is blocked, waiting for section 7 |
| `tool_end` | `id`, `name`, `ok`, `elapsed_ms`, `meta`, `content` | a tool finished |
| `error` | `message`, `status` (optional) | the turn could not continue |
| `turn_end` | `stopped`, `steps`, `tool_calls`, `usage` | the turn is over |

`turn_end.stopped` is one of `completed`, `max_steps`, `cancelled`, `error`.

`tool_end.content` is truncated to 4000 characters for display; `meta` carries
tool-specific facts, for example `{"path":"src/app.py","changed":true}` for a
write or `{"exit_code":0}` for a command. When a tool was skipped because the
turn was already cancelled, the frame carries `"cancelled": true`.

An `error` frame does not close the stream. An `error` and a `turn_end` may both
appear for the same turn, always in that order.

## 7. Approvals

Writes and shell commands are gated. The handshake is deliberately synchronous:
the tool call blocks until it is answered, so the model cannot proceed behind the
user's back.

1. the core emits `approval_request` with a unique `id`;
2. `GET /api/state` lists the same id in `pending_approvals`;
3. the user decides;
4. the extension posts `POST /api/approval`;
5. the tool runs, or fails with `denied: <reason>`, and that text goes back to
   the model as the tool result.

Rules the extension must respect:

* `remember: true` clears the matching per-family flag
  (`agent.approve_writes` or `agent.approve_commands`) for the rest of the
  session, so later calls of that family stop asking.
* If nobody answers, the request expires after 300 seconds and is treated as a
  **refusal**. A closed window must never turn into an approved write.
* `POST /api/cancel` refuses every pending approval.
* `{"delivered": false}` means the id was already resolved or had expired. Show
  that; do not retry.

## 8. Shutdown

Closing the child's stdin is the portable way to stop a core: the process
finishes the current work, stops the server, removes its runtime descriptor and
exits with code 0. `POST /api/shutdown` does the same over HTTP, and `SIGINT` /
`SIGTERM` are honoured as well.

## 9. Compatibility rules

* The `protocol` integer changes only when a frame or an endpoint changes shape
  in a way an older extension cannot read. Adding an optional field or a new
  event type does not require a bump.
* A client must ignore unknown events and unknown payload fields rather than
  failing.
* The handshake prefix and the stdout rule are the startup contract; the HTTP and
  SSE shapes above are the runtime contract. Both are covered by the tests in
  `core/tests/` and by `scripts/smoke_core.py`.