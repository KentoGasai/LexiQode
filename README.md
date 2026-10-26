# LexiQode

An IDE with an assistant that runs on **your** endpoint.

No subscription, no account, no vendor relay. You point it at anything that
speaks the OpenAI `chat/completions` API - a hosted gateway, a local runtime, or
your own proxy - and the agent works in the folder you opened: reading files,
editing them, running commands, with a mode that decides how much it may do.

## What it is, and what it stopped being

This started as a patched build of the VS Code sources. That path is retired:
two days went into fighting a 40-minute native build and a window that insisted
on showing somebody else's chat, and none of it produced anything the user could
see. The product is now its own application.

| | |
|---|---|
| The window | our own, drawn by our own HTML and CSS, delivered over a custom `app://` scheme |
| The editor | Monaco, the editing component from VS Code, used as a library |
| The terminal | xterm.js driving a shell through pipes |
| The assistant | our own Python core, started and supervised by the window |
| The model | any OpenAI-compatible endpoint, configured by you |

Monaco and xterm are the two pieces of "their functionality" that are worth
having, and both are ordinary dependencies under MIT. Nothing else about the
editor comes from a fork.

## Requirements

* Windows 10 or 11, 64-bit.
* **Python 3.11 or newer on `PATH`** for the assistant. The editor half runs
  without it, and says so instead of failing silently.
* No administrator rights. The app is a folder you unpack and run.
* Node.js 24 only if you want to build it yourself.

## Install

1. Download `LexiQode-<version>-win32-x64.zip` from your Gitea package registry
   (see [docs/gitea-packages.md](docs/gitea-packages.md)) or from the build
   artifacts of this repository.
2. Unpack it anywhere and run `LexiQode.exe`.
3. The digest next to the download is the file's SHA-256; the same digest is
   printed by the build and by the upload.

To build it yourself:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-app.ps1
powershell -ExecutionPolicy Bypass -File scripts/run-app.ps1 -Deploy
```

`build-app.ps1` runs both test suites, stages the bundle, and writes the zip and
its digest into `dist/`. `run-app.ps1 -Deploy` copies it into
`%LOCALAPPDATA%\Programs\LexiQode`, which needs no privileges.

## Point it at a model

Open the assistant, press the gear in its header, and fill in the endpoint:

* **endpoint** - the base URL, for example `https://api.example.com/v1` or
  `http://127.0.0.1:11434/v1`.
* **api key** - stored on your machine; it is never sent anywhere except that
  endpoint.
* **model** - the model id. *Save & test* saves first and then asks the endpoint
  which models it offers, because that is the only order in which the question
  can be answered truthfully.

The same settings can be set without the window:

```powershell
$env:LEXIQODE_BASE_URL = 'https://api.example.com/v1'
$env:LEXIQODE_API_KEY  = 'sk-...'
$env:LEXIQODE_MODEL    = 'your-model'
python -m lexiqode doctor     # verifies the endpoint and the key
```

Settings live in `%APPDATA%\LexiQode`: `settings.json` for the agent (endpoint,
key, model, limits) and `app-settings.json` for the window (layout, theme, open
tabs). Transcripts and other per-machine data live in `%LOCALAPPDATA%\LexiQode`.

## The five modes

Modes are enforced by the core, not drawn on a button: an excluded tool is
removed from the schemas **and** refused by the registry, so a mode cannot be
talked around by a persuasive model.

| Mode | May read | May write | May run |
|---|---|---|---|
| Agent | yes | yes | yes |
| Ask | yes | no | no |
| Plan | yes | no | no |
| Debug | yes | yes | yes |
| Review | yes | no | no |

Modes sit in the composer, at the bottom of the panel, because that is where the
decision is made: what the next message is allowed to do. The header carries
status only.

## What works

Verified by driving the built application through the DevTools protocol, not by
reading the code (`app/scripts/probe-window.cjs`):

| | |
|---|---|
| Explorer | file tree, create, rename, delete to the recycle bin, reveal |
| Editor | Monaco: syntax, multiple tabs, dirty state, CRLF preserved on save, find in file |
| Quick open | `Ctrl+P`, ranked by a fuzzy score with a boundary bonus |
| Find in files | `Ctrl+Shift+F`, streaming results in batches, cancellable |
| Search and replace | in the active file, through Monaco |
| Source control | status split into staged and unstaged, diffs, stage, unstage, discard, commit, branch switch |
| Terminal | `Ctrl+J`, real PowerShell session, `cd` persists, colour, UTF-8 or the shell's own code page |
| Assistant | streaming answers, reasoning shown separately, tool rows with arguments and results, approvals, cancel, new conversation |
| Layout | resizable and restorable: sidebar, panel, assistant, open tabs |
| Appearance | dark and light, following the system by default |

## What it deliberately does not do

Stated plainly, because a hidden limitation is worse than a missing feature:

* **The terminal is a command console.** A shell driven through pipes has no
  pseudo-console, so full-screen programs (`vim`, `top`) cannot run in it.
  Everything that reads a command and prints lines does. A pseudo-console on
  Windows needs a native module compiled at build time, and an IDE that only
  builds where Visual Studio is installed is a worse trade.
* **No extension API.** The editor has no third-party extension host. Language
  support, themes and commands come from the app itself.
* **Language intelligence is Monaco's.** TypeScript, JavaScript, JSON, CSS and
  HTML get real language services; other languages get syntax, brackets and
  folding, without a language server.
* **One folder per window.** Opening another folder replaces the workspace; a
  second window is a second process.
* **No telemetry, and no network requests at all except to your endpoint.** The
  window is served with `connect-src 'none'`: it cannot reach the network even
  if something in it tried.

## Layout

```
app/                  the window: Electron main process, preload, our interface
  src/main/           window, IPC, workspace, search, git, terminal, agent bridge
  src/preload/        the entire surface the page is allowed to call
  src/renderer/       the interface: markup, styles, modules
  src/shared/         logic both sides use, with its own tests
  test/               100 tests, `npm test`
  scripts/            vendoring the browser bundles, probes
core/                 the agent: Python, OpenAI-compatible, its own test suite
extension/            optional: the same agent inside VS Code, Cursor or VSCodium
scripts/              build, run, publish, and one-off research tools
docs/                 protocol, packages, and the notes behind decisions
```

## Tests

```powershell
cd core;  python -m pytest tests -q      # the agent, its tools and its protocol
cd app;   npm test                       # 100 tests: shared logic, window contracts
node app/scripts/probe-window.cjs        # starts the app and interrogates the window
```

The app's tests are not only unit tests. They include a live shell test (a real
PowerShell is started and driven) and a set of static contracts over the window's
sources: every element the scripts look up must exist in the markup, every
channel the window subscribes to must exist in the shared constants, every import
must resolve, and the only code allowed to produce markup is the icon set and the
markdown renderer, which escapes its input first.

The window probe is a smoke test against the real application - the same thing
that found the terminal rendering nothing when the panel was restored open, and
the fuzzy scorer ranking `a-p-p-deep.js` above `app.js`. It accepts
`LEXIQODE_PROBE_EXE` to check a packaged bundle instead of the sources.

## Publishing

`scripts/publish-gitea.ps1` uploads a built zip to Gitea's generic package
registry, which is the one that suits a desktop application: it keeps the file
exactly as built, next to the git tag that describes it.

```powershell
$env:GITEA_TOKEN = '...'      # Settings > Applications, scope write:package
powershell -ExecutionPolicy Bypass -File scripts/publish-gitea.ps1 `
    -Server https://git.example.com -Owner your-name
```

See [docs/gitea-packages.md](docs/gitea-packages.md) for the details, including
how the CI workflow publishes on a tag when the secrets are present.

## Using the agent in another editor

`extension/` contains a VS Code extension that talks to the same core over the
same protocol. It is optional and independent: `scripts/install-extension.ps1`
builds and installs it into VS Code, Cursor or VSCodium. The app does not need
it, and its absence does not affect the app.