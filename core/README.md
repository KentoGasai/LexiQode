# LexiQode core

The agent runtime behind the LexiQode editor extension. One process per
workspace, driven over a small HTTP API with a single SSE event stream.

It is deliberately editor-agnostic: the same session object serves the VSCodium
extension, the terminal REPL and one-shot CLI runs, and the tests drive it with
no editor and no network at all.

## Install

```bash
cd core
python -m pip install -r requirements.txt      # httpx, nothing else
python -m lexiqode tools                       # sanity check
```

Python 3.10 or newer. There is no other runtime dependency: the HTTP server and
the whole tool layer are standard library only.

## Configure a model

Any endpoint that speaks `/chat/completions` works with it: a hosted gateway, a
local runtime, or your own proxy. Nothing here assumes a vendor, and the core
never contacts an endpoint you did not configure.

```bash
python -m lexiqode config init
python -m lexiqode config set profile.default.base_url  https://gateway.example.com
python -m lexiqode config set profile.default.model     your-model-id
python -m lexiqode config set profile.default.api_key   sk-...
python -m lexiqode doctor
```

Environment variables override the file, which is what makes scripted runs
possible without touching disk: `LEXIQODE_BASE_URL`, `LEXIQODE_API_KEY`,
`LEXIQODE_MODEL`, `LEXIQODE_PROFILE`.

## Run

```bash
python -m lexiqode run  "add a --json flag to the CLI and test it"
python -m lexiqode chat                       # interactive
python -m lexiqode serve . --port 0           # what the editor runs
```

`serve` prints exactly one line on stdout - the handshake - and sends everything
else to stderr. The extension parses that line and nothing else, so no
diagnostic may ever be written to stdout. `../docs/protocol.md` is the contract.

## Tools

Seven built-in tools, grouped by the approval policy that governs them:

| tool | family | asks for approval |
|---|---|---|
| `read_file`, `list_dir`, `glob`, `grep` | read | no |
| `write_file`, `edit_file` | write | yes |
| `run_command` | command | yes |

Every path a tool receives is resolved by `ToolContext.resolve`, which refuses
anything outside the workspace root. A refusal comes back to the model as a
failed tool call, so it can adapt instead of retrying the same action.

## Layout

```
lexiqode/
  config.py          settings, paths, OpenAI-compatible model profiles
  daemon.py          runtime descriptor, Windows-safe pid liveness, health probe
  cli.py             serve / run / chat / tools / doctor / config
  llm/               streaming chat-completions client
  agent/             prompt, tools, approval policy, step loop
  server/            session state and the HTTP/SSE transport
tests/               no network, no editor
```

## Tests

```bash
cd core
python -m unittest discover -s tests -t .
```

The suite covers settings round trips, SSE decoding against `httpx.MockTransport`,
tool containment and approval, the step loop with a scripted model, the HTTP API
including auth and the approval handshake, and the CLI handshake in a real child
process. `../scripts/smoke_core.py` additionally runs the core against a real
OpenAI-compatible HTTP server, end to end.