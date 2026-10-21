# LexiQode extension

The editor side of LexiQode: an agent panel, an inline edit command and a diff
review, talking to the Python core over the protocol in `../docs/protocol.md`.

It runs in VSCodium, VS Code and any other editor that loads VS Code extensions,
because it uses public APIs only. Nothing about it is VSCodium-specific.

## What it does

* **Agent chat in the secondary side bar**, the position other coding agents use.
  Ask for a change in plain language; the agent reads the workspace, edits files
  and runs your tests, streaming its work into the transcript as it goes.
* **Modes in the composer**, next to the field they apply to: Agent, Ask, Plan,
  Debug and Review. Picking one is not cosmetic - the core removes the tools the
  mode does not allow, so Ask, Plan and Review cannot write to a file at all.
* **Approval before anything risky.** Writing files and running commands is
  gated. When the sidebar is visible the question appears inline; when it is
  collapsed you get a modal dialog instead, so a hidden panel never turns into a
  silent refusal.
* **Diff review.** When the agent changes a file it opens a before/after diff.
  The panel keeps a "review change" link for every file it touched.
* **Inline edit** (`Ctrl+Alt+K`, `Cmd+Alt+K` on macOS): select code, say how it
  should change, and the result is inserted as a normal editor edit - one undo
  step, no file write behind your back.

## Requirements

* the Python core from `../core`, reachable from the workspace
* Python 3.10 or newer on `PATH` (or a path in `lexiqode.pythonPath`)
* an OpenAI-compatible endpoint, its key and a model id

## Setup

1. Install and build the extension:

   ```powershell
   powershell -ExecutionPolicy Bypass -File ..\scripts\install-extension.ps1
   ```

2. Start the editor and open a folder.
3. Run **LexiQode: Set Up the Model Endpoint**: it asks for the endpoint, the key
   and the model, and for the model it queries your server first so you choose
   from a list instead of typing. Alternatively set `lexiqode.baseUrl` and
   `lexiqode.model` yourself plus **Set the Model API Key**, or configure the core
   directly with `python -m lexiqode config set ...` and leave these empty.
4. The chat opens itself the first time you open a project. After that, the
   LexiQode icon at the right or `Ctrl+Alt+L` brings it back.

## Commands

| command | what it does |
|---|---|
| `LexiQode: Set Up the Model Endpoint` | endpoint, key and model in three steps |
| `LexiQode: Open Agent` | reveal the panel |
| `LexiQode: Edit Selection with AI` | inline edit of the selection |
| `LexiQode: New Session` | clear the conversation and start fresh |
| `LexiQode: Stop the Running Turn` | cancel the turn in progress |
| `LexiQode: Set the Model API Key` | store the key in the OS credential store |
| `LexiQode: Restart the Core` | stop and start the core process |
| `LexiQode: Show Core Status` | endpoint, model, tools and ownership |
| `LexiQode: Show Core Log` | the extension log plus the core's own stderr |

## Settings

| setting | default | meaning |
|---|---|---|
| `lexiqode.pythonPath` | `python` | interpreter used to run the core |
| `lexiqode.coreRoot` | auto | folder containing the `lexiqode` package |
| `lexiqode.baseUrl` | empty | OpenAI-compatible endpoint; empty means "use the core's own settings" |
| `lexiqode.model` | empty | model id, same fallback |
| `lexiqode.autoApproveWrites` | `false` | skip the prompt for file changes |
| `lexiqode.autoApproveCommands` | `false` | skip the prompt for shell commands |
| `lexiqode.maxSteps` | `40` | model round trips allowed in one turn |
| `lexiqode.showDiffs` | `true` | open a diff when a file changes |
| `lexiqode.attachToRunningCore` | `true` | reuse a core already running for this folder |
| `lexiqode.inlineEditModel` | empty | a faster model for inline edits, if you have one |

## How the pieces connect

```
secondary side bar  ──►  this extension  ──►  core process  ──►  your endpoint
 (webview, no secrets)   (spawn, HTTP,      (agent loop,        /chat/completions
                          SSE, diffs)        tools, approvals)
```

Two decisions are worth knowing about:

* **The token never reaches the webview.** The chat surface receives
  render-ready payloads only; every call, including the event stream, is made by
  the extension host.
* **The API key never reaches a file.** It lives in `SecretStorage`, backed by
  the operating system's credential store, and is handed to the core as an
  environment variable when the process starts.

## Development

```bash
cd extension
npm install
npm run compile          # or: npm run watch
node test/client.test.js # drives the compiled client against a real core
npm run check-types:editor  # the types the editor itself would report
```

`check-types:editor` is worth knowing about: the editor ships its own TypeScript
(6.0, which stopped picking up `@types/*` automatically) while `npm run compile`
uses the repository's. When they disagree the editor underlines code that builds
fine. `tsconfig.json` names `node` explicitly and `.vscode/settings.json` pins the
editor to the repository's TypeScript so both sides agree.

`test/client.test.js` needs no editor and no model endpoint: it spawns the core
in a temporary workspace, reads the handshake, runs a turn (which fails against
a closed port) and checks that the frames, the error mapping, the attach path and
the shutdown all behave.