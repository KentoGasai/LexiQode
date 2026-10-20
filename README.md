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
| `core/` agent runtime | **working**, 136 tests plus a 24-check end-to-end smoke test |
| `docs/protocol.md` contract | **frozen** at protocol 1, extended additively |
| `extension/` VSCodium glue | **working**: agent panel, modes, in-panel settings, approvals, diffs, inline edit |
| `vscodium/` branded build | not started - the cross-cutting work |

### What is and is not "native" yet

Honest boundary, because it decides the next step:

* the chat, its mode row and its settings live in a **webview view** contributed by
  the extension. It looks and behaves like part of the editor, and the panel opens
  itself the first time a project is opened, but it is still an extension surface:
  it can be uninstalled, and it cannot draw outside a view.
* the deeper Cursor surfaces - completion inside the editor, a rewritten layout, a
  chat drawn by the workbench itself - need the **branded build**: VSCodium
  compiled from source with our patches, the extension preinstalled, and our
  `product.json`. Until that exists, "native" means "opens by itself and looks at
  home", not "is compiled into the shell".

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
python scripts/smoke_core.py                     # end-to-end run against a local fake provider
```

## Use it in the editor

```powershell
# 1. get VSCodium (portable, verified against the published sha256)
powershell -ExecutionPolicy Bypass -File scripts\install-vscodium.ps1

# 2. once per checkout: the extension's build dependencies
cd extension; npm install; cd ..

# 3. build, install into the editor, and start it
powershell -ExecutionPolicy Bypass -File scripts\run-lexiqode.ps1
```

Step 3 is repeatable: it rebuilds, replaces the installed copy and starts the
editor. In the editor, open the LexiQode icon in the activity bar.

**Point it at your model.** Run `LexiQode: Set Up the Model Endpoint` from the
command palette. It asks for the endpoint, the key and the model - and for the
model it asks *your server* for the list first, so you pick instead of typing.
The key goes into the operating system's credential store, the endpoint and model
into your user settings; no file in the repository is touched.

If you prefer to keep configuration in the core instead of the editor, the same
three values work there and the editor settings can stay empty:

```bash
python -m lexiqode config set profile.default.base_url https://your-gateway.example.com/v1
python -m lexiqode config set profile.default.model    your-model-id
python -m lexiqode config set profile.default.api_key  sk-...
```

### While working on the extension

Press <kbd>F5</kbd> in the editor: the launch configuration **LexiQode: run in
VSCodium** opens VSCodium with the extension loaded from source and this
repository as the workspace, so the core is found automatically. Use the task
**LexiQode: watch the extension** in the background for a compile-on-save loop.

Inside the editor:

| action | how |
|---|---|
| ask for a change | type in the panel; the agent edits files and runs tests |
| choose what the agent may do | the mode row at the top of the panel: Agent, Ask, Plan, Debug, Review |
| change endpoint, model, key, approvals | the gear in the panel header |
| approve a risky step | inline card in the panel, or a modal dialog when it is collapsed |
| review a file change | the diff opens automatically; the panel keeps a "review change" link |
| rewrite a selection | select code, then `Ctrl+Alt+K` |
| stop a turn | `Stop` in the panel, or `LexiQode: Stop the Running Turn` |

## Verifying it

Three levels, cheapest first:

| command | what it proves |
|---|---|
| `cd core; python -m unittest discover -s tests -t .` | the agent loop, tools, approvals and HTTP surface (116 tests) |
| `cd extension; npm test` | the client against a real core process, and activation with a stubbed editor (12 tests) |
| `powershell -File scripts\test-in-editor.ps1` | the extension loaded and running inside a real VSCodium: activation, commands, settings schema, a real core spawn, the handshake, token enforcement, the view revealing |
| `cd extension; npm run check-types:editor` | the types **the editor** sees, using its own bundled TypeScript |

The in-editor run uses a throwaway user profile and a core pointed at a closed
port, so it needs no model, no key and touches none of your own settings.

`check-types:editor` exists because the editor and the build can disagree: the
editor ships its own TypeScript (6.0, which no longer picks up `@types/*` on its
own) while `npm run compile` uses the repository's. When they differ the editor
underlines code that builds perfectly. `tsconfig.json` names `node` explicitly and
`.vscode/settings.json` pins the editor to the repository's TypeScript, so both
sides see the same thing.

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

## Layout

```
core/               the agent runtime: loop, tools, approvals, HTTP + SSE API
extension/          the editor glue: panel, diffs, inline edit, core lifecycle
docs/protocol.md    the UI <-> core contract, frozen at protocol 1
docs/cursor/        what was measured on Cursor and the feature matrix
scripts/            installers, the end-to-end smoke test, the in-editor runner
```

## Scope

This project reimplements functionality from scratch on open foundations. It does
not patch, bypass or redistribute another product's code, assets, branding or
licence checks, and the reverse-engineering notes in `docs/cursor/` record
observable behaviour and public surface only, with the evidence they came from.