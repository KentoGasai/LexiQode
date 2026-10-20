# LexiQode

An AI coding editor built from open parts: the VSCodium shell plus our own agent
runtime, driving any OpenAI-compatible model you point it at.

No subscription, no account, no vendor lock-in. You supply a base URL, an API
key and a model id; LexiQode supplies the editor, the agent loop and the tools.
Nothing here contacts an endpoint you did not configure.

## Why it is built this way

Cursor is a closed fork of VS Code with a closed agent service. What is
interesting about it is the *behaviour* - an agent that reads the repo, edits
files, runs the tests and shows you a diff before it commits. That behaviour is
not patented; it is engineering. This repository reimplements it on open
foundations:

| layer | choice | why |
|---|---|---|
| shell | VSCodium fork | upstream VS Code without the Microsoft telemetry and branding layers |
| agent | our own Python core (`core/`) | independent of any editor, testable without a network |
| models | any OpenAI-compatible endpoint | your gateway, your local runtime, your key |
| editor glue | our own extension (`extension/`) | stable public APIs only, so an upstream rebase stays cheap |

The reverse-engineering record for Cursor - measured surfaces, evidence and the
feature matrix we work from - lives in `docs/cursor/`.

## Status

| part | state |
|---|---|
| `core/` agent runtime | **working**, 107 tests plus a 24-check end-to-end smoke test |
| `docs/protocol.md` contract | **frozen** at protocol 1 |
| `extension/` VSCodium glue | not started |
| `vscodium/` fork and branding | not started |

## Quick start

```bash
cd core
python -m pip install -r requirements.txt
python -m lexiqode config init
python -m lexiqode config set profile.default.base_url  https://your-gateway.example.com
python -m lexiqode config set profile.default.model     your-model-id
python -m lexiqode config set profile.default.api_key   sk-...

python -m lexiqode doctor                 # checks the endpoint for real
python -m lexiqode chat                   # try the agent
```

Then, from the repository root:

```bash
python scripts/smoke_core.py              # full end-to-end run against a local fake provider
```

## How the pieces fit

```
   VSCodium  ──────────────►  extension/  ──────────────►  core/  ──────────►  your model endpoint
   (the editor)                TypeScript                  Python                /chat/completions
                               spawns the core,            agent loop,
                               renders the agent,          tools, approvals
                               applies the diffs
```

The extension spawns the core as a child process, reads a single handshake line
from its stdout and then talks HTTP plus one SSE stream. Because that boundary is
a documented protocol rather than an in-process API, the core can be replaced,
driven from a terminal, or tested without an editor at all - and a second editor
window attaches to the running core instead of starting a competing one.

## Safety model

The agent runs with your privileges, so the guardrails are explicit rather than
implied:

* every file path a tool receives is resolved and confined to the workspace root;
* writes and shell commands are gated by an approval prompt that the model cannot
  bypass, and an unanswered prompt counts as a **refusal**;
* the API binds to loopback and requires a token that is generated per process
  and never stored;
* the token is never exposed to the webview that renders the UI.

## Scope

This project reimplements functionality from scratch on open foundations. It does
not patch, bypass or redistribute another product's code, assets, branding or
licence checks, and the reverse-engineering notes in `docs/cursor/` record
observable behaviour and public surface only, with the evidence they came from.